"""FeatureEngine — the ONE place decision-row features are computed.

Both the dataset builder (historical parquets) and the live paper runner feed
ticks through this same class, so training features and live features can
never diverge. Feed ticks in recv_ts order via on_fut / on_option / on_chain;
each futures 1-minute close inside the session yields decision rows (one per
locked leg) from rows() — identical to dataset v2 columns (minus labels).
"""
from __future__ import annotations

from typing import Any

from .candles import CandleBuilder, structure_features
from .config import BlastConfig
from .flow import FlowTracker
from .greeks import bs_greeks, expected_hourly_move, years_to_expiry
from .raw_reader import DayLock, session_open_ts


class ChainState:
    """Latest chain view: spot, expiry, per-strike IV/OI, ATM, PCR."""

    def __init__(self) -> None:
        self.spot = 0.0
        self.expiry = ""
        self.rows: dict[float, dict[str, Any]] = {}
        self.atm = 0.0
        self.pcr = float("nan")
        self.strikes: list[float] = []

    def update(self, snap: dict[str, Any]) -> None:
        rows = snap.get("rows") or []
        spot = snap.get("spotPrice") or 0
        if not rows or spot <= 0:
            return
        self.spot = float(spot)
        self.expiry = str(snap.get("expiry", self.expiry))
        self.rows = {float(r["strike"]): r for r in rows if r.get("strike")}
        self.strikes = sorted(self.rows)
        self.atm = min(self.strikes, key=lambda s: abs(s - self.spot))
        call_oi = sum(r.get("callOI") or 0 for r in self.rows.values())
        put_oi = sum(r.get("putOI") or 0 for r in self.rows.values())
        self.pcr = put_oi / call_oi if call_oi > 0 else float("nan")

    def ladder(self, ladder: int) -> list[float]:
        if not self.strikes or self.atm not in self.rows:
            return []
        i = self.strikes.index(self.atm)
        lo = max(0, i - ladder)
        hi = min(len(self.strikes), i + ladder + 1)
        return self.strikes[lo:hi]


