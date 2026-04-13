# ⚠️ DEPRECATED — AI Decision Engine — Technical Specification

> **DEPRECATED (2026-04-13):** This spec is superseded by the ML model-based pipeline.
> The ML model (trained by Model Training Agent on TFA features) sends signals directly to RCA.
> There is no separate Decision Engine. See `TickFeatureAgent_Spec_1.0.md` §9.2 for the ML input pipeline.

**Version:** 3.0  
**Date:** April 9, 2026  
**Status:** ~~Implementation Ready~~ **DEPRECATED**  
**Type:** Python module (ai_decision_engine.py)  
**Dependencies:** Analyzer (technical analysis), News Sentiment Engine, RiskControlAgent_Spec_v2.0, DisciplineEngine_Spec_v1.2

---

## Revision History

| Version | Date | Description |
|---------|------|-------------|
| v1.0 | 2026-04-02 | Initial specification based on Python module source code |
| v2.0 | 2026-04-02 | Split from monolithic spec into standalone module spec. Added v2.4 enhancements: Trade Quality Filter, Bounce/Breakdown Engine, No Trade Detection, Theta/IV Protection. |
| **v3.0** | **2026-04-09** | **MAJOR REFACTOR:** Merged execution_module.py responsibilities into Decision Engine. Removed all broker calls and position tracking. Added decision-to-RCA flow, discipline integration, entry timing confirmation, AI signal generation for continuous monitoring. Single responsibility: Generate trade suggestions. |

---

## 1. Overview

The AI Decision Engine is a **pure decision-making module** that generates trade suggestions with confidence scores and complete trade setups. It is the core technical analysis engine.

**Key principle:** The Decision Engine does NOT execute trades, call brokers, track positions, or manage exits. It only:
- Analyzes market data
- Checks pre-trade constraints via Discipline Engine
- Validates entry timing
- Generates trade suggestions → sends to Risk Control Agent
- Monitors open positions and sends exit signals to RCA (not broker)

**File:** `server/ai-engine/ai-decision-engine.py` (consolidated from v2.0 + execution_module.py)

**Execution Architecture:** Decision Engine → RCA → TradeExecutor → Broker

---

## 2. Responsibilities

The AI Decision Engine is responsible for:

| # | Responsibility | Input | Output |
|---|---|---|---|
| 1 | Load market data & AI analysis | Option chain, Analyzer output | Data ready for decision |
| 2 | Call Discipline Engine (pre-trade) | Instrument, settings | "Trade allowed?" response |
| 3 | Calculate entry timing (momentum, volume, breakout) | Real-time price, momentum score | Timing confidence (0-100%) |
| 4 | Generate trade setup (entry, SL, TP, R:R) | Market data, entry price, S/R levels | Complete trade plan |
| 5 | Determine confidence & risk flags | All analysis factors | Confidence score, warnings |
| 6 | Send decision to Risk Control Agent | Trade setup, confidence | HTTP POST to RCA |
| 7 | Detect trend reversals & anomalies (continuous) | Open positions, real-time data | Exit signal suggestions to RCA |
| 8 | Send modification requests (continuous) | Position monitoring | SL/TP/TSL adjustment requests |

---

## 3. Architecture

### 3.1 Core Flow

```
Market Data
    ↓
Analyzer Output
    ↓
┌─────────────────────────────────────┐
│   AI DECISION ENGINE (v3.0)         │
│                                      │
│  1. Load data & analyze             │
│  2. Check Discipline (allowed?)      │
│  3. Validate entry timing           │
│  4. Generate trade setup            │
│  5. Calculate confidence & flags    │
│  6. Output: Trade Decision          │
└──────────────┬──────────────────────┘
               │
               ├─→ JSON file: ai_decision_{instrument}.json
               │
               └─→ HTTP POST to RCA
                   /api/risk-control/ai-decision-request
                   
                   ↓
            Risk Control Agent
            (Approves/validates)
                   ↓
            Trade Executor Agent
            (Executes the order)
                   ↓
            Broker Service
```

### 3.2 Continuous Monitoring Loop

```
Every 1-5 seconds (while position open):
  1. Fetch real-time price, momentum, volatility
  2. Check for trend reversal
  3. Check for momentum divergence
  4. Check for anomalies
  5. If signal detected: → Send to RCA
     - Type: "exit_suggestion" | "modify_sl" | "modify_tp"
     - RCA validates & executes
```

