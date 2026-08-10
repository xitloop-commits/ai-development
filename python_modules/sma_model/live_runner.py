"""sma-model live runner — watch-only paper-trading bridge (T154).

Standalone process. Touches NOTHING that is running:
  - tails today's raw recording files read-only (the recorder sync-flushes
    every 3 s, so a zlib streaming reader stays ~3 s behind live)
  - rebuilds the model's 1-min HA candles + SMA5 exactly like the backtest
  - at each candle close runs the same decision logic as the Gate-1
    simulator (pullback entries, EV + leg-size floors, exit head)
  - entries  → POST /api/discipline/validateTrade  (cohort "sma_model",
    origin AI, channel paper — server pins this cohort to paper)
  - exits    → POST /api/risk-control/discipline-request
               (scope GLIDE + cohort "sma_model" — close by position)

Catch-up candles processed at startup feed indicators only — the runner
NEVER trades a candle that closed before it started.

Usage:
    py -m python_modules.sma_model.live_runner            # dry-run (log only)
    py -m python_modules.sma_model.live_runner --go       # real paper trades
"""
from __future__ import annotations

import json
import os
import sys
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .config import (
    IST_OFFSET_SEC,
    MIN_DECISION_CANDLE,
    RAW_ROOT,
    SESSION_START_MIN,
    STRIKE_STEP,
)
from .events import PULLBACK_WINDOW, pullback_hit
from .features import entry_extra_features, entry_features, exit_features
from .pipeline import N_CANDLES, DayData, _heikin_ashi, _minute_index, _sma
from .plot_day import latest_model_dir, load_model

COHORT = "sma_model"
INSTRUMENT = "nifty50"
GRACE_SEC = 4          # wait past minute boundary for the 3s recorder flush


def _broker_url() -> str:
    return os.environ.get("BROKER_URL", "http://localhost:3000")


def _headers() -> dict:
    secret = os.environ.get("INTERNAL_API_SECRET", "")
    h = {"Content-Type": "application/json"}
    if secret:
        h["X-Internal-Token"] = secret
    return h


class GzTail:
    """Streaming reader over a gzip file that another process appends to.

    Handles multi-member files (each recorder restart appends a new gzip
    member) and partial flushes (Z_SYNC_FLUSH boundaries every 3 s).
    """

    def __init__(self, path: Path):
        self.path = path
        self._fh = None
        self._d = zlib.decompressobj(31)
        self._buf = b""

    def lines(self):
        if self._fh is None:
            if not self.path.exists():
                return
            self._fh = open(self.path, "rb")
        while True:
            raw = self._fh.read(1 << 20)
            if not raw:
                break
            out = b""
            while raw:
                out += self._d.decompress(raw)
                if self._d.eof:                       # next gzip member
                    raw = self._d.unused_data
                    self._d = zlib.decompressobj(31)
                else:
                    raw = b""
            self._buf += out
            if b"\n" in self._buf:
                # single split per chunk — per-line slicing of a multi-MB
                # buffer is quadratic and froze the option-file catch-up
                *complete, self._buf = self._buf.split(b"\n")
                for line in complete:
                    if line:
                        yield line


