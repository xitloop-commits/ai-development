"""
dealer_hedging.py — C4 dealer-hedging / GEX features (spec §2.1.4 C4).

Pure function. Reads the latest chain snapshot rows plus a small history
of ATM-Greek snapshots and emits 5 features describing where dealer
hedging flow is positioned relative to spot.

Features (5 outputs):
    net_gex                    Σ_strikes [γ_call·OI_call − γ_put·OI_put] · S²
                               Positive = dealers net long gamma (stabilising:
                               sells rallies, buys dips → mean-reverting).
                               Negative = dealers net short gamma (amplifying:
                               buys rallies, sells dips → trend-extending).
    gamma_flip_distance_pct    Signed % distance from spot to the strike at
                               which cumulative net gamma crosses zero.
                               +ve = flip is above spot, −ve = below.
                               NaN if no crossover exists in the strike grid.
    dealer_net_delta           Σ_strikes [Δ_call·OI_call + Δ_put·OI_put].
                               Put Δ is negative, so this self-signs.
    charm_estimate_atm         Finite-difference proxy for charm:
                               (atm_ce_delta_now − atm_ce_delta_5min_ago) / 300.
                               Units: Δ per second. Captures how dealer
                               directional hedge rotates as time decays.
    vanna_estimate_atm         Finite-difference proxy for vanna:
                               Δ(atm_ce_delta) / Δ(atm_ce_iv) over the
                               same 5-min window. NaN when |Δiv| is too
                               small to give a stable slope.

Why "_estimate" for charm + vanna:
    Closed-form Black-Scholes charm/vanna are exact but sensitive to IV
    inputs; what actually drives dealer behaviour is the OBSERVED rate
    of change of the hedge requirement. Finite-difference captures that
    directly and stays robust to micro-IV-noise.

Inputs:
    rows: chain snapshot rows (one per strike) — same shape as
          ChainSnapshot.rows used by chain_cache: each row carries
          strike / callOI / putOI / callIV / putIV (IV in PERCENT, Dhan
          convention — same as features/greeks.py).
    atm_delta_history: list[(ts, atm_ce_delta, atm_ce_iv_decimal)],
                       sorted oldest → newest. Caller maintains this in
                       a 5-min ring; samples beyond the window are
                       ignored. atm_ce_iv is in DECIMAL form (0.18, not
                       18.0) so the units match `atm_ce_iv` already in
                       the feature vector.

Null rules:
    Any per-strike Greek computation that fails (invalid IV, dte ≤ 0)
    is skipped — the aggregation still produces a value from the valid
    strikes. If ZERO strikes contribute, the aggregate is NaN.
    charm / vanna estimates require a 5-min-old sample within 60 s of
    target; otherwise NaN.
    vanna additionally requires |Δiv| ≥ 0.001 (0.1 vol points) to keep
    the slope numerically stable.
"""

from __future__ import annotations

import math

from tick_feature_agent.features.greeks import bs_greeks

_NAN = float("nan")
_DEFAULT_RFR = 0.065
_FIVE_MIN_SEC = 300.0
_BASELINE_TOLERANCE_SEC = 60.0
_MIN_DELTA_IV_FOR_VANNA = 0.001  # 0.1 vol points


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
    """Dhan IV is in percent; sanity range (0, 500)."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0 or f >= 500.0:
        return None
    return f


def _safe_oi(v) -> float | None:
    """OI must be a non-negative finite number."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f < 0:
        return None
    return f


def _per_strike_greeks(
    spot: float,
    strike: float,
    iv_pct: float | None,
    t_years: float,
    rfr: float,
    is_call: bool,
) -> tuple[float, float] | None:
    """Return (delta, gamma) for a single strike, or None if invalid."""
    iv_v = _safe_iv_pct(iv_pct)
    if iv_v is None:
        return None
    sigma = iv_v / 100.0
    delta, gamma, _theta, _vega = bs_greeks(
        spot, strike, sigma, t_years, rfr, is_call=is_call,
    )
    if not (math.isfinite(delta) and math.isfinite(gamma)):
        return None
    return delta, gamma


