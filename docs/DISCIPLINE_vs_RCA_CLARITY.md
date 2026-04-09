# Discipline Engine vs Risk Control Agent: Boundary Clarity

**Date:** 2026-04-09
**Status:** Clarification Document

---

## Current Overlap (Confusing)

| Responsibility | Discipline Engine | Risk Control Agent |
|---|---|---|
| Daily loss limit | ✅ Enforces | ✅ Monitors |
| Exit decisions | ✅ Can signal | ✅ Makes decisions |
| Position monitoring | ✅ Session checks | ✅ Real-time checks |
| Capital protection | ✅ Yes | ✅ Yes |

**Problem:** Both seem to own the same responsibilities!

---

## The Real Distinction (Correct)

### **Discipline Engine = STATIC RULE ENFORCER**

```
WHO:     Pre-trade gatekeeper
WHAT:    Enforce hard rules/constraints
WHEN:    Before entry, at fixed times (15:15), when rules trigger
HOW:     Check: time, count, capital, cooldown
OUTPUT:  "ALLOW ENTRY" or "BLOCK ENTRY" or "FORCE EXIT"

Rules (Not flexible):
├─ No trading 9:15-9:30 AM (market open)
├─ No trading 3:30 PM onwards (market close)
├─ Max 3 trades per day
├─ Max 2 open positions
├─ Daily loss limit: -2%
├─ Daily profit cap: +5%
├─ Cooldown: 15 min after loss
├─ Carry forward: closed at 15:20 if conditions fail
└─ Session halt: trading stopped until next day

Signal to RCA:
└─ "MUST_EXIT: Circuit breaker hit"
└─ "MUST_EXIT: Daily loss limit reached"
└─ "MUST_EXIT: Cooldown active"
└─ "MUST_EXIT: Session halted"
```

### **Risk Control Agent = DYNAMIC RISK MANAGER**

```
WHO:     Real-time position monitor
WHAT:    Make adaptive risk decisions based on market conditions
WHEN:    Continuously (every 1-5 seconds) while positions open
HOW:     Check: price, momentum, volatility, trend, time, profit
OUTPUT:  "HOLD", "MODIFY SL/TP", "EXIT", or "ADD (pyramid)"

Decisions (Flexible, based on market):
├─ Momentum drops below 30 → EXIT
├─ Price hits SL (-5%) → EXIT
├─ Price hits TP (+10%) → EXIT
├─ Trade age > 10 min with no progress → EXIT
├─ Volatility spike detected → TIGHTEN_SL
├─ Trend breakout sustained → EXTEND_TP or ENABLE_TSL
├─ Momentum > 70 and in profit → ADD (pyramid)
└─ Price reversal detected → EXIT

Also:
├─ Receives requests from AI Decision Engine
│  └─ "Trend reversed → EXIT" (validates & executes)
├─ Receives signals from Discipline Engine
│  └─ "Circuit breaker hit → EXIT" (must honor)
└─ Makes its own decisions
   └─ "Momentum too weak → EXIT" (own rule)
```

---

## Key Differences Explained

### **Discipline Engine: Policy Layer (Rule Enforcement)**

```
Characteristics:
✅ Static rules (same every day)
✅ Time-based (no-trade hours, 15:15 checks)
✅ Count-based (max 3 trades/day)
✅ Capital-based (daily loss limit)
✅ Cooldown-based (penalty period)
✅ BLOCKING (prevents entry)
✅ MANDATORY (must be obeyed)
✅ Applies to ALL positions equally

Example:
"It's 9:15 AM (market open) → NO NEW ENTRIES for 15 mins"
"Daily loss reached -2% → ALL POSITIONS MUST EXIT"
"Lost last trade → 15 min cooldown active"
```

### **Risk Control Agent: Execution Layer (Adaptive Risk)**

```
Characteristics:
✅ Dynamic decisions (based on market conditions)
✅ Price-based (SL/TP hits)
✅ Momentum-based (score > 70 or < 30)
✅ Volatility-based (IV expensive → exit)
✅ Trend-based (reversal detected)
✅ Position-specific (different rules per position)
✅ RECOMMENDING (suggests exits)
✅ Can be overridden (by Discipline)
✅ Applies differently to each position

Example:
"This position momentum dropped to 25 → EXIT THIS POSITION"
"This position at +15% profit with momentum > 70 → HOLD or PYRAMID"
"AI signals trend reversal → VALIDATE & EXIT"
```

---

## Exit Request Flow