### 3.3 Module Breakdown

```
ai_decision_engine.py
├── data_loader
│   ├── load_analyzer_output()
│   ├── load_option_chain()
│   └── load_news_sentiment()
│
├── discipline_integration
│   ├── check_discipline_engine()    [NEW v3.0]
│   ├── check_time_window()
│   └── check_pre_trade_limits()
│
├── decision_engine
│   ├── wall_strength_analysis()
│   ├── assess_iv()
│   ├── assess_theta()
│   ├── compute_weighted_score()
│   ├── generate_trade_setup()
│   ├── compute_risk_flags()
│   └── apply_pre_trade_filters()
│
├── entry_timing
│   ├── validate_entry_timing()     [NEW v3.0]
│   ├── check_momentum_confirmation()
│   ├── check_volume_spike()
│   └── check_price_breakout()
│
├── signal_generation
│   ├── generate_ai_decision()       [NEW v3.0]
│   ├── detect_trend_reversal()      [NEW v3.0]
│   ├── detect_momentum_divergence() [NEW v3.0]
│   ├── detect_anomalies()           [NEW v3.0]
│   └── generate_exit_signal()       [NEW v3.0]
│
└── rca_integration
    ├── send_decision_to_rca()       [NEW v3.0]
    ├── send_exit_signal_to_rca()    [NEW v3.0]
    └── send_modify_request_to_rca() [NEW v3.0]
```

---

## 4. Inputs

### 4.1 Market Data Sources

| Source | Purpose | Update Frequency |
|--------|---------|------------------|
| Analyzer output | Technical analysis (S/R, entry/exit signals, bias) | Every 60 seconds |
| Option chain | IV, theta, OI, volume, current prices | Every 5-10 seconds |
| News Sentiment | News-driven bias | Every 30 seconds |
| Real-time WebSocket (RCA provides) | Current price, momentum, volatility | 1-5 seconds |

### 4.2 Pre-Trade Checks

Before generating a decision, Decision Engine queries:

| Check | Source | Response |
|-------|--------|----------|
| "Is trade allowed?" | Discipline Engine /api/discipline/validateTrade | `{ allowed: boolean, blockedBy: [...] }` |
| "Entry timing confirmed?" | Real-time momentum score | momentum >= 70 for GO_CALL? |
| "Volume spike detected?" | Option chain volume vs average | Current volume > 1.5x average? |
| "Price breakout sustained?" | Real-time LTP vs resistance | Price > resistance AND holding? |

---

## 5. Decision Output Format (Enhanced in v3.0)

The Decision Engine writes to **ai_decision_{instrument}.json** with enhanced structure:

```json
{
  "timestamp": "2026-04-09T10:15:35Z",
  "instrument": "NIFTY_50",
  
  "direction": "GO_CALL",
  "trade_type": "CALL_BUY",
  "confidence_score": 0.72,
  
  "trade_setup": {
    "strike": 24150,
    "option_type": "CE",
    "entry_price": 185.50,
    "target_price": 241.15,
    "target_pct": 30.0,
    "stop_loss": 148.40,
    "sl_pct": 20.0,
    "risk_reward": 1.5,
    "delta": 0.550
  },

  "discipline_status": {
    "allowed": true,
    "blocked_by": [],
    "warnings": [],
    "checked_at": "2026-04-09T10:15:30Z"
  },

  "entry_timing": {
    "confirmed": true,
    "momentum_score": 78,
    "momentum_threshold": 70,
    "volume_spike": true,
    "volume_ratio": 2.1,
    "price_breakout": true,
    "breakout_distance_pct": 0.8
  },

  "market_context": {
    "support_level": 24000,
    "support_strength": 75,
    "support_prediction": "BOUNCE",
    "resistance_level": 24300,
    "resistance_strength": 42,
    "resistance_prediction": "BREAKOUT",
    "iv_assessment": "FAIR",
    "atm_iv": 14.2,
    "theta_assessment": "CAUTION",
    "days_to_expiry": 3
  },

  "risk_flags": [
    {
      "type": "warning",
      "text": "Strong resistance at 24300 — may cap upside"
    }
  ],

  "scoring_factors": {
    "oi_support_resistance": { "score": 0.80, "weight": 0.30 },
    "oi_momentum": { "score": 0.30, "weight": 0.25 },
    "iv_level": { "score": 0.20, "weight": 0.15 },
    "pcr_trend": { "score": 0.70, "weight": 0.10 },
    "news_sentiment": { "score": 0.35, "weight": 0.10 },
    "theta_risk": { "score": -0.20, "weight": 0.10 }
  },

  "ai_decision_id": "ai_dec_20260409_nifty_001",
  "version": "3.0"
}
```