def compute_dealer_hedging_features(
    spot: float | None,
    rows: list[dict] | None,
    days_to_expiry: float | None,
    atm_delta_history: list[tuple[float, float, float]] | None,
    now_ts: float | None,
    risk_free_rate: float = _DEFAULT_RFR,
) -> dict[str, float]:
    """
    Compute the 5 C4 dealer-hedging features.

    Args:
        spot:               Current underlying spot price.
        rows:               Chain snapshot rows (ChainSnapshot.rows shape).
        days_to_expiry:     Calendar days to expiry (fractional ok).
        atm_delta_history:  [(ts, atm_ce_delta, atm_ce_iv_decimal), ...]
                            sorted oldest → newest.
        now_ts:             Current epoch second (for charm / vanna lookup).
        risk_free_rate:     Annualized rfr, decimal. Default 6.5%.

    Returns:
        Dict of 5 float features. NaN where input insufficient.
    """
    out: dict[str, float] = {
        "net_gex": _NAN,
        "gamma_flip_distance_pct": _NAN,
        "dealer_net_delta": _NAN,
        "charm_estimate_atm": _NAN,
        "vanna_estimate_atm": _NAN,
    }

    spot_v = _safe_pos(spot)
    dte_v = days_to_expiry
    rows_ok = bool(rows)
    dte_ok = dte_v is not None and math.isfinite(dte_v) and dte_v > 0

    # ── Chain-aggregate features (net_gex, gamma_flip, dealer_net_delta) ──
    if spot_v is not None and rows_ok and dte_ok:
        t_years = dte_v / 365.0
        s_squared = spot_v * spot_v

        # Per-strike pass: collect (strike, net_gamma_contrib, net_delta_contrib).
        per_strike: list[tuple[float, float, float]] = []
        net_gex_sum = 0.0
        net_delta_sum = 0.0
        n_valid = 0

        for row in rows:
            strike_v = _safe_pos(row.get("strike"))
            if strike_v is None:
                continue
            call_oi = _safe_oi(row.get("callOI"))
            put_oi = _safe_oi(row.get("putOI"))

            call_gk = _per_strike_greeks(
                spot_v, strike_v, row.get("callIV"), t_years, risk_free_rate, is_call=True,
            )
            put_gk = _per_strike_greeks(
                spot_v, strike_v, row.get("putIV"), t_years, risk_free_rate, is_call=False,
            )

            gamma_contrib = 0.0
            delta_contrib = 0.0
            counted = False

            if call_gk is not None and call_oi is not None:
                c_delta, c_gamma = call_gk
                gamma_contrib += c_gamma * call_oi
                delta_contrib += c_delta * call_oi
                counted = True
            if put_gk is not None and put_oi is not None:
                p_delta, p_gamma = put_gk
                # Dealer GEX convention: subtract put gamma exposure.
                gamma_contrib -= p_gamma * put_oi
                delta_contrib += p_delta * put_oi  # p_delta < 0
                counted = True

            if counted:
                per_strike.append((strike_v, gamma_contrib, delta_contrib))
                net_gex_sum += gamma_contrib * s_squared
                net_delta_sum += delta_contrib
                n_valid += 1

        if n_valid > 0:
            out["net_gex"] = net_gex_sum
            out["dealer_net_delta"] = net_delta_sum

            # Gamma flip: sweep strikes in order; find the strike where the
            # CUMULATIVE running net gamma first crosses zero. That strike
            # marks the transition from net-short-gamma below to
            # net-long-gamma above (or vice versa).
            per_strike.sort(key=lambda x: x[0])
            cum = 0.0
            prev_cum = 0.0
            prev_strike = None
            flip_strike: float | None = None
            for k, g_contrib, _d_contrib in per_strike:
                prev_cum = cum
                cum += g_contrib
                if prev_strike is not None and (
                    (prev_cum < 0 and cum >= 0) or (prev_cum > 0 and cum <= 0)
                ):
                    # Linear interpolate the strike where cum == 0.
                    span = cum - prev_cum
                    if span != 0:
                        frac = -prev_cum / span
                        flip_strike = prev_strike + frac * (k - prev_strike)
                    else:
                        flip_strike = k
                    break
                prev_strike = k

            if flip_strike is not None and spot_v > 0:
                out["gamma_flip_distance_pct"] = (flip_strike - spot_v) / spot_v * 100.0

    # ── Finite-difference charm / vanna ───────────────────────────────────
    now_v = now_ts
    if now_v is None or not isinstance(now_v, (int, float)) or not math.isfinite(now_v):
        return out
    if not atm_delta_history:
        return out

    # Current sample = latest entry at-or-before now_ts with finite values.
    current: tuple[float, float, float] | None = None
    for ts, d, iv in reversed(atm_delta_history):
        if not (isinstance(ts, (int, float)) and math.isfinite(ts) and ts <= now_v):
            continue
        if not (math.isfinite(d) and math.isfinite(iv)):
            continue
        current = (float(ts), float(d), float(iv))
        break
    if current is None:
        return out
    cur_ts, cur_delta, cur_iv = current

    # Baseline = latest sample at-or-before (now − 300s), within tolerance.
    target_ts = now_v - _FIVE_MIN_SEC
    baseline: tuple[float, float, float] | None = None
    for ts, d, iv in reversed(atm_delta_history):
        if not (isinstance(ts, (int, float)) and math.isfinite(ts) and ts <= target_ts):
            continue
        if target_ts - ts > _BASELINE_TOLERANCE_SEC:
            break
        if not (math.isfinite(d) and math.isfinite(iv)):
            break
        baseline = (float(ts), float(d), float(iv))
        break
    if baseline is None:
        return out
    base_ts, base_delta, base_iv = baseline

    dt = cur_ts - base_ts
    if dt > 0:
        out["charm_estimate_atm"] = (cur_delta - base_delta) / dt

    d_iv = cur_iv - base_iv
    if abs(d_iv) >= _MIN_DELTA_IV_FOR_VANNA:
        out["vanna_estimate_atm"] = (cur_delta - base_delta) / d_iv

    return out
