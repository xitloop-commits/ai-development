"""
atm.py — ATM detection and strike window computation.

All functions are pure (no I/O, no state). Callers handle logging and FATAL exits.

Design notes:
  - detect_strike_step: raises ValueError on bad input — caller (chain_poller or
    chain_cache) logs FATAL and exits.
  - compute_atm: standard round-to-nearest-multiple. Python's round() uses
    banker's rounding (round half to even), which is correct for .5 midpoints —
    both sides of the spread are equidistant so either is valid.
  - ATM window: always 7 strikes (ATM-3s … ATM+3s). Strikes in the window that
    are not in the live chain are simply absent from the buffer — consumers guard
    via tick_available.
"""

from __future__ import annotations


def detect_strike_step(strikes: list[int | float]) -> int:
    """
    Given a list of strike prices, return the minimum consecutive strike step.

    Raises:
        ValueError: if fewer than 2 distinct strikes or the computed step is ≤ 0.

    Notes:
        Non-uniform chains (step varies across strikes) are handled by returning
        the minimum step. Callers may log WARN if the chain is non-uniform.
        The computed step is used only at startup and is NOT updated mid-session.
    """
    unique = sorted(set(int(s) for s in strikes))
    if len(unique) < 2:
        raise ValueError(f"Need at least 2 distinct strikes to compute step, got {len(unique)}")
    diffs = [unique[i + 1] - unique[i] for i in range(len(unique) - 1)]
    step = min(diffs)
    if step <= 0:
        raise ValueError(
            f"Strike step must be positive, got {step} "
            f"(duplicate or descending strikes in input)"
        )
    return step


def compute_atm(spot: float, strike_step: int) -> int:
    """
    Round spot price to the nearest multiple of strike_step.

    Uses Python's built-in round() (banker's rounding — round half to even),
    which is correct for the .5 midpoint case.

    Args:
        spot:        Current underlying price (e.g. 24137.6).
        strike_step: Distance between consecutive strikes (e.g. 50 for NIFTY).

    Returns:
        ATM strike as int (e.g. 24150 for spot=24137.6, step=50).
    """
    return int(round(spot / strike_step) * strike_step)


def compute_atm_window(atm: int, strike_step: int) -> list[int]:
    """
    Return the 7-element ATM window: [ATM-3s, ATM-2s, ATM-1s, ATM, ATM+1s, ATM+2s, ATM+3s].

    Args:
        atm:         ATM strike (from compute_atm).
        strike_step: Distance between consecutive strikes.

    Returns:
        List of 7 strike prices in ascending order.

    Example:
        compute_atm_window(24150, 50) →
            [23850, 23950, 24050, 24150, 24250, 24350, 24450]
             ATM-3  ATM-2  ATM-1   ATM  ATM+1  ATM+2  ATM+3
    """
    return [atm + i * strike_step for i in range(-3, 4)]


def atm_shifted(old_atm: int | None, new_atm: int) -> bool:
    """
    Return True if the ATM strike has moved from the previous computation.

    Args:
        old_atm: ATM from the previous tick (None on first tick).
        new_atm: ATM computed on the current tick.

    Returns:
        True on first tick (old_atm is None) or when old_atm != new_atm.
    """
    return old_atm != new_atm
