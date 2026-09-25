"""TCS2 - the option chain, built from ticks and kept current on every tick.

Spec: docs/systems/14_tcs2.md  (D12, D21, D25, D38)

The chain is NEVER fetched. Dhan's option-chain endpoint is not called: every
value here is assembled from the tick stream, and IV and the Greeks are computed
(D12). The one exception that proves it - Dhan's published chain - is used only
by the D38 comparison screen, as a check, never as a source.

Why it is laid out as parallel numpy arrays rather than a dict of leg objects
---------------------------------------------------------------------------
Two jobs with opposite shapes have to share one structure:

  * `on_tick()` runs perhaps three million times a day and must be O(1) with no
    allocation. It writes scalars into pre-allocated arrays.
  * The maths - IV and four Greeks for every leg - is vectorised and wants the
    whole chain as contiguous arrays. Measured: 14.2 ms for a 1,484-leg IV solve,
    0.40 ms for all Greeks.

Keeping legs in arrays indexed by position means the vectorised pass needs no
gathering, and the per-tick path needs no object churn.

**IV and the Greeks are NOT recomputed per tick.** At three million ticks a day
that would be 14 ms of work per tick. `refresh_analytics()` runs them for the
whole chain at once, on a timer; `on_tick()` only stores what arrived. This is
the single most important performance decision in the module.
"""
from __future__ import annotations

import datetime as dt
import time
from dataclasses import dataclass, field
from typing import Iterable

import numpy as np

from . import config as cfg
from . import greeks as gk
from .scrip import Contract, Resolved
from .wire import ResponseCode, Tick

# Expiry cut-off time per exchange, used for time-to-expiry. Day-granularity
# would put a weekly option's last session at zero time left, which would make
# every IV on expiry day meaningless.
EXPIRY_TIME = {"NSE": (15, 30), "MCX": (23, 30)}


@dataclass
class OIChange:
    """One intraday-tier row (D23): a leg's OI moved."""

    ts: float
    security_id: int
    strike: float
    is_call: bool
    expiry: str
    oi: int
    oi_delta: int
    ltp: float
    volume: int


@dataclass
class ChainSummary:
    """Chain-level values (D25: per chain, not per row)."""

    expiry: str
    spot: float = 0.0
    futures: float = 0.0
    basis: float = 0.0
    atm_strike: float = 0.0
    atm_straddle: float = 0.0
    atm_iv: float = float("nan")
    total_call_oi: int = 0
    total_put_oi: int = 0
    total_call_volume: int = 0
    total_put_volume: int = 0
    pcr_oi: float = 0.0
    pcr_volume: float = 0.0
    max_pain: float = 0.0
    call_wall_strike: float = 0.0
    call_wall_oi: int = 0
    put_wall_strike: float = 0.0
    put_wall_oi: int = 0
    days_to_expiry: float = 0.0
    legs_seen: int = 0


