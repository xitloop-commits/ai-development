# Discipline Engine — Settings Gap Analysis

**Purpose:** Cross-reference the Settings page spec (Feature 4 in `ats-feature-requirements.md`, lines 606–658) against the Discipline Engine spec (Section 12 in `discipline-engine-spec.md`, lines 665–712) to ensure all configuration/settings live in the Settings spec, and the Discipline Engine spec focuses purely on logic and behavior.

---

## Sources Compared

| Source | Location | Role |
|--------|----------|------|
| **Settings Page Spec** | `ats-feature-requirements.md` → "Settings Page — Complete Parameter Reference" (lines 606–658) | Authoritative list of what appears in the Settings UI |
| **Discipline Engine Spec** | `discipline-engine-spec.md` → Section 12 "Settings Schema & Defaults" (lines 665–712) | Detailed settings with types, ranges, and defaults |
| **Discipline Engine Data Model** | `discipline-engine-spec.md` → Section 3 "Data Model" (lines 169–278) | MongoDB `discipline_settings` schema with per-rule enable/disable toggles |

---

## 1. Line-by-Line Comparison

The table below maps every setting from the Discipline Engine spec (Section 12) to its counterpart in the Settings Page spec. **"Missing"** means the setting exists in the Discipline Engine spec but is absent from the Settings Page spec.

| # | Discipline Engine Spec (Section 12) | Default | Settings Page Spec | Status |
|---|-------------------------------------|---------|-------------------|--------|
| 1 | Daily loss limit **enabled** toggle | true | Not listed (only "Daily loss limit %" listed) | **MISSING** — enable/disable toggle |
| 2 | Daily loss limit threshold % | 3% | "Daily loss limit % (default: 3%)" | **MATCH** |
| 3 | Max consecutive losses **enabled** toggle | true | Not listed (only count listed) | **MISSING** — enable/disable toggle |
| 4 | Max consecutive losses count | 3 | "Max consecutive losses before cooldown (default: 3)" | **MATCH** |
| 5 | Max consecutive losses cooldown duration | 30 min | "Cooldown duration after consecutive losses (default: 30 min)" | **MATCH** |
| 6 | Max trades per day **enabled** toggle | true | Not listed (only limit listed) | **MISSING** — enable/disable toggle |
| 7 | Max trades per day limit | 5 | "Max trades per day (default: 5)" | **MATCH** |
| 8 | Max open positions **enabled** toggle | true | Not listed (only limit listed) | **MISSING** — enable/disable toggle |
| 9 | Max open positions limit | 3 | "Max open positions (default: 3)" | **MATCH** |
| 10 | Revenge cooldown **enabled** toggle | true | Not listed (only duration listed) | **MISSING** — enable/disable toggle |
| 11 | Revenge cooldown duration | 15 min | "Revenge trade cooldown duration (default: 15 min, options: 10/15/30 min)" | **MATCH** |
| 12 | Require loss acknowledgment | true | "Require 'I accept the loss' acknowledgment (default: ON)" | **MATCH** |
| 13 | No trading after open **enabled** toggle | true | Not listed as toggle | **MISSING** — enable/disable toggle (Time Windows section has the values but no toggle) |
| 14 | No trading after open (NSE) | 15 min | "No trading first N minutes after market open (default: 15 min) — per exchange" | **MATCH** (implicit) |
| 15 | No trading after open (MCX) | 15 min | Same as above | **MATCH** (implicit) |
| 16 | No trading before close **enabled** toggle | true | Not listed as toggle | **MISSING** — enable/disable toggle |
| 17 | No trading before close (NSE) | 15 min | "No trading last N minutes before market close (default: 15 min) — per exchange" | **MATCH** (implicit) |
| 18 | No trading before close (MCX) | 15 min | Same as above | **MATCH** (implicit) |
| 19 | Lunch break pause enabled | false | "Lunch break pause toggle (default: OFF) — NSE only" | **MATCH** |
| 20 | Lunch break start time | 12:30 | Not listed (implied by "12:30–1:30 PM" in Feature 16) | **MISSING** — configurable start time |
| 21 | Lunch break end time | 13:30 | Not listed (implied) | **MISSING** — configurable end time |
| 22 | Pre-trade gate **enabled** toggle | true | "Pre-trade confirmation gate toggle (default: ON)" | **MATCH** |
| 23 | Min R:R check **enabled** toggle | true | Not listed as separate toggle | **MISSING** — sub-toggle for R:R check within pre-trade gate |
| 24 | Min R:R ratio | 1.5 | "Minimum R:R ratio for trade approval (default: 1:1.5)" | **MATCH** |
| 25 | Emotional state check **enabled** toggle | true | Not listed | **MISSING** — sub-toggle for emotional state check |
| 26 | Max position size **enabled** toggle | true | Not listed (only % listed) | **MISSING** — enable/disable toggle |
| 27 | Max position size % | 40% | "Max position size % of capital (default: 40%)" | **MATCH** |
| 28 | Max total exposure **enabled** toggle | true | Not listed (only % listed) | **MISSING** — enable/disable toggle |
| 29 | Max total exposure % | 80% | "Max total exposure % of capital (default: 80%)" | **MATCH** |
| 30 | Journal enforcement **enabled** toggle | true | "Trade journal enforcement toggle (default: ON)" | **MATCH** |
| 31 | Max unjournaled trades | 3 | "Max unjournaled trades before block (default: 3)" | **MATCH** |
| 32 | Weekly review **enabled** toggle | true | "Weekly review gate toggle (default: ON)" | **MATCH** |
| 33 | Discipline score warning threshold | 70 | "Discipline score warning" mentioned in Feature 19 but **not in Settings param list** | **MISSING** — configurable threshold value |
| 34 | Red week reduction trigger (weeks) | 3 | "Red week reduction" mentioned in Feature 19 but **not in Settings param list** | **MISSING** — configurable trigger count |
| 35 | Winning streak reminder **enabled** toggle | true | Not listed as toggle | **MISSING** — enable/disable toggle |
| 36 | Winning streak trigger (days) | 5 | "Winning streak reminder threshold (default: 5 days)" | **MATCH** |
| 37 | Losing streak auto-reduce **enabled** toggle | true | Not listed as toggle | **MISSING** — enable/disable toggle |
| 38 | Losing streak trigger (days) | 3 | "Losing streak auto-reduce threshold (default: 3 days)" | **MATCH** |
| 39 | Losing streak reduction % | 50% | Not listed | **MISSING** — configurable reduction percentage |

