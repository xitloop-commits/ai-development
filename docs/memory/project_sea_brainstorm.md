---
name: SEA Brainstorm — Trade Signal Output Design
description: SEA output redesign from GO_CALL/GO_PUT/WAIT to LONG_CE/LONG_PE/SHORT_CE/SHORT_PE with SL and TP. Feature-to-prediction mapping. Ready to continue implementation plan update.
type: project
---

## Where we left off

SEA's output design was upgraded. User confirmed the final output needed from SEA is:

```
LONG CE / LONG PE / SHORT CE / SHORT PE / WAIT
+ SL (stop loss LTP)
+ TP (take profit LTP)
```

Not just GO_CALL/GO_PUT/WAIT — that was Phase 1 thinking. This is the actual actionable signal.

## The 4-Action Logic

| Action | When | Regime |
|---|---|---|
| LONG CE | Strong bullish, big move expected | TREND |
| LONG PE | Strong bearish, big move expected | TREND |
| SHORT CE | No upward move expected, CE will decay | RANGE / DEAD |
| SHORT PE | No downward move expected, PE will decay | RANGE / DEAD |
| WAIT | Unclear, poor liquidity, DEAD with no edge | Any |

**Routing rule:** REGIME is the primary router.
- TREND → LONG (directional, movement-driven)
- RANGE/DEAD → SHORT (premium selling, decay-driven)
- NEUTRAL → only trade if direction_prob very high (>0.72), else WAIT

## SL / TP Derivation from Model Targets

### LONG CE / LONG PE
```
entry_ltp = atm_ce_ltp  (or pe_ltp)
TP        = entry_ltp + max_upside_30s
SL        = entry_ltp - max_drawdown_30s
```

### SHORT CE / SHORT PE
```
entry_ltp = atm_ce_ltp  (or pe_ltp) — sell at this
TP        = entry_ltp - avg_decay_per_strike_30s
SL        = entry_ltp + (risk_reward_ratio_30s × avg_decay_per_strike_30s)
```

## Updated TradeSignal dataclass (replaces SignalPacket)

```python
@dataclass
class TradeSignal:
    instrument: str
    timestamp: float
    timestamp_ist: str

    action: str        # "LONG_CE" | "LONG_PE" | "SHORT_CE" | "SHORT_PE" | "WAIT"
    strike: int        # ATM strike

    entry_ltp: float   # option LTP at signal time
    tp: float          # take profit LTP
    sl: float          # stop loss LTP
    rr: float          # tp_distance / sl_distance

    direction_prob_30s: float
    max_upside_30s: float
    max_drawdown_30s: float
    avg_decay_per_strike_30s: float
    upside_percentile_30s: float
    regime: str
    regime_confidence: float

    model_version: str
```

## Feature → Prediction Groups (fully audited)

### Group 1 — Short-term direction (→ direction_30s, LONG CE/PE decision)
- underlying_momentum, return_5ticks, velocity, tick_imbalance_20, ofi_5, trade_direction

### Group 2 — Medium-term direction (→ direction_60s)
- return_20ticks, tick_imbalance_50, ofi_20, horizon_momentum_ratio, chain_pcr_atm

### Group 3 — Breakout magnitude (→ max_upside, direction_magnitude, upside_percentile)
- volatility_compression, stagnation_duration_sec, range_20ticks, breakout_readiness,
  breakout_readiness_extended, momentum_persistence_ticks, time_since_last_big_move

### Group 4 — Institutional OI pressure (→ direction + CE vs PE choice)
- atm_zone_call/put/net_pressure, active_zone_dominance, chain_oi_imbalance_atm,
  chain_oi_change_*, chain_pcr_atm

### Group 5 — Option smart money flow (→ direction, leading indicator)
- opt_0_ce/pe_premium_momentum, opt_0_ce/pe_bid_ask_imbalance, wing confirmations

### Group 6 — Execution quality / risk-reward (→ RR, drawdown, WAIT gate)
- spread_tightening_atm, opt_0_ce/pe_spread, dead_market_score, active_strike_count, volume_drought_atm

### Group 7 — Regime context (→ gates all other groups, routes LONG vs SHORT)
- regime, regime_confidence, volatility_compression, dead_market_score, zone_activity_score

### Group 8 — Premium decay (→ total_premium_decay, avg_decay_per_strike → SHORT TP/SL)
- total_premium_decay_atm, momentum_decay_20ticks_atm, volume_drought_atm, dead_market_score,
  active_strike_count, realized_vol_5/20/50

### Group 9 — Multi-timeframe alignment (→ signal quality / confidence filter)
- horizon_momentum_ratio, horizon_vol_ratio, horizon_ofi_ratio,
  tick_imbalance_10/20/50, return_5/20/50ticks

## What needs to change in implementation plans

### SEA spec changes needed:
1. `signal_builder.py` — SignalPacket → TradeSignal, add tp/sl/rr/entry_ltp/action fields, compute TP/SL from model outputs
2. `thresholds.py` — decide_direction() → decide_action() returning 5 values, add SHORT CE/PE path driven by regime + decay targets
3. `signal_logger.py` — log line gains tp, sl, rr, entry_ltp, action fields
4. `engine.py` — no structural change

### MTA spec changes: NONE needed
- The 15 model targets already produce everything required (max_upside, max_drawdown, avg_decay_per_strike, risk_reward_ratio)

## TFA Feature Audit Result (completed)

**No TFA changes needed.** All required features exist in the 370-column vector.

Two genuine gaps:
1. **Time-of-day (IST)** — only raw epoch timestamp exists. MTA preprocessor derives it as `(hour*60 + minute) - (9*60+15)`. No TFA change needed.
2. **Distance from max-OI strike** — not worth adding Phase 1. Use zone/chain proxies instead.

## Open items before starting implementation sessions

- [ ] Update SEA_ImplementationPlan_v0.1.md with TradeSignal replacing SignalPacket
- [ ] Update thresholds.py spec with 5-way decide_action() logic including SHORT path
- [ ] Decide SHORT thresholds: what min avg_decay qualifies a SHORT trade?
- [ ] Decide: is strike always ATM, or best RR across ATM±1? (Open item F in spec)
- [ ] Decide: 30s or 60s window for primary TP/SL? Or show both?
- [ ] Both MTA + SEA parallel sessions ready to start once spec updated
