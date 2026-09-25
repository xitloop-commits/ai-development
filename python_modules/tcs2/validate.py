"""TCS2 - is every value on the screen actually calculated correctly?

Spec: docs/systems/14_tcs2.md  (D12, D25, D38)

Two kinds of check, and the distinction matters:

**Self-consistency** - recompute a value a different way from the same data and
require the two to agree. Catches arithmetic and wiring mistakes. Cannot catch a
shared wrong assumption: if our forward is wrong, our IV and our delta are wrong
together and agree perfectly.

**Against Dhan's own option chain** - the only check that can catch a shared wrong
assumption, because it is an entirely separate calculation by someone else. D12
deliberately forbids using that endpoint as a SOURCE; using it as a REFEREE is
exactly what D38 asked for, and this module is that, automated.

Dhan's chain gives, per strike per side: last price, OI, volume, top bid and ask,
implied volatility, and delta, gamma, theta and vega. So every number we compute
has an independent opinion available.

Nothing here is on the live path. It is run on demand.
"""
from __future__ import annotations

import json
import math
import urllib.request
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from . import config as cfg
from . import greeks as gk

OPTION_CHAIN_URL = "https://api.dhan.co/v2/optionchain"
EXPIRY_LIST_URL = "https://api.dhan.co/v2/optionchain/expirylist"

# Dhan's option chain is heavily rate-limited - roughly one request every three
# seconds. A validator that trips the limit reports failures that are its own
# fault, so it waits rather than retrying blindly.
CHAIN_MIN_INTERVAL_SEC = 3.5

# Underlying ids Dhan's chain endpoint expects, which are NOT the ids we
# subscribe. 13 is the NIFTY index and 25 BANKNIFTY; MCX takes the futures.
CHAIN_UNDERLYING = {
    "nifty50": (13, "IDX_I"),
    "banknifty": (25, "IDX_I"),
}


@dataclass
class Check:
    """One assertion about one value."""

    name: str
    ok: bool
    ours: Any = None
    theirs: Any = None
    detail: str = ""

    def line(self) -> str:
        mark = "ok  " if self.ok else "FAIL"
        body = f"{mark} {self.name:<44}"
        if self.ours is not None:
            body += f" ours {self.ours!s:>14}"
        if self.theirs is not None:
            body += f"  theirs {self.theirs!s:>14}"
        if self.detail:
            body += f"   {self.detail}"
        return body


@dataclass
class Report:
    checks: list[Check] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)

    def add(self, name: str, ok: bool, ours=None, theirs=None,
            detail: str = "") -> None:
        self.checks.append(Check(name, ok, ours, theirs, detail))

    def skip(self, name: str, why: str) -> None:
        self.skipped.append(f"{name}: {why}")

    @property
    def failures(self) -> list[Check]:
        return [c for c in self.checks if not c.ok]

    def summary(self) -> str:
        n = len(self.checks)
        bad = len(self.failures)
        return (f"{n - bad}/{n} checks passed"
                + (f", {bad} FAILED" if bad else "")
                + (f", {len(self.skipped)} skipped" if self.skipped else ""))


def _close(a: float, b: float, rel: float = 0.01, abs_: float = 0.0) -> bool:
    if a is None or b is None:
        return False
    if a != a or b != b:
        return False
    return abs(a - b) <= max(abs_, rel * max(abs(a), abs(b)))


# -- self-consistency ----------------------------------------------------

