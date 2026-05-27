"""
features/dealer_hedging_columnar.py — T50 B.3d — numpy-vectorised dealer_hedging.

A drop-in replacement for ``dealer_hedging.compute_dealer_hedging_features``
that replaces the per-strike Python loop calling ``bs_greeks`` with one
numpy vectorised pass. Same input signature, same output dict shape,
same NaN guards — installed as a replay-only monkey-patch via
``max_pain_cache.install_dealer_hedging``. Live ``tick_processor``
keeps the scalar implementation untouched.

Win pattern (per-call, no cross-snapshot caching):
    Scalar: ~100 strikes × per-strike Python BS = ~1.5 ms per call
    Vectorised: ~100-element numpy arrays in one BS pass = ~0.15 ms
    -> ~10× per-call speedup, ~4s saved per full replay date.

charm_estimate_atm + vanna_estimate_atm use a 5-minute lookback in
``atm_delta_history``. That's already cheap (~3 Python iterations
per call) — we keep the scalar logic for those.
"""

from __future__ import annotations

import math

import numpy as np

_NAN = float("nan")
_DEFAULT_RFR = 0.065
_FIVE_MIN_SEC = 300.0
_BASELINE_TOLERANCE_SEC = 30.0
_MIN_DELTA_IV_FOR_VANNA = 0.005