class LiveDay:
    """Incremental DayData builder fed by the four tails."""

    def __init__(self, date: str):
        n = N_CANDLES
        nan = lambda: np.full(n, np.nan)
        self.day = DayData(
            date=date,
            o=nan(), h=nan(), l=nan(), c=nan(),
            ha_o=nan(), ha_c=nan(), ha_h=nan(), ha_l=nan(),
            sma=nan(), candle_end_ts=nan(),
            atp=nan(), vol_cum=nan(), buy_cum=nan(), sell_cum=nan(),
            depth_imb=nan(), spread=nan(), tick_count=np.zeros(n),
            spot=nan(), atm_iv=nan(),
            oi_call=nan(), oi_put=nan(), doi_call=nan(), doi_put=nan(),
            vix=nan(),
        )
        root = RAW_ROOT / date
        self.t_und = GzTail(root / f"{INSTRUMENT}_underlying_ticks.ndjson.gz")
        self.t_opt = GzTail(root / f"{INSTRUMENT}_option_ticks.ndjson.gz")
        self.t_chn = GzTail(root / f"{INSTRUMENT}_chain_snapshots.ndjson.gz")
        self.t_vix = GzTail(root / f"{INSTRUMENT}_vix_ticks.ndjson.gz")
        self.sec_to_leg: dict[str, tuple[int, str]] = {}
        self.leg_to_sec: dict[tuple[int, str], str] = {}
        self.last_chain: dict | None = None
        self._und_last: dict[int, tuple] = {}

    def pump(self) -> None:
        day = self.day
        for line in self.t_chn.lines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not rec.get("recv_ts") or not rec.get("spotPrice"):
                continue
            self.last_chain = rec
            day.expiry = rec.get("expiry") or day.expiry
            for r in rec.get("rows") or []:
                k = r.get("strike")
                if k is None:
                    continue
                for sid_key, t in (("callSecurityId", "CE"), ("putSecurityId", "PE")):
                    sid = r.get(sid_key)
                    if sid:
                        self.sec_to_leg[str(sid)] = (int(k), t)
                        self.leg_to_sec[(int(k), t)] = str(sid)

        for line in self.t_und.lines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts, ltp = rec.get("recv_ts"), rec.get("ltp") or 0.0
            if not ts or ltp <= 0:
                continue
            i = _minute_index(ts)
            if not (0 <= i < N_CANDLES):
                continue
            if np.isnan(day.o[i]):
                day.o[i] = day.h[i] = day.l[i] = ltp
            day.h[i] = max(day.h[i], ltp)
            day.l[i] = min(day.l[i], ltp)
            day.c[i] = ltp
            day.tick_count[i] += 1
            depth = rec.get("depth") or []
            bq = sum(d.get("bid_qty", 0) for d in depth)
            aq = sum(d.get("ask_qty", 0) for d in depth)
            imb = (bq - aq) / (bq + aq) if (bq + aq) > 0 else 0.0
            bid, ask = rec.get("bid") or 0.0, rec.get("ask") or 0.0
            self._und_last[i] = (
                rec.get("atp"), rec.get("volume"), rec.get("total_buy"),
                rec.get("total_sell"), imb,
                (ask - bid) if (bid > 0 and ask > 0) else np.nan, ts,
            )

        if self.sec_to_leg:
            marker = b'"security_id": "'
            for line in self.t_opt.lines():
                # O(1) prefilter: slice the id out and dict-check it — a
                # 462-branch regex here cost ~1.5 ms/line (observed live).
                pos = line.rfind(marker)
                if pos < 0:
                    continue
                pos += len(marker)
                end = line.find(b'"', pos)
                if end < 0:
                    continue
                key = self.sec_to_leg.get(line[pos:end].decode())
                if key is None:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = rec.get("recv_ts")
                if not ts:
                    continue
                i = _minute_index(ts)
                if not (0 <= i < N_CANDLES):
                    continue
                if key not in day.opt_bid:
                    day.opt_bid[key] = np.full(N_CANDLES, np.nan)
                    day.opt_ask[key] = np.full(N_CANDLES, np.nan)
                    day.opt_ltp[key] = np.full(N_CANDLES, np.nan)
                bid, ask = rec.get("bid") or 0.0, rec.get("ask") or 0.0
                ltp = rec.get("ltp") or 0.0
                if bid > 0 and ask > 0:
                    day.opt_bid[key][i] = bid
                    day.opt_ask[key][i] = ask
                if ltp > 0:
                    day.opt_ltp[key][i] = ltp

        for line in self.t_vix.lines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts, ltp = rec.get("recv_ts"), rec.get("ltp") or 0.0
            if ts and ltp > 0:
                i = _minute_index(ts)
                if 0 <= i < N_CANDLES:
                    day.vix[i] = ltp

    def finalize(self, i: int) -> bool:
        """Close candle i: fill gaps from i−1, recompute HA/SMA/context.
        Returns False when there is no usable candle."""
        day = self.day
        if np.isnan(day.c[i]):
            if i == 0 or np.isnan(day.c[i - 1]):
                return False
            day.o[i] = day.h[i] = day.l[i] = day.c[i] = day.c[i - 1]
        if i in self._und_last:
            atp, vol, tb, tsell, imb, spr, ts = self._und_last[i]
            day.atp[i] = atp if atp else np.nan
            day.vol_cum[i] = vol if vol is not None else np.nan
            day.buy_cum[i] = tb if tb is not None else np.nan
            day.sell_cum[i] = tsell if tsell is not None else np.nan
            day.depth_imb[i] = imb
            day.spread[i] = spr
            day.candle_end_ts[i] = ts
        elif i > 0:
            for arr in (day.atp, day.vol_cum, day.buy_cum, day.sell_cum,
                        day.depth_imb, day.spread):
                arr[i] = arr[i - 1]
            day.candle_end_ts[i] = (day.candle_end_ts[i - 1] + 60.0
                                    if not np.isnan(day.candle_end_ts[i - 1])
                                    else np.nan)
        if self.last_chain is not None:
            sp = self.last_chain.get("spotPrice")
            day.spot[i] = sp if sp else (day.spot[i - 1] if i > 0 else np.nan)
            atm = round(day.spot[i] / STRIKE_STEP) * STRIKE_STEP
            oc = op = dc = dp = 0.0
            iv = np.nan
            for r in self.last_chain.get("rows") or []:
                k = r.get("strike")
                if k is None or abs(k - atm) > 3 * STRIKE_STEP:
                    continue
                oc += r.get("callOI") or 0
                op += r.get("putOI") or 0
                dc += r.get("callOIChange") or 0
                dp += r.get("putOIChange") or 0
                if k == atm:
                    civ, piv = r.get("callIV") or 0, r.get("putIV") or 0
                    if civ > 0 and piv > 0:
                        iv = (civ + piv) / 2.0
                    elif civ > 0 or piv > 0:
                        iv = max(civ, piv)
            day.oi_call[i], day.oi_put[i] = oc, op
            day.doi_call[i], day.doi_put[i] = dc, dp
            day.atm_iv[i] = iv
        for key in day.opt_bid:
            for arr in (day.opt_bid[key], day.opt_ask[key], day.opt_ltp[key]):
                if np.isnan(arr[i]) and i > 0:
                    arr[i] = arr[i - 1]
        if np.isnan(day.vix[i]) and i > 0:
            day.vix[i] = day.vix[i - 1]
        _heikin_ashi(day)
        _sma(day)
        return True


