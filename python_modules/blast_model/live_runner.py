"""Live PAPER runner — step 6's two-week gate (paper-only, 1 lot, self-ledger).

Tails today's raw recorder files READ-ONLY as they grow (never touches the
recorder or any Dhan connection), feeds every tick through the SAME
FeatureEngine the datasets were built with, scores each 1-minute decision row
with the final b8w5 heads, and paper-trades the locked combo from the
2026-09-07 tune/judge verdict:

    side PE only · enter p≥0.60 · exit p≥0.50 · hold ≤20m · EOD cut 15:20
    fills at the decision premium ± spread · full Dhan charge stack

Ledger + every scored row -> logs/blast_model/<date>_{trades,scores}.ndjson
(the paper gate compares these against backtest behaviour).

Run live:    python -m blast_model.live_runner            (waits for today's files)
Replay test: python -m blast_model.live_runner --date 2026-09-05
"""
from __future__ import annotations

import argparse
import json
import os
import time
import zlib
from datetime import datetime, timedelta, timezone
from typing import Any

from .backtest import LOT_SIZE, dhan_option_charges
from .config import BlastConfig
from .feature_engine import FeatureEngine
from .raw_reader import _ROOT, compute_day_lock, day_dir, session_open_ts

# Platform trade path (Partha 2026-09-08: show blast trades in the paper
# workspace). Reuses the SAME discipline-chain client the SEA engine uses —
# cohort "blast", channel paper. This is platform plumbing, not old-model
# code, so it does not break the clean-slate rule. Optional: if the import
# or a POST fails, the runner still trades its own ledger.
try:
    from signal_engine_agent.risk_control_client import close_trade, send_signal, submit_new_trade
    _PLATFORM = True
except Exception:  # pragma: no cover — platform client unavailable
    _PLATFORM = False

IST = timezone(timedelta(hours=5, minutes=30))
INSTRUMENT_NAME = "NIFTY50"
COHORT = "blast"

# ── locked trade combo (label sweep verdict 2026-09-07) ─────────────────────
LABEL_TAG = "b8w5"
SIDE_FILTER = "PE"
ENTER_FLOOR = 0.60
EXIT_FLOOR = 0.50
MAX_HOLD_MIN = 20
EOD_CUT_HHMM = "15:20"
SPREAD = 0.10