class Chain:
    """One instrument's whole option chain, across every watched expiry."""

    def __init__(self, resolved: Resolved, now: float | None = None) -> None:
        self.instrument = resolved.instrument
        self.cap = cfg.CAPABILITIES[resolved.instrument]
        self.resolved = resolved
        self.trade_date = resolved.trade_date
        # Everything is Black-76 against an implied forward (D40). Kept only to
        # record which exchange this is; the pricing no longer branches on it.
        self._on_futures = not self.cap.has_index

        opts: list[Contract] = list(resolved.options)
        n = len(opts)
        self.contracts = opts
        self._row: dict[int, int] = {}
        for i, c in enumerate(opts):
            self._row[int(c.security_id)] = i

        # Static, from the scrip master - never changes during a session (D26).
        self.strike = np.array([c.strike for c in opts], dtype=np.float64)
        self.is_call = np.array([c.option_type == "CE" for c in opts], dtype=bool)
        self.expiry = np.array([c.expiry for c in opts], dtype="U10")
        self.security_id = np.array([int(c.security_id) for c in opts], dtype=np.int64)
        self.expiries = tuple(resolved.option_expiries)

        # Live, written by on_tick().
        z = lambda dtype: np.zeros(n, dtype=dtype)      # noqa: E731
        self.ltp = z(np.float64)
        self.atp = z(np.float64)
        self.bid = z(np.float64)
        self.ask = z(np.float64)
        self.bid_size = z(np.int64)
        self.ask_size = z(np.int64)
        self.volume = z(np.int64)
        self.ltq = z(np.int64)
        self.oi = z(np.int64)
        self.high_oi = z(np.int64)
        self.low_oi = z(np.int64)
        self.total_buy = z(np.int64)
        self.total_sell = z(np.int64)
        self.day_open = z(np.float64)
        self.day_high = z(np.float64)
        self.day_low = z(np.float64)
        self.day_close = z(np.float64)
        self.prev_close = z(np.float64)
        self.prev_oi = z(np.int64)
        self.last_ts = z(np.float64)
        self.tick_count = z(np.int64)

        # Open-interest baselines. `oi_open` is the first OI each leg reported
        # today, which is what "today's change" is measured against (D29 part 1).
        self.oi_open = np.full(n, -1, dtype=np.int64)
        self._oi_prev = np.full(n, -1, dtype=np.int64)

        # Computed by refresh_analytics().
        self.forward: dict[str, float] = {}
        # True where IV came from a live book mid rather than a last traded
        # price. Worth keeping: a leg priced off a stale LTP deserves less trust.
        self.price_source = np.zeros(n, dtype=bool)
        self.iv = np.full(n, np.nan)
        self.delta = np.full(n, np.nan)
        self.gamma = np.full(n, np.nan)
        self.theta = np.full(n, np.nan)
        self.vega = np.full(n, np.nan)
        self.analytics_at = 0.0

        # Underlying, from the tick stream (D21) - index for NSE, futures for MCX.
        self.spot = 0.0
        self.spot_ts = 0.0
        self.futures: dict[int, float] = {}
        self._futures_ids = [int(c.security_id) for c in resolved.futures]
        self._index_id = int(resolved.index.security_id) if resolved.index else None
        self._vix_id = int(resolved.vix.security_id) if resolved.vix else None
        self.vix = 0.0

        self.oi_changes: list[OIChange] = []
        self.ticks_applied = 0
        self.unknown_ticks = 0
        self._expiry_epoch = {e: self._expiry_ts(e) for e in self.expiries}

    # -- time ------------------------------------------------------------

    def _expiry_ts(self, expiry: str) -> float:
        hh, mm = EXPIRY_TIME[self.cap.exchange]
        d = dt.date.fromisoformat(expiry)
        return dt.datetime(d.year, d.month, d.day, hh, mm).timestamp()

    def time_to_expiry(self, expiry: str, now: float | None = None) -> float:
        now = now if now is not None else time.time()
        return gk.year_fraction(now, self._expiry_epoch[expiry])

    # -- ingest ----------------------------------------------------------

    def on_tick(self, t: Tick) -> None:
        """Apply one tick. O(1), no allocation on the hot path.

        Underlying and VIX ticks are routed here too, so a caller never has to
        know which security a packet belongs to.
        """
        sid = t.security_id

        if sid == self._index_id:
            if t.ltp > 0:
                self.spot, self.spot_ts = t.ltp, t.recv_ts
            self.ticks_applied += 1
            return
        if sid == self._vix_id:
            if t.ltp > 0:
                self.vix = t.ltp
            self.ticks_applied += 1
            return
        if sid in self._futures_ids:
            if t.ltp > 0:
                self.futures[sid] = t.ltp
                # MCX has no index: the futures IS the underlying (D11).
                if self._on_futures and sid == self._futures_ids[0]:
                    self.spot, self.spot_ts = t.ltp, t.recv_ts
            self.ticks_applied += 1
            return

        i = self._row.get(sid)
        if i is None:
            self.unknown_ticks += 1
            return

        self.ticks_applied += 1
        self.tick_count[i] += 1
        self.last_ts[i] = t.recv_ts

        if t.kind == ResponseCode.OI:
            self._apply_oi(i, t.oi, t.recv_ts)
            return
        if t.kind == ResponseCode.PREV_CLOSE:
            self.prev_close[i] = t.prev_close
            self.prev_oi[i] = t.prev_oi
            return

        if t.ltp > 0:
            self.ltp[i] = t.ltp
        if t.atp > 0:
            self.atp[i] = t.atp
        if t.ltq:
            self.ltq[i] = t.ltq
        if t.volume:
            self.volume[i] = t.volume
        if t.total_buy:
            self.total_buy[i] = t.total_buy
        if t.total_sell:
            self.total_sell[i] = t.total_sell
        if t.day_open:
            self.day_open[i] = t.day_open
        if t.day_high:
            self.day_high[i] = t.day_high
        if t.day_low:
            self.day_low[i] = t.day_low
        if t.day_close:
            self.day_close[i] = t.day_close
        # Both sides zero means no book was sent, not a market with no bid and
        # no ask - so leave the previous book standing rather than wiping it.
        if t.has_book:
            self.bid[i] = t.bid
            self.ask[i] = t.ask
            self.bid_size[i] = t.bid_size
            self.ask_size[i] = t.ask_size
        if t.kind == ResponseCode.FULL:
            self.high_oi[i] = t.high_oi
            self.low_oi[i] = t.low_oi
            self._apply_oi(i, t.oi, t.recv_ts)

    def _apply_oi(self, i: int, oi: int, ts: float) -> None:
        if oi <= 0:
            return
        if self.oi_open[i] < 0:
            self.oi_open[i] = oi
        prev = self._oi_prev[i]
        self.oi[i] = oi
        if prev >= 0 and oi != prev:
            # One intraday-tier row per OI change (D23). Appended here and
            # drained by the writer; this module never touches the database.
            self.oi_changes.append(OIChange(
                ts=ts, security_id=int(self.security_id[i]),
                strike=float(self.strike[i]), is_call=bool(self.is_call[i]),
                expiry=str(self.expiry[i]), oi=int(oi), oi_delta=int(oi - prev),
                ltp=float(self.ltp[i]), volume=int(self.volume[i])))
        self._oi_prev[i] = oi

    def drain_oi_changes(self) -> list[OIChange]:
        """Hand over pending intraday rows and forget them.

        The writer batches these every few seconds (D23); the chain keeps no
        history of its own.
        """
        out = self.oi_changes
        self.oi_changes = []
        return out

    # -- derived ---------------------------------------------------------

    @property
    def reference(self) -> float:
        """The underlying level to work from, with a fallback that matters.

        Normally the index tick for NSE and the futures tick for MCX (D11). But
        the index does NOT always tick: measured 2026-09-25, of 1,500 subscribed
        nifty legs exactly two stayed silent - the index and India VIX - while
        the futures kept updating. Without a fallback the entire chain would
        then have no ATM strike, no forward and no IV.

        Falling back to the nearest futures is safe here because it is only used
        to pick near-the-money strikes and to seed the forward; the forward
        itself is still read from the option prices (D40).
        """
        if self.spot > 0:
            return self.spot
        for sid in self._futures_ids:
            px = self.futures.get(sid, 0.0)
            if px > 0:
                return px
        return 0.0

    @property
    def oi_change(self) -> np.ndarray:
        """Change in OI since this leg's first report today."""
        return np.where(self.oi_open >= 0, self.oi - self.oi_open, 0)

    @property
    def spread(self) -> np.ndarray:
        return np.where((self.bid > 0) & (self.ask > 0), self.ask - self.bid, np.nan)

    def implied_forward(self, expiry: str, now: float | None = None) -> float:
        """The forward this expiry's option prices imply (D40).

        Derived by put-call parity from our own chain rather than assumed from
        spot and a rate. Falls back to the matching futures, then to spot, when
        no strike is quoting both sides yet.
        """
        ref = self.reference
        m = self._mask(expiry)
        if not m.any() or ref <= 0:
            return ref
        t = self.time_to_expiry(expiry, now)
        strikes = np.unique(self.strike[m])
        call_px = np.zeros(strikes.size)
        put_px = np.zeros(strikes.size)
        for j, k in enumerate(strikes):
            c = m & (self.strike == k) & self.is_call
            p = m & (self.strike == k) & ~self.is_call
            # Mid where there is a book, LTP otherwise - parity on stale prints
            # would drag the forward the same way it dragged the IVs.
            if c.any():
                i = int(np.flatnonzero(c)[0])
                call_px[j] = ((self.bid[i] + self.ask[i]) / 2.0
                              if self.bid[i] > 0 and self.ask[i] > 0
                              else self.ltp[i])
            if p.any():
                i = int(np.flatnonzero(p)[0])
                put_px[j] = ((self.bid[i] + self.ask[i]) / 2.0
                             if self.bid[i] > 0 and self.ask[i] > 0
                             else self.ltp[i])
        fwd = gk.forward_from_parity(strikes, call_px, put_px, ref, t)
        if fwd > 0 and abs(fwd - ref) < 0.2 * ref:
            return fwd
        if self._futures_ids and self._futures_ids[0] in self.futures:
            return self.futures[self._futures_ids[0]]
        return ref

    def refresh_analytics(self, now: float | None = None) -> float:
        """Recompute IV and all Greeks for the whole chain. NOT per tick.

        Everything is priced with Black-76 against the forward that the options
        themselves imply (D40), which is why there is no spot-versus-futures
        branch here: on MCX the forward is the futures by construction, and on
        NSE it is read out of the chain instead of being assumed.

        Returns seconds taken. Legs whose premium cannot identify a volatility
        keep NaN rather than a fabricated number (D39).
        """
        now = now if now is not None else time.time()
        t0 = time.perf_counter()
        if self.reference <= 0:
            return 0.0

        t_years = np.empty(len(self.strike))
        fwd_arr = np.empty(len(self.strike))
        for e in self.expiries:
            sel = self.expiry == e
            t_years[sel] = self.time_to_expiry(e, now)
            f = self.implied_forward(e, now)
            self.forward[e] = f
            fwd_arr[sel] = f

        # Imply from the BOOK MID where a book exists, and from the last traded
        # price only when it does not.
        #
        # Measured 2026-09-25 against Dhan's chain: on illiquid legs the LTP is
        # badly stale. The 21,700 call printed 1,820 while its live market was
        # 1,349 / 1,467 - a mid of 1,408, so the LTP was **412 points** out, and
        # it implied a 100% volatility on an instrument trading near 11%. The
        # 18,000 call showed 128% the same way. A mid is the market now; a last
        # trade is the market whenever it last traded.
        #
        # Near the money it makes almost no difference (IV bias against Dhan
        # moved only +0.223 -> +0.212), because there the LTP is fresh. The gain
        # is entirely in not publishing absurd numbers on the wings.
        has_book = (self.bid > 0) & (self.ask > 0)
        px = np.where(has_book, (self.bid + self.ask) / 2.0, self.ltp)
        self.price_source = has_book        # for the screen and for validation

        priced = px > 0
        self.iv[:] = np.nan
        if priced.any():
            self.iv[priced] = gk.implied_vol(
                px[priced], fwd_arr[priced], self.strike[priced],
                t_years[priced], self.is_call[priced], on_futures=True)

        # Take each strike's volatility from its OUT-OF-THE-MONEY side, and give
        # it to both legs.
        #
        # A deep in-the-money option is almost all intrinsic value, so its vol is
        # hypersensitive: the 31,500 put quoted a mid of 8,384.82 against an
        # intrinsic of 8,379.02 - **5.80 of time value on 8,385** - and implied
        # 114% on an instrument trading near 11%. The out-of-the-money side of the
        # same strike is where the time value actually lives, which is why every
        # desk reads vol off the wings. Put-call parity says one vol serves both
        # legs of a strike, so nothing is lost by doing it properly.
        for e in self.expiries:
            sel = self.expiry == e
            f = self.forward.get(e, 0.0)
            if f <= 0:
                continue
            for k in np.unique(self.strike[sel]):
                otm_is_call = k >= f
                src = sel & (self.strike == k) & (self.is_call == otm_is_call)
                dst = sel & (self.strike == k) & (self.is_call != otm_is_call)
                if not (src.any() and dst.any()):
                    continue
                v = self.iv[src][0]
                if not np.isnan(v):
                    self.iv[dst] = v

        usable = ~np.isnan(self.iv)
        for arr in (self.delta, self.gamma, self.theta, self.vega):
            arr[:] = np.nan
        if usable.any():
            g = gk.price_and_greeks(fwd_arr[usable], self.strike[usable],
                                    t_years[usable], self.iv[usable],
                                    self.is_call[usable], on_futures=True)
            self.delta[usable] = g["delta"]
            self.gamma[usable] = g["gamma"]
            self.theta[usable] = g["theta"]
            self.vega[usable] = g["vega"]

        self.analytics_at = now
        return time.perf_counter() - t0

    # -- chain-level -----------------------------------------------------

    def _mask(self, expiry: str | None) -> np.ndarray:
        if expiry is None:
            return np.ones(len(self.strike), dtype=bool)
        return self.expiry == expiry

    def max_pain(self, expiry: str) -> float:
        """The strike at which option writers lose least.

        For each candidate settlement K: calls below K and puts above K finish in
        the money, and the writers pay the difference weighted by open interest.
        """
        m = self._mask(expiry)
        if not m.any():
            return 0.0
        strikes = np.unique(self.strike[m])
        if strikes.size == 0:
            return 0.0
        ce, pe = m & self.is_call, m & ~self.is_call
        ce_k, ce_oi = self.strike[ce], self.oi[ce].astype(np.float64)
        pe_k, pe_oi = self.strike[pe], self.oi[pe].astype(np.float64)
        # (settlement, leg) matrices, so the whole curve is one vectorised pass.
        pain = (np.maximum(strikes[:, None] - ce_k[None, :], 0.0) @ ce_oi
                + np.maximum(pe_k[None, :] - strikes[:, None], 0.0) @ pe_oi)
        return float(strikes[int(np.argmin(pain))])

    def atm_strike(self, expiry: str) -> float:
        ref = self.reference
        m = self._mask(expiry)
        if not m.any() or ref <= 0:
            return 0.0
        strikes = np.unique(self.strike[m])
        return float(strikes[int(np.argmin(np.abs(strikes - ref)))])

    def summary(self, expiry: str, now: float | None = None) -> ChainSummary:
        m = self._mask(expiry)
        s = ChainSummary(expiry=expiry, spot=self.reference)
        if not m.any():
            return s

        ce, pe = m & self.is_call, m & ~self.is_call
        s.total_call_oi = int(self.oi[ce].sum())
        s.total_put_oi = int(self.oi[pe].sum())
        s.total_call_volume = int(self.volume[ce].sum())
        s.total_put_volume = int(self.volume[pe].sum())
        s.pcr_oi = (s.total_put_oi / s.total_call_oi) if s.total_call_oi else 0.0
        s.pcr_volume = ((s.total_put_volume / s.total_call_volume)
                        if s.total_call_volume else 0.0)

        if self._futures_ids and self._futures_ids[0] in self.futures:
            s.futures = self.futures[self._futures_ids[0]]
            s.basis = s.futures - self.spot if self.spot > 0 else 0.0

        if ce.any() and self.oi[ce].max() > 0:
            j = int(np.argmax(self.oi[ce]))
            s.call_wall_strike = float(self.strike[ce][j])
            s.call_wall_oi = int(self.oi[ce][j])
        if pe.any() and self.oi[pe].max() > 0:
            j = int(np.argmax(self.oi[pe]))
            s.put_wall_strike = float(self.strike[pe][j])
            s.put_wall_oi = int(self.oi[pe][j])

        s.max_pain = self.max_pain(expiry)
        s.atm_strike = self.atm_strike(expiry)
        if s.atm_strike:
            at = m & (self.strike == s.atm_strike)
            c = at & self.is_call
            p = at & ~self.is_call
            if c.any() and p.any():
                s.atm_straddle = float(self.ltp[c][0] + self.ltp[p][0])
            ivs = self.iv[at]
            ivs = ivs[~np.isnan(ivs)]
            if ivs.size:
                s.atm_iv = float(ivs.mean())

        s.days_to_expiry = self.time_to_expiry(expiry, now) * 365.0
        s.legs_seen = int((self.tick_count[m] > 0).sum())
        return s

    # -- readout ---------------------------------------------------------

    def rows(self, expiry: str) -> list[dict]:
        """One dict per strike, both sides side by side - the D38 screen's input.

        NaN is preserved rather than turned into 0: a leg whose IV we refuse to
        compute must read as blank, never as a cheap option (D38).
        """
        m = self._mask(expiry)
        out: list[dict] = []
        for k in np.unique(self.strike[m]):
            row: dict = {"strike": float(k)}
            for side, flag in (("call", True), ("put", False)):
                sel = m & (self.strike == k) & (self.is_call == flag)
                if not sel.any():
                    continue
                i = int(np.flatnonzero(sel)[0])
                row[side] = {
                    "security_id": int(self.security_id[i]),
                    "ltp": float(self.ltp[i]),
                    "bid": float(self.bid[i]),
                    "ask": float(self.ask[i]),
                    "bid_size": int(self.bid_size[i]),
                    "ask_size": int(self.ask_size[i]),
                    "oi": int(self.oi[i]),
                    "oi_change": int(self.oi_change[i]),
                    "volume": int(self.volume[i]),
                    "iv": float(self.iv[i]),
                    "delta": float(self.delta[i]),
                    "gamma": float(self.gamma[i]),
                    "theta": float(self.theta[i]),
                    "vega": float(self.vega[i]),
                    "ticks": int(self.tick_count[i]),
                }
            out.append(row)
        return out

    def apply_many(self, ticks: Iterable[Tick]) -> int:
        n = 0
        for t in ticks:
            self.on_tick(t)
            n += 1
        return n
