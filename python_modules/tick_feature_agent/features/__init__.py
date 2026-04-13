"""
tick_feature_agent.features — Feature computation modules.

Phase 6:
    atm             ATM detection, strike step, ATM window (7 strikes)
    active_strikes  Active strike selection via volume + OI union

Later phases (not yet built):
    underlying, option_tick, chain, active_features,
    compression, decay, regime, time_to_move, zone,
    targets, meta, ofi, realized_vol, micro_agg, horizon
"""
