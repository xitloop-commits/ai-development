"""
active_strikes.py — Active strike selection from option chain snapshots.

Determines which 0–6 option strikes are "active" each cycle using a two-set
union approach:

  Volume set  — top 3 strikes by call_vol_diff + put_vol_diff (non-zero only).
                Unavailable on the first snapshot (cumulative volumes have no
                baseline); the volume set is empty until the second snapshot.
  ΔOI set     — top 3 strikes by |callOIChange| + |putOIChange| (non-zero only).
                Available from the first snapshot.

The union of both sets (0–6 distinct strikes after dedup) is returned, ordered
by descending normalized strength (min-max normalized ΔOI score across the full
chain snapshot). Ties in selection use the tiebreaker: ascending distance to
spot, then above-spot wins on equal distance.

Public API:
    StrikeScore            — value object per strike.
    compute_strike_scores  — raw + normalized scores from chain rows.
    select_active_strikes  — two-set union → ordered active list.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence


# ── Value object ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class StrikeScore:
    """
    Computed scores for a single strike.

    Attributes:
        strike:   Strike price (int).
        vol_score: call_vol_diff + put_vol_diff (cumulative volume change since
                   last snapshot). Always 0.0 when prev_rows is None.
        oi_score: |callOIChange| + |putOIChange| from chain snapshot row.
        strength: min-max normalised oi_score across the full chain (0.0–1.0).
                  All-zero oi_scores → 0.0; all-equal non-zero → 1.0.
    """
    strike:    int
    vol_score: float
    oi_score:  float
    strength:  float


# ── Internals ─────────────────────────────────────────────────────────────────

def _normalize(values: list[float]) -> list[float]:
    """
    Min-max normalization.

    Edge cases:
        All values 0.0       → [0.0, ...]
        All values equal > 0 → [1.0, ...]
        Normal case          → (v - min) / (max - min)
    """
    if not values:
        return []
    mx = max(values)
    if mx == 0.0:
        return [0.0] * len(values)
    mn = min(values)
    if mx == mn:          # all equal non-zero
        return [1.0] * len(values)
    span = mx - mn
    return [(v - mn) / span for v in values]


def _tiebreak_key(strike: int, spot: float, raw_score: float) -> tuple:
    """
    Sort key for descending-score selection with a distance tiebreaker.

    Primary:   higher raw_score wins  (negate for ascending sort)
    Secondary: ascending |strike - spot|  (closer to ATM wins)
    Tertiary:  above-spot wins on equal distance  (0 < 1 in ascending sort)
    """
    dist  = abs(strike - spot)
    above = 0 if strike > spot else 1
    return (-raw_score, dist, above)


# ── Public API ────────────────────────────────────────────────────────────────

def compute_strike_scores(
    rows: list[dict],
    prev_rows: list[dict] | None,
) -> list[StrikeScore]:
    """
    Compute volume-diff and ΔOI scores for every strike in the chain snapshot.

    Args:
        rows:      Current chain snapshot rows (from ChainSnapshot.rows).
                   Each row must contain 'strike', 'callVolume', 'putVolume',
                   'callOIChange', 'putOIChange'.
        prev_rows: Previous snapshot rows (any ordering), or None on the first
                   snapshot. When None, all vol_scores are 0.0.

    Returns:
        List of StrikeScore, one per row, in the same order as rows.
        strength is min-max normalised oi_score across all returned rows.
    """
    # Build strike → prev_row lookup (keyed by int strike)
    prev_map: dict[int, dict] = {}
    if prev_rows:
        for r in prev_rows:
            prev_map[int(r["strike"])] = r

    raw: list[tuple[int, float, float]] = []
    for row in rows:
        strike = int(row["strike"])

        # Volume diff — cumulative day volume change since last snapshot.
        # When prev_rows is None (first snapshot) there is no baseline, so
        # vol_score is 0.0 for all strikes (caller sets vol_diff_available=False).
        if prev_rows is None:
            vol_score = 0.0
        else:
            call_vol      = float(row.get("callVolume", 0) or 0)
            put_vol       = float(row.get("putVolume",  0) or 0)
            prev_row      = prev_map.get(strike)
            prev_call_vol = float(prev_row.get("callVolume", 0) or 0) if prev_row else 0.0
            prev_put_vol  = float(prev_row.get("putVolume",  0) or 0) if prev_row else 0.0
            # Clamp to 0 — volume can't decrease intraday (guard against stale data)
            vol_score = max(0.0, (call_vol - prev_call_vol) + (put_vol - prev_put_vol))

        # ΔOI — use chain snapshot's OI-change field directly
        call_doi = abs(float(row.get("callOIChange", 0) or 0))
        put_doi  = abs(float(row.get("putOIChange",  0) or 0))
        oi_score = call_doi + put_doi

        raw.append((strike, vol_score, oi_score))

    # Normalise oi_scores across all strikes
    oi_values = [r[2] for r in raw]
    norm_oi   = _normalize(oi_values)

    return [
        StrikeScore(strike=r[0], vol_score=r[1], oi_score=r[2], strength=norm_oi[i])
        for i, r in enumerate(raw)
    ]


def select_active_strikes(
    scores: list[StrikeScore],
    spot: float,
    vol_diff_available: bool,
    top_n: int = 3,
) -> list[StrikeScore]:
    """
    Select up to 2 × top_n active strikes using the two-set union approach.

    Algorithm:
        1. ΔOI set  — top top_n strikes by oi_score  (non-zero only).
        2. Volume set — top top_n strikes by vol_score (non-zero only,
                        skipped entirely when vol_diff_available is False).
        3. Union of both sets (dedup by strike).
        4. Order result by descending strength (normalized ΔOI score).

    Tiebreaker within each set:
        Ascending |strike - spot|, then above-spot wins on equal distance.

    Args:
        scores:             Output of compute_strike_scores().
        spot:               Current underlying spot price (for tiebreaker).
        vol_diff_available: False on the first chain snapshot — volume set is
                            skipped, returning OI top-n only (0–top_n strikes).
        top_n:              Maximum strikes per set (default 3).

    Returns:
        List of StrikeScore (0 to 2×top_n elements) ordered by descending
        strength. Returns [] if scores is empty.
    """
    if not scores:
        return []

    selected_strikes: set[int] = set()

    # ── ΔOI set ───────────────────────────────────────────────────────────────
    oi_candidates = [s for s in scores if s.oi_score > 0.0]
    oi_sorted = sorted(
        oi_candidates,
        key=lambda s: _tiebreak_key(s.strike, spot, s.oi_score),
    )
    for s in oi_sorted[:top_n]:
        selected_strikes.add(s.strike)

    # ── Volume set (skip on first snapshot) ───────────────────────────────────
    if vol_diff_available:
        vol_candidates = [s for s in scores if s.vol_score > 0.0]
        vol_sorted = sorted(
            vol_candidates,
            key=lambda s: _tiebreak_key(s.strike, spot, s.vol_score),
        )
        for s in vol_sorted[:top_n]:
            selected_strikes.add(s.strike)

    # ── Build result ordered by descending strength ───────────────────────────
    result = [s for s in scores if s.strike in selected_strikes]
    result.sort(key=lambda s: -s.strength)
    return result
