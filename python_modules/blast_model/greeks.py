"""Black-Scholes greeks per strike — fresh implementation (no old-stack code).

Inputs come straight from the chain snapshots: per-strike IV (%), spot, and
time-to-expiry. Used for the ATM±ladder per-strike features so the model can
weigh leverage (delta/gamma) against bleed (theta)."""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def years_to_expiry(expiry: str, now_ts: float, close_hhmm: str = "15:30") -> float:
    """Calendar years to expiry-day close (IST). Floor keeps expiry-day greeks finite."""
    try:
        h, m = close_hhmm.split(":")
        exp_dt = datetime.strptime(expiry, "%Y-%m-%d").replace(
            hour=int(h), minute=int(m), tzinfo=IST
        )
    except ValueError:
        return 0.0
    yrs = (exp_dt.timestamp() - now_ts) / (365.0 * 24 * 3600)
    return max(yrs, 1.0 / (365.0 * 24 * 4))  # ≥ 15 minutes


def bs_greeks(spot: float, strike: float, iv_pct: float, t_years: float,
              is_call: bool, r: float = 0.0) -> dict[str, float] | None:
    """delta, gamma, theta_per_day. None when inputs can't price."""
    if spot <= 0 or strike <= 0 or iv_pct <= 0 or t_years <= 0:
        return None
    sigma = iv_pct / 100.0
    sq = sigma * math.sqrt(t_years)
    d1 = (math.log(spot / strike) + (r + 0.5 * sigma * sigma) * t_years) / sq
    delta = _norm_cdf(d1) if is_call else _norm_cdf(d1) - 1.0
    gamma = _norm_pdf(d1) / (spot * sq)
    theta_year = -(spot * _norm_pdf(d1) * sigma) / (2.0 * math.sqrt(t_years))
    return {"delta": delta, "gamma": gamma, "theta_day": theta_year / 365.0}


def expected_hourly_move(spot: float, iv_pct: float, session_hours: float) -> float:
    """Points a typical trading HOUR pays at this IV (annualised → per-hour)."""
    if spot <= 0 or iv_pct <= 0:
        return 0.0
    trading_hours_year = 252.0 * session_hours
    return spot * (iv_pct / 100.0) / math.sqrt(trading_hours_year)