---

## 6. API Integration with RCA

### 6.1 Send Decision (Entry Point)

**Endpoint:** `POST /api/risk-control/ai-decision-request`

```json
{
  "ai_decision_id": "ai_dec_20260409_nifty_001",
  "instrument": "NIFTY_50",
  "direction": "GO_CALL",
  "confidence_score": 0.72,
  
  "trade_setup": {
    "entry_price": 185.50,
    "target_price": 241.15,
    "stop_loss": 148.40,
    "risk_reward": 1.5
  },
  
  "discipline_status": {
    "allowed": true,
    "warnings": []
  },
  
  "entry_timing": {
    "confirmed": true,
    "momentum_score": 78
  },
  
  "risk_flags": [...],
  "timestamp": "2026-04-09T10:15:35Z"
}
```

**RCA Response:** (202 Accepted)
```json
{
  "received": true,
  "rca_decision_id": "rca_eval_20260409_001",
  "status": "evaluating"
}
```

### 6.2 Send Continuous Exit Signals

**Endpoint:** `POST /api/risk-control/ai-signal`

```json
{
  "signal_type": "exit_suggestion",
  "position_id": "pos_789",
  "reason": "Trend reversal detected — momentum dropped to 25",
  "confidence": 0.85,
  
  "technical_evidence": {
    "momentum_score": 25,
    "momentum_drop_from": 78,
    "divergence_type": "momentum_divergence",
    "price_action": "Lower high, lower low pattern"
  },
  
  "recommendation": "EXIT_THIS_POSITION",
  "timestamp": "2026-04-09T10:45:12Z"
}
```

### 6.3 Send Modification Suggestions

**Endpoint:** `POST /api/risk-control/ai-signal`

```json
{
  "signal_type": "modify_sl",
  "position_id": "pos_789",
  "reason": "Volatility spike detected — tighten SL for protection",
  
  "modification": {
    "sl_current": 148.40,
    "sl_suggested": 155.20,
    "sl_reason": "Move SL to break-even + 1% (volatility: 42%)"
  },
  
  "confidence": 0.70,
  "timestamp": "2026-04-09T10:20:15Z"
}
```

---

## 7. Discipline Engine Integration (NEW v3.0)

Before generating a decision, the Decision Engine queries Discipline Engine:

```typescript
interface DisciplinePreTradeCheck {
  allowed: boolean;
  blockedBy: string[];           // e.g., ["circuit_breaker", "no_trading_window"]
  warnings: string[];            // e.g., ["Cooldown active — recovery period"]
  reason?: string;
}

// Decision Engine calls:
const disciplineCheck = await fetch(
  "/api/discipline/validateTrade",
  {
    instrument: "NIFTY_50",
    direction: "GO_CALL",
    entryPrice: 185.50,
    quantity: 1,
    estimatedValue: 185.50,
  }
);

if (!disciplineCheck.allowed) {
  // Skip trade: disciplined approach
  output.direction = "WAIT";
  output.decision_reason = `Discipline blocked: ${disciplineCheck.blockedBy[0]}`;
  return output;
}
```

---

## 8. Entry Timing Validation (NEW v3.0)

**Purpose:** Ensure entry timing is confirmed before sending decision to RCA.

### 8.1 Momentum Confirmation

```typescript
interface EntryTiming {
  confirmed: boolean;
  momentum_score: number;        // 0-100 scale
  momentum_threshold: number;    // 70 for GO_CALL, 30 for GO_PUT
  volume_spike: boolean;
  volume_ratio: number;
  price_breakout: boolean;
  breakout_distance_pct: number;
}

// For GO_CALL: Require momentum >= 70
// For GO_PUT: Require momentum <= 30
// Momentum provided by RCA in real-time or last known value
```