def check_self(chain, expiry: str, report: Report | None = None) -> Report:
    """Recompute each displayed value a different way and require agreement.

    Catches wiring and arithmetic errors. Deliberately cannot catch a shared
    assumption - that is what `check_against_dhan` is for.
    """
    rep = report or Report()
    m = chain.expiry == expiry
    if not m.any():
        rep.skip("self", f"no legs for {expiry}")
        return rep
    s = chain.summary(expiry)

    # --- arithmetic that the screen shows ---
    strikes = np.unique(chain.strike[m])
    nearest = float(strikes[int(np.argmin(np.abs(strikes - chain.reference)))])
    rep.add("ATM strike is the nearest to the reference",
            s.atm_strike == nearest, s.atm_strike, nearest)

    ce = m & chain.is_call & (chain.strike == s.atm_strike)
    pe = m & ~chain.is_call & (chain.strike == s.atm_strike)
    if ce.any() and pe.any():
        expect = float(chain.ltp[ce][0] + chain.ltp[pe][0])
        rep.add("ATM straddle = ATM call + ATM put",
                _close(s.atm_straddle, expect, 1e-9), s.atm_straddle, expect)

    call_oi = int(chain.oi[m & chain.is_call].sum())
    put_oi = int(chain.oi[m & ~chain.is_call].sum())
    expect_pcr = (put_oi / call_oi) if call_oi else 0.0
    rep.add("PCR(OI) = total put OI / total call OI",
            _close(s.pcr_oi, expect_pcr, 1e-6), round(s.pcr_oi, 4),
            round(expect_pcr, 4))

    # Walls, recomputed by a plain scan rather than argmax.
    best_ce = (0.0, -1)
    best_pe = (0.0, -1)
    for i in np.flatnonzero(m):
        oi = int(chain.oi[i])
        if bool(chain.is_call[i]):
            if oi > best_ce[1]:
                best_ce = (float(chain.strike[i]), oi)
        elif oi > best_pe[1]:
            best_pe = (float(chain.strike[i]), oi)
    rep.add("call wall is the largest call OI",
            s.call_wall_strike == best_ce[0], s.call_wall_strike, best_ce[0])
    rep.add("put wall is the largest put OI",
            s.put_wall_strike == best_pe[0], s.put_wall_strike, best_pe[0])

    # Max pain, recomputed by a brute-force loop instead of the matrix form.
    pains = {}
    for k in strikes:
        pain = 0.0
        for i in np.flatnonzero(m):
            oi = float(chain.oi[i])
            sk = float(chain.strike[i])
            if bool(chain.is_call[i]):
                pain += max(k - sk, 0.0) * oi
            else:
                pain += max(sk - k, 0.0) * oi
        pains[float(k)] = pain
    brute = min(pains, key=lambda x: pains[x]) if pains else 0.0
    rep.add("max pain matches a brute-force recompute",
            s.max_pain == brute, s.max_pain, brute)

    if chain.spot > 0 and s.futures > 0:
        rep.add("basis = futures - spot",
                _close(s.basis, s.futures - chain.spot, 1e-9),
                round(s.basis, 2), round(s.futures - chain.spot, 2))

    # --- the maths ---
    fwd = chain.forward.get(expiry, 0.0)
    if fwd > 0:
        # Put-call parity at the money, which is how the forward was derived -
        # so this is a closure check, not independent evidence.
        if ce.any() and pe.any():
            c_px, p_px = float(chain.ltp[ce][0]), float(chain.ltp[pe][0])
            t = chain.time_to_expiry(expiry)
            lhs = c_px - p_px
            rhs = math.exp(-gk.DEFAULT_RATE * t) * (fwd - s.atm_strike)
            rep.add("put-call parity holds at the money",
                    _close(lhs, rhs, 0.05, abs_=2.0), round(lhs, 2),
                    round(rhs, 2))

    # A leg is only self-checkable if its OWN price implied its vol. Since a
    # strike's vol is read off its out-of-the-money side and shared with the
    # in-the-money side, an ITM leg can carry an IV without ever having traded -
    # repricing that leg against its own absent price would prove nothing.
    own_price = np.where(chain.price_source, (chain.bid + chain.ask) / 2.0,
                         chain.ltp)
    otm = np.where(chain.is_call, chain.strike >= chain.reference,
                   chain.strike < chain.reference)
    usable = m & ~np.isnan(chain.iv) & (own_price > 0) & otm
    if usable.any():
        # The nearest-the-money out-of-the-money leg: most liquid, least noisy.
        # Delta is then checked by a numeric bump of our own pricer, which proves
        # the delta we report IS the sensitivity of the price we report.
        near = np.flatnonzero(usable)
        i = int(near[int(np.argmin(np.abs(chain.strike[near] - chain.reference)))])
        t = chain.time_to_expiry(expiry)
        h = max(fwd * 1e-5, 1e-4)
        up = gk.price_and_greeks(fwd + h, chain.strike[i], t, chain.iv[i],
                                 bool(chain.is_call[i]), on_futures=True)["price"]
        dn = gk.price_and_greeks(fwd - h, chain.strike[i], t, chain.iv[i],
                                 bool(chain.is_call[i]), on_futures=True)["price"]
        numeric = float((up - dn) / (2 * h))
        rep.add("delta equals a numeric bump of our own pricer",
                _close(float(chain.delta[i]), numeric, 0.01),
                round(float(chain.delta[i]), 4), round(numeric, 4))

        # Our IV must reprice to the PRICE WE IMPLIED IT FROM - the book mid
        # where there was a book, the last trade otherwise. Comparing against the
        # last trade when the mid was used would fail on every stale leg, which
        # is the whole reason the mid is used.
        used = float(own_price[i])
        theo = float(gk.price_and_greeks(fwd, chain.strike[i], t, chain.iv[i],
                                         bool(chain.is_call[i]),
                                         on_futures=True)["price"])
        rep.add("our IV reprices to the price it came from",
                _close(theo, used, 0.02, abs_=0.05),
                round(theo, 2), round(used, 2),
                detail=("mid" if bool(chain.price_source[i]) else "last trade"))

        # Call and put delta at the same strike must differ by the discount
        # factor - a structural identity, independent of whether the vol is right.
        for k in strikes:
            c = m & chain.is_call & (chain.strike == k) & ~np.isnan(chain.delta)
            p = m & ~chain.is_call & (chain.strike == k) & ~np.isnan(chain.delta)
            if c.any() and p.any():
                t = chain.time_to_expiry(expiry)
                df = math.exp(-gk.DEFAULT_RATE * t)
                diff = float(chain.delta[c][0] - chain.delta[p][0])
                rep.add(f"call/put delta parity at {k:,.0f}",
                        _close(diff, df, 0.02), round(diff, 4), round(df, 4))
                break

    # --- ranges that must simply hold ---
    iv = chain.iv[m]
    iv = iv[~np.isnan(iv)]
    if iv.size:
        rep.add("every IV is positive and below 500%",
                bool((iv > 0).all() and (iv < 5.0).all()),
                f"{iv.min():.3f}-{iv.max():.3f}")
        # An index option implying above 150% is almost always a stale print
        # rather than a real market - which is why IV is implied from the book
        # mid. Kept as a check so a return of the problem is visible.
        wild = int((iv > 1.5).sum())
        rep.add("no leg implies an implausible volatility (>150%)", wild == 0,
                f"{wild} of {iv.size} legs")
    d = chain.delta[m & chain.is_call]
    d = d[~np.isnan(d)]
    if d.size:
        rep.add("call deltas sit between 0 and 1",
                bool((d >= 0).all() and (d <= 1).all()),
                f"{d.min():.3f}-{d.max():.3f}")
    d = chain.delta[m & ~chain.is_call]
    d = d[~np.isnan(d)]
    if d.size:
        rep.add("put deltas sit between -1 and 0",
                bool((d <= 0).all() and (d >= -1).all()),
                f"{d.min():.3f}-{d.max():.3f}")
    sp = chain.spread[m]
    sp = sp[~np.isnan(sp)]
    if sp.size:
        rep.add("no negative spread (ask below bid)", bool((sp >= 0).all()),
                f"min {sp.min():.2f}")
    return rep


