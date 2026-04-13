# ⚠️ DEPRECATED — AI Engine — Module 3: AI Decision Engine

> **DEPRECATED (2026-04-13):** Superseded by ML model pipeline. ML model sends signals directly to RCA.
> See `TickFeatureAgent_Spec_1.0.md` for the replacement architecture.

**Document:** ai-engine-decision-spec.md
**Project:** Automatic Trading System (ATS)
**Status:** ~~Authoritative Reference~~ **DEPRECATED**

---

## Revision History

| Version | Date       | Author    | Changes                                                  |
| ------- | ---------- | --------- | -------------------------------------------------------- |
| v1.0    | 2026-04-02 | Manus AI  | Initial specification based on latest Python module source code |
| v2.0    | 2026-04-02 | Manus AI  | Split from monolithic spec into standalone module spec. Added v2.4 enhancements: Trade Quality Filter, Bounce/Breakdown Engine, No Trade Detection, Theta/IV Protection. |

---

## 1. Overview

**File:** `ai_decision_engine.py` (1215 lines)
**Purpose:** Produce a scored trade direction (GO_CALL / GO_PUT / WAIT) with confidence, complete trade setup, and risk assessment for each instrument.

The AI Decision Engine is the core decision-making module. It synthesizes technical data from the Analyzer, raw data from the Fetcher, and fundamental data from the News Sentiment Engine to produce a final trade decision.

---

## 2. Input Sources

The AI Decision Engine consumes three data sources per instrument:

1. **Analyzer Output** (`output/analyzer_output_{instrument}.json`): Market bias, S/R levels, entry/exit/breakout signals, smart money signals.
2. **Raw Option Chain** (`output/option_chain_{instrument}.json`): Live strike data for wall strength analysis, IV assessment, theta assessment, and trade setup pricing.
3. **News Sentiment** (fetched live from NewsData.io API): Multi-query weighted keyword scoring with event calendar awareness.

---

## 3. Wall Strength Analysis

The `analyze_wall_strength` function scores each S/R level on a 0–100 scale and predicts whether price will break through or bounce off.

### 3.1 Scoring Factors

The base score starts at 50 and is adjusted by three factors:

**Factor 1 — Absolute OI vs Average** (up to +25 / -10 points):

| OI Ratio (vs avg across all strikes) | Score Adjustment |
| ------------------------------------- | ---------------- |
| > 3.0x average                        | +25              |
| > 1.5x average                        | +15              |
| <= 1.5x average                       | -10              |

**Factor 2 — OI Change Direction** (up to +15 / -20 points):

| OI Change                | Score Adjustment |
| ------------------------ | ---------------- |
| Increasing (wall building) | +15            |
| Decreasing (wall crumbling)| -20            |
| Unchanged                | 0                |

**Factor 3 — Volume vs Average** (up to +10 points):

| Volume Ratio             | Score Adjustment |
| ------------------------ | ---------------- |
| > 2.0x average           | +10              |
| > 1.0x average           | 0                |
| <= 1.0x average          | 0                |

The final score is clamped to [0, 100].

### 3.2 Prediction Logic

| Strength Score | Support Prediction | Resistance Prediction | Probability                     |
| -------------- | ------------------ | --------------------- | ------------------------------- |
| < 35           | BREAKDOWN          | BREAKOUT              | 50 + (35 - strength), max 85    |
| > 65           | BOUNCE             | BOUNCE                | 50 + (strength - 65), max 85    |
| 35–65          | UNCERTAIN          | UNCERTAIN             | 50                              |

Each prediction includes an evidence array — human-readable strings explaining each scoring factor's contribution.

### 3.3 Wall Type Mapping

For **resistance walls**, the analysis uses Call OI data at the strike. High Call OI means many call writers are defending that level — a strong resistance wall.

For **support walls**, the analysis uses Put OI data at the strike. High Put OI means many put writers are defending that level — a strong support floor.

---

## 4. IV Assessment

The `assess_iv` function evaluates whether ATM options are fairly priced, cheap, or expensive relative to the overall IV surface.

**Method:** The ATM IV is taken as the maximum of CE and PE implied volatility at the ATM strike. This is compared to the average IV across all strikes (both CE and PE) in the option chain.

| IV Ratio (ATM / Average) | Assessment | Implication                                  |
| ------------------------ | ---------- | -------------------------------------------- |
| > 1.3                    | EXPENSIVE  | Options overpriced — risk of IV crush        |
| < 0.8                    | CHEAP      | Options fairly/under-priced — favorable for buyers |
| 0.8–1.3                  | FAIR       | Normal pricing                               |

