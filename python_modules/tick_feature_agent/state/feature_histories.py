"""
feature_histories.py — caller-maintained time-bounded ring buffers (Phase 2d).

Several of the new Phase 2 feature modules take a history buffer of
``(ts, value...)`` samples and look back N minutes. The
:class:`FeatureHistories` dataclass below owns those buffers so the
tick processor and chain-poller can share one well-tested data
structure instead of each rolling its own.

Buffers held (one per feature concern):

    ``vix``             ``[(ts, vix_value), ...]``
                        Consumed by :mod:`features.india_vix`. Lookback
                        300 s with 60 s tolerance → 360 s retained.

    ``pcr``             ``[(ts, pcr_global), ...]``
                        Consumed by :func:`features.chain.compute_pcr_slope`.
                        Lookback 1800 s → 2100 s retained for headroom.

    ``oi_totals``       ``[(ts, total_call_oi, total_put_oi), ...]``
                        Consumed by :func:`features.chain.compute_oi_change_deltas`.
                        Longest lookback is 60 min → 3900 s retained.

    ``iv_velocity``     ``[(ts, atm_ce_iv_dec, atm_pe_iv_dec, spot), ...]``
                        Consumed by :func:`features.greeks.compute_iv_velocity_features`.
                        Lookback 300 s with 60 s tolerance → 390 s retained.

    ``atm_delta``       ``[(ts, atm_ce_delta, atm_ce_iv_dec), ...]``
                        Consumed by :func:`features.dealer_hedging.compute_dealer_hedging_features`
                        for charm + vanna finite-difference estimates. Same
                        lookback as ``iv_velocity``.

    ``active_strikes``  ``[(ts, rows), ...]`` where ``rows`` is a small
                        list of dicts carrying the per-strike fields used
                        by :func:`features.active_features.compute_strike_rotation_features`
                        (``strike``, ``callOI``, ``putOI``, ``callOIChange``,
                        ``putOIChange``). Lookback 300 s with 60 s
                        tolerance → 390 s retained.

Population cadence is the caller's choice — typically once per chain
poll (5 s) for the chain-derived buffers and once per ATM-delta
recompute (per tick) for ``atm_delta``. Append-side pruning keeps
memory bounded.

Pruning is amortised O(1): after each append we drop entries from the
left whose timestamp is older than ``newest_ts - lookback_sec``. The
buffers are plain :class:`collections.deque` to make this cheap.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any

# Lookback windows in seconds (retention = feature lookback + tolerance buffer).
VIX_RETENTION_SEC = 360.0           # india_vix uses 300 s + 60 s tolerance
PCR_RETENTION_SEC = 2_100.0         # pcr_slope uses 1800 s; +5 min headroom
OI_TOTALS_RETENTION_SEC = 3_900.0   # oi_change_deltas uses up to 3600 s; +5 min
IV_VELOCITY_RETENTION_SEC = 390.0   # iv_velocity 300 s + 60 s + tiny pad
ATM_DELTA_RETENTION_SEC = 390.0     # dealer_hedging charm/vanna 5-min FD
ACTIVE_STRIKES_RETENTION_SEC = 390.0  # strike_rotation 5-min center-of-mass

# Per-snapshot row schema for the active-strikes buffer. We deliberately
# keep this minimal so memory cost stays small (~50 strikes × 5 floats per
# 5-s snapshot × ~78 snapshots in a 6.5-min window ≈ 100 KB per buffer).
_ACTIVE_STRIKE_KEYS = ("strike", "callOI", "putOI", "callOIChange", "putOIChange")


def _prune_left(buf: deque, retention_sec: float, now_ts: float) -> None:
    """Drop entries older than (now_ts - retention_sec) from the left."""
    cutoff = now_ts - retention_sec
    while buf and buf[0][0] < cutoff:
        buf.popleft()


def _is_finite(v: Any) -> bool:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return False
    return f == f and f not in (float("inf"), float("-inf"))


@dataclass
class FeatureHistories:
    """Time-bounded ring buffers for caller-side feature history."""

    vix: deque = field(default_factory=deque)
    pcr: deque = field(default_factory=deque)
    oi_totals: deque = field(default_factory=deque)
    iv_velocity: deque = field(default_factory=deque)
    atm_delta: deque = field(default_factory=deque)
    active_strikes: deque = field(default_factory=deque)

    # ── Reset ─────────────────────────────────────────────────────────────

    def reset(self) -> None:
        """Clear every buffer. Call at session start / rollover."""
        self.vix.clear()
        self.pcr.clear()
        self.oi_totals.clear()
        self.iv_velocity.clear()
        self.atm_delta.clear()
        self.active_strikes.clear()

    # ── Append (each variant validates inputs; bad inputs silently dropped) ──

    def append_vix(self, ts: float, vix_value: float) -> None:
        if not (_is_finite(ts) and _is_finite(vix_value) and float(vix_value) > 0):
            return
        ts_v = float(ts)
        self.vix.append((ts_v, float(vix_value)))
        _prune_left(self.vix, VIX_RETENTION_SEC, ts_v)

    def append_pcr(self, ts: float, pcr_global: float) -> None:
        if not (_is_finite(ts) and _is_finite(pcr_global) and float(pcr_global) >= 0):
            return
        ts_v = float(ts)
        self.pcr.append((ts_v, float(pcr_global)))
        _prune_left(self.pcr, PCR_RETENTION_SEC, ts_v)

    def append_oi_totals(self, ts: float, total_call_oi: float, total_put_oi: float) -> None:
        if not (_is_finite(ts) and _is_finite(total_call_oi) and _is_finite(total_put_oi)):
            return
        if float(total_call_oi) < 0 or float(total_put_oi) < 0:
            return
        ts_v = float(ts)
        self.oi_totals.append((ts_v, float(total_call_oi), float(total_put_oi)))
        _prune_left(self.oi_totals, OI_TOTALS_RETENTION_SEC, ts_v)

    def append_iv_velocity(
        self,
        ts: float,
        atm_ce_iv_decimal: float,
        atm_pe_iv_decimal: float,
        spot: float,
    ) -> None:
        if not (
            _is_finite(ts)
            and _is_finite(atm_ce_iv_decimal)
            and _is_finite(atm_pe_iv_decimal)
            and _is_finite(spot)
            and float(atm_ce_iv_decimal) > 0
            and float(atm_pe_iv_decimal) > 0
            and float(spot) > 0
        ):
            return
        ts_v = float(ts)
        self.iv_velocity.append(
            (ts_v, float(atm_ce_iv_decimal), float(atm_pe_iv_decimal), float(spot))
        )
        _prune_left(self.iv_velocity, IV_VELOCITY_RETENTION_SEC, ts_v)

    def append_atm_delta(
        self,
        ts: float,
        atm_ce_delta: float,
        atm_ce_iv_decimal: float,
    ) -> None:
        if not (
            _is_finite(ts) and _is_finite(atm_ce_delta) and _is_finite(atm_ce_iv_decimal)
        ):
            return
        if float(atm_ce_iv_decimal) <= 0:
            return
        ts_v = float(ts)
        self.atm_delta.append((ts_v, float(atm_ce_delta), float(atm_ce_iv_decimal)))
        _prune_left(self.atm_delta, ATM_DELTA_RETENTION_SEC, ts_v)

    def append_active_strikes(self, ts: float, rows: list[dict]) -> None:
        if not _is_finite(ts) or not isinstance(rows, list):
            return
        # Compact each row to the minimal field set so we don't retain
        # the full chain-snapshot payload per sample.
        compact: list[dict] = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            entry: dict[str, float] = {}
            for k in _ACTIVE_STRIKE_KEYS:
                v = r.get(k)
                if v is None:
                    continue
                try:
                    entry[k] = float(v)
                except (TypeError, ValueError):
                    continue
            if entry:
                compact.append(entry)
        if not compact:
            return
        ts_v = float(ts)
        self.active_strikes.append((ts_v, compact))
        _prune_left(self.active_strikes, ACTIVE_STRIKES_RETENTION_SEC, ts_v)

    # ── Read views (for callers that prefer list interfaces) ─────────────

    def vix_list(self) -> list[tuple[float, float]]:
        return list(self.vix)

    def pcr_list(self) -> list[tuple[float, float]]:
        return list(self.pcr)

    def oi_totals_list(self) -> list[tuple[float, float, float]]:
        return list(self.oi_totals)

    def iv_velocity_list(self) -> list[tuple[float, float, float, float]]:
        return list(self.iv_velocity)

    def atm_delta_list(self) -> list[tuple[float, float, float]]:
        return list(self.atm_delta)

    def active_strikes_list(self) -> list[tuple[float, list[dict]]]:
        return list(self.active_strikes)