def check_flow(flow, report: Report | None = None) -> Report:
    """The order-flow readings, recomputed from the prints they came from."""
    rep = report or Report()
    if flow is None or not flow.prints:
        rep.skip("flow", "no prints yet")
        return rep

    a = flow.aggression(1800)
    total = a["buy_share"] + a["sell_share"] + a["passive_share"]
    rep.add("buy + sell + passive shares sum to 1", _close(total, 1.0, 1e-9),
            round(total, 9), 1.0)

    from .flow import BUY, SELL
    expect = sum(p.side * p.qty for p in flow.prints
                 if p.side in (BUY, SELL))
    got = flow.delta(1e9)
    rep.add("window delta = sum of signed prints", got == expect, got, expect)

    b = flow.book
    if b.valid:
        tot = b.bid_depth + b.ask_depth
        expect_imb = (b.bid_depth - b.ask_depth) / tot if tot else 0.0
        rep.add("imbalance = (bid depth - ask depth) / total",
                _close(flow.imbalance(), expect_imb, 1e-9),
                round(flow.imbalance(), 6), round(expect_imb, 6))
        rep.add("imbalance stays within -1 to 1",
                -1.0 <= flow.imbalance() <= 1.0, round(flow.imbalance(), 4))
        rep.add("spread is not negative", b.spread >= 0, round(b.spread, 2))
    return rep


# -- against Dhan's own chain -------------------------------------------

def fetch_dhan_chain(instrument: str, expiry: str, token: str,
                     client_id: str) -> dict:
    """Dhan's option chain. The REFEREE, never a source (D12)."""
    if instrument not in CHAIN_UNDERLYING:
        raise ValueError(f"no chain underlying known for {instrument}")
    scrip, seg = CHAIN_UNDERLYING[instrument]
    req = urllib.request.Request(
        OPTION_CHAIN_URL,
        data=json.dumps({"UnderlyingScrip": scrip, "UnderlyingSeg": seg,
                         "Expiry": expiry}).encode("utf-8"),
        headers={"Content-Type": "application/json", "access-token": token,
                 "client-id": str(client_id)})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read())["data"]


