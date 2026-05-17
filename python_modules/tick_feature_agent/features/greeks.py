"""
greeks.py — Wave 1: ATM IV surface + Black-Scholes greeks (Phase 1A Layer 1).

Pure function. Reads ATM strike CE/PE IV from the chain snapshot and
computes Greeks via Black-Scholes (calendar days, RBI repo 6.5%, no
dividends, no early-exercise — European style, matching Indian index
+ commodity options).

Features (9 outputs):
    atm_ce_iv          ATM CE implied volatility (decimal, e.g. 0.18)
    atm_pe_iv          ATM PE implied volatility (decimal)
    iv_skew_atm        atm_pe_iv - atm_ce_iv (>0 = put skew = bearish)
    atm_ce_delta       ∂C/∂S — sensitivity of CE to underlying ($1 move → $delta in option)
    atm_pe_delta       ∂P/∂S — typically negative for PE
    atm_gamma          ∂²C/∂S² — same for CE and PE (single output)
    atm_ce_theta       Time decay per calendar DAY (negative for long option)
    atm_pe_theta       Time decay per calendar DAY
    atm_vega           Sensitivity to 1% IV change in option ₹ (same for CE/PE)

Why these:
    - Delta tells per-leg sensitivity → accurate per-leg PnL prediction
    - Gamma tells stability near strike → high gamma = volatile near ATM
    - Theta tells cost-of-holding per day → exit timing
    - Vega tells IV exposure → important for short-premium trades
    - IV directly tells market-expected move size

Null rules:
    Any required input missing/invalid (None, NaN, ≤0 for spot/strike/T,
    IV not in (0, 5)) → NaN for the affected output.
"""

from __future__ import annotations

import math

_NAN = float("nan")
_DEFAULT_RFR = 0.065  # RBI repo rate (decimal)
_SQRT_2PI = math.sqrt(2.0 * math.pi)


# ── Standard normal CDF / PDF (no scipy dep) ──────────────────────────────


def _norm_cdf(x: float) -> float:
    """Standard normal CDF using erf — accurate to ~1e-15."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    """Standard normal PDF."""
    return math.exp(-0.5 * x * x) / _SQRT_2PI


# ── Black-Scholes greeks ──────────────────────────────────────────────────


def bs_greeks(
    spot: float,
    strike: float,
    sigma: float,
    t_years: float,
    rfr: float,
    is_call: bool,
) -> tuple[float, float, float, float]:
    """
    Return (delta, gamma, theta_per_day, vega_per_1pct).

    All inputs assumed pre-validated as finite, positive (where required).
    Public so feature modules that aggregate Greeks across the chain
    (e.g. dealer_hedging) can reuse the same Black-Scholes core.
    """
    sqrt_t = math.sqrt(t_years)
    sigma_sqrt_t = sigma * sqrt_t
    if sigma_sqrt_t <= 0:
        return _NAN, _NAN, _NAN, _NAN

    d1 = (math.log(spot / strike) + (rfr + 0.5 * sigma * sigma) * t_years) / sigma_sqrt_t
    d2 = d1 - sigma_sqrt_t
    pdf_d1 = _norm_pdf(d1)
    cdf_d1 = _norm_cdf(d1)
    cdf_d2 = _norm_cdf(d2)
    discount = math.exp(-rfr * t_years)

    if is_call:
        delta = cdf_d1
        # Theta per YEAR, convert to per DAY by /365
        theta_year = -spot * pdf_d1 * sigma / (2.0 * sqrt_t) - rfr * strike * discount * cdf_d2
    else:
        delta = cdf_d1 - 1.0
        theta_year = -spot * pdf_d1 * sigma / (2.0 * sqrt_t) + rfr * strike * discount * _norm_cdf(-d2)

    gamma = pdf_d1 / (spot * sigma_sqrt_t)
    # Vega per 1.00 change in sigma (i.e., 100% IV change). Convert to per
    # 1% IV change (the way it's quoted) by /100.
    vega_per_1pct = spot * pdf_d1 * sqrt_t / 100.0
    theta_per_day = theta_year / 365.0

    return delta, gamma, theta_per_day, vega_per_1pct


# ── Public API ────────────────────────────────────────────────────────────


def _safe_pos(v: float | None) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0:
        return None
    return f


def _safe_iv_pct(v: float | None) -> float | None:
    """IV as received from Dhan (in percent, e.g. 18.5). Sanity range: (0, 500)."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0 or f >= 500.0:
        return None
    return f


