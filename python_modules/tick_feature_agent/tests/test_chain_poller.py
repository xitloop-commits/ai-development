"""
tests/test_chain_poller.py - ChainPoller construction + underlying-id override.

The override was added on 2026-04-21 after CRUDEOIL TFA failed to start: the
MCX front-month futures contract (CRUDEOIL-April2026) expired on 2026-04-20,
and the profile's static underlying_security_id became stale. Dhan's option-
chain expiry-list API returned an empty list for the stale id, so TFA halted
at startup. The fix lets main.py pass the freshly-resolved near-month id.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_chain_poller.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG  = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from tick_feature_agent.feed.chain_poller import ChainPoller
from tick_feature_agent.instrument_profile import InstrumentProfile


def _mcx_profile(security_id: str = "486502") -> InstrumentProfile:
    return InstrumentProfile(
        exchange="MCX",
        instrument_name="CRUDEOIL",
        underlying_symbol="CRUDEOIL25MAYFUT",
        underlying_security_id=security_id,
        session_start="09:00",
        session_end="23:30",
        underlying_tick_timeout_sec=30,
        option_tick_timeout_sec=120,
        momentum_staleness_threshold_sec=120,
        warm_up_duration_sec=20,
        regime_trend_volatility_min=0.6,
        regime_trend_imbalance_min=0.4,
        regime_trend_momentum_min=0.5,
        regime_trend_activity_min=0.3,
        regime_range_volatility_max=0.5,
        regime_range_imbalance_max=0.3,
        regime_range_activity_min=0.3,
        regime_dead_activity_max=0.15,
        regime_dead_vol_drought_max=0.02,
        target_windows_sec=[30, 60, 300, 900],
    )


class TestChainPollerUnderlyingId:

    def test_default_uses_profile_id(self):
        """Without override, the profile's static id is used."""
        p = _mcx_profile(security_id="486502")
        poller = ChainPoller(profile=p)
        assert poller._underlying_sec_id == "486502"

    def test_override_takes_precedence(self):
        """
        With override, the fresh resolved id is used - even when the profile
        carries a stale one. This is the MCX rollover path.
        """
        p = _mcx_profile(security_id="486502")   # stale April contract
        poller = ChainPoller(profile=p, underlying_security_id="488290")  # fresh May
        assert poller._underlying_sec_id == "488290"

    def test_override_none_falls_back_to_profile(self):
        """Explicit None override falls back to profile (equivalent to not passing)."""
        p = _mcx_profile(security_id="486502")
        poller = ChainPoller(profile=p, underlying_security_id=None)
        assert poller._underlying_sec_id == "486502"

    def test_empty_string_override_falls_back_to_profile(self):
        """Empty string override falls back (defensive: resolver may return '')."""
        p = _mcx_profile(security_id="486502")
        poller = ChainPoller(profile=p, underlying_security_id="")
        assert poller._underlying_sec_id == "486502"

    def test_mcx_exch_seg(self):
        p = _mcx_profile()
        poller = ChainPoller(profile=p)
        assert poller._exch_seg == "MCX_COMM"
