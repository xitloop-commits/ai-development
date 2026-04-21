# Risk Control Agent (RCA) Specification v2.0

**Document:** RiskControlAgent_Spec_v2.0.md
**Project:** Automatic Trading System (ATS)
**Status:** Specification (Ready for Implementation)
**Version:** 2.0
**Date:** 2026-04-09

---

## Change History

| Version | Date | Author | Summary |
|---------|------|--------|---------|
| v1.0 | 2026-04-08 | AI Team | Initial draft (generic risk control) |
| v2.0 | 2026-04-09 | AI Team | Complete refactor: real-time monitoring, paper/live split, external signals, API contracts, exit decision matrix |

---

## 1. Overview

The Risk Control Agent (RCA) is the **real-time risk decision maker** that:
- **Approves or rejects** trade requests that arrive after the Discipline pre-trade gate
- **Monitors all open positions** continuously (every 1-5 seconds)
- **Decides when to exit** based on market conditions, own rules, and external signals
- **Modifies SL/TP/TSL** for live trades to adapt to market changes
- **Manages paper trades completely** (entry to exit)
- **Coordinates with Discipline Engine** (honors hard rules)
- **Validates AI/SEA signals** before executing

RCA is the **central risk hub** — all trade decisions flow through it, and it sends commands only to TradeExecutorAgent.

```
SEA (generates signal)
        ↓
Discipline Engine.validateTrade (pre-trade gate, Module 4)
        ↓
RCA.evaluate (approves/sizes/sets SL/TP)
        ↓
TradeExecutorAgent (ONLY broker caller)
        ↓
Broker (Dhan) / Portfolio Agent records outcome
```

---

## 2. Inputs

### 2.1 From SEA via Discipline.validateTrade (Validated Trade Requests)

```json
{
  "instrument": "NIFTY_50",
  "trade_direction": "GO_CALL" | "GO_PUT" | "WAIT",
  "trade_setup": {
    "strike": 24150,
    "entry_price": 185.50,
    "target_price": 241.15,
    "stop_loss": 148.40,
    "risk_reward": 1.5,
    "target_pct": 30.0,
    "sl_pct": 20.0
  },
  "confidence_score": 0.72,
  "discipline_status": {
    "allowed": true,
    "blocked_by": [],
    "warnings": []
  },
  "entry_timing": {
    "confirmed": true,
    "momentum_score": 65,
    "volume_spike": true,
    "price_breakout": true
  }
}
```

### 2.2 From Market Data (Real-Time)

Via WebSocket (or REST fallback):
- Current price (LTP)
- Volume
- Bid/Ask spread
- OHLC (1-minute candles)

### 2.3 From Portfolio Agent (Read-Only)

- Current open positions
- Position P&L (realized & unrealized)
- Capital available
- Daily realized P&L
- Win/loss streaks

### 2.4 From Discipline Engine (Signals)

```json
{
  "action": "EXIT" | "MODIFY",
  "reason": "CIRCUIT_BREAKER" | "COOLDOWN" | "SESSION_HALT" | "LOSS_LIMIT",
  "position_id": "POS-20260409120530-1",
  "params": {
    "new_SL": 175.0,
    "new_TP": 200.0
  }
}
```

### 2.5 From SEA / AI Signals (Continuous Signals)

```json
{
  "position_id": "POS-20260409120530-1",
  "action": "EXIT" | "MODIFY",
  "signal": "TREND_REVERSAL" | "BREAKOUT_FAILED" | "NEW_DIRECTION" | "ANOMALY",
  "reason": "Momentum reversed from bullish to bearish",
  "params": {
    "new_SL": 180.0,
    "new_TP": 220.0,
    "new_TSL": {
      "enabled": true,
      "distance": 5.0
    }
  }
}
```

---

## 3. Outputs

### 3.1 Trade Approval (forwarded to TradeExecutorAgent)