class LiveTrader:
    """The same state machine as the Gate-1 simulator, one candle at a time."""

    def __init__(self, live: LiveDay, go: bool):
        self.live = live
        self.go = go
        self.model, self.manifest = load_model(latest_model_dir())
        self.cross: tuple[int, int] | None = None
        self.in_pos: tuple | None = None       # (dir, strike, entry_candle)
        self.log_path = RAW_ROOT.parent / "sma_model_dataset" / \
            f"live_{live.day.date}.log"
        self._log(f"runner start go={go} model={self.manifest.get('created')} "
                  f"floors: EV≥{self.model.ev_threshold} "
                  f"size≥{self.model.size_threshold}")

    def _log(self, msg: str) -> None:
        line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
        print(line, flush=True)
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass

    def on_candle(self, i: int, tradeable: bool) -> None:
        day = self.live.day
        side = day.side()
        if side[i] != 0 and side[i - 1] != 0 and side[i] != side[i - 1]:
            self.cross = (i, int(side[i]))
        if tradeable:
            pos = ("CE" if self.in_pos[0] > 0 else "PE") if self.in_pos else "flat"
            self._log(f"c{i} close={day.c[i]:.1f} sma={day.sma[i]:.1f} "
                      f"side={'+' if side[i] > 0 else '-' if side[i] < 0 else '0'} "
                      f"pos={pos}")
        if self.in_pos is None:
            self._maybe_enter(i, side, tradeable)
        else:
            self._maybe_exit(i, side, tradeable)

    def _maybe_enter(self, i: int, side, tradeable: bool) -> None:
        day = self.live.day
        if self.cross is None:
            return
        x, d = self.cross
        if side[i] != d or i - x > PULLBACK_WINDOW:
            self.cross = None
            return
        if not (i > x and i >= MIN_DECISION_CANDLE and i < N_CANDLES - 1
                and not np.isnan(day.spot[i]) and pullback_hit(day, i, d)):
            return
        atm = day.atm_strike(i)
        if np.isnan(atm):
            return
        strike = int(atm)
        opt = "CE" if d > 0 else "PE"
        q = day.quote(strike, opt, i)
        if q is None:
            self._log(f"c{i} pullback {opt}{strike} — no quote, skip")
            self.cross = None
            return
        feats = np.array([entry_features(day, i, d)
                          + entry_extra_features(day, i, d, x)])
        ev = float(self.model.entry.predict(feats)[0])
        sz = float(self.model.size.predict(feats)[0])
        verdict = (ev >= self.model.ev_threshold
                   and sz >= self.model.size_threshold)
        self._log(f"c{i} pullback {opt}{strike} ask={q[1]:.2f} "
                  f"EV=₹{ev:+.0f} size={sz:.1f}pts → "
                  f"{'ENTER' if verdict else 'skip'}")
        if verdict and tradeable:
            self._post_tray_signal(
                i, direction=f"LONG_{opt}", action="ENTER", strike=strike,
                entry=q[1],
                reason=f"pullback EV ₹{ev:+.0f}, leg {sz:.1f}pts")
            if self._submit_entry(i, d, strike, opt, q[1]):
                self.in_pos = (d, strike, i)
        self.cross = None

    def _maybe_exit(self, i: int, side, tradeable: bool) -> None:
        day = self.live.day
        d, strike, i_in = self.in_pos
        last_candle = i >= N_CANDLES - 1
        wrong = side[i] != 0 and side[i] != d
        if not (last_candle or wrong):
            return
        do_exit = last_candle
        if wrong and not last_candle:
            feats = np.array([exit_features(day, i, d, i_in, strike)])
            p_hold = float(self.model.exit.predict(feats)[0])
            do_exit = p_hold < 0.5
            self._log(f"c{i} wrong-side close, hold-prob={p_hold:.2f} → "
                      f"{'EXIT' if do_exit else 'hold'}")
        if do_exit:
            if tradeable:
                opt = "CE" if d > 0 else "PE"
                self._post_tray_signal(
                    i, direction=f"EXIT_{opt}", action="EXIT", strike=strike,
                    entry=None,
                    reason="leg end" if not last_candle else "session end")
                self._submit_exit(d)
            self.in_pos = None

    def _post_tray_signal(self, i: int, direction: str, action: str,
                          strike: int, entry: float | None,
                          reason: str) -> None:
        """Show this decision in the UI signal tray (POST /api/sea/signal)."""
        day = self.live.day
        now = time.time()
        payload = {
            "id": f"sma-model-{day.date}-c{i}-{action.lower()}",
            "correlationId": f"sma-model-{day.date}-c{i}",
            "timestamp": now,
            "timestamp_ist": datetime.fromtimestamp(
                now + IST_OFFSET_SEC, tz=timezone.utc).strftime("%H:%M:%S"),
            "instrument": INSTRUMENT,
            "direction": direction,
            "action": action,
            "cohort": COHORT,
            "reason": reason,
            "entry": entry,
            "atm_strike": strike,
            "spot_price": (None if np.isnan(day.spot[i]) else float(day.spot[i])),
            "model_version": str(self.manifest.get("created", "")),
        }
        if not self.go:
            return
        try:
            import requests
            requests.post(f"{_broker_url()}/api/sea/signal",
                          headers=_headers(), data=json.dumps(payload),
                          timeout=5)
        except Exception as exc:
            self._log(f"  tray POST failed: {exc}")

    def _submit_entry(self, i, d, strike, opt, ask) -> bool:
        payload = {
            "executionId": f"sma-model-{self.live.day.date}-c{i}",
            "channel": "paper", "origin": "AI",
            "instrument": INSTRUMENT, "exchange": "NSE",
            "transactionType": "BUY", "optionType": opt,
            "strike": float(strike), "expiry": self.live.day.expiry or None,
            "contractSecurityId": self.live.leg_to_sec.get((strike, opt)),
            "entryPrice": float(ask), "stopLoss": None, "takeProfit": None,
            "lots": 1, "cohort": COHORT,
            "correlationId": f"sma-model-{self.live.day.date}-c{i}",
        }
        payload = {k: v for k, v in payload.items() if v is not None}
        payload["stopLoss"] = None
        payload["takeProfit"] = None
        if not self.go:
            self._log(f"  [dry-run] would BUY {opt} {strike} @ {ask:.2f}")
            return True
        try:
            import requests
            r = requests.post(f"{_broker_url()}/api/discipline/validateTrade",
                              headers=_headers(), data=json.dumps(payload),
                              timeout=10)
            body = r.json() if r.status_code < 500 else {}
            ok = bool(body.get("success"))
            self._log(f"  entry POST → {r.status_code} success={ok} "
                      f"{body.get('reason') or body.get('tradeId') or ''}")
            return ok
        except Exception as exc:
            self._log(f"  entry POST failed: {exc}")
            return False

    def _submit_exit(self, d: int) -> None:
        opt = "CE" if d > 0 else "PE"
        if not self.go:
            self._log(f"  [dry-run] would CLOSE {opt} position")
            return
        payload = {
            "reason": "AI_EXIT",
            "scope": {"kind": "GLIDE", "instrument": INSTRUMENT,
                      "optionType": opt, "cohort": COHORT},
        }
        try:
            import requests
            r = requests.post(
                f"{_broker_url()}/api/risk-control/discipline-request",
                headers=_headers(), data=json.dumps(payload), timeout=10)
            self._log(f"  exit POST → {r.status_code}")
        except Exception as exc:
            self._log(f"  exit POST failed: {exc}")


