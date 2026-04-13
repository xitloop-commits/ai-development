"""
ofi.py — §8.18 Order Flow Imbalance (OFI).

Features:
    underlying_trade_direction   ∈ {-1.0, 0.0, 1.0} — per-tick, never NaN
    underlying_ofi_5             sum(td × Δvol) over last 5 ticks,  NaN if < 5
    underlying_ofi_20            sum(td × Δvol) over last 20 ticks, NaN if < 20
    underlying_ofi_50            sum(td × Δvol) over last 50 ticks, NaN if < 50

Trade direction classification (per tick, no warm-up):
    ltp >= ask               → +1.0  (aggressive buy  — taker hit the ask)
    ltp <= bid               → -1.0  (aggressive sell — taker hit the bid)
    otherwise                → 0.0   (passive / inside spread)
    bid = ask = 0  (pre-depth state)  → 0.0  (treated as missing, per spec rule)
    bid = ask = ltp (zero-width, non-zero) → +1.0 (first condition wins by spec)

Rolling OFI:
    ofi_N = sum(trade_direction[i] × Δvolume[i] for i in last N ticks)
    Δvolume[i] = max(0, volume[i] - volume[i-1])
    For the oldest tick in the window, predecessor is taken from the buffer when
    available; when the window spans the entire buffer (n == w), Δvolume = 0 for
    the oldest tick.

Null guard:
    ofi_N emits NaN until N ticks are in the buffer.  Once warm, always a
    valid float (0.0 if perfectly balanced or zero volume in the window).
"""

from __future__ import annotations

from tick_feature_agent.buffers.tick_buffer import CircularBuffer

_NAN = float("nan")
_OFI_WINDOWS = (5, 20, 50)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _trade_direction(ltp: float, bid: float, ask: float) -> float:
    """
    Classify a single tick's trade direction.

    Returns +1.0 (aggressive buy), -1.0 (aggressive sell), or 0.0 (passive).

    Spec edge cases honoured:
    - bid=ask=0  → 0.0  (pre-depth packet, treated as missing)
    - ltp >= ask → +1.0 (includes ltp = ask and zero-spread ltp=bid=ask>0)
    - ltp <= bid → -1.0
    """
    if bid == 0.0 and ask == 0.0:
        return 0.0          # pre-depth state — no bid/ask data yet
    if ltp >= ask:
        return 1.0
    if ltp <= bid:
        return -1.0
    return 0.0


# ── Public API ────────────────────────────────────────────────────────────────

def compute_ofi_features(buffer: CircularBuffer) -> dict:
    """
    Compute all §8.18 OFI features.

    Args:
        buffer: CircularBuffer with the current tick already pushed.
                Maxlen=50 assumed (standard underlying buffer).

    Returns:
        Dict of 4 float features.
        `underlying_trade_direction` is never NaN (0.0 when buffer is empty).
        ofi_N features are NaN when buffer has fewer than N ticks.
    """
    n = len(buffer)

    out: dict = {
        "underlying_trade_direction": 0.0,   # safe default for empty buffer
        "underlying_ofi_5":           _NAN,
        "underlying_ofi_20":          _NAN,
        "underlying_ofi_50":          _NAN,
    }

    if n == 0:
        return out

    ticks = buffer.get_last(n)   # list[UnderlyingTick], oldest → newest
    current = ticks[-1]

    # ── Trade direction — per-tick, no warm-up ─────────────────────────────────
    out["underlying_trade_direction"] = _trade_direction(
        float(current.ltp), float(current.bid), float(current.ask)
    )

    # ── Rolling OFI windows ────────────────────────────────────────────────────
    for w in _OFI_WINDOWS:
        if n < w:
            continue   # leaves NaN

        window = ticks[-w:]              # length == w, oldest first

        # Predecessor for the oldest tick in the window:
        #   - If buffer holds more than w ticks, compute Δvol normally
        #   - Otherwise (buffer exactly w ticks deep) no prior tick is known,
        #     so Δvol for the oldest entry is treated as 0 (unknown delta)
        pred_vol: float | None = float(ticks[-(w + 1)].volume) if n > w else None

        ofi = 0.0
        for i, t in enumerate(window):
            td = _trade_direction(float(t.ltp), float(t.bid), float(t.ask))
            if i == 0:
                if pred_vol is None:
                    delta_vol = 0.0   # first session tick: delta unknowable
                else:
                    delta_vol = max(0.0, float(t.volume) - pred_vol)
            else:
                delta_vol = max(0.0, float(t.volume) - float(window[i - 1].volume))
            ofi += td * delta_vol

        out[f"underlying_ofi_{w}"] = ofi

    return out
