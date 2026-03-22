/**
 * In-memory trading data store.
 * Python modules push data here via REST endpoints.
 * tRPC procedures read from here to serve the frontend.
 */
import type {
  RawOptionChainData,
  RawAnalyzerOutput,
  RawAIDecision,
  InstrumentData,
  Signal,
  Position,
  ModuleStatus,
  SupportResistance,
  ActiveStrike,
  TradingMode,
  SRLevel,
} from '../shared/tradingTypes';

interface InstrumentStore {
  optionChain: RawOptionChainData | null;
  analyzerOutput: RawAnalyzerOutput | null;
  aiDecision: RawAIDecision | null;
  lastOptionChainUpdate: number;
  lastAnalyzerUpdate: number;
  lastAIDecisionUpdate: number;
}

// In-memory store keyed by instrument name
const instrumentStores: Record<string, InstrumentStore> = {};

// Signals log (rolling buffer of last 200 signals)
const signalsLog: Signal[] = [];
const MAX_SIGNALS = 200;

// Positions
const positions: Position[] = [];

// Trading mode
let tradingMode: TradingMode = 'PAPER';

// Active instruments — controls which instruments the Python pipeline processes
// Default: all instruments enabled
const ALL_INSTRUMENT_KEYS = ['NIFTY_50', 'CRUDEOIL', 'NATURALGAS'] as const;
export type InstrumentKey = typeof ALL_INSTRUMENT_KEYS[number];
let activeInstruments: Set<string> = new Set(ALL_INSTRUMENT_KEYS);

// Module heartbeats
const moduleHeartbeats: Record<string, { lastSeen: number; message: string }> = {
  FETCHER: { lastSeen: 0, message: 'Waiting for data...' },
  ANALYZER: { lastSeen: 0, message: 'Waiting for data...' },
  'AI ENGINE': { lastSeen: 0, message: 'Waiting for data...' },
  EXECUTOR: { lastSeen: 0, message: 'Waiting for data...' },
};

// Signal ID counter
let signalIdCounter = 0;

function getOrCreateStore(instrument: string): InstrumentStore {
  if (!instrumentStores[instrument]) {
    instrumentStores[instrument] = {
      optionChain: null,
      analyzerOutput: null,
      aiDecision: null,
      lastOptionChainUpdate: 0,
      lastAnalyzerUpdate: 0,
      lastAIDecisionUpdate: 0,
    };
  }
  return instrumentStores[instrument]!;
}

// --- Data Push Functions (called by REST endpoints) ---

export function pushOptionChain(instrument: string, data: RawOptionChainData): void {
  const store = getOrCreateStore(instrument);
  store.optionChain = data;
  store.lastOptionChainUpdate = Date.now();
  moduleHeartbeats['FETCHER'] = {
    lastSeen: Date.now(),
    message: `Fetched ${instrument} - ${Object.keys(data.oc || {}).length} strikes`,
  };
}

export function pushAnalyzerOutput(instrument: string, data: RawAnalyzerOutput): void {
  const store = getOrCreateStore(instrument);
  store.analyzerOutput = data;
  store.lastAnalyzerUpdate = Date.now();
  moduleHeartbeats['ANALYZER'] = {
    lastSeen: Date.now(),
    message: `Analyzed ${instrument} - Bias: ${data.market_bias}`,
  };

  // Generate signals from analyzer output
  const allSignals = [
    ...(data.oi_change_signals || []),
    ...(data.entry_signals || []),
    ...(data.real_time_signals || []),
    ...(data.smart_money_signals || []),
  ];

  for (const sigText of allSignals) {
    const signal = parseSignalText(instrument, sigText, data.timestamp);
    if (signal) {
      signalsLog.unshift(signal);
      if (signalsLog.length > MAX_SIGNALS) {
        signalsLog.pop();
      }
    }
  }
}

export function pushAIDecision(instrument: string, data: RawAIDecision): void {
  const store = getOrCreateStore(instrument);
  store.aiDecision = data;
  store.lastAIDecisionUpdate = Date.now();
  moduleHeartbeats['AI ENGINE'] = {
    lastSeen: Date.now(),
    message: `${instrument}: ${data.decision} (${(data.confidence_score * 100).toFixed(0)}%)`,
  };
}