---

## 2. Summary of Gaps

### 2.1 Missing Enable/Disable Toggles (13 items)

The Discipline Engine spec defines that **every rule** has an `enabled/disabled` toggle (Section 1, paragraph 3). The Settings Page spec lists the configurable parameter values but omits the per-rule enable/disable toggles for most rules. These toggles are missing from the Settings Page spec:

1. Daily loss limit enabled
2. Max consecutive losses enabled
3. Max trades per day enabled
4. Max open positions enabled
5. Revenge cooldown enabled
6. No trading after open enabled
7. No trading before close enabled
8. Min R:R check enabled (sub-toggle within pre-trade gate)
9. Emotional state check enabled (sub-toggle within pre-trade gate)
10. Max position size enabled
11. Max total exposure enabled
12. Winning streak reminder enabled
13. Losing streak auto-reduce enabled

### 2.2 Missing Configurable Parameters (4 items)

These configurable values exist in the Discipline Engine spec but are absent from the Settings Page spec:

1. **Lunch break start time** (default: 12:30) — currently implied as fixed
2. **Lunch break end time** (default: 13:30) — currently implied as fixed
3. **Discipline score warning threshold** (default: 70, range: 50–90)
4. **Red week reduction trigger count** (default: 3 weeks, range: 2–5)
5. **Losing streak reduction percentage** (default: 50%, range: 25–75%)

### 2.3 Missing Type/Range Metadata

The Settings Page spec lists settings as a flat bullet list without specifying:
- **Input type** (toggle, number, select, time picker)
- **Valid range** (min/max for numbers)
- **UI grouping** (which settings belong to which group/card)