def _safe_pos(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0:
        return None
    return f


def _safe_oi(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f < 0:
        return None
    return f


def _safe_iv_pct(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0 or f >= 500.0:
        return None
    return f


def _erf_vec(x: np.ndarray) -> np.ndarray:
    """Vectorised erf via scipy.special if available, fallback to math.erf."""
    try:
        from scipy.special import erf as _scipy_erf  # type: ignore[import-untyped]
        return _scipy_erf(x)
    except Exception:
        # numpy.vectorize is slow but correct — only used when scipy isn't
        # installed. Replay deps include scikit-learn -> scipy, so this
        # branch should rarely fire in production.
        return np.vectorize(math.erf, otypes=[np.float64])(x)


_SQRT_2 = math.sqrt(2.0)
_SQRT_2PI = math.sqrt(2.0 * math.pi)


def _norm_cdf_vec(x: np.ndarray) -> np.ndarray:
    return 0.5 * (1.0 + _erf_vec(x / _SQRT_2))


def _norm_pdf_vec(x: np.ndarray) -> np.ndarray:
    return np.exp(-0.5 * x * x) / _SQRT_2PI


def compute_dealer_hedging_features_vec(
    spot,
    rows,
    days_to_expiry,
    atm_delta_history,
    now_ts,
    risk_free_rate: float = _DEFAULT_RFR,
):
    """Vectorised dealer_hedging.compute_dealer_hedging_features.

    Same input signature + output dict shape as the scalar (5 keys).
    """
    out: dict[str, float] = {
        "net_gex": _NAN,
        "gamma_flip_distance_pct": _NAN,
        "dealer_net_delta": _NAN,
        "charm_estimate_atm": _NAN,
        "vanna_estimate_atm": _NAN,
    }

    spot_v = _safe_pos(spot)
    rows_ok = bool(rows)
    dte_ok = (
        days_to_expiry is not None
        and isinstance(days_to_expiry, (int, float))
        and math.isfinite(days_to_expiry)
        and days_to_expiry > 0
    )

    # ── Chain-aggregate features (net_gex, gamma_flip, dealer_net_delta) ──
    if spot_v is not None and rows_ok and dte_ok:
        t_years = float(days_to_expiry) / 365.0
        sqrt_t = math.sqrt(t_years)

        # Materialise per-strike inputs into arrays. Defensive validation
        # mirrors scalar's per-row guards: drop strikes with non-positive
        # strike value; bs_greeks needs (sigma * sqrt(t)) > 0 -> drop
        # rows where IV is invalid; OI must be finite + >= 0 to count.
        strike_list: list[float] = []
        c_oi_list: list[float] = []
        p_oi_list: list[float] = []
        c_iv_list: list[float] = []
        p_iv_list: list[float] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            sv = _safe_pos(row.get("strike"))
            if sv is None:
                continue
            strike_list.append(sv)
            c_oi_list.append(_safe_oi(row.get("callOI")) or _NAN)
            p_oi_list.append(_safe_oi(row.get("putOI")) or _NAN)
            c_iv_list.append(_safe_iv_pct(row.get("callIV")) or _NAN)
            p_iv_list.append(_safe_iv_pct(row.get("putIV")) or _NAN)

        if strike_list:
            K = np.asarray(strike_list, dtype=np.float64)
            cOI = np.asarray(c_oi_list, dtype=np.float64)
            pOI = np.asarray(p_oi_list, dtype=np.float64)
            cIV = np.asarray(c_iv_list, dtype=np.float64)
            pIV = np.asarray(p_iv_list, dtype=np.float64)

            S = float(spot_v)
            r = float(risk_free_rate)

            # Vectorised BS for call leg.
            sig_c = cIV / 100.0
            ssq_c = sig_c * sqrt_t
            valid_c = np.isfinite(sig_c) & (ssq_c > 0) & np.isfinite(cOI)

            # Suppress invalid-input warnings — masked out below.
            with np.errstate(invalid="ignore", divide="ignore"):
                d1_c = (np.log(S / K) + (r + 0.5 * sig_c * sig_c) * t_years) / ssq_c
                pdf_d1_c = _norm_pdf_vec(d1_c)
                cdf_d1_c = _norm_cdf_vec(d1_c)
                delta_c = cdf_d1_c
                gamma_c = pdf_d1_c / (S * ssq_c)

            valid_c &= np.isfinite(delta_c) & np.isfinite(gamma_c)

            # Vectorised BS for put leg.
            sig_p = pIV / 100.0
            ssq_p = sig_p * sqrt_t
            valid_p = np.isfinite(sig_p) & (ssq_p > 0) & np.isfinite(pOI)

            with np.errstate(invalid="ignore", divide="ignore"):
                d1_p = (np.log(S / K) + (r + 0.5 * sig_p * sig_p) * t_years) / ssq_p
                pdf_d1_p = _norm_pdf_vec(d1_p)
                cdf_d1_p = _norm_cdf_vec(d1_p)
                delta_p = cdf_d1_p - 1.0
                gamma_p = pdf_d1_p / (S * ssq_p)

            valid_p &= np.isfinite(delta_p) & np.isfinite(gamma_p)

            # Per-strike contributions. Mask invalid sides to 0.
            c_g_contrib = np.where(valid_c, gamma_c * cOI, 0.0)
            c_d_contrib = np.where(valid_c, delta_c * cOI, 0.0)
            p_g_contrib = np.where(valid_p, gamma_p * pOI, 0.0)
            p_d_contrib = np.where(valid_p, delta_p * pOI, 0.0)

            # Scalar's "counted" condition: at least one of CE / PE valid for this strike.
            counted = valid_c | valid_p
            n_valid = int(np.sum(counted))
            if n_valid > 0:
                gamma_contribs = c_g_contrib - p_g_contrib  # GEX convention: CE plus, PE minus
                delta_contribs = c_d_contrib + p_d_contrib   # p_delta is already negative

                # Filter to counted strikes for the gamma_flip sweep
                mask = counted
                strikes_counted = K[mask]
                gamma_counted = gamma_contribs[mask]
                s_squared = S * S
                net_gex_sum = float(np.sum(gamma_counted) * s_squared)
                net_delta_sum = float(np.sum(delta_contribs[mask]))

                out["net_gex"] = net_gex_sum
                out["dealer_net_delta"] = net_delta_sum

                # gamma_flip: sort by strike, scan cumulative sum for sign change.
                order = np.argsort(strikes_counted, kind="stable")
                k_sorted = strikes_counted[order]
                g_sorted = gamma_counted[order]
                cum = np.cumsum(g_sorted)
                # Detect first index i (>0) where (cum[i-1], cum[i]) cross zero.
                flip_strike = None
                if cum.size >= 2:
                    prev = cum[:-1]
                    curr = cum[1:]
                    crossings = (
                        ((prev < 0) & (curr >= 0)) | ((prev > 0) & (curr <= 0))
                    )
                    idxs = np.nonzero(crossings)[0]
                    if idxs.size > 0:
                        i = int(idxs[0])
                        prev_cum = float(prev[i])
                        cur_cum = float(curr[i])
                        prev_strike = float(k_sorted[i])
                        curr_strike = float(k_sorted[i + 1])
                        span = cur_cum - prev_cum
                        if span != 0.0:
                            frac = -prev_cum / span
                            flip_strike = prev_strike + frac * (curr_strike - prev_strike)
                        else:
                            flip_strike = curr_strike
                if flip_strike is not None and S > 0:
                    out["gamma_flip_distance_pct"] = (flip_strike - S) / S * 100.0

    # ── charm / vanna (history-based, scalar — small cost) ──
    if (
        now_ts is not None
        and isinstance(now_ts, (int, float))
        and math.isfinite(now_ts)
        and atm_delta_history
    ):
        now_v = float(now_ts)
        # Current sample = latest entry at-or-before now_ts with finite values.
        current = None
        for ts, d, iv in reversed(atm_delta_history):
            if not (isinstance(ts, (int, float)) and math.isfinite(ts) and ts <= now_v):
                continue
            if not (math.isfinite(d) and math.isfinite(iv)):
                continue
            current = (float(ts), float(d), float(iv))
            break
        if current is not None:
            cur_ts, cur_delta, cur_iv = current
            target_ts = now_v - _FIVE_MIN_SEC
            baseline = None
            for ts, d, iv in reversed(atm_delta_history):
                if not (isinstance(ts, (int, float)) and math.isfinite(ts) and ts <= target_ts):
                    continue
                if target_ts - ts > _BASELINE_TOLERANCE_SEC:
                    break
                if not (math.isfinite(d) and math.isfinite(iv)):
                    break
                baseline = (float(ts), float(d), float(iv))
                break
            if baseline is not None:
                base_ts, base_delta, base_iv = baseline
                dt = cur_ts - base_ts
                if dt > 0:
                    out["charm_estimate_atm"] = (cur_delta - base_delta) / dt
                d_iv = cur_iv - base_iv
                if abs(d_iv) >= _MIN_DELTA_IV_FOR_VANNA:
                    out["vanna_estimate_atm"] = (cur_delta - base_delta) / d_iv

    return out
