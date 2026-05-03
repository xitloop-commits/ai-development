/**
 * Indicators — locked behaviours.
 *
 * Two scopes:
 *
 *   1. `computeAiRollup` (pure function) — the AI dot's status logic is
 *      where the real semantic content lives. Test it directly with
 *      hand-built query stubs; no React, no tRPC mock.
 *   2. Render smoke — `<Indicators />` mounts and shows the four
 *      cells (API / FEED / AI / Discipline) with mocked tRPC.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { computeAiRollup } from './Indicators';

// ─── computeAiRollup logic ──────────────────────────────────────

type Q = { data: any };

function q(data: any): Q {
  return { data };
}

function liveData({
  fileAgeSec = 5,
  marketOpen = true,
}: { fileAgeSec?: number; marketOpen?: boolean } = {}) {
  return { file_age_sec: fileAgeSec, is_market_open: marketOpen ? 1 : 0 };
}

function model() {
  return { version: 'v1', trained_at: 'x', feature_count: 100, metrics: {} };
}

describe('computeAiRollup — AI pipeline status logic', () => {
  it('returns gray when no instrument has market open', () => {
    const queries = [
      q({ live: liveData({ marketOpen: false }), signal: null, model: model() }),
      q({ live: liveData({ marketOpen: false }), signal: null, model: model() }),
      q({ live: liveData({ marketOpen: false }), signal: null, model: model() }),
      q({ live: liveData({ marketOpen: false }), signal: null, model: model() }),
    ];
    const r = computeAiRollup(queries as any);
    expect(r.status).toBe('gray');
    expect(r.anyMarketOpen).toBe(false);
    expect(r.modelsLoadedCount).toBe(4);
  });

  it('returns green when market open, all instruments fresh, and 4/4 models loaded', () => {
    const queries = [
      q({ live: liveData({ fileAgeSec: 3 }), signal: null, model: model() }),
      q({ live: liveData({ fileAgeSec: 8 }), signal: null, model: model() }),
      q({ live: liveData({ fileAgeSec: 12 }), signal: null, model: model() }),
      q({ live: liveData({ fileAgeSec: 5 }), signal: null, model: model() }),
    ];
    const r = computeAiRollup(queries as any);
    expect(r.status).toBe('green');
    expect(r.modelsLoadedCount).toBe(4);
  });

  it('returns red when market open and zero models loaded (signals would be impossible)', () => {
    const queries = [
      q({ live: liveData({ fileAgeSec: 3 }), signal: null, model: null }),
      q({ live: liveData({ fileAgeSec: 8 }), signal: null, model: null }),
      q({ live: liveData({ fileAgeSec: 12 }), signal: null, model: null }),
      q({ live: liveData({ fileAgeSec: 5 }), signal: null, model: null }),
    ];
    const r = computeAiRollup(queries as any);
    expect(r.status).toBe('red');
    expect(r.modelsLoadedCount).toBe(0);
  });

  it('returns red when market open and TFA is stale on every live instrument', () => {
    const queries = [
      q({ live: liveData({ fileAgeSec: 600 }), signal: null, model: model() }),
      q({ live: liveData({ fileAgeSec: 600 }), signal: null, model: model() }),
      q({ live: liveData({ fileAgeSec: 600 }), signal: null, model: model() }),
      q({ live: liveData({ fileAgeSec: 600 }), signal: null, model: model() }),
    ];
    const r = computeAiRollup(queries as any);
    expect(r.status).toBe('red');
  });

  it('returns amber when models < 4/4 (partial degradation, not full red)', () => {
    const queries = [
      q({ live: liveData({ fileAgeSec: 3 }), signal: null, model: model() }),
      q({ live: liveData({ fileAgeSec: 8 }), signal: null, model: model() }),
      q({ live: liveData({ fileAgeSec: 12 }), signal: null, model: model() }),
      q({ live: liveData({ fileAgeSec: 5 }), signal: null, model: null }), // model missing
    ];
    const r = computeAiRollup(queries as any);
    expect(r.status).toBe('amber');
    expect(r.modelsLoadedCount).toBe(3);
  });

  it('returns amber when one instrument is TFA-stale but others are fresh (partial)', () => {
    const queries = [
      q({ live: liveData({ fileAgeSec: 3 }), signal: null, model: model() }),
      q({ live: liveData({ fileAgeSec: 200 }), signal: null, model: model() }), // stale
      q({ live: liveData({ fileAgeSec: 12 }), signal: null, model: model() }),
      q({ live: liveData({ fileAgeSec: 5 }), signal: null, model: model() }),
    ];
    const r = computeAiRollup(queries as any);
    expect(r.status).toBe('amber');
  });

  it('does not penalise instruments whose market is closed', () => {
    // CRUDEOIL closed (MCX market hours), NIFTY/BANKNIFTY open and fresh,
    // GAS closed too. Result should be GREEN (the live ones are healthy).
    const queries = [
      q({ live: liveData({ fileAgeSec: 3 }), signal: null, model: model() }),
      q({ live: liveData({ fileAgeSec: 8 }), signal: null, model: model() }),
      q({ live: liveData({ marketOpen: false, fileAgeSec: 9999 }), signal: null, model: model() }),
      q({ live: liveData({ marketOpen: false, fileAgeSec: 9999 }), signal: null, model: model() }),
    ];
    const r = computeAiRollup(queries as any);
    expect(r.status).toBe('green');
    expect(r.anyMarketOpen).toBe(true);
  });

  it('handles missing live data gracefully (treats as not-fresh, market closed)', () => {
    const queries = [
      q({ live: null, signal: null, model: model() }),
      q({ live: null, signal: null, model: model() }),
      q({ live: null, signal: null, model: model() }),
      q({ live: null, signal: null, model: model() }),
    ];
    const r = computeAiRollup(queries as any);
    // No market open anywhere → gray
    expect(r.status).toBe('gray');
  });

  it('extracts the most-recent signal age across all instruments', () => {
    // BANKNIFTY has the freshest signal (2 minutes ago); NIFTY older.
    const now = Date.now();
    const twoMinAgo = new Date(now - 2 * 60_000).toISOString();
    const tenMinAgo = new Date(now - 10 * 60_000).toISOString();
    const queries = [
      q({ live: liveData(), signal: { timestamp_ist: tenMinAgo }, model: model() }),
      q({ live: liveData(), signal: { timestamp_ist: twoMinAgo }, model: model() }),
      q({ live: liveData(), signal: null, model: model() }),
      q({ live: liveData(), signal: null, model: model() }),
    ];
    const r = computeAiRollup(queries as any);
    expect(r.lastSignalAgeSec).not.toBeNull();
    expect(r.lastSignalAgeSec!).toBeLessThan(180); // within 3 min of "two minutes ago"
    expect(r.lastSignalAgeSec!).toBeGreaterThan(60);
  });

  it('reports per-instrument freshness so the tooltip can colour each label', () => {
    const queries = [
      q({ live: liveData({ fileAgeSec: 3 }), signal: null, model: model() }),
      q({ live: liveData({ fileAgeSec: 999 }), signal: null, model: model() }),
      q({ live: liveData({ marketOpen: false }), signal: null, model: null }),
      q({ live: liveData({ fileAgeSec: 30 }), signal: null, model: model() }),
    ];
    const r = computeAiRollup(queries as any);
    expect(r.perInstrument[0].tfaFresh).toBe(true);
    expect(r.perInstrument[1].tfaFresh).toBe(false);
    expect(r.perInstrument[2].marketOpen).toBe(false);
    expect(r.perInstrument[3].tfaFresh).toBe(true);
    expect(r.perInstrument[2].modelLoaded).toBe(false);
    expect(r.perInstrument[3].modelLoaded).toBe(true);
  });
});

// ─── Render smoke for the composite ─────────────────────────────

// ─── tRPC mock — uses the REAL BrokerServiceStatus shape ────────
// Pre-fix the indicator silently read non-existent `connected` /
// `activeBroker` / `mode` fields and always displayed "None Connected,
// Paper Trading". Mock is now keyed off the actual fields the server
// returns from `getBrokerServiceStatus()`.

const noopQuery = { data: undefined, isLoading: false };

const mockBrokerStatus = {
  data: {
    activeBrokerId: 'dhan',
    activeBrokerName: 'Dhan (Trading)',
    tokenStatus: 'valid',
    apiStatus: 'connected',
    wsStatus: 'connected',
    killSwitchActive: false,
    registeredAdapters: ['dhan', 'mock-ai', 'mock-my'],
  },
  isLoading: false,
};

vi.mock('@/lib/trpc', () => ({
  trpc: {
    broker: {
      status: { useQuery: () => mockBrokerStatus },
      feed: { state: { useQuery: () => ({ data: { wsConnected: true, totalSubscriptions: 4 }, isLoading: false }) } },
    },
    discipline: {
      getDashboard: { useQuery: () => ({ data: { score: 92, breakdown: {
        circuitBreaker: 20, tradeLimits: 15, cooldowns: 15, timeWindows: 10,
        positionSizing: 15, journal: 10, preTradeGate: 7,
      } }, isLoading: false }) },
    },
    trading: {
      instrumentLiveState: { useQuery: () => noopQuery },
    },
  },
}));

import { Indicators } from './Indicators';

describe('Indicators — render smoke', () => {
  it('mounts the four cells with their text labels visible', () => {
    render(<Indicators />);
    expect(screen.getByText('API')).toBeInTheDocument();
    expect(screen.getByText('FEED')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
    // Discipline shows the score number 92
    expect(screen.getByText('92')).toBeInTheDocument();
  });
});

// ─── ApiIndicator regression — guard against the field-mismatch bug ─
// Pre-fix the indicator read non-existent `connected` field; `undefined
// !== false` was true so the icon ALWAYS showed green even when the
// broker was offline. Tooltip content renders inside a Radix Portal so
// it's not assertable without hover-simulation; instead we test the
// visible icon-color class on the trigger, which is the user-facing
// signal anyway.

describe('Indicators — ApiIndicator field-mismatch regression', () => {
  it('icon is green (text-bullish) when apiStatus=connected AND tokenStatus=valid', () => {
    const { container } = render(<Indicators />);
    // Find the API trigger by its label text, then check the sibling icon.
    const apiLabel = container.querySelector('span.tracking-wider'); // first one is API
    const apiCell = apiLabel?.closest('div');
    const icon = apiCell?.querySelector('svg.lucide-globe');
    expect(icon).toBeTruthy();
    expect(icon?.classList.contains('text-bullish')).toBe(true);
    // Critically: NOT the muted-foreground gray that would mean "off".
    expect(icon?.classList.contains('text-muted-foreground')).toBe(false);
  });

  it('does not render the placeholder "None" / "No broker" anywhere in the trigger', () => {
    // The icon trigger is always-rendered (not hidden in a Portal).
    // Even though tooltip content is hidden until hover, those strings
    // would still appear in the DOM if we'd accidentally moved them
    // into the trigger. Sanity: the trigger should contain only "API".
    const { container } = render(<Indicators />);
    // Find the API cell containing the Globe + "API" label.
    const apiCell = container.querySelector('svg.lucide-globe')?.closest('div');
    expect(apiCell?.textContent).toBe('API');
    expect(apiCell?.textContent).not.toContain('None');
    expect(apiCell?.textContent).not.toContain('Paper Trading');
  });
});
