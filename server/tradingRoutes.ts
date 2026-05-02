/**
 * REST API routes for receiving data from Python trading modules.
 * These are plain Express routes (not tRPC) because the Python scripts
 * use simple HTTP POST requests to push data.
 *
 * All endpoints are under /api/trading/*
 *
 * B8: every body-consuming route validates with a strict zod schema
 * before the handler runs. Unknown fields are rejected at the boundary.
 * Body data envelopes (option-chain payloads, analyzer outputs) keep
 * their inner shape as `z.unknown()` — Python owns those formats and
 * the in-memory store treats them opaquely.
 */
import type { Express, Request, Response } from 'express';
import { z } from "zod";
import {
  pushOptionChain,
  pushAnalyzerOutput,
  updateModuleHeartbeat,
  getActiveInstruments,
  setActiveInstruments,
} from './tradingStore';
import { getMongoHealth, pingMongo } from './mongo';
import { getAllInstruments, addInstrument, removeInstrument, assignHotkey, type InstrumentConfig } from './instruments';
import { searchByQuery, downloadScripMaster, needsRefresh } from './broker/adapters/dhan/scripMaster';
import { setConfiguredInstruments } from './tradingStore';
import { validateBody, validateParams, validateQuery } from "./_core/zodMiddleware";
import { createLogger } from "./broker/logger";

const log = createLogger("BSA", "TradingAPI");

// ─── Schemas ────────────────────────────────────────────────────

const instrumentEnvelopeSchema = z
  .object({
    instrument: z.string().min(1),
    // The chain / analyzer payloads are owned by the Python pipeline; we
    // store them opaquely. Only the envelope is strict-validated.
    data: z.unknown(),
  })
  .strict();

const heartbeatSchema = z
  .object({
    module: z.string().min(1),
    message: z.string().optional(),
  })
  .strict();

const activeInstrumentsSchema = z
  .object({
    instruments: z.array(z.string().min(1)),
  })
  .strict();

const addInstrumentSchema = z
  .object({
    key: z.string().min(1),
    displayName: z.string().min(1),
    exchange: z.string().min(1),
    exchangeSegment: z.string().min(1),
    underlying: z.string().nullable().optional(),
    autoResolve: z.boolean().optional(),
    symbolName: z.string().nullable().optional(),
  })
  .strict();

const instrumentKeyParamsSchema = z
  .object({
    key: z.string().min(1),
  })
  .strict();

const hotkeyBodySchema = z
  .object({
    hotkey: z.string().nullable().optional(),
  })
  .strict();

const searchInstrumentsQuerySchema = z
  .object({
    query: z.string().min(1),
    exchange: z.string().min(1).optional(),
  })
  .strict();

// ─── Routes ─────────────────────────────────────────────────────