**Output:** `{"atm_iv": 14.2, "assessment": "FAIR", "detail": "ATM IV 14.2% is near average — fair pricing"}`

---

## 5. Theta Assessment

The `assess_theta` function evaluates time decay risk based on days to expiry (DTE).

**Method:** Extracts the theta value from ATM strike Greeks (maximum of CE and PE theta). Parses the expiry date from the analyzer output, supporting multiple date formats (`%Y-%m-%d`, `%d-%m-%Y`, `%Y-%m-%d %H:%M:%S`).

| DTE  | Warning Level | Warning Text                                          |
| ---- | ------------- | ----------------------------------------------------- |
| <= 1 | CRITICAL      | "Expiry tomorrow — theta decay is extreme"            |
| <= 2 | HIGH RISK     | "2 days to expiry — theta decay accelerating"         |
| <= 4 | CAUTION       | "N days to expiry — theta decay significant"          |
| > 4  | None          | No warning                                            |

**Output:** `{"theta_per_day": 5.20, "days_to_expiry": 3, "warning": "CAUTION: 3 days to expiry..."}`

---

## 6. Weighted Scoring Engine

The `compute_weighted_score` function is the central decision-making algorithm. It combines six factors into a single weighted score that determines trade direction and confidence.

### 6.1 Factor Definitions

**Factor 1: OI Support/Resistance (Weight: 30%)**

| Condition                                                | Score |
| -------------------------------------------------------- | ----- |
| Strong support (>60) + weak resistance (<40)             | +0.8  |
| Strong support (>60) + resistance BREAKOUT prediction    | +0.9  |
| Strong resistance (>60) + weak support (<40)             | -0.8  |
| Strong resistance (>60) + support BREAKDOWN prediction   | -0.9  |
| Support strength > resistance strength                   | +0.3  |
| Resistance strength > support strength                   | -0.3  |

**Factor 2: OI Change Momentum (Weight: 25%)**

Counts bullish and bearish keywords in the analyzer's entry signals, real-time signals, and smart money signals:

- **Bullish keywords:** "bullish", "call buy", "put writing", "put short buildup"
- **Bearish keywords:** "bearish", "put buy", "call writing", "call short buildup"

Score = `(bullish_count - bearish_count) x 0.3`, clamped to [-1.0, +1.0].

**Factor 3: IV Level (Weight: 15%)**

| Assessment | Score |
| ---------- | ----- |
| CHEAP      | +0.5  |
| FAIR       | +0.2  |
| EXPENSIVE  | -0.5  |

**Factor 4: PCR Trend (Weight: 10%)**

| PCR Ratio | Score                                            |
| --------- | ------------------------------------------------ |
| > 1.2     | +0.7 (Bullish — heavy put writing = strong support) |
| > 1.0     | +0.3                                             |
| < 0.8     | -0.7 (Bearish — heavy call writing = strong resistance) |
| < 1.0     | -0.3                                             |

**Factor 5: News Sentiment (Weight: 10% or 15%)**

The base weight is 10%, but increases to 15% on event days (when the event calendar has upcoming events for this instrument). The score is computed as:

```
conf_mult = min(1.0, news_confidence / 80)
strength_mult = max(conf_mult, 1.0 if Strong, 0.6 if Moderate, 0.3 if Mild)
score = +/-0.5 x strength_mult
```

**Factor 6: Theta Risk (Weight: 10%)**

| DTE  | Score |
| ---- | ----- |
| <= 1 | -0.8  |
| <= 2 | -0.5  |
| <= 4 | -0.2  |
| > 4  | +0.3  |

### 6.2 Direction Determination

```
total_score = Sum(factor_score x factor_weight)

if total_score > 0.15  -> GO_CALL
if total_score < -0.15 -> GO_PUT
else                   -> WAIT
```

The +/-0.15 threshold creates a dead zone that prevents marginal signals from triggering trades. This is a deliberate design choice to reduce noise and only act on clear directional conviction.

### 6.3 Confidence Calculation

```
confidence = min(0.95, abs(total_score) x 1.5)

if direction != WAIT:
    confidence = max(0.30, confidence)
```

The confidence is capped at 95% (the system never claims certainty) and floored at 30% when a direction is given (if the engine decided to trade, it has at least 30% conviction).