class FeatureEngine:
    def __init__(self, date: str, lock: DayLock, cfg: BlastConfig | None = None):
        self.cfg = cfg or BlastConfig()
        self.date = date
        self.lock = lock
        self.locked = {"CE": lock.ce_strike, "PE": lock.pe_strike}
        self.open_ts = session_open_ts(date, self.cfg.session_open_hhmm)
        self.prem: dict[str, dict[int, CandleBuilder]] = {
            side: {tf: CandleBuilder(tf) for tf in self.cfg.structure_tfs_sec}
            for side in ("CE", "PE")
        }
        self.fut_1m = CandleBuilder(self.cfg.decision_candle_sec)
        self.flows: dict[tuple[float, str], FlowTracker] = {}
        self.chain = ChainState()

    # ── tick inputs ────────────────────────────────────────────────────────
    def on_chain(self, snap: dict[str, Any]) -> None:
        self.chain.update(snap)

    def on_option(self, ts: float, d: dict[str, Any]) -> None:
        strike = d.get("strike")
        side = d.get("opt_type")
        if strike is None or side not in ("CE", "PE"):
            return
        strike = float(strike)
        ltp = d.get("ltp") or 0
        if strike == self.locked[side]:
            for tf in self.cfg.structure_tfs_sec:
                self.prem[side][tf].add(ts, ltp, d.get("ltq") or 0)
        self._flow(strike, side).add(
            ts, d.get("oi") or 0, d.get("volume") or 0, ltp,
            d.get("total_buy") or 0, d.get("total_sell") or 0)

    def on_fut(self, ts: float, d: dict[str, Any]) -> list[dict[str, Any]]:
        """Returns decision rows when this tick closed a session 1m candle."""
        closed = self.fut_1m.add(ts, d.get("ltp") or 0, d.get("ltq") or 0)
        if closed is not None and closed.t >= self.open_ts:
            return self.rows(ts)
        return []

    # ── internals ──────────────────────────────────────────────────────────
    def _flow(self, strike: float, side: str) -> FlowTracker:
        key = (strike, side)
        ft = self.flows.get(key)
        if ft is None:
            ft = self.flows[key] = FlowTracker(self.cfg.flow_windows_sec)
        return ft

    def _ret(self, candles, n):
        if len(candles) <= n:
            return float("nan")
        a, b = candles[-1 - n].close, candles[-1].close
        return (b - a) / a if a > 0 else float("nan")

    def _atm_iv(self) -> float:
        r = self.chain.rows.get(self.chain.atm)
        if not r:
            return float("nan")
        ivs = [v for v in (r.get("callIV"), r.get("putIV")) if v and v > 0]
        return sum(ivs) / len(ivs) if ivs else float("nan")

    def _strike_dist(self, strike: float, side: str) -> float:
        ch = self.chain
        if not ch.strikes or ch.atm not in ch.rows:
            return float("nan")
        step = ch.strikes[1] - ch.strikes[0] if len(ch.strikes) > 1 else 1
        d = (strike - ch.atm) / step
        return d if side == "CE" else -d  # + = OTM for both sides

    def _leg_greeks(self, strike: float, side: str, tte: float):
        r = self.chain.rows.get(strike)
        if not r:
            return None
        iv = r.get("callIV") if side == "CE" else r.get("putIV")
        if not iv or iv <= 0:
            return None
        return bs_greeks(self.chain.spot, strike, float(iv), tte, side == "CE")

    def rows(self, now_ts: float) -> list[dict[str, Any]]:
        """Decision rows for both locked legs at a futures 1m close."""
        cfg = self.cfg
        ch = self.chain
        if ch.spot <= 0 or not ch.expiry:
            return []
        out = []
        tte = years_to_expiry(ch.expiry, now_ts, cfg.session_close_hhmm)
        exp_move_hr = expected_hourly_move(ch.spot, self._atm_iv(), cfg.session_hours)
        fut_candles = self.fut_1m.candles
        fut_struct = structure_features(fut_candles, cfg.swing_window, cfg.range_lookback, "fut1m")
        fut_ret_1m = self._ret(fut_candles, 1)
        fut_ret_5m = self._ret(fut_candles, 5)
        for side in ("CE", "PE"):
            b1 = self.prem[side][cfg.decision_candle_sec]
            if not b1.candles:
                continue
            c = b1.candles[-1]
            row: dict[str, Any] = {
                "date": self.date, "ts": now_ts, "side": side, "candle_t": c.t,
                "strike": self.locked[side], "premium": c.close,
                "spot": ch.spot, "atm": ch.atm,
                "dist_atm_strikes": self._strike_dist(self.locked[side], side),
                "pcr": ch.pcr, "atm_iv": self._atm_iv(),
                "tte_years": tte, "exp_move_hr": exp_move_hr,
                "fut_ret_1m": fut_ret_1m, "fut_ret_5m": fut_ret_5m,
            }
            row.update(fut_struct)
            for tf in cfg.structure_tfs_sec:
                row.update(structure_features(
                    self.prem[side][tf].candles, cfg.swing_window, cfg.range_lookback, f"p{tf}s"))
            g = self._leg_greeks(self.locked[side], side, tte)
            row["leg_delta"] = g["delta"] if g else float("nan")
            row["leg_gamma"] = g["gamma"] if g else float("nan")
            row["leg_theta_day"] = g["theta_day"] if g else float("nan")
            for k, strike in enumerate(ch.ladder(cfg.ladder)):
                p = f"lad{k - cfg.ladder:+d}"
                gg = self._leg_greeks(strike, side, tte)
                row[f"{p}_delta"] = gg["delta"] if gg else float("nan")
                row[f"{p}_theta_day"] = gg["theta_day"] if gg else float("nan")
                r = ch.rows.get(strike, {})
                row[f"{p}_oi"] = (r.get("callOI") if side == "CE" else r.get("putOI")) or float("nan")
                row[f"{p}_iv"] = (r.get("callIV") if side == "CE" else r.get("putIV")) or float("nan")
                row.update(self._flow(strike, side).features(now_ts, p))
            out.append(row)
        return out