```json
{
  "action": "APPROVE" | "REDUCE_SIZE" | "REJECT" | "REVIEW",
  "reason": "Optional explanation",
  "approved_trade": {
    "direction": "BUY",
    "entry_price": 185.50,
    "stop_loss": 176.22,
    "take_profit": 220.00,
    "trailing_stop_loss": {
      "enabled": false
    },
    "position_size": 50,
    "risk_score": 0.35,
    "constraints": {
      "max_loss_per_trade": 500,
      "max_position_size": 75,
      "volatility_multiplier": 0.9
    }
  }
}
```

### 3.2 Exit Commands (to TradeExecutorAgent)

```json
{
  "command": "EXIT",
  "position_id": "POS-20260409120530-1",
  "reason": "MOMENTUM_EXIT" | "SL_HIT" | "TP_HIT" | "AGE_EXIT" | 
           "DISCIPLINE_EXIT" | "AI_EXIT",
  "exit_type": "MARKET" | "LIMIT",
  "exit_price": 190.0,
  "current_price": 190.50,
  "current_pnl": 250.00
}
```

### 3.3 Modification Commands (to TradeExecutorAgent)

```json
{
  "command": "MODIFY",
  "position_id": "POS-20260409120530-1",
  "modifications": {
    "new_SL": 180.00,
    "new_TP": 225.00,
    "new_TSL": {
      "enabled": true,
      "distance": 5.0,
      "trigger": 50.0
    }
  },
  "reason": "MOMENTUM_ADJUSTMENT" | "VOLATILITY_ADJUSTMENT" | 
           "AI_SIGNAL" | "DISCIPLINE_REQUEST",
  "detail": "Momentum increased to 75, extending TP and enabling TSL"
}
```

---

## 4. Core Responsibilities

### 4.1 Trade Approval (Entry Gate)

When a validated trade request arrives (SEA signal that has already passed Discipline.validateTrade):

```
1. Validate the incoming trade request
   ├─ Check confidence >= MIN_CONFIDENCE
   ├─ Check R:R >= MIN_RISK_REWARD
   └─ Check entry price > 0, strike valid

2. Check capital constraints
   ├─ Available capital >= estimated trade value
   ├─ Position size won't exceed max
   └─ Daily exposure < max portfolio exposure

3. Check market conditions
   ├─ Volatility not extreme (don't trade in spikes)
   ├─ Liquidity sufficient (bid-ask not too wide)
   └─ LTP aligns with entry price (slippage reasonable)

4. Check Discipline constraints
   ├─ Is trading allowed? (time window, count limits)
   ├─ Daily caps not hit? (profit/loss limits)
   └─ Cooldown active? (no entry after recent loss)

5. Decide position size
   ├─ Base on capital & trade target
   ├─ Apply volatility adjustment
   ├─ Apply risk multiplier (from performance)
   └─ Floor at 1 lot, cap at max

6. Output decision
   ├─ APPROVE: trade approved with final SL/TP/size
   ├─ REDUCE_SIZE: approve but smaller qty
   ├─ REJECT: insufficient conditions
   └─ REVIEW: borderline case (flag for monitoring)
```

### 4.2 Real-Time Monitoring (Continuous)

For each OPEN position, every 1-5 seconds:

```
1. Get current market price (WebSocket)

2. Check exit conditions (in order of precedence):
   
   A. Discipline signals (MANDATORY)
      └─ If received: execute immediately
      
   B. RCA's own rules (ADAPTIVE)
      ├─ Price <= SL → full exit
      ├─ Price >= TP → full exit
      ├─ Momentum < 30 → full exit
      ├─ Momentum < 50 while in profit → partial exit
      ├─ Trade age > 10 min → force exit
      └─ Trade age > 5 min with no progress → exit
      
   C. AI signals (VALIDATED)
      ├─ If trend reversal detected
      ├─ If breakout failed
      ├─ If anomaly detected
      └─ RCA validates against momentum/volatility before executing

3. Check modification opportunities (live trades only):
   ├─ Momentum increased significantly → extend TP or enable TSL
   ├─ Volatility spike detected → tighten SL
   ├─ Support/resistance level detected → adjust SL to new level
   └─ Trend acceleration → increase TP target

4. Send commands to TradeExecutor:
   ├─ exitTrade(position_id, reason)
   ├─ modifyOrder(position_id, new_SL, new_TP, new_TSL)
   └─ Log all decisions with timestamp
```