---

## 7. Trade Setup Generator

When the direction is GO_CALL or GO_PUT, the `generate_trade_setup` function produces a complete trade plan.

### 7.1 Strike Selection

The ATM strike is calculated as: `round(LTP / step) x step`, where `step` is the instrument's strike step size (NIFTY: 50, BANKNIFTY: 100, CRUDEOIL: 50, NATURALGAS: 5).

### 7.2 Entry Price

The entry price is the live `last_price` of the ATM CE (for GO_CALL) or ATM PE (for GO_PUT) from the option chain data.

### 7.3 Target Calculation

The target is based on the distance to the relevant S/R level, adjusted by the wall strength prediction and the option's delta:

**For GO_CALL:**
- Distance to resistance = `resistance_level - LTP`
- If resistance prediction is BREAKOUT: `target_move = distance x 1.5` (expect price to overshoot)
- If resistance prediction is BOUNCE: `target_move = distance x 0.8` (expect price to stall near resistance)
- `target_price = entry_price + (target_move x |delta|)`
- Fallback: `entry_price x 1.3` if delta is zero

**For GO_PUT:**
- Distance to support = `LTP - support_level`
- If support prediction is BREAKDOWN: `target_move = distance x 1.5`
- If support prediction is BOUNCE: `target_move = distance x 0.8`
- `target_price = entry_price + (target_move x |delta|)`

### 7.4 Stop Loss Calculation

The stop loss is based on the distance to the opposite S/R level:

**For GO_CALL:**
- Distance to support = `LTP - support_level`
- `sl_move = distance x 0.6`
- `sl_price = entry_price - (sl_move x |delta|)`
- Floor: `max(sl_price, entry_price x 0.5)` — SL never exceeds 50% of entry

**For GO_PUT:**
- Distance to resistance = `resistance_level - LTP`
- `sl_move = distance x 0.6`
- `sl_price = entry_price - (sl_move x |delta|)`
- Floor: `max(sl_price, entry_price x 0.5)`

### 7.5 Risk:Reward Ratio

```
risk   = entry_price - sl_price
reward = target_price - entry_price
R:R    = reward / risk (rounded to 1 decimal)
```

### 7.6 Trade Setup Output

```json
{
  "direction": "GO_CALL",
  "strike": 24150,
  "option_type": "CE",
  "entry_price": 185.50,
  "target_price": 241.15,
  "target_pct": 30.0,
  "stop_loss": 148.40,
  "sl_pct": 20.0,
  "risk_reward": 1.5,
  "target_label": "Breakout target beyond 24300",
  "delta": 0.550,
  "resistance_level": 24300,
  "support_level": 24000
}
```

---

## 8. Pre-Trade Filters (v2.4 Enhancements)

Before a trade setup is finalized and passed to the Execution Module, it must pass three strict filters. If any filter fails, the trade is rejected and the decision reverts to `WAIT`.

### 8.1 Trade Quality Filter

Ensures only high-probability setups are executed.

| Condition | Threshold | Action on Failure |
| --------- | --------- | ----------------- |
| Confidence | >= 65% (`MIN_CONFIDENCE`) | Reject trade |
| S/R Alignment | Trade direction must align with S/R prediction (e.g., GO_CALL requires Support BOUNCE or Resistance BREAKOUT) | Reject trade |
| Trap Signals | No trap signals detected by No Trade Detection | Reject trade |

### 8.2 Bounce vs Breakdown Engine

Classifies the structural setup of the trade to ensure logical alignment.

| Setup Type | Required Direction | Action if Mismatched |
| ---------- | ------------------ | -------------------- |
| Bounce off Support | GO_CALL | Reject |
| Bounce off Resistance | GO_PUT | Reject |
| Breakdown below Support | GO_PUT | Reject |
| Breakout above Resistance | GO_CALL | Reject |
| Trap / False Breakout | Any | Reject |

### 8.3 No Trade Detection (Sideways / Trap Markets)

Prevents entries in unfavorable market conditions.

**Sideways Market Detection:**
Evaluates 4 signals. If >= `NO_TRADE_SIDEWAYS_THRESHOLD` (default: 3) are true, the market is sideways and the trade is rejected.
1. **Narrow Range:** (Day High - Day Low) < 0.5% of LTP
2. **Balanced OI:** Top CE OI and top PE OI are within 15% of each other
3. **Low Volume:** Current cumulative volume < 0.7x of average
4. **Neutral PCR:** PCR ratio between 0.90 and 1.10