def compute_greek_features(
    spot: float | None,
    atm_strike: float | None,
    atm_ce_iv_pct: float | None,
    atm_pe_iv_pct: float | None,
    days_to_expiry: float | None,
    risk_free_rate: float = _DEFAULT_RFR,
) -> dict[str, float]:
    """
    Compute 9 IV + Greek features for the ATM strike.

    Args:
        spot:             Current underlying spot price.
        atm_strike:       ATM strike (computed by chain_cache).
        atm_ce_iv_pct:    Dhan-reported CE IV in PERCENT (e.g. 18.5, not 0.185).
        atm_pe_iv_pct:    Same for PE.
        days_to_expiry:   Calendar days to expiry (can be fractional, e.g. 0.5).
        risk_free_rate:   Annualized rate, decimal. Default 6.5% (RBI repo).

    Returns:
        Dict with 9 keys, all floats. NaN where input is missing.
    """
    out: dict[str, float] = {
        "atm_ce_iv": _NAN,
        "atm_pe_iv": _NAN,
        "iv_skew_atm": _NAN,
        "atm_ce_delta": _NAN,
        "atm_pe_delta": _NAN,
        "atm_gamma": _NAN,
        "atm_ce_theta": _NAN,
        "atm_pe_theta": _NAN,
        "atm_vega": _NAN,
    }

    spot_v = _safe_pos(spot)
    strike_v = _safe_pos(atm_strike)
    dte_v = days_to_expiry
    if dte_v is None or not math.isfinite(dte_v) or dte_v <= 0:
        # Cannot compute greeks at expiry or post-expiry; surface IV only
        # if available
        ce_iv = _safe_iv_pct(atm_ce_iv_pct)
        pe_iv = _safe_iv_pct(atm_pe_iv_pct)
        if ce_iv is not None:
            out["atm_ce_iv"] = ce_iv / 100.0
        if pe_iv is not None:
            out["atm_pe_iv"] = pe_iv / 100.0
        if ce_iv is not None and pe_iv is not None:
            out["iv_skew_atm"] = (pe_iv - ce_iv) / 100.0
        return out

    ce_iv_pct = _safe_iv_pct(atm_ce_iv_pct)
    pe_iv_pct = _safe_iv_pct(atm_pe_iv_pct)

    # Surface IVs (decimal form)
    if ce_iv_pct is not None:
        out["atm_ce_iv"] = ce_iv_pct / 100.0
    if pe_iv_pct is not None:
        out["atm_pe_iv"] = pe_iv_pct / 100.0
    if ce_iv_pct is not None and pe_iv_pct is not None:
        out["iv_skew_atm"] = (pe_iv_pct - ce_iv_pct) / 100.0

    # Greeks require spot, strike, IV, T
    if spot_v is None or strike_v is None:
        return out

    t_years = dte_v / 365.0

    # CE greeks
    if ce_iv_pct is not None:
        sigma_ce = ce_iv_pct / 100.0
        delta, gamma, theta_d, vega = bs_greeks(
            spot_v, strike_v, sigma_ce, t_years, risk_free_rate, is_call=True,
        )
        out["atm_ce_delta"] = delta
        out["atm_ce_theta"] = theta_d
        # Gamma + Vega taken from CE leg as canonical (they're math-identical
        # to PE at same strike+IV; we publish single fields for both)
        out["atm_gamma"] = gamma
        out["atm_vega"] = vega

    # PE greeks (delta + theta differ; gamma + vega already published)
    if pe_iv_pct is not None:
        sigma_pe = pe_iv_pct / 100.0
        delta, _gamma, theta_d, _vega = bs_greeks(
            spot_v, strike_v, sigma_pe, t_years, risk_free_rate, is_call=False,
        )
        out["atm_pe_delta"] = delta
        out["atm_pe_theta"] = theta_d
        # If CE IV was missing but PE IV is present, use PE for gamma/vega
        if math.isnan(out["atm_gamma"]):
            out["atm_gamma"] = _gamma
        if math.isnan(out["atm_vega"]):
            out["atm_vega"] = _vega

    return out