export function pushPosition(position: Position): void {
  const existingIdx = positions.findIndex(p => p.id === position.id);
  if (existingIdx >= 0) {
    positions[existingIdx] = position;
  } else {
    positions.unshift(position);
  }
  moduleHeartbeats['EXECUTOR'] = {
    lastSeen: Date.now(),
    message: `${positions.filter(p => p.status === 'OPEN').length} open positions`,
  };
}

export function updateModuleHeartbeat(module: string, message: string): void {
  if (moduleHeartbeats[module]) {
    moduleHeartbeats[module] = { lastSeen: Date.now(), message };
  }
}

export function setTradingMode(mode: TradingMode): void {
  tradingMode = mode;
}

export function getTradingMode(): TradingMode {
  return tradingMode;
}

// --- Active Instruments Management ---

export function getActiveInstruments(): string[] {
  return Array.from(activeInstruments);
}

export function setActiveInstruments(instruments: string[]): void {
  // Validate: only allow known instrument keys, and keep at least one active
  const valid = instruments.filter(k => (ALL_INSTRUMENT_KEYS as readonly string[]).includes(k));
  if (valid.length === 0) {
    // Fallback: keep all active if empty list provided
    activeInstruments = new Set(ALL_INSTRUMENT_KEYS);
  } else {
    activeInstruments = new Set(valid);
  }
}

export function isInstrumentActive(instrument: string): boolean {
  return activeInstruments.has(instrument);
}

// --- Data Read Functions (called by tRPC procedures) ---

export function getModuleStatuses(): ModuleStatus[] {
  const now = Date.now();
  const STALE_THRESHOLD = 30000; // 30 seconds

  return [
    {
      name: 'Option Chain Fetcher',
      shortName: 'FETCHER',
      status: getModuleHealth(moduleHeartbeats['FETCHER']!.lastSeen, now, STALE_THRESHOLD),
      lastUpdate: moduleHeartbeats['FETCHER']!.lastSeen > 0
        ? new Date(moduleHeartbeats['FETCHER']!.lastSeen).toISOString()
        : '',
      message: moduleHeartbeats['FETCHER']!.message,
    },
    {
      name: 'Option Chain Analyzer',
      shortName: 'ANALYZER',
      status: getModuleHealth(moduleHeartbeats['ANALYZER']!.lastSeen, now, STALE_THRESHOLD),
      lastUpdate: moduleHeartbeats['ANALYZER']!.lastSeen > 0
        ? new Date(moduleHeartbeats['ANALYZER']!.lastSeen).toISOString()
        : '',
      message: moduleHeartbeats['ANALYZER']!.message,
    },
    {
      name: 'AI Decision Engine',
      shortName: 'AI ENGINE',
      status: getModuleHealth(moduleHeartbeats['AI ENGINE']!.lastSeen, now, STALE_THRESHOLD),
      lastUpdate: moduleHeartbeats['AI ENGINE']!.lastSeen > 0
        ? new Date(moduleHeartbeats['AI ENGINE']!.lastSeen).toISOString()
        : '',
      message: moduleHeartbeats['AI ENGINE']!.message,
    },
    {
      name: 'Execution Module',
      shortName: 'EXECUTOR',
      status: getModuleHealth(moduleHeartbeats['EXECUTOR']!.lastSeen, now, STALE_THRESHOLD),
      lastUpdate: moduleHeartbeats['EXECUTOR']!.lastSeen > 0
        ? new Date(moduleHeartbeats['EXECUTOR']!.lastSeen).toISOString()
        : '',
      message: moduleHeartbeats['EXECUTOR']!.message,
    },
  ];
}

function getModuleHealth(lastSeen: number, now: number, threshold: number): 'active' | 'warning' | 'error' | 'idle' {
  if (lastSeen === 0) return 'idle';
  const age = now - lastSeen;
  if (age < threshold) return 'active';
  if (age < threshold * 3) return 'warning';
  return 'error';
}