**Trap Market Detection:**
If **any 1** of these signals is true, the trade is rejected immediately.
1. **False Breakout:** Price broke above resistance within last 5 mins but is now below it
2. **False Breakdown:** Price broke below support within last 5 mins but is now above it
3. **OI Contradiction:** Price moving up but CE OI increasing heavily (or vice versa)
4. **Signal-Momentum Divergence:** AI Engine says GO_CALL but Momentum Score < 30

---

## 9. Risk Flags

The `compute_risk_flags` function generates warning and danger flags for the trade:

| Condition                                  | Type    | Flag Text                                                       |
| ------------------------------------------ | ------- | --------------------------------------------------------------- |
| IV assessment is EXPENSIVE                 | warning | "IV is elevated at X% — risk of IV crush even if direction is right" |
| Theta warning exists                       | danger  | (Theta warning text from assessment)                            |
| Time > 14:30 (2:30 PM)                     | danger  | "Late session — no new trades allowed"                          |
| DTE <= 2                                   | danger  | "DTE <= 2 — extreme theta risk, no new trades allowed"          |
| Delta outside 0.4–0.6                      | warning | "Delta is X — outside preferred 0.4-0.6 range"                  |
| GO_CALL + resistance strength > 70         | warning | "Strong resistance at X — may cap upside"                       |
| GO_PUT + support strength > 70             | warning | "Strong support at X — may cap downside"                        |
| GO_CALL + support strength < 30            | danger  | "Support at X is weak — SL may get hit quickly"                 |
| GO_PUT + resistance strength < 30          | danger  | "Resistance at X is weak — SL may get hit quickly"              |

---

## 9. Decision Output Schema

The AI Decision Engine writes `ai_decision_{instrument}.json` with a dual-format structure that maintains backward compatibility with the legacy format while providing enhanced fields:

```json
{
  "instrument": "NIFTY_50",
  "timestamp": "2026-04-02 10:15:35",
  "decision": "GO",
  "trade_type": "CALL_BUY",
  "confidence_score": 0.72,
  "rationale": "OI Support Resistance: bullish — Support: 75/100 (BOUNCE), ...",
  "market_bias_oc": "Bullish",
  "market_bias_news": "Bullish",
  "active_strikes": { "call": ["..."], "put": ["..."] },
  "main_support": 24000,
  "main_resistance": 24300,
  "entry_signal_details": null,
  "news_summary": "News: Bullish (Strong, 85% conf from 23 articles)",
  "target_strike": null,
  "target_expiry_date": "2026-04-03",
  "trade_direction": "GO_CALL",
  "atm_strike": 24150,
  "ltp": 24155.30,
  "support_analysis": {
    "level": 24000, "strength": 75, "prediction": "BOUNCE", "probability": 60,
    "evidence": ["..."], "oi": 1250000, "oi_change": 70000, "oi_change_pct": 5.9,
    "volume": 85000, "iv": 15.1
  },
  "resistance_analysis": {
    "level": 24300, "strength": 42, "prediction": "BREAKOUT", "probability": 58,
    "evidence": ["..."], "oi": 650000, "oi_change": -15000, "oi_change_pct": -2.3,
    "volume": 45000, "iv": 13.8
  },
  "iv_assessment": { "atm_iv": 14.2, "assessment": "FAIR", "detail": "..." },
  "theta_assessment": { "theta_per_day": 5.20, "days_to_expiry": 3, "warning": "CAUTION: ..." },
  "pcr_ratio": 1.28,
  "trade_setup": {
    "direction": "GO_CALL", "strike": 24150, "option_type": "CE",
    "entry_price": 185.50, "target_price": 241.15, "target_pct": 30.0,
    "stop_loss": 148.40, "sl_pct": 20.0, "risk_reward": 1.5,
    "target_label": "...", "delta": 0.550,
    "resistance_level": 24300, "support_level": 24000
  },
  "risk_flags": [ { "type": "warning", "text": "..." } ],
  "scoring_factors": {
    "oi_support_resistance": { "score": 0.80, "weight": 0.30, "detail": "..." },
    "oi_momentum": { "score": 0.30, "weight": 0.25, "detail": "..." },
    "iv_level": { "score": 0.20, "weight": 0.15, "detail": "..." },
    "pcr_trend": { "score": 0.70, "weight": 0.10, "detail": "..." },
    "news_sentiment": { "score": 0.35, "weight": 0.15, "detail": "..." },
    "theta_risk": { "score": -0.20, "weight": 0.10, "detail": "..." }
  },
  "news_detail": {
    "sentiment": "Bullish", "strength": "Strong", "confidence": 85,
    "total_articles": 23, "bull_score": 18.5, "bear_score": 4.2,
    "net_score": 14.3, "queries_used": 8,
    "event_flags": ["RBI MPC Meeting (Tomorrow)"],
    "top_articles": [ { "title": "...", "source": "...", "score": 4.2 } ]
  }
}
```