### 4.3 Paper Trade Management

For positions with `environment: "paper"`:

```
RCA owns COMPLETE lifecycle:

Entry:
  ├─ Receive validated trade request (SEA → Discipline.validateTrade → RCA)
  ├─ Send to TradeExecutor: submitTrade(paper)
  └─ TradeExecutor places paper order

Monitoring:
  ├─ RCA monitors real-time price
  ├─ RCA detects SL hit
  ├─ RCA detects TP hit
  └─ RCA monitors for other exit conditions

Exit:
  ├─ RCA decides exit (momentum, age, AI signal, etc)
  ├─ Send to TradeExecutor: exitTrade(paper, position_id, reason)
  ├─ TradeExecutor places SELL order (paper adapter)
  └─ Portfolio Agent records outcome
```

### 4.4 Live Trade Management

For positions with `environment: "live"`:

```
RCA monitors & requests, Broker executes:

Entry:
  ├─ Receive validated trade request (SEA → Discipline.validateTrade → RCA)
  ├─ Send to TradeExecutor: submitTrade(live)
  ├─ TradeExecutor attaches SL/TP/TSL to broker order
  └─ Broker manages auto-exit when SL/TP hit

Monitoring:
  ├─ RCA monitors real-time price (backup monitoring)
  ├─ RCA detects if adjustments needed (SL/TP/TSL drift)
  ├─ RCA monitors for momentum/volatility changes
  └─ RCA receives exit events from Broker (SL/TP hit)

Modification:
  ├─ RCA decides: "SL needs tightening" or "TP can extend"
  ├─ Send to TradeExecutor: modifyOrder(live, new_SL, new_TP)
  ├─ TradeExecutor calls brokerService.modifyOrder()
  └─ Broker updates its SL/TP/TSL

Exit:
  ├─ If SL/TP hit by broker → receive event, record
  ├─ If RCA decides exit → send to TradeExecutor: exitTrade(live)
  │  ├─ TradeExecutor cancels broker's pending SL/TP orders
  │  ├─ TradeExecutor places SELL market order
  │  └─ Portfolio Agent records outcome
  └─ If Discipline signals exit → RCA honors it, sends to TradeExecutor
```

### 4.5 Handle External Requests (Discipline & AI/SEA)

```
From Discipline Engine:
  ├─ Receive: POST /api/risk-control/discipline-request
  ├─ Extract: action (EXIT|MODIFY), reason, params
  ├─ Decision: MUST honor (hard rules override RCA's decision)
  └─ Execute: immediately send to TradeExecutor

From AI/SEA signals:
  ├─ Receive: POST /api/risk-control/ai-signal
  ├─ Extract: action (EXIT|MODIFY), signal, reason, params
  ├─ Validate: Does AI signal align with current momentum/volatility?
  │  ├─ If YES (aligned) → Execute
  │  ├─ If NO (conflict) → Log rejection, don't execute
  │  └─ Optionally notify SEA of rejection
  └─ Execute (if valid): send to TradeExecutor
```

---

## 5. Exit Decision Matrix (Precedence)

When multiple exit conditions trigger simultaneously, apply in this order:

