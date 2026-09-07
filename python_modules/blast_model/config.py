"""Knobs for the blast model. Every value here is sweepable by the tuner —
nothing is a law (Partha 2026-09-07: backtest a grid, rank by rupees)."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class BlastConfig:
    instrument: str = "nifty50"

    # ── Label (the definition of a "blast") ────────────────────────────────
    blast_pct: float = 0.10          # ENTER label: premium +10% …
    blast_window_min: int = 10       # … within 10 minutes
    drop_pct: float = 0.10           # EXIT label: premium −10% within the window
    drop_window_min: int = 10

    # ── Candles / structure ────────────────────────────────────────────────
    decision_candle_sec: int = 60            # decide once per 1-minute close
    structure_tfs_sec: tuple[int, ...] = (60, 120, 300)
    swing_window: int = 3                    # candles each side for a pivot
    range_lookback: int = 30                 # candles for range_pos / new-range

    # ── Contract selection ─────────────────────────────────────────────────
    lock_offset: int = 2       # session lock = ATM ∓ offset (CE below, PE above)
    ladder: int = 3            # per-strike features across ATM ± ladder

    # ── Flow velocity (who is entering/exiting quickly, per strike) ────────
    flow_windows_sec: tuple[int, ...] = (60, 120, 300)

    # ── Session (NSE) ──────────────────────────────────────────────────────
    session_open_hhmm: str = "09:15"
    session_close_hhmm: str = "15:30"
    session_hours: float = 6.25

    # ── Output ─────────────────────────────────────────────────────────────
    # Resolved against the repo root at build time (see dataset.build_day).
    out_dir: str = "data/blast_model/nifty50"

    def label_tag(self) -> str:
        return f"b{int(self.blast_pct * 100)}w{self.blast_window_min}"