### 9.1 Rationale Generation

The rationale string is auto-generated from the top 3 scoring factors (sorted by `|score x weight|` descending). Each factor contributes a clause like: `"OI Support Resistance: bullish — Support: 75/100 (BOUNCE), Resistance: 42/100 (BREAKOUT)"`.

---

## 10. News Sentiment Engine

### 10.1 Architecture

The News Sentiment Engine is embedded within the AI Decision Engine module. It fetches news articles from the NewsData.io API using instrument-specific multi-query configurations, scores each article using weighted keyword dictionaries, and produces an aggregate sentiment assessment.

### 10.2 Query Configuration

Each instrument has 5–8 targeted queries with individual weights:

| Instrument    | Queries    | Weight Range | Categories         |
| ------------- | ---------- | ------------ | ------------------ |
| NIFTY_50      | 8 queries  | 0.50–1.00    | Business           |
| BANKNIFTY     | 7 queries  | 0.50–1.00    | Business           |
| CRUDEOIL      | 7 queries  | 0.50–1.00    | Business, World    |
| NATURALGAS    | 6 queries  | 0.50–1.00    | Business, Science  |

**NIFTY_50 Queries** (representative):

| Query                                          | Weight | Focus                |
| ---------------------------------------------- | ------ | -------------------- |
| "Nifty 50 Indian stock market"                 | 1.00   | Direct instrument news |
| "Gift Nifty SGX Nifty pre market India"        | 0.90   | Pre-market signals   |
| "India VIX volatility index fear gauge"        | 0.85   | Volatility sentiment |
| "RBI monetary policy interest rate India"      | 0.80   | Central bank policy  |
| "FII DII flow India stock market"              | 0.70   | Institutional flows  |
| "S&P 500 Nasdaq Wall Street overnight futures" | 0.65   | US market overnight  |
| "India GDP CPI inflation WPI PMI data"         | 0.60   | Macro data           |
| "Reliance Infosys HDFC Bank quarterly results" | 0.50   | Earnings             |

### 10.3 Keyword Scoring

Each article's title and description are concatenated and scored against instrument-specific keyword dictionaries. Keywords have weights of 1 (moderate signal) or 2 (strong signal).

**Scoring Formula:**

```
bull_score = Sum(keyword_weight) for each bullish keyword found in text
bear_score = Sum(keyword_weight) for each bearish keyword found in text

# API sentiment label also contributes:
if API says "positive": bull_score += 1
if API says "negative": bear_score += 1

# Apply query weight:
article_bull_score = bull_score x query_weight
article_bear_score = bear_score x query_weight
article_net_score  = (bull_score - bear_score) x query_weight
```

### 10.4 Aggregate Sentiment

```
total_bull = Sum(article_bull_scores)
total_bear = Sum(article_bear_scores)
net_score  = total_bull - total_bear

Sentiment:
  net_score > 3  -> Bullish  (confidence = min(100, net_score x 8))
  net_score < -3 -> Bearish  (confidence = min(100, |net_score| x 8))
  otherwise      -> Neutral  (confidence = max(0, 50 - |net_score| x 10))

Strength:
  articles > 15 AND |net_score| > 5 -> Strong
  articles > 5  AND |net_score| > 2 -> Moderate
  articles > 0                      -> Mild
  otherwise                         -> Weak
```

### 10.5 Caching

News results are cached per instrument for 5 minutes (`NEWS_CACHE_EXPIRY = 300`). The cache key is the instrument name, and the cache stores the timestamp and full result object. This prevents excessive API calls (NewsData.io has rate limits) while keeping sentiment reasonably fresh.

### 10.6 Rate Limiting

A 1-second `time.sleep()` is inserted between each query within an instrument's query set. With 6–8 queries per instrument and 4 instruments, a full news refresh takes approximately 24–32 seconds.

---

## 11. Event Calendar

