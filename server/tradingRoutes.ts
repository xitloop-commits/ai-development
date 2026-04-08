/**
 * REST API routes for receiving data from Python trading modules.
 * These are plain Express routes (not tRPC) because the Python scripts
 * use simple HTTP POST requests to push data.
 *
 * All endpoints are under /api/trading/*
 */
import type { Express, Request, Response } from 'express';
import {
  pushOptionChain,
  pushAnalyzerOutput,
  pushAIDecision,
  pushPosition,
  updateModuleHeartbeat,
  setTradingMode,
  getTradingMode,
  getActiveInstruments,
  setActiveInstruments,
} from './tradingStore';
import { getMongoHealth, pingMongo } from './mongo';
import { getAllInstruments, addInstrument, removeInstrument, assignHotkey, type InstrumentConfig } from './instruments';
import { searchByQuery, downloadScripMaster, needsRefresh } from './broker/adapters/dhan/scripMaster';
import { setConfiguredInstruments } from './tradingStore';

export function registerTradingRoutes(app: Express): void {
  // Push option chain data from the Fetcher module
  app.post('/api/trading/option-chain', (req: Request, res: Response) => {
    try {
      const { instrument, data } = req.body;
      if (!instrument || !data) {
        res.status(400).json({ error: 'Missing instrument or data' });
        return;
      }
      pushOptionChain(instrument, data);
      res.json({ success: true, message: `Option chain updated for ${instrument}` });
    } catch (err: any) {
      console.error('[Trading API] Error pushing option chain:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Push analyzer output from the Analyzer module
  app.post('/api/trading/analyzer', (req: Request, res: Response) => {
    try {
      const { instrument, data } = req.body;
      if (!instrument || !data) {
        res.status(400).json({ error: 'Missing instrument or data' });
        return;
      }
      pushAnalyzerOutput(instrument, data);
      res.json({ success: true, message: `Analyzer output updated for ${instrument}` });
    } catch (err: any) {
      console.error('[Trading API] Error pushing analyzer output:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Push AI decision from the AI Decision Engine
  app.post('/api/trading/ai-decision', (req: Request, res: Response) => {
    try {
      const { instrument, data } = req.body;
      if (!instrument || !data) {
        res.status(400).json({ error: 'Missing instrument or data' });
        return;
      }
      pushAIDecision(instrument, data);
      res.json({ success: true, message: `AI decision updated for ${instrument}` });
    } catch (err: any) {
      console.error('[Trading API] Error pushing AI decision:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Push position updates from the Execution Module
  app.post('/api/trading/position', (req: Request, res: Response) => {
    try {
      const { position } = req.body;
      if (!position) {
        res.status(400).json({ error: 'Missing position data' });
        return;
      }
      pushPosition(position);
      res.json({ success: true, message: 'Position updated' });
    } catch (err: any) {
      console.error('[Trading API] Error pushing position:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Module heartbeat endpoint
  app.post('/api/trading/heartbeat', (req: Request, res: Response) => {
    try {
      const { module, message } = req.body;
      if (!module) {
        res.status(400).json({ error: 'Missing module name' });
        return;
      }
      updateModuleHeartbeat(module, message || 'Active');
      res.json({ success: true });
    } catch (err: any) {
      console.error('[Trading API] Error updating heartbeat:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Trading mode control
  app.post('/api/trading/mode', (req: Request, res: Response) => {
    try {
      const { mode } = req.body;
      if (mode !== 'LIVE' && mode !== 'PAPER') {
        res.status(400).json({ error: 'Mode must be LIVE or PAPER' });
        return;
      }
      setTradingMode(mode);
      res.json({ success: true, mode });
    } catch (err: any) {
      console.error('[Trading API] Error setting trading mode:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/trading/mode', (_req: Request, res: Response) => {
    res.json({ mode: getTradingMode() });
  });

  // --- Active Instruments Control ---
  // GET: Python modules poll this to know which instruments to process
  app.get('/api/trading/active-instruments', (_req: Request, res: Response) => {
    res.json({ instruments: getActiveInstruments() });
  });

  // POST: Dashboard frontend sets which instruments are active
  app.post('/api/trading/active-instruments', (req: Request, res: Response) => {
    try {
      const { instruments } = req.body;
      if (!Array.isArray(instruments)) {
        res.status(400).json({ error: 'instruments must be an array of instrument keys' });
        return;
      }
      setActiveInstruments(instruments);
      res.json({ success: true, instruments: getActiveInstruments() });
    } catch (err: any) {
      console.error('[Trading API] Error setting active instruments:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Instruments Configuration ---
  // GET: Python modules fetch all configured instruments (for dynamic INSTRUMENTS dict)
  app.get('/api/trading/instruments', async (_req: Request, res: Response) => {
    try {
      const instruments = await getAllInstruments();
      res.json({ instruments });
    } catch (err: any) {
      console.error('[Trading API] Error fetching instruments:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Scrip Master Search ---
  // GET: Search Dhan scrip master for instruments
  app.get('/api/trading/search-instruments', async (req: Request, res: Response) => {
    try {
      const { query, exchange } = req.query;
      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'Missing query parameter' });
        return;
      }

      // Ensure scrip master is loaded
      if (needsRefresh(24)) {
        try {
          console.log('[Scrip Master] Downloading for search request...');
          await downloadScripMaster();
        } catch (err: any) {
          console.warn('[Scrip Master] Download failed:', err.message);
          // Continue with cached data
        }
      }

      const exchangeFilter = (exchange && exchange !== 'ALL') ? (exchange as string) : undefined;
      const results = searchByQuery(query, exchangeFilter, 20);
      res.json({ results });
    } catch (err: any) {
      console.error('[Trading API] Error searching instruments:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST: Add a new instrument
  app.post('/api/trading/instruments', async (req: Request, res: Response) => {
    try {
      const { key, displayName, exchange, exchangeSegment, underlying, autoResolve, symbolName } = req.body;

      // Validation
      if (!key || !displayName || !exchange || !exchangeSegment) {
        res.status(400).json({ error: 'Missing required fields: key, displayName, exchange, exchangeSegment' });
        return;
      }

      const config: Omit<InstrumentConfig, "isDefault" | "addedAt"> = {
        key,
        displayName,
        exchange,
        exchangeSegment,
        underlying: underlying || null,
        autoResolve: autoResolve === true,
        symbolName: symbolName || null,
      };

      const result = await addInstrument(config);

      // Update in-memory store
      const instruments = await getAllInstruments();
      setConfiguredInstruments(instruments);

      res.json({ success: true, instrument: result });
    } catch (err: any) {
      console.error('[Trading API] Error adding instrument:', err);
      res.status(400).json({ error: err.message || 'Failed to add instrument' });
    }
  });

  // DELETE: Remove an instrument
  app.delete('/api/trading/instruments/:key', async (req: Request, res: Response) => {
    try {
      const { key } = req.params;

      if (!key) {
        res.status(400).json({ error: 'Missing key parameter' });
        return;
      }

      await removeInstrument(key);

      // Update in-memory store
      const instruments = await getAllInstruments();
      setConfiguredInstruments(instruments);

      res.json({ success: true });
    } catch (err: any) {
      console.error('[Trading API] Error removing instrument:', err);
      res.status(400).json({ error: err.message || 'Failed to remove instrument' });
    }
  });

  // PATCH: Assign hotkey to an instrument (with swap support)
  app.patch('/api/trading/instruments/:key/hotkey', async (req: Request, res: Response) => {
    try {
      const { key } = req.params;
      const { hotkey } = req.body;

      if (!key) {
        res.status(400).json({ error: 'Missing key parameter' });
        return;
      }

      await assignHotkey(key, hotkey || null);

      // Update in-memory store
      const instruments = await getAllInstruments();
      setConfiguredInstruments(instruments);

      res.json({ success: true });
    } catch (err: any) {
      console.error('[Trading API] Error assigning hotkey:', err);
      res.status(400).json({ error: err.message || 'Failed to assign hotkey' });
    }
  });

  // Health check
  app.get('/api/trading/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // MongoDB health check (REST — accessible by Python modules)
  app.get('/api/health/mongodb', async (_req: Request, res: Response) => {
    try {
      const health = getMongoHealth();
      const latencyMs = await pingMongo();
      const statusCode = health.status === 'connected' ? 200 : 503;
      res.status(statusCode).json({ ...health, latencyMs });
    } catch (err: any) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  console.log('[Trading API] REST routes registered under /api/trading/*');
}