def check_against_dhan(chain, expiry: str, dhan: dict, band: int = 6,
                       report: Report | None = None) -> Report:
    """Compare our numbers against Dhan's, near the money.

    Near the money on purpose: far strikes have stale quotes and Dhan itself
    reports zero Greeks there, so a disagreement would say nothing.

    **Scale differences are measured, not assumed.** Dhan reports IV in percent
    where we use a fraction, and its vega and theta are per 1% of vol and per day
    on its own convention. The ratio is reported so a units mistake shows up as a
    clean constant rather than as a vague mismatch.
    """
    rep = report or Report()
    oc = dhan.get("oc") or {}
    if not oc:
        rep.skip("dhan", "empty chain returned")
        return rep

    their_spot = dhan.get("last_price")
    if their_spot and chain.spot > 0:
        rep.add("spot matches Dhan's underlying price",
                _close(chain.spot, their_spot, 0.002), round(chain.spot, 2),
                their_spot)
    elif their_spot:
        rep.add("spot is being received at all", False, chain.spot, their_spot,
                "we have no spot - see D51")

    m = chain.expiry == expiry
    s = chain.summary(expiry)
    atm = s.atm_strike
    step = cfg.CAPABILITIES[chain.instrument].strike_step
    lo, hi = atm - band * step, atm + band * step

    matched = 0
    iv_diffs: list[float] = []
    delta_diffs: list[float] = []
    oi_mismatch: list[str] = []
    ltp_mismatch: list[str] = []

    for key, row in oc.items():
        k = float(key)
        if not (lo <= k <= hi):
            continue
        for side, flag in (("ce", True), ("pe", False)):
            their = row.get(side) or {}
            if not their:
                continue
            sel = m & (chain.strike == k) & (chain.is_call == flag)
            if not sel.any():
                continue
            i = int(np.flatnonzero(sel)[0])
            if chain.tick_count[i] == 0:
                continue
            matched += 1
            label = f"{k:,.0f} {side.upper()}"

            if their.get("oi") and int(chain.oi[i]) and \
                    not _close(float(chain.oi[i]), float(their["oi"]), 0.02):
                oi_mismatch.append(
                    f"{label} ours {int(chain.oi[i]):,} theirs {int(their['oi']):,}")
            if their.get("last_price") and float(chain.ltp[i]) and \
                    not _close(float(chain.ltp[i]), float(their["last_price"]),
                               0.05, abs_=0.10):
                ltp_mismatch.append(
                    f"{label} ours {chain.ltp[i]:.2f} theirs {their['last_price']:.2f}")

            their_iv = their.get("implied_volatility")
            if their_iv and not np.isnan(chain.iv[i]):
                # Theirs is a percentage, ours a fraction.
                iv_diffs.append(float(chain.iv[i]) * 100.0 - float(their_iv))
            their_d = (their.get("greeks") or {}).get("delta")
            if their_d and not np.isnan(chain.delta[i]):
                delta_diffs.append(float(chain.delta[i]) - float(their_d))

    if not matched:
        rep.skip("dhan", "no overlapping legs with data near the money")
        return rep

    rep.add(f"legs compared near the money ({band} strikes each side)",
            matched > 0, matched)
    rep.add("open interest agrees with Dhan", not oi_mismatch,
            detail=("; ".join(oi_mismatch[:3]) if oi_mismatch else "all within 2%"))
    rep.add("last price agrees with Dhan", not ltp_mismatch,
            detail=("; ".join(ltp_mismatch[:3]) if ltp_mismatch
                    else "all within 5%"))

    # Judged on the MEAN, with the worst case reported but not failing.
    #
    # Not a loosened threshold - a different question. Our chain is assembled
    # from ticks over a collection window; Dhan's is a snapshot at one instant.
    # Individual legs therefore differ by timing alone, and the worst case is
    # dominated by whichever leg last traded longest ago. A systematic MEAN
    # offset is the thing that would indicate a wrong forward, rate or model,
    # and it is the statistic worth gating on.
    #
    # Measured 2026-09-25 against Dhan: IV mean +0.21 vol points, delta mean
    # +0.027, with our parity forward beating both Dhan's spot (+0.59 / -0.040)
    # and the near futures (+0.32 / +0.028) as the underlying.
    if iv_diffs:
        worst = max(iv_diffs, key=abs)
        mean = sum(iv_diffs) / len(iv_diffs)
        rep.add("our IV agrees with Dhan's on average", abs(mean) <= 0.75,
                f"{len(iv_diffs)} legs",
                detail=f"mean {mean:+.2f} vol pts (worst leg {worst:+.2f})")
    if delta_diffs:
        worst = max(delta_diffs, key=abs)
        mean = sum(delta_diffs) / len(delta_diffs)
        rep.add("our delta agrees with Dhan's on average", abs(mean) <= 0.04,
                f"{len(delta_diffs)} legs",
                detail=f"mean {mean:+.4f} (worst leg {worst:+.4f})")
    return rep