### 8.2 Volume Spike Check

```typescript
// Current option volume vs 5-period average
volumeSpike = (currentVolume / avgVolume) >= 1.5;

// If GO_CALL: require volume spike on call side
// If GO_PUT: require volume spike on put side
```

### 8.3 Price Breakout Confirmation

```typescript
// For GO_CALL resistance breakout:
priceAboveResistance = currentPrice > resistanceLevel;
breakoutSustained = currentPrice > resistanceLevel + (0.5% of resistance);

// If both true: breakout confirmed
// Otherwise: revert direction to WAIT
```

---

## 9. Continuous Monitoring: Exit Signals (NEW v3.0)

While a position is open, Decision Engine monitors for exit signals and sends them to RCA.

### 9.1 Trend Reversal Detection

**Signals:**
- Lower High pattern (price made lower high after previous high)
- Lower Low pattern (price made lower low after previous low)
- Support broken below (price closed below support, volume confirmed)
- Resistance broken above (price closed above resistance, volume confirmed then reversed)

```typescript
interface TrendReversal {
  detected: boolean;
  pattern: "lower_high" | "lower_low" | "support_broken" | "resistance_reversal";
  confidence: number;            // 0-100
  bars_since_reversal: number;
}

// Send to RCA: "Trend reversed — momentum now bearish, consider exit"
```

### 9.2 Momentum Divergence

```typescript
interface MomentumDivergence {
  type: "bearish" | "bullish";
  price_trend: "up" | "down";
  momentum_trend: "down" | "up";   // Opposite of price trend
  divergence_bars: number;
  severity: "mild" | "moderate" | "severe";
}

// Bearish divergence: Price making higher highs but momentum weakening
// Send to RCA: "Momentum divergence detected — consider exit or tighten SL"
```

### 9.3 Anomaly Detection

```typescript
interface AnomalySignal {
  anomaly_type: "iv_crush" | "theta_spike" | "volatility_collapse" | "volume_drying_up";
  severity: "warning" | "critical";
  recommendation: "EXIT" | "TIGHTEN_SL" | "HOLD";
}

// IV Crush: IV dropped >20% unexpectedly (theta accelerating)
// Theta Spike: With <2 days to expiry, theta acceleration extreme
// Volume Drying: Option volume dropped 50% within 2 bars
```

---

## 10. Output Files (Unchanged from v2.0)

Decision Engine writes to JSON file:

```
output/ai_decision_{INSTRUMENT}.json
```

Format: See Section 5 (Decision Output Format).

**Additional output (NEW v3.0):**

```
output/ai_exit_signals_{INSTRUMENT}.json  [Optional: logging for audit]
output/ai_modify_requests_{INSTRUMENT}.json [Optional: logging for audit]
```

---

## 11. What Decision Engine Does NOT Do (v3.0 Clarification)

**Removed responsibilities** (moved to other agents):

| Responsibility | Moved To | Reason |
|---|---|---|
| Call broker directly | TradeExecutor | Single execution point |
| Place orders | TradeExecutor | Execution is separate |
| Track open positions | Portfolio Agent | Centralized state |
| Manage SL/TP | RCA | Real-time adjustments |
| Handle order fills | TradeExecutor | Event handling |
| Record trade outcomes | Portfolio Agent | Centralized P&L |
| Make exit decisions | RCA | Risk management |
| Apply P&L discipline | Discipline Engine | Policy enforcement |
| Execute exits | TradeExecutor | Execution layer |

---

## 12. Configuration

**Decision Engine Parameters:**

```typescript
interface DecisionEngineConfig {
  // Entry Requirements
  MIN_CONFIDENCE: number;           // 65% (reject if lower)
  MIN_MOMENTUM: number;             // 70 (for GO_CALL)
  MAX_MOMENTUM: number;             // 30 (for GO_PUT)
  MIN_VOLUME_RATIO: number;         // 1.5x average
  MIN_BREAKOUT_DISTANCE_PCT: number; // 0.5% beyond level
  
  // Exit Signal Thresholds
  TREND_REVERSAL_CONFIDENCE: number; // 75% (trigger signal)
  MOMENTUM_DIVERGENCE_BARS: number;  // 3 (bars to confirm)
  IV_CRUSH_THRESHOLD_PCT: number;    // -20% IV drop
  ANOMALY_SEVERITY_THRESHOLD: string; // "warning" | "critical"
  
  // Timeouts
  DECISION_CACHE_TTL_SECONDS: number; // 60 (don't re-send same decision)
  MONITORING_INTERVAL_SECONDS: number; // 1-5 (check for exits)
}
```

