"""TCS2 - implied volatility and Greeks, vectorised over a whole chain.

Spec: docs/systems/14_tcs2.md  (D12, D25, D27)

Dhan sends neither IV nor any Greek, so every one of them is computed here from
the premium, the underlying, the strike and the time left. Volume, OI and the
book all arrive in the tick and are NOT computed (D25).

Two models, because the two exchanges are genuinely different:

  * **MCX uses Black-76.** Crude and gas options are written ON A FUTURES
    CONTRACT (D11), so the underlying is the futures price and there is no
    cost-of-carry term.
  * **NSE uses Black-Scholes on SPOT.** Measured 2026-09-18: nifty futures trade
    20-33 points above spot near expiry and up to ~88 earlier in the cycle, yet
    **weekly options price around spot, not futures**. Pricing NSE options off
    the futures would therefore bias every IV and every delta.

No scipy: only numpy is a declared dependency, so the normal CDF is implemented
here and its accuracy is pinned by a test against `math.erf`.
"""
from __future__ import annotations

import numpy as np

# Risk-free rate. Matches what the research code has used throughout, so an IV
# computed here is comparable with one computed there.
DEFAULT_RATE = 0.065

MIN_SIGMA = 1e-4
MAX_SIGMA = 5.0
MIN_T = 1e-8

ArrayLike = np.ndarray | float


def _ndtr(x: np.ndarray) -> np.ndarray:
    """Standard normal CDF, vectorised, numpy only.

    Abramowitz & Stegun 7.1.26 applied to erf, with the sign folded so the tail
    is evaluated on the positive side. Absolute error < 1.5e-7, which is far
    below the bid-ask noise on any option we price, and is asserted in
    `test_greeks.py::test_ndtr_matches_math_erf`.
    """
    x = np.asarray(x, dtype=np.float64)
    z = x / np.sqrt(2.0)
    sign = np.sign(z)
    a = np.abs(z)
    t = 1.0 / (1.0 + 0.3275911 * a)
    poly = t * (0.254829592 + t * (-0.284496736 + t * (
        1.421413741 + t * (-1.453152027 + t * 1.061405429))))
    erf = sign * (1.0 - poly * np.exp(-a * a))
    return 0.5 * (1.0 + erf)


def _npdf(x: np.ndarray) -> np.ndarray:
    return np.exp(-0.5 * x * x) / np.sqrt(2.0 * np.pi)