```
Priority 1: DISCIPLINE SIGNALS (MANDATORY)
  └─ "Circuit breaker hit" → EXIT_ALL immediately
  └─ "Daily loss limit" → EXIT_ALL immediately
  └─ "Cooldown active" → EXIT_THIS immediately
  └─ "Session halt" → EXIT_ALL immediately

Priority 2: RCA OWN RULES (ADAPTIVE)
  ├─ Price <= SL → FULL_EXIT
  ├─ Price >= TP → FULL_EXIT
  ├─ Momentum < 30 → FULL_EXIT
  ├─ Trade age > 10 min → FORCE_EXIT
  ├─ Trade age > 5 min, no progress → FULL_EXIT
  ├─ Momentum < 50 while +profit → PARTIAL_EXIT
  └─ Momentum > 70 while +profit → HOLD or PYRAMID

Priority 3: AI/SEA SIGNALS (VALIDATED)
  ├─ Trend reversal (IF momentum confirms) → EXIT
  ├─ Breakout failed (IF price confirmation) → EXIT
  ├─ Anomaly detected (IF volatility check passes) → EXIT
  └─ (RCA validates before executing)

Rule:
  If Discipline signal arrives → ALL other rules paused, execute Discipline
  If RCA rule triggered → Check for AI/SEA validation
  If AI/SEA signal arrives → Validate, then execute or reject
```

---

## 6. Real-Time Monitoring Logic

### 6.1 Check Frequency

```
Paper Trades:    Every 1 second (tight control)
Live Trades:     Every 1-5 seconds (price via WebSocket)
```

### 6.2 Momentum Calculation

```
Dual-window approach (if WebSocket available):
  ├─ Fast window: 30s-1m momentum (recent move)
  ├─ Slow window: 2-3m momentum (sustained trend)
  └─ Score: 0-100
       - < 30: Dying momentum (EXIT)
       - 30-50: Weak momentum (PARTIAL_EXIT if in profit)
       - 50-70: Holding momentum (HOLD, tighten SL)
       - > 70: Strong momentum (HOLD, extend TP, pyramid if in profit)
```

### 6.3 Exit Check Function (Pseudo-code)

```python
def monitor_position(position, current_price):
    """
    Check if position should exit. Returns (exit_type, reason) or (None, None)
    """
    
    # 1. Check Discipline signals (these come via API, not price-based)
    if discipline_signal_received(position.id):
        signal = get_discipline_signal(position.id)
        return (signal.action, f"DISCIPLINE: {signal.reason}")
    
    # 2. Check SL/TP hits
    if current_price <= position.stop_loss:
        return ("FULL_EXIT", f"SL_HIT: {current_price} <= {position.stop_loss}")
    
    if current_price >= position.take_profit:
        return ("FULL_EXIT", f"TP_HIT: {current_price} >= {position.take_profit}")
    
    # 3. Check momentum-based exits
    momentum = get_momentum_score(position)
    pnl_pct = (current_price - position.entry_price) / position.entry_price * 100
    
    if momentum < 30:
        return ("FULL_EXIT", f"MOMENTUM: {momentum:.0f} < 30 (dying)")
    
    if momentum < 50 and pnl_pct > 0:
        return ("PARTIAL_EXIT", f"MOMENTUM: {momentum:.0f} weak while +{pnl_pct:.1f}%")
    
    # 4. Check trade age
    age_seconds = get_position_age_seconds(position)
    
    if age_seconds > 600:  # 10 minutes
        return ("FULL_EXIT", f"AGE: {age_seconds/60:.1f} min > 10 (force exit)")
    
    if age_seconds > 300 and pnl_pct <= 1.0:  # 5 minutes, no progress
        return ("FULL_EXIT", f"AGE: {age_seconds/60:.1f} min, no progress ({pnl_pct:+.1f}%)")
    
    # 5. Check AI/SEA signals (async, non-blocking)
    if ai_signal_received(position.id):
        signal = get_ai_signal(position.id)
        if validate_ai_signal(signal, momentum, current_volatility):
            return (signal.action, f"AI/SEA: {signal.signal} - {signal.reason}")
        else:
            log_ai_rejection(position.id, signal)
    
    # 6. No exit condition met
    return (None, None)
```

---

## 7. API Contracts

