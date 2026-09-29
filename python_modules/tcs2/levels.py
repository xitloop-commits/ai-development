"""TCS2 - how many times a level was reached, and how many times it held.

Partha 2026-09-29: "how many time S/R level reached / rejected".

A level's open interest says how much is standing there. It does not say whether
the standing has been tested. Those are different facts and they often disagree:

  * a wall with huge open interest that price has never gone near is untested -
    it may be an option seller's yield trade, not a line anyone is defending
  * a smaller level that price has hit four times and been pushed back from four
    times is the one actually holding the market up

So we count. Every futures print is checked against the strike grid: coming
within a tolerance of a strike is a TOUCH; leaving again on the side it came from
is a REJECTION; leaving on the other side is a BREAK.

Counts live in memory for the session. A restart loses them, which is honest -
we would rather show nothing than show a count we cannot stand behind, and there
is no way to reconstruct touches from a chain snapshot after the fact.
"""
from __future__ import annotations

from dataclasses import dataclass

# How near price must come to count as touching, and how far it must go to count
# as having left, both as a share of the strike step.
#
# The two differ on purpose. If leaving used the same threshold as arriving, a
# price sitting exactly on a level and jittering by one tick would register
# dozens of touches - the count would measure the jitter, not the market.
TOUCH_FRAC = 0.15
AWAY_FRAC = 0.50


@dataclass
class Tested:
    """What has happened at one strike."""

    touches: int = 0
    rejections: int = 0
    breaks: int = 0
    last_at: float = 0.0

    @property
    def held(self) -> str:
        """Plain words for how the level has behaved, or "" when untested."""
        if self.touches == 0:
            return ""
        if self.rejections == 0 and self.breaks == 0:
            return f"at it now, {self.touches}x"
        bits = [f"{self.touches}x hit"]
        if self.rejections:
            bits.append(f"{self.rejections} held")
        if self.breaks:
            bits.append(f"{self.breaks} broke")
        return ", ".join(bits)


class LevelTracker:
    """Counts touches and rejections against the strike grid.

    Fed from the futures print on the feed thread, so it does no allocation per
    tick beyond the first visit to a strike and never touches disk.
    """

    def __init__(self, step: float) -> None:
        self.step = float(step) if step and step > 0 else 1.0
        self.touch_tol = self.step * TOUCH_FRAC
        self.away_tol = self.step * AWAY_FRAC
        self._at: dict[float, Tested] = {}
        # Strikes price is currently sitting on, and which side it arrived from.
        self._inside: dict[float, int] = {}
        self._last: float | None = None

    # -- the tick path ---------------------------------------------------

    def on_price(self, price: float, now: float) -> None:
        if price is None or price <= 0:
            return

        # Leaving comes first: a price that has moved on must close out the level
        # it was sitting on before it can be counted as arriving at the next one.
        for k, came_from in list(self._inside.items()):
            if abs(price - k) <= self.away_tol:
                continue
            del self._inside[k]
            st = self._at.setdefault(k, Tested())
            if _side(price, k) == came_from:
                st.rejections += 1          # pushed back the way it came
            else:
                st.breaks += 1              # went through

        k = round(price / self.step) * self.step
        if abs(price - k) <= self.touch_tol and k not in self._inside:
            came_from = _side(self._last, k) if self._last is not None else _side(price, k)
            self._inside[k] = came_from or 1
            st = self._at.setdefault(k, Tested())
            st.touches += 1
            st.last_at = now

        self._last = price

    # -- reading ---------------------------------------------------------

    def at(self, strike: float) -> Tested:
        return self._at.get(float(strike), Tested())

    def tested(self) -> dict[float, Tested]:
        return dict(self._at)


def _side(price: float, k: float) -> int:
    """+1 when price is above the strike, -1 below, 0 when exactly on it."""
    if price > k:
        return 1
    if price < k:
        return -1
    return 0