export function getInstrumentData(): InstrumentData[] {
  const instrumentConfigs: Record<string, { displayName: string; exchange: string }> = {
    'NIFTY_50': { displayName: 'NIFTY 50', exchange: 'NSE' },
    'CRUDEOIL': { displayName: 'CRUDE OIL', exchange: 'MCX' },
    'NATURALGAS': { displayName: 'NATURAL GAS', exchange: 'MCX' },
  };

  const result: InstrumentData[] = [];

  for (const [key, config] of Object.entries(instrumentConfigs)) {
    const store = instrumentStores[key];
    if (!store) {
      // Return a placeholder for instruments with no data yet
      result.push(createEmptyInstrument(key, config.displayName, config.exchange));
      continue;
    }

    const oc = store.optionChain;
    const analyzer = store.analyzerOutput;
    const ai = store.aiDecision;

    // Calculate OI totals from raw option chain
    let totalCallOI = 0;
    let totalPutOI = 0;
    let strikesFound = 0;

    if (oc && oc.oc) {
      for (const strikeData of Object.values(oc.oc)) {
        strikesFound++;
        if (strikeData.ce) totalCallOI += strikeData.ce.oi;
        if (strikeData.pe) totalPutOI += strikeData.pe.oi;
      }
    }

    const pcrRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

    // Build support/resistance from analyzer
    const supportLevels: SupportResistance[] = (analyzer?.support_levels || []).map(strike => ({
      strike,
      callOI: getStrikeOI(oc, strike, 'ce'),
      putOI: getStrikeOI(oc, strike, 'pe'),
      type: 'support' as const,
    }));

    const resistanceLevels: SupportResistance[] = (analyzer?.resistance_levels || []).map(strike => ({
      strike,
      callOI: getStrikeOI(oc, strike, 'ce'),
      putOI: getStrikeOI(oc, strike, 'pe'),
      type: 'resistance' as const,
    }));

    // Build active strikes from analyzer
    const activeStrikes: ActiveStrike[] = [];
    if (analyzer?.active_strikes) {
      for (const strike of (analyzer.active_strikes.call || []).slice(0, 5)) {
        const ceData = oc?.oc?.[String(strike)]?.ce;
        activeStrikes.push({
          strike,
          type: 'call',
          oi: ceData?.oi || 0,
          oiChange: ceData ? ceData.oi - (ceData.previous_oi || 0) : 0,
          volume: ceData?.volume || 0,
          signal: getStrikeSignal(strike, 'call', analyzer),
        });
      }
      for (const strike of (analyzer.active_strikes.put || []).slice(0, 5)) {
        const peData = oc?.oc?.[String(strike)]?.pe;
        activeStrikes.push({
          strike,
          type: 'put',
          oi: peData?.oi || 0,
          oiChange: peData ? peData.oi - (peData.previous_oi || 0) : 0,
          volume: peData?.volume || 0,
          signal: getStrikeSignal(strike, 'put', analyzer),
        });
      }
    }

    // Map market bias
    let marketBias: InstrumentData['marketBias'] = 'NEUTRAL';
    if (analyzer?.market_bias) {
      const bias = analyzer.market_bias.toUpperCase();
      if (bias.includes('BULLISH')) marketBias = 'BULLISH';
      else if (bias.includes('BEARISH')) marketBias = 'BEARISH';
      else if (bias.includes('RANGE') || bias.includes('BOUND')) marketBias = 'RANGE_BOUND';
    }

    // Map AI decision
    let aiDecision: InstrumentData['aiDecision'] = 'WAIT';
    let aiConfidence = 0;
    let aiRationale = 'Waiting for AI analysis...';
    if (ai) {
      const dec = ai.decision?.toUpperCase() || '';
      if (dec === 'GO') aiDecision = 'GO';
      else if (dec === 'NO_GO' || dec === 'NO GO') aiDecision = 'NO_GO';
      else aiDecision = 'WAIT';
      aiConfidence = ai.confidence_score || 0;
      aiRationale = ai.rationale || 'No rationale provided.';
    }

    // Get instrument-specific signals
    const instrumentSignals = signalsLog.filter(s => s.instrument === key).slice(0, 20);

    result.push({
      name: key,
      displayName: config.displayName,
      exchange: config.exchange,
      expiry: analyzer?.timestamp ? new Date(analyzer.timestamp).toLocaleDateString('en-IN') : 'N/A',
      lastPrice: oc?.last_price || analyzer?.last_price || 0,
      marketBias,
      aiDecision,
      aiConfidence,
      aiRationale,
      supportLevels,
      resistanceLevels,
      activeStrikes,
      signals: instrumentSignals,
      totalCallOI,
      totalPutOI,
      pcrRatio,
      strikesFound,

      // Enhanced fields from v2 AI engine (pass through if available)
      srLevels: ai?.sr_levels || buildSRLevelsFromStore(store, ai),
      tradeDirection: ai?.trade_direction,
      atmStrike: ai?.atm_strike,
      supportAnalysis: ai?.support_analysis,
      resistanceAnalysis: ai?.resistance_analysis,
      ivAssessment: ai?.iv_assessment,
      thetaAssessment: ai?.theta_assessment,
      tradeSetup: ai?.trade_setup,
      riskFlags: ai?.risk_flags,
      scoringFactors: ai?.scoring_factors,
    });
  }

  return result;
}