### 7.1 Trade Approval (from Discipline.validateTrade upstream, invoked by SEA)

```
POST /api/risk-control/evaluate

Request:
{
  "instrument": "NIFTY_50",
  "signal": { ... },                // SEA signal that passed Discipline.validateTrade
  "discipline_status": { ... },
  "timestamp": "2026-04-09T10:15:35Z"
}

Response (200 OK):
{
  "action": "APPROVE" | "REDUCE_SIZE" | "REJECT" | "REVIEW",
  "reason": "Trade approved with adjusted SL",
  "approved_trade": {
    "direction": "BUY",
    "entry_price": 185.50,
    "stop_loss": 176.22,
    "take_profit": 220.00,
    "trailing_stop_loss": {...},
    "position_size": 50,
    "risk_score": 0.35,
    "constraints": {...}
  }
}

Response (400 Bad Request):
{
  "action": "REJECT",
  "reason": "Confidence score below minimum threshold"
}
```

### 7.2 AI/SEA Signal Request

```
POST /api/risk-control/ai-signal

Request:
{
  "position_id": "POS-20260409120530-1",
  "action": "EXIT" | "MODIFY",
  "signal": "TREND_REVERSAL" | "BREAKOUT_FAILED" | "NEW_DIRECTION" | "ANOMALY",
  "reason": "Momentum reversed from bullish to bearish",
  "params": {
    "new_SL": 180.0,
    "new_TP": 220.0,
    "new_TSL": { "enabled": true, "distance": 5.0 }
  },
  "timestamp": "2026-04-09T10:15:35Z"
}

Response (200 OK):
{
  "accepted": true,
  "executed": true,
  "reason": "AI signal validated against current momentum (72 > 50)",
  "command_id": "CMD-20260409-12345"
}

Response (200 OK - Rejected):
{
  "accepted": false,
  "executed": false,
  "reason": "AI/SEA exit signal conflicts with current momentum (45 < 50 threshold). Not executing.",
  "command_id": null
}
```

### 7.3 Discipline Signal Request

```
POST /api/risk-control/discipline-request

Request:
{
  "position_id": "POS-20260409120530-1" | null,  // null = all positions
  "action": "EXIT" | "MODIFY",
  "reason": "CIRCUIT_BREAKER" | "COOLDOWN" | "SESSION_HALT" | "LOSS_LIMIT",
  "params": {
    "new_SL": 175.0,
    "new_TP": 200.0
  },
  "timestamp": "2026-04-09T10:15:35Z"
}

Response (200 OK):
{
  "accepted": true,
  "executed": true,
  "affected_positions": ["POS-20260409120530-1"],
  "reason": "Discipline signal honored (hard rule)",
  "command_ids": ["CMD-20260409-12346"]
}
```

### 7.4 Internal Call to TradeExecutorAgent

```
Note: These are INTERNAL calls, not external APIs

RCA → TradeExecutor:
  POST /api/executor/submitTrade
  POST /api/executor/modifyOrder
  POST /api/executor/exitTrade

(See TradeExecutorAgent_Spec_v1.2 for details)
```

---

## 8. Configuration & Parameters

```python
# Momentum thresholds
MOMENTUM_STRONG = 70         # Add to position, extend TP
MOMENTUM_WEAK_EXIT = 50      # Partial exit if in profit
MOMENTUM_DIE = 30            # Full exit

# Trade age thresholds
TRADE_AGE_FORCE_EXIT = 600   # 10 minutes (force exit)
TRADE_AGE_NO_PROGRESS = 300  # 5 minutes (exit if no move)
TRADE_AGE_CHECK = 120        # 2 minutes (first check)

# Hard SL (from Risk Control rules)
HARD_STOP_LOSS_PCT = -5.0    # -5% from entry

# Profit targets
PROFIT_TAKE_PARTIAL = 6.0    # +6% partial exit
PROFIT_TAKE_FULL = 10.0      # +10% full exit

# Monitoring
MONITOR_INTERVAL = 1-5       # seconds (configurable)
MOMENTUM_CALC_FAST = 60      # 1 minute
MOMENTUM_CALC_SLOW = 180     # 3 minutes

# Position sizing
MIN_QUANTITY = 1             # minimum lot
MAX_POSITION_SIZE = 100      # quantity cap

# Volatility adjustment
VOLATILITY_MULTIPLIER_MIN = 0.25
VOLATILITY_MULTIPLIER_MAX = 1.0
VOLATILITY_SPIKE_THRESHOLD = 2.0  # 2x normal IV
```