class GzTail:
    """Read a GROWING .ndjson.gz: keep a raw-byte offset + one zlib stream."""

    def __init__(self, path: str):
        self.path = path
        self.pos = 0
        self.dec = zlib.decompressobj(wbits=31)
        self.buf = b""

    def drain(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return out
        if size <= self.pos:
            return out
        with open(self.path, "rb") as f:
            f.seek(self.pos)
            raw = f.read(size - self.pos)
        self.pos = size
        try:
            self.buf += self.dec.decompress(raw)
        except zlib.error:
            return out  # corrupt seam — stop consuming this stream quietly
        *lines, self.buf = self.buf.split(b"\n")
        for ln in lines:
            ln = ln.strip()
            if not ln:
                continue
            try:
                out.append(json.loads(ln))
            except json.JSONDecodeError:
                continue
        return out


class CohortToggle:
    """Follows the AI menu's Blast switch (paper book), polled every 30s.
    Fails open to the last known state so a server blip never stops the gate."""

    def __init__(self) -> None:
        self._on = True
        self._last = 0.0

    def enabled(self) -> bool:
        now = time.time()
        if now - self._last > 30:
            self._last = now
            try:
                import requests

                url = os.environ.get("BROKER_URL", "http://localhost:3000")
                r = requests.get(f"{url}/api/trpc/trading.aiConfig", timeout=3)
                j = r.json()["result"]["data"]["json"]
                self._on = bool(((j.get("paper") or {}).get("ai") or {}).get("cohorts", {}).get("blast", True))
            except Exception:
                pass
        return self._on


class Trader:
    """One paper position, locked combo, ndjson ledger (+ optional platform post)."""

    def __init__(self, date: str, log_dir: str, post: bool = False, sec_id_for=None):
        self.date = date
        os.makedirs(log_dir, exist_ok=True)
        self.trades_path = os.path.join(log_dir, f"{date}_trades.ndjson")
        self.scores_path = os.path.join(log_dir, f"{date}_scores.ndjson")
        self.pos: dict[str, Any] | None = None
        self.closed: list[dict[str, Any]] = []
        self.post = post and _PLATFORM
        self.sec_id_for = sec_id_for  # side -> contract security id (from chain)
        self.toggle = CohortToggle() if self.post else None
        # Catch-up guard: on a restart the tailer replays today's bytes from 0
        # to rebuild candle/flow state. Rows older than this are STATE ONLY —
        # no ledger, no trades, no platform posts (prevents duplicates).
        self.live_after = time.time() - 90
        h, m = EOD_CUT_HHMM.split(":")
        self.eod = datetime.strptime(date, "%Y-%m-%d").replace(
            hour=int(h), minute=int(m), tzinfo=IST).timestamp()

    def _log(self, path: str, obj: dict[str, Any]) -> None:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj) + "\n")

    def on_row(self, row: dict[str, Any], p_enter: float, p_exit: float) -> None:
        ts = row["ts"]
        if ts < self.live_after:
            return  # catch-up replay after a restart: state only
        hhmm = datetime.fromtimestamp(ts, IST).strftime("%H:%M:%S")
        self._log(self.scores_path, {"ts": ts, "side": row["side"], "premium": row["premium"],
                                     "p_enter": round(p_enter, 4), "p_exit": round(p_exit, 4)})
        pos = self.pos
        if pos is not None and row["side"] == pos["side"]:
            held_min = (ts - pos["entry_ts"]) / 60.0
            reason = ("exit" if p_exit >= EXIT_FLOOR
                      else "time" if held_min >= MAX_HOLD_MIN
                      else "eod" if ts >= self.eod else None)
            if reason:
                self._close(ts, row["premium"], reason, hhmm)
        if self.pos is None and ts < self.eod and row["side"] == SIDE_FILTER:
            if self.toggle is not None and not self.toggle.enabled():
                return  # Blast switched OFF in the AI menu — no new entries
            if p_enter >= ENTER_FLOOR and row["premium"] > 0:
                self.pos = {"side": row["side"], "strike": row["strike"],
                            "entry_ts": ts, "entry_px": row["premium"], "p_enter": p_enter}
                print(f"{hhmm}  ENTER {row['side']} {row['strike']:g} @ {row['premium']:.2f} "
                      f"(p_enter {p_enter:.2f})", flush=True)
                self._log(self.trades_path, {"ev": "entry", "ts": ts, **{k: v for k, v in self.pos.items() if k != "entry_ts"}})
                if self.post:
                    self._post_entry(row, p_enter)

    def _post_entry(self, row: dict[str, Any], p_enter: float) -> None:
        """Open the SAME trade in the platform's paper workspace (cohort blast)."""
        try:
            sec_id = self.sec_id_for(row["side"]) if self.sec_id_for else None
            send_signal({"instrument": INSTRUMENT_NAME, "cohort": COHORT, "side": row["side"],
                         "strike": row["strike"], "action": "LONG", "price": row["premium"],
                         "confidence": round(p_enter, 3), "ts": row["ts"],
                         "note": "blast model paper gate"})
            payload = {
                "executionId": f"BLAST-{int(row['ts'] * 1000)}",
                "channel": "paper", "origin": "AI",
                "instrument": INSTRUMENT_NAME, "exchange": "NSE",
                "transactionType": "BUY", "optionType": row["side"],
                "strike": row["strike"], "entryPrice": row["premium"],
                "stopLoss": None, "takeProfit": None,
                "cohort": COHORT, "aiConfidence": p_enter,
            }
            if sec_id:
                payload["contractSecurityId"] = str(sec_id)
            resp = submit_new_trade(payload, timeout=5.0)
            tid = resp.get("tradeId") if isinstance(resp, dict) else None
            if tid and self.pos is not None:
                self.pos["server_trade_id"] = tid
                print(f"          workspace trade opened ({tid})", flush=True)
            else:
                print(f"          workspace post rejected: {resp.get('reason', resp) if isinstance(resp, dict) else resp}", flush=True)
        except Exception as exc:  # never let platform posting stall the model
            print(f"          workspace post failed: {exc}", flush=True)

    def _close(self, ts: float, px: float, reason: str, hhmm: str) -> None:
        pos = self.pos
        assert pos is not None
        buy = (pos["entry_px"] + SPREAD) * LOT_SIZE
        sell = max(px - SPREAD, 0.05) * LOT_SIZE
        charges = dhan_option_charges(buy, sell)
        net = (sell - buy) - charges
        rec = {"ev": "exit", "ts": ts, "side": pos["side"], "strike": pos["strike"],
               "entry_px": pos["entry_px"], "exit_px": px,
               "hold_min": round((ts - pos["entry_ts"]) / 60.0, 1),
               "reason": reason, "charges": round(charges, 2), "net": round(net, 2)}
        self.closed.append(rec)
        self._log(self.trades_path, rec)
        print(f"{hhmm}  EXIT  {pos['side']} {pos['strike']:g} @ {px:.2f} "
              f"({reason}, net {net:+,.0f})", flush=True)
        tid = pos.get("server_trade_id")
        if self.post and tid:
            try:
                close_trade(str(tid), reason=f"BLAST_{reason.upper()}")
                print(f"          workspace trade closed ({tid})", flush=True)
            except Exception as exc:
                print(f"          workspace close failed: {exc} — close {tid} manually!", flush=True)
        self.pos = None

    def mark_close_at_eod(self, last_px: dict[str, float]) -> None:
        if self.pos is not None:
            px = last_px.get(self.pos["side"], self.pos["entry_px"])
            self._close(self.eod, px, "eod", "EOD")

    def summary(self) -> str:
        n = len(self.closed)
        net = sum(t["net"] for t in self.closed)
        wins = sum(1 for t in self.closed if t["net"] > 0)
        return f"day done: {n} trades, net {net:+,.0f} INR, wins {wins}/{n}"


