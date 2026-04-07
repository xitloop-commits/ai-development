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
import { getAllInstruments } from './instruments';

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