def main() -> None:
    go = "--go" in sys.argv
    now = time.time()
    ist = datetime.fromtimestamp(now + IST_OFFSET_SEC, tz=timezone.utc)
    date = ist.strftime("%Y-%m-%d")
    if not (RAW_ROOT / date).exists():
        raise SystemExit(f"no recording folder for {date} — is the recorder up?")

    live = LiveDay(date)
    trader = LiveTrader(live, go)

    def cur_candle() -> int:
        ist_min = int((time.time() + IST_OFFSET_SEC) // 60) % 1440
        return ist_min - SESSION_START_MIN

    # Catch-up: every candle that closed before launch feeds indicators only.
    live.pump()
    start_candle = cur_candle()
    done = -1
    for i in range(0, min(start_candle, N_CANDLES)):
        if live.finalize(i):
            trader.on_candle(i, tradeable=False)
            done = i
    trader._log(f"caught up through candle {done} — trading from candle "
                f"{max(start_candle, MIN_DECISION_CANDLE)}")

    while True:
        c = cur_candle()
        if c >= N_CANDLES:
            if trader.in_pos is not None:
                trader._log("session end with open position — closing")
                trader._submit_exit(trader.in_pos[0])
            trader._log("session over — runner stopping")
            return
        sec_in_min = int(time.time() + IST_OFFSET_SEC) % 60
        target = done + 1
        if target < c and sec_in_min >= GRACE_SEC or target < c - 1:
            live.pump()
            if live.finalize(target):
                trader.on_candle(target, tradeable=True)
            done = target
        else:
            time.sleep(1.0)


if __name__ == "__main__":
    main()