def _d1_d2(fwd: np.ndarray, strike: np.ndarray, t: np.ndarray,
           sigma: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    sigma = np.clip(sigma, MIN_SIGMA, MAX_SIGMA)
    t = np.maximum(t, MIN_T)
    vol_t = sigma * np.sqrt(t)
    d1 = (np.log(fwd / strike) + 0.5 * sigma * sigma * t) / vol_t
    return d1, d1 - vol_t, vol_t


def price_and_greeks(underlying: ArrayLike, strike: ArrayLike, t_years: ArrayLike,
                     sigma: ArrayLike, is_call: ArrayLike,
                     on_futures: bool, rate: float = DEFAULT_RATE) -> dict:
    """Theoretical price and Greeks for a whole chain at once.

    `on_futures=True` selects Black-76 (MCX, options on futures);
    `on_futures=False` selects Black-Scholes on spot (NSE index options).

    Greeks are returned per unit of underlying move, per calendar day for theta,
    and per 1.00 (i.e. 100 vol points) for vega - the caller scales if it wants
    "per 1% vol".
    """
    u = np.asarray(underlying, dtype=np.float64)
    k = np.asarray(strike, dtype=np.float64)
    t = np.maximum(np.asarray(t_years, dtype=np.float64), MIN_T)
    s = np.asarray(sigma, dtype=np.float64)
    call = np.asarray(is_call, dtype=bool)

    # Black-76 discounts the whole payoff and carries the forward directly.
    # Black-Scholes on spot grows spot to the forward at the risk-free rate.
    df = np.exp(-rate * t)
    fwd = u if on_futures else u * np.exp(rate * t)

    d1, d2, vol_t = _d1_d2(fwd, k, t, s)
    nd1, nd2 = _ndtr(d1), _ndtr(d2)
    pdf_d1 = _npdf(d1)

    call_px = df * (fwd * nd1 - k * nd2)
    put_px = df * (k * _ndtr(-d2) - fwd * _ndtr(-d1))
    px = np.where(call, call_px, put_px)

    # Delta is with respect to the quantity actually quoted: the futures price on
    # MCX, the spot index on NSE. For Black-Scholes that drops the discount
    # factor, which is why the two branches differ rather than sharing a formula.
    if on_futures:
        delta = np.where(call, df * nd1, df * (nd1 - 1.0))
        gamma = df * pdf_d1 / (fwd * np.clip(s, MIN_SIGMA, MAX_SIGMA) * np.sqrt(t))
    else:
        delta = np.where(call, nd1, nd1 - 1.0)
        gamma = pdf_d1 / (u * np.clip(s, MIN_SIGMA, MAX_SIGMA) * np.sqrt(t))

    vega = df * fwd * pdf_d1 * np.sqrt(t)
    theta_year = -df * fwd * pdf_d1 * np.clip(s, MIN_SIGMA, MAX_SIGMA) / (2.0 * np.sqrt(t))
    return {
        "price": px,
        "delta": delta,
        "gamma": gamma,
        "vega": vega,
        "theta": theta_year / 365.0,      # per calendar day
    }


def intrinsic(underlying: ArrayLike, strike: ArrayLike, is_call: ArrayLike,
              t_years: ArrayLike = 0.0, on_futures: bool = False,
              rate: float = DEFAULT_RATE) -> np.ndarray:
    """No-arbitrage lower bound on the premium.

    Model-aware on purpose. Under Black-76 the whole payoff is discounted, so a
    deep in-the-money option legitimately trades BELOW `F - K`; comparing it to
    an undiscounted intrinsic would flag correct prices as arbitrage.
    """
    u = np.asarray(underlying, dtype=np.float64)
    k = np.asarray(strike, dtype=np.float64)
    call = np.asarray(is_call, dtype=bool)
    t = np.maximum(np.asarray(t_years, dtype=np.float64), 0.0)
    raw = np.where(call, np.maximum(u - k, 0.0), np.maximum(k - u, 0.0))
    if on_futures:
        return raw * np.exp(-rate * t)
    return raw


def implied_vol(market_price: ArrayLike, underlying: ArrayLike, strike: ArrayLike,
                t_years: ArrayLike, is_call: ArrayLike, on_futures: bool,
                rate: float = DEFAULT_RATE, newton_iters: int = 12,
                bisect_iters: int = 60, tol: float = 1e-8,
                vol_tol: float = 1e-7, min_vega_frac: float = 1e-7) -> np.ndarray:
    """Implied vol for a whole chain. NaN where no solution exists.

    Newton first, because it converges in a few iterations near the money. Then
    **bisection for whatever Newton failed on** - which is not a nicety: vega
    collapses toward zero on far strikes, so Newton's step explodes and it
    silently returns nonsense. A Newton-only trial on 2026-09-24 was wrong by
    0.17 vol points on far strikes; with the fallback the error below is ~1e-12.

    Returns NaN, never a wrong number, when:
      * time to expiry has passed,
      * the premium is at or below intrinsic (no time value to imply from),
      * the premium is above the theoretical maximum,
      * **the premium carries no volatility information at all.** Measured on a
        7-day nifty chain: at strike 29,000 with spot 23,476 and vol 0.10 the
        price is 0.0000 and vega is 0.0000, so a one-paisa pricing difference
        implies a vol error of 1e10. Any number returned there would be an
        artefact of float noise. Controlled by `min_vega_frac`.

    Convergence is judged in VOL space, not price space. `|price error| / vega`
    is the vol error that a given price error corresponds to, and on a far strike
    a price residual well inside tolerance can still hide a vol error of 3e-4 -
    which is exactly what a price-based check let through on the first attempt.
    """
    p = np.asarray(market_price, dtype=np.float64)
    u = np.asarray(underlying, dtype=np.float64)
    k = np.asarray(strike, dtype=np.float64)
    t = np.asarray(t_years, dtype=np.float64)
    call = np.asarray(is_call, dtype=bool)
    p, u, k, t, call = np.broadcast_arrays(p, u, k, t, call)
    p, u, k, t = (np.array(x, dtype=np.float64) for x in (p, u, k, t))
    call = np.array(call, dtype=bool)

    out = np.full(p.shape, np.nan, dtype=np.float64)

    lo_px = price_and_greeks(u, k, t, np.full(p.shape, MIN_SIGMA), call,
                             on_futures, rate)["price"]
    hi_px = price_and_greeks(u, k, t, np.full(p.shape, MAX_SIGMA), call,
                             on_futures, rate)["price"]

    ok = (t > MIN_T) & (p > 0.0) & np.isfinite(p) & (p > lo_px + tol) & (p < hi_px - tol)
    if not ok.any():
        return out

    pu, pk, pt, pc, pp = u[ok], k[ok], t[ok], call[ok], p[ok]

    # Newton, started from a vol that is sane for index options.
    sig = np.full(pp.shape, 0.25)
    for _ in range(newton_iters):
        g = price_and_greeks(pu, pk, pt, sig, pc, on_futures, rate)
        diff = g["price"] - pp
        step = diff / np.maximum(g["vega"], 1e-12)
        sig = np.clip(sig - step, MIN_SIGMA, MAX_SIGMA)

    # Judge Newton in VOL space: a price residual divided by vega IS the vol
    # error it corresponds to. Checking the price residual alone passes legs
    # whose vol is still wrong by orders of magnitude more than the tolerance.
    g_at = price_and_greeks(pu, pk, pt, sig, pc, on_futures, rate)
    vol_err = np.abs(g_at["price"] - pp) / np.maximum(g_at["vega"], 1e-300)
    bad = ~(vol_err <= vol_tol)

    # Bisection on the rest. Price rises monotonically with vol, so the bracket
    # [MIN_SIGMA, MAX_SIGMA] is guaranteed to contain the root for every leg that
    # passed the `ok` filter above - which is what makes this a fallback that
    # cannot itself fail, unlike Newton.
    if bad.any():
        lo = np.full(int(bad.sum()), MIN_SIGMA)
        hi = np.full(int(bad.sum()), MAX_SIGMA)
        bu, bk, bt, bc, bp = pu[bad], pk[bad], pt[bad], pc[bad], pp[bad]
        for _ in range(bisect_iters):
            mid = 0.5 * (lo + hi)
            px = price_and_greeks(bu, bk, bt, mid, bc, on_futures, rate)["price"]
            too_low = px < bp
            lo = np.where(too_low, mid, lo)
            hi = np.where(too_low, hi, mid)
        sig[bad] = 0.5 * (lo + hi)

    # Refuse to report a vol the premium cannot actually identify. Vega is the
    # price change per unit of vol; when it is negligible against the underlying,
    # every vol in a wide range produces the same quoted price and any single
    # answer would be float noise dressed up as a measurement.
    final = price_and_greeks(pu, pk, pt, sig, pc, on_futures, rate)
    identifiable = final["vega"] > min_vega_frac * np.maximum(pu, 1.0)
    sig = np.where(identifiable, sig, np.nan)

    out[ok] = sig
    return out


def year_fraction(now_epoch: float, expiry_epoch: float) -> float:
    """Time to expiry in years, floored at zero."""
    return max(0.0, (expiry_epoch - now_epoch) / (365.0 * 24 * 3600.0))


def forward_from_parity(strikes: ArrayLike, call_px: ArrayLike, put_px: ArrayLike,
                        spot: float, t_years: float, rate: float = DEFAULT_RATE,
                        max_strikes: int = 8) -> float:
    """The forward the option market is actually pricing, by put-call parity.

    `C - P = df * (F - K)`, so every strike quoting both sides gives its own
    reading of F. The median of the strikes nearest the money is taken, because
    parity is exact only where both legs are liquid and a single wide quote far
    from the money would otherwise drag the answer.

    **Why this is derived rather than assumed.** Forcing `F = spot * e^(rT)`
    conflicts with the market: at spot 23,500, r 6.5% and 11 days that forward is
    23,546, which puts the no-arbitrage floor for the 23,400 call at 145.8 - so a
    real premium of 132.5 has no implied vol at all and every in-the-money call
    returns NaN. Measured 2026-09-18, NSE weekly options price around spot rather
    than the futures, so the rate-implied forward is simply the wrong number.
    Reading F out of the option prices sidesteps the question for both exchanges.

    Returns `spot` unchanged when no strike quotes both sides.
    """
    k = np.asarray(strikes, dtype=np.float64)
    c = np.asarray(call_px, dtype=np.float64)
    p = np.asarray(put_px, dtype=np.float64)
    both = (c > 0) & (p > 0) & np.isfinite(c) & np.isfinite(p)
    if not both.any() or t_years <= MIN_T:
        return float(spot)
    k, c, p = k[both], c[both], p[both]
    near = np.argsort(np.abs(k - spot))[:max_strikes]
    fwd = k[near] + (c[near] - p[near]) * np.exp(rate * t_years)
    return float(np.median(fwd))