class Scorer:
    def __init__(self, instrument: str):
        import lightgbm as lgb

        mdir = os.path.join(_ROOT, "models", "blast_model", instrument)
        meta = json.load(open(os.path.join(mdir, f"features_{LABEL_TAG}.json"), encoding="utf-8"))
        self.features: list[str] = meta["features"]
        self.enter = lgb.Booster(model_file=os.path.join(mdir, f"enter_{LABEL_TAG}.lgbm"))
        self.exit = lgb.Booster(model_file=os.path.join(mdir, f"exit_{LABEL_TAG}.lgbm"))

    def score(self, row: dict[str, Any]) -> tuple[float, float]:
        import numpy as np

        row = dict(row)
        row["is_call"] = 1.0 if row.get("side") == "CE" else 0.0
        x = np.array([[float(row.get(f, float("nan"))) for f in self.features]])
        return float(self.enter.predict(x)[0]), float(self.exit.predict(x)[0])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="past date = replay test (process to EOF and exit)")
    ap.add_argument("--no-post", action="store_true",
                    help="ledger only — do not mirror trades into the paper workspace")
    args = ap.parse_args()
    cfg = BlastConfig()
    today = datetime.now(IST).strftime("%Y-%m-%d")
    date = args.date or today
    live = date == today
    base = day_dir(date)
    files = {k: os.path.join(base, f"{cfg.instrument}_{k}.ndjson.gz")
             for k in ("underlying_ticks", "option_ticks", "chain_snapshots")}

    print(f"blast paper runner — {date} ({'LIVE tail' if live else 'replay test'}), "
          f"combo: {SIDE_FILTER} e{ENTER_FLOOR} x{EXIT_FLOOR} h{MAX_HOLD_MIN}m, label {LABEL_TAG}", flush=True)
    while live and not all(os.path.exists(p) for p in files.values()):
        print("waiting for recorder files…", flush=True)
        time.sleep(20)

    lock = None
    while lock is None:
        lock = compute_day_lock(date, cfg.lock_offset, cfg.instrument, cfg.session_open_hhmm)
        if lock is None:
            if not live:
                raise SystemExit("no usable chain snapshot for that date")
            time.sleep(10)
    open_dt = datetime.fromtimestamp(session_open_ts(date, cfg.session_open_hhmm), IST)
    print(f"lock: CE {lock.ce_strike:g} / PE {lock.pe_strike:g} (ATM {lock.atm:g} "
          f"@ {open_dt.strftime('%H:%M')}), expiry {lock.expiry}", flush=True)

    eng = FeatureEngine(date, lock, cfg)
    scorer = Scorer(cfg.instrument)

    def sec_id_for(side: str):
        r = eng.chain.rows.get(eng.locked[side])
        if not r:
            return None
        return r.get("callSecurityId") if side == "CE" else r.get("putSecurityId")

    post = live and not args.no_post
    print(f"workspace mirror: {'ON (cohort blast)' if post and _PLATFORM else 'off'}", flush=True)
    trader = Trader(date, os.path.join(_ROOT, "logs", "blast_model"), post=post, sec_id_for=sec_id_for)
    tails = {k: GzTail(p) for k, p in files.items()}
    last_px: dict[str, float] = {}
    last_data = time.time()
    session_end = datetime.strptime(date, "%Y-%m-%d").replace(hour=15, minute=31, tzinfo=IST).timestamp()

    while True:
        batch: list[tuple[float, str, dict[str, Any]]] = []
        for kind, tail in tails.items():
            for d in tail.drain():
                ts = d.get("recv_ts")
                if ts is not None:
                    batch.append((float(ts), kind, d))
        if batch:
            last_data = time.time()
            batch.sort(key=lambda x: x[0])
            for ts, kind, d in batch:
                if kind == "chain_snapshots":
                    eng.on_chain(d)
                elif kind == "underlying_ticks":
                    for row in eng.on_fut(ts, d):
                        p_en, p_ex = scorer.score(row)
                        trader.on_row(row, p_en, p_ex)
                else:
                    eng.on_option(ts, d)
                    if d.get("opt_type") in ("CE", "PE") and d.get("strike") in (lock.ce_strike, lock.pe_strike):
                        if d.get("ltp"):
                            last_px[d["opt_type"]] = d["ltp"]
        else:
            if not live:
                break  # replay test: EOF reached
            now = time.time()
            if now > session_end and now - last_data > 120:
                break  # session over and stream quiet
            time.sleep(1.0)

    trader.mark_close_at_eod(last_px)
    print(trader.summary(), flush=True)


if __name__ == "__main__":
    main()