---

## 9. What RCA Does NOT Do

```
❌ RCA does NOT:
  ├─ Call broker directly (TradeExecutor does)
  ├─ Track positions in-memory long-term (Portfolio Agent owns)
  ├─ Record trade outcomes (Portfolio Agent does)
  ├─ Enforce pre-trade rules (Discipline Engine does)
  ├─ Persist state to database (Portfolio Agent does)
  └─ Generate AI signals (SEA does)

✅ RCA:
  ├─ Makes real-time decisions
  ├─ Monitors open positions
  ├─ Sends commands to TradeExecutor
  ├─ Validates external signals
  └─ Reads state from Portfolio Agent (query-only)
```

---

## 10. Testing Strategy

### 10.1 Unit Tests (30+ tests)

```
Trade Approval Tests:
  - ✅ Approve valid trade
  - ✅ Reject low confidence
  - ✅ Reject insufficient capital
  - ✅ Reject during no-trade window
  - ✅ Adjust position size based on volatility
  - ✅ Apply risk multiplier

Exit Decision Tests:
  - ✅ Exit on SL hit
  - ✅ Exit on TP hit
  - ✅ Exit on momentum < 30
  - ✅ Partial exit on momentum < 50 while in profit
  - ✅ Force exit on trade age > 10 min
  - ✅ Honor Discipline signal (priority test)
  - ✅ Validate AI/SEA signal (accept valid, reject conflicting)

Modification Tests:
  - ✅ Tighten SL on volatility spike
  - ✅ Extend TP on momentum increase
  - ✅ Enable TSL on trend confirmation
  - ✅ Reject invalid modification (SL > TP)

Paper vs Live Tests:
  - ✅ Paper: RCA manages all exits
  - ✅ Live: Broker manages auto-exit, RCA monitors
  - ✅ Live: modifyOrder sends to broker
  - ✅ Live: RCA can request exit
```

### 10.2 Integration Tests (10+ tests)

```
SEA → Discipline.validateTrade → RCA → TradeExecutor:
  - ✅ Full trade lifecycle (entry, monitor, exit)
  - ✅ Paper trade scenario
  - ✅ Live trade scenario
  - ✅ SL/TP modification during hold

Discipline Engine → RCA → TradeExecutor:
  - ✅ Circuit breaker triggers exit
  - ✅ Cooldown blocks entry
  - ✅ Session halt forces close

SEA (AI signals) → RCA → TradeExecutor:
  - ✅ Trend reversal signal accepted
  - ✅ Conflicting AI/SEA signal rejected
  - ✅ Multiple signals handled in order

Portfolio Agent Integration:
  - ✅ RCA reads position state correctly
  - ✅ RCA reads capital state correctly
  - ✅ RCA respects capital constraints
```

### 10.3 Stress Tests

```
- ✅ 100+ concurrent position monitoring
- ✅ High-frequency signal arrival (multiple per second)
- ✅ Network latency to Broker (500ms delays)
- ✅ Momentum calculation during extreme volatility
- ✅ Multiple exit conditions triggering simultaneously
```

---

## 11. Implementation Plan

### Phase 1: Foundation (Week 1-2)
- [ ] Create RCA service skeleton
- [ ] Implement trade approval logic
- [ ] Build momentum calculation engine
- [ ] Create exit decision logic (core rules)
- [ ] Implement API endpoints (/evaluate, /ai-request, /discipline-request)