export function getSignals(limit: number = 50): Signal[] {
  return signalsLog.slice(0, limit);
}

export function getPositions(): Position[] {
  return positions;
}

// --- Helper Functions ---

function getStrikeOI(oc: RawOptionChainData | null, strike: number, type: 'ce' | 'pe'): number {
  if (!oc || !oc.oc) return 0;
  const strikeData = oc.oc[String(strike)];
  if (!strikeData) return 0;
  return (type === 'ce' ? strikeData.ce?.oi : strikeData.pe?.oi) || 0;
}

function getStrikeSignal(strike: number, type: string, analyzer: RawAnalyzerOutput): string {
  // Try to find a signal mentioning this strike
  const allSignals = [
    ...(analyzer.oi_change_signals || []),
    ...(analyzer.entry_signals || []),
    ...(analyzer.real_time_signals || []),
  ];
  const strikeStr = String(strike);
  for (const sig of allSignals) {
    if (sig.includes(strikeStr)) {
      if (sig.toLowerCase().includes('buildup')) return 'BUILDUP';
      if (sig.toLowerCase().includes('writing')) return 'WRITING';
      if (sig.toLowerCase().includes('covering')) return 'COVERING';
      if (sig.toLowerCase().includes('unwinding')) return 'UNWINDING';
    }
  }
  return 'ACTIVE';
}

function parseSignalText(instrument: string, text: string, timestamp: string): Signal | null {
  if (!text || text.trim().length === 0) return null;

  signalIdCounter++;
  const id = `sig_${signalIdCounter}`;
  const lower = text.toLowerCase();

  let type: Signal['type'] = 'long_buildup';
  let severity: Signal['severity'] = 'medium';
  let strike = 0;

  // Extract strike price from text (look for numbers)
  const strikeMatch = text.match(/(\d{3,6})/);
  if (strikeMatch) strike = parseInt(strikeMatch[1]!, 10);

  // Determine signal type
  if (lower.includes('long buildup') || lower.includes('long_buildup')) {
    type = 'long_buildup';
    severity = 'high';
  } else if (lower.includes('short buildup') || lower.includes('short_buildup')) {
    type = 'short_buildup';
    severity = 'high';
  } else if (lower.includes('short covering') || lower.includes('short_covering')) {
    type = 'short_covering';
    severity = 'medium';
  } else if (lower.includes('long unwinding') || lower.includes('long_unwinding')) {
    type = 'long_unwinding';
    severity = 'medium';
  } else if (lower.includes('call writing') || lower.includes('call_writing')) {
    type = 'call_writing';
    severity = 'high';
  } else if (lower.includes('put writing') || lower.includes('put_writing')) {
    type = 'put_writing';
    severity = 'high';
  } else if (lower.includes('trap') && lower.includes('up')) {
    type = 'trap_up';
    severity = 'high';
  } else if (lower.includes('trap') && lower.includes('down')) {
    type = 'trap_down';
    severity = 'high';
  } else if (lower.includes('scalp') && lower.includes('buy')) {
    type = 'scalp_buy';
    severity = 'low';
  } else if (lower.includes('scalp') && lower.includes('sell')) {
    type = 'scalp_sell';
    severity = 'low';
  }

  return {
    id,
    timestamp: timestamp || new Date().toISOString(),
    instrument,
    type,
    strike,
    description: text,
    severity,
  };
}

