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

const noopQuery = { data: undefined, isLoading: false };

vi.mock('@/lib/trpc', () => ({
  trpc: {
    broker: {
      status: { useQuery: () => ({ data: { connected: true, activeBroker: 'mock', mode: 'paper' }, isLoading: false }) },
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