### Phase 2: Monitoring & Management (Week 2-3)
- [ ] Build real-time monitoring loop
- [ ] Implement paper trade exit handling
- [ ] Implement live trade modification requests
- [ ] Implement Discipline signal handling
- [ ] Implement AI signal validation

### Phase 3: Integration (Week 3-4)
- [ ] Wire from Discipline.validateTrade (SEA upstream)
- [ ] Wire to TradeExecutorAgent
- [ ] Wire to Portfolio Agent
- [ ] Wire to Discipline Engine (signals in)
- [ ] Wire to SEA (AI signal channel)

### Phase 4: Testing & Hardening (Week 4)
- [ ] Unit tests (30+ tests)
- [ ] Integration tests (10+ tests)
- [ ] Performance/stress tests
- [ ] Error handling & recovery
- [ ] Documentation & runbooks

---

## 12. Deployment & Rollout

```
Stage 1: Paper Trading Only
  └─ Deploy to paper_trading workspace
  └─ Monitor for 2-3 days
  └─ Verify monitoring, exits, modifications

Stage 2: Live Trading (With Caution)
  └─ Deploy to live workspace
  └─ Start with small position sizes
  └─ Monitor for drift, errors, slippage
  └─ Gradually increase sizes

Stage 3: Full Production
  └─ Remove safeguards (size caps, etc)
  └─ Monitor performance metrics
  └─ Adjust thresholds based on live data
```

---

## 13. Monitoring & Observability

### RCA Health Metrics

```
- Position monitoring latency (should be < 2 sec)
- Exit decision latency (< 100ms)
- API response time (< 500ms)
- Accuracy of momentum calculation
- False positive exits (exits that shouldn't have happened)
- Signal handling rate (AI, Discipline signals processed)
- Position count (open, closed, pending)
```

### Logs & Traces

```
Every decision logged:
  - Timestamp
  - Position ID
  - Current price, momentum, P&L
  - Decision made (hold, exit, modify)
  - Reason for decision
  - Command sent to TradeExecutor
  - Response from TradeExecutor
```

---

## 14. Success Criteria

- ✅ All positions monitored in real-time (< 5sec latency)
- ✅ Paper trades fully managed by RCA (entry to exit)
- ✅ Live trades: RCA monitors, Broker executes SL/TP
- ✅ Discipline signals honored (hard rules enforced)
- ✅ AI signals validated before execution
- ✅ Zero unauthorized broker calls (only TradeExecutor)
- ✅ Portfolio Agent receives all position updates
- ✅ 100+ unit & integration tests passing
- ✅ No duplicate exits or modifications
- ✅ Slippage tracked and logged

---

## 15. Future Enhancements

```
v2.1: Machine learning optimization
  └─ Predict optimal SL/TP based on historical data
  
v2.2: Advanced pyramiding
  └─ Intelligent position add-ons based on trend strength
  
v2.3: Dynamic position sizing
  └─ Adjust qty based on real-time volatility
  
v3.0: Multi-asset correlation
  └─ Consider portfolio correlation for sizing & exits
```

---

## Appendix A: Exit Reason Codes

```
SL_HIT              Price <= stop loss
TP_HIT              Price >= take profit
MOMENTUM_EXIT       Momentum < threshold
AGE_EXIT            Trade age > max time
DISCIPLINE_EXIT     Discipline Engine signal
AI_EXIT             AI/SEA signal
VOLATILITY_EXIT     IV spike detected
REVERSAL_EXIT       Trend reversal detected
ANOMALY_EXIT        Price anomaly detected
PROFIT_EXIT         Profit target partial exit
PYRAMID_HOLD        Holding for pyramid add
FORCE_EXIT          Force close due to age/rules
```

---

**Status:** Ready for Implementation
**Approval:** User (2026-04-09)
**Owner:** AI Team
**Next:** TradeExecutorAgent_Spec_v1.2.md