/**
 * Build S/R levels from the option chain + analyzer data when the AI engine
 * hasn't provided pre-computed sr_levels (fallback for legacy AI output).
 * Constructs up to 11 levels: S5..S1, ATM, R1..R5.
 */
function buildSRLevelsFromStore(
  store: InstrumentStore,
  ai: RawAIDecision | null,
): SRLevel[] | undefined {
  const oc = store.optionChain;
  const analyzer = store.analyzerOutput;
  if (!oc || !oc.oc || !analyzer) return undefined;

  const ltp = oc.last_price || analyzer.last_price || 0;
  if (ltp === 0) return undefined;

  const supportStrikes = (analyzer.support_levels || []).sort((a, b) => a - b);
  const resistanceStrikes = (analyzer.resistance_levels || []).sort((a, b) => a - b);
  const atmStrike = ai?.atm_strike || 0;

  const levels: SRLevel[] = [];

  // Build support levels (S5 = farthest, S1 = closest to ATM)
  const supReversed = [...supportStrikes].reverse(); // closest first
  for (let i = 0; i < Math.min(5, supReversed.length); i++) {
    const strike = supReversed[i]!;
    const label = `S${i + 1}`;
    const peData = findStrikeData(oc, strike, 'pe');
    const currentOI = peData?.oi || 0;
    const prevOI = peData?.previous_oi || 0;
    const oiChange = currentOI - prevOI;
    const oiChangePct = prevOI > 0 ? ((oiChange / prevOI) * 100) : 0;

    const { activityLabel, technicalLabel, trend, trendArrow, barStatus } =
      classifyActivity(oiChange, oiChangePct, ltp, oc.last_price || 0, 'support');

    levels.push({
      strike,
      label,
      type: 'support',
      oi: currentOI,
      openOI: prevOI, // best approximation without opening snapshot
      oiChangePct: Math.round(oiChangePct * 10) / 10,
      oiChangeAbs: oiChange,
      strength: computeQuickStrength(currentOI, oiChange, oc, 'pe'),
      activityLabel,
      technicalLabel,
      trend,
      trendArrow,
      barStatus,
    });
  }

  // Reverse so S5 is first (farthest from ATM)
  levels.reverse();

  // ATM level
  if (atmStrike > 0) {
    levels.push({
      strike: atmStrike,
      label: 'ATM',
      type: 'atm',
      oi: 0,
      openOI: 0,
      oiChangePct: 0,
      oiChangeAbs: 0,
      strength: 0,
      activityLabel: 'Current Price',
      technicalLabel: 'LTP',
      trend: 'flat',
      trendArrow: '●',
      barStatus: 'atm',
    });
  }

  // Build resistance levels (R1 = closest, R5 = farthest)
  for (let i = 0; i < Math.min(5, resistanceStrikes.length); i++) {
    const strike = resistanceStrikes[i]!;
    const label = `R${i + 1}`;
    const ceData = findStrikeData(oc, strike, 'ce');
    const currentOI = ceData?.oi || 0;
    const prevOI = ceData?.previous_oi || 0;
    const oiChange = currentOI - prevOI;
    const oiChangePct = prevOI > 0 ? ((oiChange / prevOI) * 100) : 0;

    const { activityLabel, technicalLabel, trend, trendArrow, barStatus } =
      classifyActivity(oiChange, oiChangePct, ltp, oc.last_price || 0, 'resistance');

    levels.push({
      strike,
      label,
      type: 'resistance',
      oi: currentOI,
      openOI: prevOI,
      oiChangePct: Math.round(oiChangePct * 10) / 10,
      oiChangeAbs: oiChange,
      strength: computeQuickStrength(currentOI, oiChange, oc, 'ce'),
      activityLabel,
      technicalLabel,
      trend,
      trendArrow,
      barStatus,
    });
  }

  return levels.length > 0 ? levels : undefined;
}

