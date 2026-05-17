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

C9 IV velocity (compute_iv_velocity_features):
    Adds 4 features describing how ATM IV is *moving* (not just where it
    sits). Lets the trend/swing gate distinguish drifting IV from
    exploding IV and from panic-without-spot-move:
        iv_change_1min               Change in ATM CE IV over 1 min (decimal)
        iv_change_5min               Same over 5 min
        iv_skew_velocity             Δ(atm_pe_iv − atm_ce_iv) over 5 min
        iv_expansion_without_spot    max(|Δce|, |Δpe|) / |Δspot %| over 5 min
                                     — NaN when |Δspot %| < 0.05% to keep
                                     the ratio numerically stable.
    Operates on a caller-maintained history buffer of
    (ts, atm_ce_iv_decimal, atm_pe_iv_decimal, spot) snapshots, the
    same shape india_vix.py / dealer_hedging.py expect.
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


# ── C9 IV velocity ────────────────────────────────────────────────────────

_ONE_MIN_SEC = 60.0
_FIVE_MIN_SEC = 300.0
_BASELINE_TOLERANCE_SEC = 60.0
_MIN_SPOT_PCT_FOR_EXPANSION = 0.05  # 5 bps — below this the ratio is unstable


def _safe_iv_decimal(v) -> float | None:
    """ATM IV in DECIMAL form (e.g. 0.18). Sanity range: (0, 5)."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0 or f >= 5.0:
        return None
    return f


def _safe_finite(v) -> float | None:
    """Generic finite-float coercion. Used for ts + spot in the history."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return f


def _latest_at_or_before(
    iv_history: list[tuple[float, float, float, float]],
    target_ts: float,
    tolerance_sec: float | None,
) -> tuple[float, float, float, float] | None:
    """
    Walk `iv_history` newest → oldest and return the first row whose ts is
    finite, > 0, ≤ target_ts, and whose ce_iv / pe_iv / spot are all valid.

    If `tolerance_sec` is not None, also require (target_ts − ts) ≤ tolerance.
    When the freshest candidate is beyond tolerance we stop scanning — older
    rows can only be staler, so a hit upstream is impossible.

    Rows with invalid fields are skipped silently (consistent with
    india_vix.py).
    """
    for ts, ce_iv, pe_iv, spot in reversed(iv_history):
        ts_v = _safe_finite(ts)
        if ts_v is None or ts_v <= 0 or ts_v > target_ts:
            continue
        if tolerance_sec is not None and (target_ts - ts_v) > tolerance_sec:
            # The newest candidate we can reach is already too stale; older
            # rows are even staler, so abandon the search.
            return None
        ce_v = _safe_iv_decimal(ce_iv)
        pe_v = _safe_iv_decimal(pe_iv)
        spot_v = _safe_finite(spot)
        if ce_v is None or pe_v is None or spot_v is None or spot_v <= 0:
            # Row is corrupt; keep scanning further back.
            continue
        return ts_v, ce_v, pe_v, spot_v
    return None


def compute_iv_velocity_features(
    iv_history: list[tuple[float, float, float, float]] | None,
    now_ts: float | None,
) -> dict[str, float]:
    """
    Compute the 4 C9 IV-velocity features.

    Args:
        iv_history: list of (ts_epoch_seconds, atm_ce_iv_decimal,
                    atm_pe_iv_decimal, underlying_spot) sorted oldest →
                    newest. All four fields per row; rows with any
                    missing / non-finite field are skipped silently.
                    IV is DECIMAL (0.18, not 18.0) — matches the
                    `atm_ce_iv` / `atm_pe_iv` already published by
                    compute_greek_features().
        now_ts:     current epoch second.

    Returns:
        Dict with 4 float keys:
            iv_change_1min               Δ atm_ce_iv over 1 min
            iv_change_5min               Δ atm_ce_iv over 5 min
            iv_skew_velocity             Δ (atm_pe_iv − atm_ce_iv) over 5 min
            iv_expansion_without_spot    max(|Δce_5m|, |Δpe_5m|) / |Δspot %|
                                         NaN when |Δspot %| < 0.05%.

    Null rules:
        - history None / empty                 → all 4 NaN.
        - now_ts invalid                       → all 4 NaN.
        - no current row at-or-before now_ts   → all 4 NaN.
        - 1-min baseline missing / stale       → iv_change_1min NaN
                                                 (5-min outputs may still
                                                 compute).
        - 5-min baseline missing / stale       → iv_change_5min,
                                                 iv_skew_velocity,
                                                 iv_expansion_without_spot
                                                 all NaN.
        - 5-min |Δspot %| < 0.05%              → iv_expansion_without_spot
                                                 NaN.
    """
    out: dict[str, float] = {
        "iv_change_1min": _NAN,
        "iv_change_5min": _NAN,
        "iv_skew_velocity": _NAN,
        "iv_expansion_without_spot": _NAN,
    }

    now_v = _safe_finite(now_ts)
    if now_v is None or now_v <= 0 or not iv_history:
        return out

    # "current" = latest valid row at-or-before now_ts. No tolerance bound
    # on the current snapshot — the feature is dominated by the relative
    # change, not the freshness of the latest tick (caller decides how
    # stale "now" can be).
    current = _latest_at_or_before(iv_history, now_v, tolerance_sec=None)
    if current is None:
        return out
    _cur_ts, cur_ce, cur_pe, cur_spot = current

    # 1-minute baseline → iv_change_1min only.
    base_1m = _latest_at_or_before(
        iv_history,
        now_v - _ONE_MIN_SEC,
        tolerance_sec=_BASELINE_TOLERANCE_SEC,
    )
    if base_1m is not None:
        _b_ts, b_ce, _b_pe, _b_spot = base_1m
        out["iv_change_1min"] = cur_ce - b_ce

    # 5-minute baseline → iv_change_5min, iv_skew_velocity,
    # iv_expansion_without_spot all share this lookup.
    base_5m = _latest_at_or_before(
        iv_history,
        now_v - _FIVE_MIN_SEC,
        tolerance_sec=_BASELINE_TOLERANCE_SEC,
    )
    if base_5m is None:
        return out
    _b5_ts, b5_ce, b5_pe, b5_spot = base_5m

    d_ce = cur_ce - b5_ce
    d_pe = cur_pe - b5_pe
    out["iv_change_5min"] = d_ce
    # Δ(pe − ce) = Δpe − Δce; identical to (now_skew − base_skew).
    out["iv_skew_velocity"] = d_pe - d_ce

    # iv_expansion_without_spot: max IV expansion magnitude per 1% of
    # spot move. Big number = IV exploded while spot barely moved (panic
    # flow / event re-pricing).
    if b5_spot > 0:
        spot_pct_change = (cur_spot - b5_spot) / b5_spot * 100.0
        if math.isfinite(spot_pct_change) and abs(spot_pct_change) >= _MIN_SPOT_PCT_FOR_EXPANSION:
            iv_expansion = max(abs(d_ce), abs(d_pe))
            out["iv_expansion_without_spot"] = iv_expansion / abs(spot_pct_change)

    return out
