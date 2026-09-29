"""TCS2 - the window actually gets built.

Twice on 2026-09-29 the screen crashed on startup while every other test passed:
once because a widget was used before it was created, once because `_show_body`
ran before the panel it hides existed. Both were ordering faults inside
`__init__`, and nothing in the suite built a window, so nothing could catch them.

These tests build the real thing. They are skipped where there is no display,
which is honest - a skipped test says "not checked here", a passing fake would
say "checked" and be wrong.
"""
from __future__ import annotations

import pytest

tk = pytest.importorskip("tkinter")

from tcs2 import screen as sc                               # noqa: E402
from tcs2.chain import Chain                                # noqa: E402
from tcs2.scrip import Contract, Resolved                   # noqa: E402

EXPIRY = "2026-10-06"


def _chain() -> Chain:
    opts, sid = [], 1000
    for k in (23_000.0, 23_100.0, 23_200.0):
        for side in ("CE", "PE"):
            opts.append(Contract(security_id=str(sid), display_name=f"N {k} {side}",
                                 instrument="OPTIDX", expiry=EXPIRY, strike=k,
                                 option_type=side, expiry_flag="W", lot_size=75,
                                 tick_size=0.05))
            sid += 1
    idx = Contract(security_id="13", display_name="Nifty 50", instrument="INDEX",
                   expiry="", strike=0.0, option_type="XX", expiry_flag="",
                   lot_size=1, tick_size=0.05)
    fut = Contract(security_id="900", display_name="FUT", instrument="FUTIDX",
                   expiry=EXPIRY, strike=0.0, option_type="XX", expiry_flag="M",
                   lot_size=65, tick_size=0.05)
    return Chain(Resolved(instrument="nifty50", trade_date="2026-10-01",
                          index=idx, vix=None, futures=(fut,),
                          option_expiries=(EXPIRY,), options=tuple(opts)))


class _FakeHealth:
    class _Beat:
        def beat(self):
            pass

    gui = _Beat()

    def summary(self):
        return "ok"


class _FakeRT:
    def __init__(self):
        self.chain = _chain()
        self.flow = {}
        self.instrument = "nifty50"
        self.health = _FakeHealth()
        self.levels = None

    def latest(self):
        return None


def test_the_screen_can_be_built_at_all():
    """The whole point: __init__ runs top to bottom without an AttributeError."""
    rt = _FakeRT()
    try:
        w = sc.Screen(rt)
    except tk.TclError as exc:
        pytest.skip(f"no display: {exc}")
    try:
        w.withdraw()
        assert w.body_view == "chain"
        # Every widget __init__ creates must exist by the time it returns.
        for name in ("status_text", "chain_text", "points_text", "right",
                     "health_label", "price_label", "expiry_text", "body_label",
                     "verdict_text", "flow_text"):
            assert hasattr(w, name), f"__init__ never created {name}"
    finally:
        w.destroy()


def test_switching_to_the_points_and_back_does_not_crash():
    """`p` hides the chain and brings the verdict panel back."""
    rt = _FakeRT()
    try:
        w = sc.Screen(rt)
    except tk.TclError as exc:
        pytest.skip(f"no display: {exc}")
    try:
        w.withdraw()
        w._toggle_body()
        assert w.body_view == "points"
        assert w.points_text.winfo_manager() == "pack"
        w._toggle_body()
        assert w.body_view == "chain"
        assert w.chain_text.winfo_manager() == "pack"
        assert w.status_text.winfo_manager() == "pack"
    finally:
        w.destroy()


def test_the_verdict_panel_is_hidden_while_the_chain_is_shown():
    """It is hidden so the strike column can sit at the middle of the window."""
    rt = _FakeRT()
    try:
        w = sc.Screen(rt)
    except tk.TclError as exc:
        pytest.skip(f"no display: {exc}")
    try:
        w.withdraw()
        assert w.right.winfo_manager() == ""        # not packed
        w._toggle_body()
        assert w.right.winfo_manager() == "pack"
    finally:
        w.destroy()


def test_the_chain_can_be_drawn_into_the_real_widget():
    """Rendering touches tags, indices and scrolling - none of it covered by the
    pure width tests."""
    rt = _FakeRT()
    try:
        w = sc.Screen(rt)
    except tk.TclError as exc:
        pytest.skip(f"no display: {exc}")
    try:
        w.withdraw()
        w.update_idletasks()
        line = sc.render_chain(w.chain_text, rt, EXPIRY, status=w.status_text)
        assert isinstance(line, str)
        drawn = w.chain_text.get("1.0", "end-1c")
        assert "STRIKE" in drawn
    finally:
        w.destroy()