The Discipline Engine spec Section 12 provides all of this. The Settings Page spec should either reference Section 12 or incorporate these details.

### 2.4 Settings That Exist in Settings Page Spec But NOT in Discipline Engine Spec

The current **implemented** `userSettings.ts` has these legacy fields that appear in neither the new Discipline Engine spec nor the Settings Page spec as currently written:

| Legacy Field | Current Default | Disposition |
|-------------|----------------|-------------|
| `maxLossPerDay` (absolute ₹) | 5000 | **Dropped** — Discipline Engine spec uses only % of capital |
| `mandatoryChecklist` | true | **Replaced** by `preTradeGate.enabled` |
| `minChecklistScore` | 60 | **Dropped** — replaced by the 7-check gate system |
| `trailingStopEnabled` | false | **Not discipline** — belongs in Order Execution settings |
| `trailingStopPercent` | 1.5 | **Not discipline** — belongs in Order Execution settings |
| `noRevengeTrading` | true | **Replaced** by `revengeCooldown.enabled` |
| `requireRationale` | false | **Replaced** by journal enforcement |

---

## 3. Recommendations

### 3.1 Update the Settings Page Spec

Add the following to the "Discipline" section of the Settings Page Parameter Reference:

**Per-rule enable/disable toggles** — Every discipline rule should have an explicit toggle listed. The Settings Page spec should state: *"Each discipline rule has an enabled/disabled toggle. When disabled, the rule does not block trades and its weight is redistributed in the discipline score."*

**Missing parameters to add:**
- Lunch break start time (time picker, default: 12:30)
- Lunch break end time (time picker, default: 13:30)
- Discipline score warning threshold (number, 50–90, default: 70)
- Red week reduction trigger (number, 2–5 weeks, default: 3)
- Losing streak reduction % (number, 25–75%, default: 50%)

**Type and range metadata** — Either reference the Discipline Engine spec Section 12 table directly, or incorporate the type/range columns into the Settings Page spec.

### 3.2 Clean Up the Discipline Engine Spec

The Discipline Engine spec should **remove or minimize** Section 12 (Settings Schema & Defaults) and instead reference the Settings Page spec as the single source of truth for settings. The Discipline Engine spec should retain:
- The `DisciplineSettings` TypeScript interface (Section 3, Data Model) — this is the implementation contract
- The default values table — needed for code implementation
- References to the Settings Page spec for UI layout and grouping

Alternatively, keep Section 12 as-is but add a note: *"The authoritative UI specification for these settings is in the Settings Page spec (Feature 4). This section defines the data model and defaults for implementation."*

### 3.3 Handle Legacy Settings Migration

The legacy `DisciplineSettings` interface in `userSettings.ts` should be deprecated. The migration path:
- `maxLossPerDay` (₹) → dropped (use only % of capital)
- `mandatoryChecklist` → `preTradeGate.enabled`
- `minChecklistScore` → dropped
- `trailingStopEnabled` / `trailingStopPercent` → move to Order Execution section
- `noRevengeTrading` → `revengeCooldown.enabled`
- `requireRationale` → `journalEnforcement.enabled`

### 3.4 Time Windows Ownership

Time window settings currently appear in **both** the Settings Page spec (under "Time Windows" section) and the Discipline Engine spec (Module 3). The recommendation:
- **Settings Page spec** owns the configuration (what the user sees and edits)
- **Discipline Engine spec** owns the enforcement logic (how time windows block trades)
- Both specs should cross-reference each other

---

## 4. Disposition Summary

| Category | Count | Action |
|----------|-------|--------|
| Settings that match between both specs | 20 | No action needed |
| Enable/disable toggles missing from Settings spec | 13 | Add to Settings spec |
| Configurable parameters missing from Settings spec | 5 | Add to Settings spec |
| Legacy settings to deprecate | 7 | Document migration path |
| **Total settings in Discipline Engine spec** | **39** | — |
| **Total settings currently in Settings Page spec** | **16** | Needs expansion to ~39 |