export function registerTradingRoutes(app: Express): void {
  // Push option chain data from the Fetcher module
  app.post(
    '/api/trading/option-chain',
    validateBody(instrumentEnvelopeSchema),
    (req: Request, res: Response) => {
      try {
        const { instrument, data } = req.body as z.infer<typeof instrumentEnvelopeSchema>;
        pushOptionChain(instrument, data as Parameters<typeof pushOptionChain>[1]);
        res.json({ success: true, message: `Option chain updated for ${instrument}` });
      } catch (err: any) {
        log.error('Error pushing option chain', err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // Push analyzer output from the Analyzer module
  app.post(
    '/api/trading/analyzer',
    validateBody(instrumentEnvelopeSchema),
    (req: Request, res: Response) => {
      try {
        const { instrument, data } = req.body as z.infer<typeof instrumentEnvelopeSchema>;
        pushAnalyzerOutput(instrument, data as Parameters<typeof pushAnalyzerOutput>[1]);
        res.json({ success: true, message: `Analyzer output updated for ${instrument}` });
      } catch (err: any) {
        log.error('Error pushing analyzer output', err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // Module heartbeat endpoint
  app.post(
    '/api/trading/heartbeat',
    validateBody(heartbeatSchema),
    (req: Request, res: Response) => {
      try {
        const { module, message } = req.body as z.infer<typeof heartbeatSchema>;
        updateModuleHeartbeat(module, message ?? 'Active');
        res.json({ success: true });
      } catch (err: any) {
        log.error('Error updating heartbeat', err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // --- Active Instruments Control ---
  // GET: Python modules poll this to know which instruments to process
  app.get('/api/trading/active-instruments', (_req: Request, res: Response) => {
    res.json({ instruments: getActiveInstruments() });
  });

  // POST: Dashboard frontend sets which instruments are active
  app.post(
    '/api/trading/active-instruments',
    validateBody(activeInstrumentsSchema),
    (req: Request, res: Response) => {
      try {
        const { instruments } = req.body as z.infer<typeof activeInstrumentsSchema>;
        setActiveInstruments(instruments);
        res.json({ success: true, instruments: getActiveInstruments() });
      } catch (err: any) {
        log.error('Error setting active instruments', err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // --- Instruments Configuration ---
  // GET: Python modules fetch all configured instruments (for dynamic INSTRUMENTS dict)
  app.get('/api/trading/instruments', async (_req: Request, res: Response) => {
    try {
      const instruments = await getAllInstruments();
      res.json({ instruments });
    } catch (err: any) {
      log.error('Error fetching instruments', err);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Scrip Master Search ---
  // GET: Search Dhan scrip master for instruments
  app.get(
    '/api/trading/search-instruments',
    validateQuery(searchInstrumentsQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { query, exchange } =
          req.query as unknown as z.infer<typeof searchInstrumentsQuerySchema>;

        // Ensure scrip master is loaded
        if (needsRefresh(24)) {
          try {
            log.info('[Scrip Master] Downloading for search request...');
            await downloadScripMaster();
          } catch (err: any) {
            log.warn(`[Scrip Master] Download failed: ${err.message}`);
            // Continue with cached data
          }
        }

        const exchangeFilter = exchange && exchange !== 'ALL' ? exchange : undefined;
        const results = searchByQuery(query, exchangeFilter, 20);
        res.json({ results });
      } catch (err: any) {
        log.error('Error searching instruments', err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // POST: Add a new instrument
  app.post(
    '/api/trading/instruments',
    validateBody(addInstrumentSchema),
    async (req: Request, res: Response) => {
      try {
        const body = req.body as z.infer<typeof addInstrumentSchema>;
        const config: Omit<InstrumentConfig, "isDefault" | "addedAt"> = {
          key: body.key,
          displayName: body.displayName,
          exchange: body.exchange,
          exchangeSegment: body.exchangeSegment,
          underlying: body.underlying ?? null,
          autoResolve: body.autoResolve === true,
          symbolName: body.symbolName ?? null,
          hotkey: null,
        };
        const result = await addInstrument(config);

        // Update in-memory store
        const instruments = await getAllInstruments();
        setConfiguredInstruments(instruments);

        res.json({ success: true, instrument: result });
      } catch (err: any) {
        log.error('Error adding instrument', err);
        res.status(400).json({ error: err.message || 'Failed to add instrument' });
      }
    },
  );

  // DELETE: Remove an instrument
  app.delete(
    '/api/trading/instruments/:key',
    validateParams(instrumentKeyParamsSchema),
    async (req: Request, res: Response) => {
      try {
        const { key } = req.params as z.infer<typeof instrumentKeyParamsSchema>;
        await removeInstrument(key);

        // Update in-memory store
        const instruments = await getAllInstruments();
        setConfiguredInstruments(instruments);

        res.json({ success: true });
      } catch (err: any) {
        log.error('Error removing instrument', err);
        res.status(400).json({ error: err.message || 'Failed to remove instrument' });
      }
    },
  );

  // PATCH: Assign hotkey to an instrument (with swap support)
  app.patch(
    '/api/trading/instruments/:key/hotkey',
    validateParams(instrumentKeyParamsSchema),
    validateBody(hotkeyBodySchema),
    async (req: Request, res: Response) => {
      try {
        const { key } = req.params as z.infer<typeof instrumentKeyParamsSchema>;
        const { hotkey } = req.body as z.infer<typeof hotkeyBodySchema>;
        await assignHotkey(key, hotkey || null);

        // Update in-memory store
        const instruments = await getAllInstruments();
        setConfiguredInstruments(instruments);

        res.json({ success: true });
      } catch (err: any) {
        log.error('Error assigning hotkey', err);
        res.status(400).json({ error: err.message || 'Failed to assign hotkey' });
      }
    },
  );

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

  log.info('REST routes registered under /api/trading/*');
}