```
THREE sources can request exits:

1. DISCIPLINE ENGINE (Hard Rules)
   ├─ "Daily loss limit hit → EXIT ALL"
   ├─ "Circuit breaker triggered → EXIT ALL"
   ├─ "Cooldown active → BLOCK NEW, EXIT THIS"
   └─ Priority: MANDATORY
   
2. RISK CONTROL AGENT (Own Rules)
   ├─ "Momentum < 30 → EXIT THIS"
   ├─ "Trade age > 10 min → EXIT THIS"
   ├─ "Position at profit but momentum weak → PARTIAL_EXIT"
   └─ Priority: RCA's judgment
   
3. AI DECISION ENGINE (Market Signals)
   ├─ "Trend reversed → EXIT THIS"
   ├─ "Breakout failed → EXIT THIS"
   ├─ "Anomaly detected → VERIFY & EXIT"
   └─ Priority: RCA validates before executing

RCA's Job:
├─ Honor Discipline signals (non-negotiable)
├─ Execute own decisions (based on monitoring)
├─ Validate AI signals (against current state)
└─ Send to TradeExecutor (unified execution)
```

---

## In Decision Matrix

```
Question: Should I EXIT this position?

Discipline Engine answers:
  "Is there a RULE that forbids holding this?"
  - Time window violation? → YES
  - Daily loss limit hit? → YES
  - Circuit breaker? → YES
  - Cooldown active? → YES
  - Session halt? → YES
  If YES to any → MUST EXIT

Risk Control Agent answers:
  "Based on CURRENT MARKET CONDITIONS, should I exit?"
  - Momentum weak? → YES
  - SL hit? → YES
  - TP hit? → YES
  - Trade too old? → YES
  - Trend reversed? → YES (if AI confirms)
  If YES to any → SHOULD EXIT (validate & decide)

Final Decision:
├─ If Discipline says MUST → EXECUTE EXIT (non-negotiable)
├─ If RCA says SHOULD → EXECUTE EXIT (dynamic decision)
└─ If AI says CONSIDER → RCA validates then decides
```

---

## Are They Similar? (Truth)

**YES, they overlap in EXIT DECISIONS**

But they answer DIFFERENT QUESTIONS:

```
Discipline Engine:
"Are we ALLOWED to keep this position open?"
Answer: Based on time, count, capital, rules

Risk Control Agent:
"Should we ACTIVELY EXIT this position NOW?"
Answer: Based on price, momentum, volatility, trend
```

**Analogy:**
- Discipline = "Is the store open?" (Hours: 9-5)
- RCA = "Is it a good time to shop?" (Crowds, sales, weather)

You can only shop when BOTH are YES.

---

## Should They Be Merged?

**NO - keep them separate because:**

```
1. Different Concerns
   ├─ Discipline = Policy (rule enforcer)
   └─ RCA = Risk (market responder)

2. Different Triggers
   ├─ Discipline = Time, count, capital
   └─ RCA = Price, momentum, trend

3. Different Scope
   ├─ Discipline = Portfolio-wide rules
   └─ RCA = Position-specific decisions

4. Different Timing
   ├─ Discipline = Periodic checks (15:15) + event-based
   └─ RCA = Continuous monitoring (1-5 sec)

5. Different Flexibility
   ├─ Discipline = Rigid (same every day)
   └─ RCA = Adaptive (learns from market)
```

---

## Correct Architecture

```
┌─────────────────────────────────────────────┐
│         DISCIPLINE ENGINE (TypeScript)       │
│                                              │
│  Pre-trade Gate:                            │
│  ├─ Is trading allowed? (time, count)       │
│  └─ Block or allow entry                    │
│                                              │
│  Rule Enforcement:                          │
│  ├─ Daily profit/loss caps                  │
│  ├─ Cooldown periods                        │
│  ├─ Session halts                           │
│  └─ Send "MUST_EXIT" signals to RCA         │
└──────────────┬──────────────────────────────┘
               │ "MUST_EXIT" (hard rules)
               ▼
┌─────────────────────────────────────────────┐
│    RISK CONTROL AGENT (TypeScript)           │
│                                              │
│  Real-Time Monitoring:                      │
│  ├─ Monitor price vs SL/TP                  │
│  ├─ Check momentum/volatility               │
│  ├─ Receive AI signals                      │
│  └─ Make adaptive decisions                 │
│                                              │
│  Decision Output:                           │
│  ├─ Honor Discipline signals (execute)      │
│  ├─ Execute own decisions (momentum, price) │
│  ├─ Validate AI signals                     │
│  └─ Send to TradeExecutor                   │
└──────────────┬──────────────────────────────┘
               │ exitTrade() / modifyOrder()
               ▼
        TradeExecutorAgent
```

---

## Summary

| Aspect | Discipline | RCA |
|--------|-----------|-----|
| **Role** | Rule enforcer | Risk manager |
| **Type** | Policy layer | Execution layer |
| **Triggers** | Time, count, capital | Price, momentum, trend |
| **Scope** | Portfolio-wide | Position-specific |
| **Flexibility** | Rigid | Adaptive |
| **Priority** | Mandatory | Recommended |
| **Exit Signal** | "MUST_EXIT" | "SHOULD_EXIT" |

---

**Conclusion: NOT similar - complementary roles**

- Discipline = "What are the RULES?"
- RCA = "What does the MARKET say?"

Both needed for complete risk management.