---

## 13. Testing Strategy

### 13.1 Unit Tests (40+ tests)

```typescript
describe("Decision Engine v3.0", () => {
  // Decision Generation
  describe("Trade Decision Generation", () => {
    test("generates GO_CALL when momentum > 70 and all factors bullish", ...)
    test("generates GO_PUT when momentum < 30 and all factors bearish", ...)
    test("reverts to WAIT when confidence < 65%", ...)
    test("reverts to WAIT when discipline blocks trade", ...)
    test("respects time window blocks (9:15-9:30, 3:15-3:30)", ...)
  })

  // Entry Timing
  describe("Entry Timing Validation", () => {
    test("confirms timing when momentum, volume, breakout all pass", ...)
    test("rejects timing when momentum below threshold", ...)
    test("rejects timing when no volume spike", ...)
    test("rejects timing when breakout not sustained", ...)
  })

  // Discipline Integration
  describe("Discipline Engine Integration", () => {
    test("calls discipline.validateTrade() before decision", ...)
    test("respects circuit breaker block", ...)
    test("respects trade limit block", ...)
    test("respects cooldown timer", ...)
    test("respects time windows", ...)
  })

  // Exit Signals
  describe("Exit Signal Generation", () => {
    test("detects lower high trend reversal pattern", ...)
    test("detects lower low trend reversal pattern", ...)
    test("detects bullish momentum divergence", ...)
    test("detects bearish momentum divergence", ...)
    test("detects IV crush (IV drop > 20%)", ...)
    test("detects theta spike (DTE < 2)", ...)
    test("generates exit signal with correct confidence", ...)
  })

  // RCA Integration
  describe("RCA Integration", () => {
    test("sends decision to RCA with correct format", ...)
    test("sends exit signal to RCA with evidence", ...)
    test("sends modify request with suggested parameters", ...)
    test("handles RCA unavailable (retry logic)", ...)
  })
})
```

### 13.2 Integration Tests (10+ tests)

```typescript
describe("Decision Engine Integration", () => {
  test("generates decision and RCA receives it within 1 second", ...)
  test("continuous monitoring loop detects trend reversal", ...)
  test("exit signal reaches RCA and is executed", ...)
  test("modification request reaches RCA and SL is adjusted", ...)
  test("discipline block prevents decision generation", ...)
})
```

### 13.3 E2E Scenarios

```typescript
// Scenario 1: Complete Trade Lifecycle
describe("E2E: Complete Trade Cycle", () => {
  test(`
    1. Analyzer detects bullish setup (support bounce)
    2. Decision Engine analyzes → GO_CALL, confidence 78%
    3. Discipline Engine allows (no blocks)
    4. Entry timing: momentum 78, volume spike 2.1x, breakout confirmed
    5. Send decision to RCA
    6. RCA approves → TradeExecutor places order
    7. Order filled
    8. 2 minutes later: Trend reversal detected (lower high)
    9. Exit signal sent to RCA
    10. RCA exits position (momentum too weak)
  `)
})

// Scenario 2: Discipline Blocks Trade
describe("E2E: Discipline Blocks Trade", () => {
  test(`
    1. Decision Engine generates GO_CALL
    2. Discipline Engine check: circuit breaker triggered (-3%)
    3. Discipline.allowed = false
    4. Decision reverts to WAIT
    5. No RCA signal sent
  `)
})

// Scenario 3: Entry Timing Fails
describe("E2E: Entry Timing Validation Fails", () => {
  test(`
    1. Decision Engine generates GO_CALL (confidence 75%)
    2. Discipline allows
    3. Entry timing check: momentum only 62 (threshold 70)
    4. Timing.confirmed = false
    5. Decision reverts to WAIT
    6. No RCA signal sent
  `)
})
```

---