function findStrikeData(
  oc: RawOptionChainData,
  strike: number,
  type: 'ce' | 'pe',
): { oi: number; previous_oi: number; volume: number; implied_volatility: number } | null {
  const strikeStr = String(strike);
  let data = oc.oc[strikeStr];
  if (!data) {
    // Try float key matching
    for (const key of Object.keys(oc.oc)) {
      try {
        if (Math.abs(parseFloat(key) - strike) < 0.01) {
          data = oc.oc[key];
          break;
        }
      } catch { continue; }
    }
  }
  if (!data) return null;
  const side = type === 'ce' ? data.ce : data.pe;
  if (!side) return null;
  return {
    oi: side.oi || 0,
    previous_oi: side.previous_oi || 0,
    volume: side.volume || 0,
    implied_volatility: side.implied_volatility || 0,
  };
}

function classifyActivity(
  oiChange: number,
  oiChangePct: number,
  _ltp: number,
  _currentPrice: number,
  wallType: 'support' | 'resistance',
): {
  activityLabel: string;
  technicalLabel: string;
  trend: SRLevel['trend'];
  trendArrow: string;
  barStatus: SRLevel['barStatus'];
} {
  const absPct = Math.abs(oiChangePct);

  if (oiChange > 0) {
    // OI increasing
    if (wallType === 'support') {
      // Put OI increasing at support = sellers entering (short buildup) = wall strengthening
      return {
        activityLabel: 'Sellers Entering',
        technicalLabel: 'Short Buildup',
        trend: absPct > 10 ? 'strong_up' : 'up',
        trendArrow: absPct > 10 ? '▲▲' : '▲',
        barStatus: 'strengthening',
      };
    } else {
      // Call OI increasing at resistance = sellers entering (call writing) = wall strengthening
      return {
        activityLabel: 'Sellers Entering',
        technicalLabel: 'Call Writing',
        trend: absPct > 10 ? 'strong_up' : 'up',
        trendArrow: absPct > 10 ? '▲▲' : '▲',
        barStatus: 'strengthening',
      };
    }
  } else if (oiChange < 0) {
    // OI decreasing
    if (wallType === 'support') {
      // Put OI decreasing at support = sellers exiting (short covering) = wall weakening
      return {
        activityLabel: 'Sellers Exiting',
        technicalLabel: 'Short Covering',
        trend: absPct > 10 ? 'strong_down' : 'down',
        trendArrow: absPct > 10 ? '▼▼' : '▼',
        barStatus: 'weakening',
      };
    } else {
      // Call OI decreasing at resistance = sellers exiting (short covering) = wall weakening
      return {
        activityLabel: 'Sellers Exiting',
        technicalLabel: 'Short Covering',
        trend: absPct > 10 ? 'strong_down' : 'down',
        trendArrow: absPct > 10 ? '▼▼' : '▼',
        barStatus: 'weakening',
      };
    }
  } else {
    return {
      activityLabel: 'Holding Steady',
      technicalLabel: 'No Change',
      trend: 'flat',
      trendArrow: '─',
      barStatus: 'stable',
    };
  }
}

function computeQuickStrength(
  currentOI: number,
  oiChange: number,
  oc: RawOptionChainData,
  type: 'ce' | 'pe',
): number {
  // Compare this strike's OI to the average OI of all strikes of the same type
  const allOI: number[] = [];
  for (const v of Object.values(oc.oc)) {
    const side = type === 'ce' ? v.ce : v.pe;
    if (side && side.oi > 0) allOI.push(side.oi);
  }
  const avgOI = allOI.length > 0 ? allOI.reduce((a, b) => a + b, 0) / allOI.length : 1;

  let strength = 50;
  const ratio = currentOI / Math.max(avgOI, 1);
  if (ratio > 3) strength += 25;
  else if (ratio > 1.5) strength += 15;
  else if (ratio < 0.5) strength -= 15;

  if (oiChange > 0) strength += 15;
  else if (oiChange < 0) strength -= 20;

  return Math.max(0, Math.min(100, strength));
}

function createEmptyInstrument(name: string, displayName: string, exchange: string): InstrumentData {
  return {
    name,
    displayName,
    exchange,
    expiry: 'N/A',
    lastPrice: 0,
    marketBias: 'NEUTRAL',
    aiDecision: 'WAIT',
    aiConfidence: 0,
    aiRationale: 'Waiting for data from Python modules...',
    supportLevels: [],
    resistanceLevels: [],
    activeStrikes: [],
    signals: [],
    totalCallOI: 0,
    totalPutOI: 0,
    pcrRatio: 0,
    strikesFound: 0,
  };
}