The AI Decision Engine includes a hardcoded event calendar for 2026 that tracks market-moving events. Events are used in two ways:

1. **News weight boost**: On event days, the news sentiment factor weight increases from 10% to 15%.
2. **Event flags**: Upcoming events (within 3 days) are included in the decision output for display on the dashboard.

### 11.1 Event Categories

| Category                     | Frequency               | Instruments Affected           |
| ---------------------------- | ----------------------- | ------------------------------ |
| RBI MPC Meeting              | Bi-monthly (6 dates)    | NIFTY_50, BANKNIFTY            |
| US Fed FOMC Decision         | 8 dates per year        | NIFTY_50, BANKNIFTY, CRUDEOIL  |
| EIA Crude Oil Inventory      | Weekly (Wednesday)      | CRUDEOIL                       |
| EIA Natural Gas Storage      | Weekly (Thursday)       | NATURALGAS                     |
| India GDP Data               | Quarterly (4 dates)     | NIFTY_50, BANKNIFTY            |
| India CPI Inflation          | Monthly (12 dates)      | NIFTY_50, BANKNIFTY            |
| India Manufacturing PMI      | Monthly (12 dates)      | NIFTY_50, BANKNIFTY            |
| Weekly Options Expiry        | Weekly (Thursday)       | NIFTY_50, BANKNIFTY            |
| Baker Hughes Rig Count       | Weekly (Friday)         | CRUDEOIL, NATURALGAS           |
| OPEC+ Meeting                | Quarterly (4 dates)     | CRUDEOIL                       |

### 11.2 Event Detection Logic

The `get_upcoming_events` function checks two types of events:

**Recurring events** (weekly): Compares the current day of the week and tomorrow's day of the week against the `recurrence` field. Labels are "Today" or "Tomorrow."

**Fixed-date events**: Parses the `date` field and computes the delta from today. Events within 0–3 days are included, labeled as "Today," "Tomorrow," or "In N days."

---

## Appendix A — Keyword Dictionaries

### A.1 Equity Keywords (NIFTY_50)

**Bullish (28 keywords):**

| Keyword                                                                  | Weight | Category       |
| ------------------------------------------------------------------------ | ------ | -------------- |
| rally, surge, breakout, record high, all-time high                       | 2      | Strong bullish |
| rate cut, fii buying, strong earnings, beat estimates                    | 2      | Fundamental    |
| gift nifty positive/higher/green, sgx nifty higher, pre market positive  | 2      | Pre-market     |
| vix falls/drops/low/decline, volatility eases                            | 2      | VIX (low = bullish) |
| wall street rally, s&p 500 gains, nasdaq rally, us futures positive      | 2      | US overnight   |
| gdp growth, cpi falls, inflation eases, pmi expansion                    | 2      | India macro    |
| gain, rise, bullish, positive, growth, recovery, uptrend, buying, inflow, upgrade, outperform, optimism, boost, strong | 1 | Moderate |

**Bearish (28 keywords):** Mirror structure with opposite signals (crash, plunge, rate hike, vix spikes, wall street crash, gdp slows, etc.)

### A.2 Banking Keywords (BANKNIFTY)

Extends the Equity dictionary with 9 additional keywords per side:

| Bullish Additions (weight)                                                 | Bearish Additions (weight)                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| credit growth (2), npa reduction (2), loan growth (2)                      | npa increase (2), bad loans (2), provisioning (1)                         |
| nim expansion (2), bank profit (2)                                         | nim compression (2), moratorium (2)                                       |
| deposit growth (1), casa ratio (1), retail lending (1)                     | us bank crisis (2), banking contagion (2), bank run (2)                   |

### A.3 Crude Oil Keywords (CRUDEOIL)

18 bullish + 18 bearish keywords focused on supply/demand, OPEC, geopolitics, and DXY (inverse correlation — dollar weakness = crude bullish).

### A.4 Natural Gas Keywords (NATURALGAS)

13 bullish + 13 bearish keywords focused on weather, storage, EIA reports, TTF/European gas, and rig counts.

---

## Appendix B — Testing

The AI Decision Engine's scoring and decision logic is covered by the `TestAIDecisionEngine` class in `python_modules/test_python_modules.py`, which validates weighted scoring, direction thresholds, and confidence calculations. The dashboard integration for pushing AI decisions (GO/WAIT/NO_GO) is tested in `server/tradingRoutes.test.ts`.

---

*End of specification.*