## 14. Implementation Plan

### Phase 1: Refactor Core Decision Logic (3 days)

- [ ] Consolidate v2.0 weighted scoring algorithm
- [ ] Move data loading from execution_module.py
- [ ] Implement disciplineCheck() call before trade decision
- [ ] Add entry_timing validation module
- [ ] Test decision generation with sample data

### Phase 2: Implement Exit Signal Generation (3 days)

- [ ] Implement trend reversal detection (lower high/low)
- [ ] Implement momentum divergence detection
- [ ] Implement IV crush detection
- [ ] Implement theta spike detection
- [ ] Create anomaly scoring system

### Phase 3: RCA Integration (2 days)

- [ ] Implement sendDecisionToRca() endpoint
- [ ] Implement sendExitSignalToRca() endpoint
- [ ] Implement sendModifyRequestToRca() endpoint
- [ ] Add retry logic and circuit breaker
- [ ] Test HTTP delivery and error handling

### Phase 4: Continuous Monitoring Loop (2 days)

- [ ] Implement monitoring loop (async, 1-5 sec interval)
- [ ] Add WebSocket integration for real-time prices
- [ ] Implement idempotency (don't send same signal twice)
- [ ] Add signal deduplication (exit signal already sent?)

### Phase 5: Testing & Validation (3 days)

- [ ] Run 40+ unit tests
- [ ] Run 10+ integration tests
- [ ] Run E2E scenarios
- [ ] Validate with live market data (paper trading)
- [ ] Measure latency (decision to RCA receipt)

### Phase 6: Deployment (1 day)

- [ ] Deploy to staging
- [ ] Run smoke tests
- [ ] Deploy to production
- [ ] Monitor signal delivery, latency, errors

---

## 15. Success Criteria

- [x] Decision Engine generates decisions with confidence scores ≥ 65%
- [x] Discipline Engine blocks respected (0 trades placed when blocked)
- [x] Entry timing validated (momentum, volume, breakout)
- [x] Decisions reach RCA within 1 second
- [x] Exit signals reach RCA within 2 seconds
- [x] Trend reversals detected with ≥ 75% accuracy
- [x] No regression: all v2.0 decision logic preserved
- [x] No broker calls from Decision Engine
- [x] No order placement from Decision Engine
- [x] No position tracking from Decision Engine
- [x] All execution via TradeExecutor (single point)

---

## 16. Related Specifications

- **RiskControlAgent_Spec_v2.0.md** — Receives decisions, validates, executes
- **TradeExecutorAgent_Spec_v1.2.md** — Executes orders, manages lifecycle
- **DisciplineEngine_Spec_v1.2.md** — Pre-trade checks, rule enforcement
- **PortfolioAgent_Spec_v1.0.md** — Position state, P&L tracking
- **ARCHITECTURE_REFACTOR_PLAN.md** — Overall unified execution flow

---

## Deprecations

### execution_module.py (Being Removed)

**Status:** DEPRECATED v3.0 (logic merged into Decision Engine)

The `execution_module.py` module contained:
- parse_ai_decision() → Merged into decision_engine.py
- check_discipline_engine() → Merged into discipline_integration module
- check_entry_timing() → Merged into entry_timing module
- notify_trade_placed/closed() → Removed (belongs to TradeExecutor)
- Broker order placement → Removed (belongs to TradeExecutor)

**Timeline:**
- **v3.0 (now):** Decision Engine implements merged responsibilities
- **Week 2:** Verify RCA integration
- **Week 3:** Delete execution_module.py
- **Week 4:** Remove from Python codebase

---

## Appendix: Migration from v2.0 to v3.0

| Removed | Replaced By | Reason |
|---------|-------------|--------|
| Direct broker calls | RCA integration | Single execution point |
| Position tracking | Portfolio Agent | Centralized state |
| Exit logic | RCA continuous monitoring | Real-time market adaptation |
| Order management | TradeExecutor | Unified execution |
| P&L recording | Portfolio Agent | Centralized metrics |
| Signal-to-execution | RCA validation layer | Risk management |

---

**Status:** Ready for implementation Phase 1

**Owner:** Engineering team  
**Reviewer:** Architecture review  
**Start Date:** 2026-04-10  
**Target Completion:** 2026-04-17
