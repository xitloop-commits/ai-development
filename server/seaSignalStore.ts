/**
 * seaSignalStore.ts — MongoDB persistence for SEA signals.
 *
 * Replaces the log-file tail as the source of truth for the UI signal tray.
 * The SEA POSTs each emitted signal to /api/sea/signal; the handler inserts it
 * here (durable, queryable, no file-size/rotation pain) and broadcasts it over
 * /ws/ticks for live push. The tray loads history from here (paginated,
 * recent-first) and gets new ones over the WS.
 *
 * NOTE: the log file is still written by the SEA and still read by rcaMonitor
 * via seaSignals.getSEASignals — this store is purely the UI delivery path.
 */

import mongoose, { Schema } from "mongoose";

export interface SeaSignalDoc {
  /** Unique id (the SEA's `sea-...` id, or a generated one). */
  id: string;
  /** Server ingest epoch ms — the sort/pagination key (monotonic arrival order). */
  ts: number;
  /** IST date string YYYY-MM-DD (for day filtering). */
  date: string;
  timestamp_ist: string;
  instrument: string;
  direction: string;
  action?: string;
  cohort?: string;
  reason?: string;
  entry?: number;
  tp?: number;
  sl?: number;
  rr?: number;
  atm_strike?: number;
  atm_ce_ltp?: number | null;
  atm_pe_ltp?: number | null;
  atm_ce_security_id?: string | null;
  atm_pe_security_id?: string | null;
  spot_price?: number | null;
  direction_prob_30s?: number | null;
  model_version?: string;
}

const seaSignalSchema = new Schema(
  {
    id: { type: String, required: true, index: true },
    ts: { type: Number, required: true, index: true },
    date: { type: String, required: true, index: true },
    timestamp_ist: { type: String, default: "" },
    instrument: { type: String, required: true },
    direction: { type: String, default: "" },
    action: { type: String, default: null },
    cohort: { type: String, default: null },
    reason: { type: String, default: null },
    entry: { type: Number, default: null },
    tp: { type: Number, default: null },
    sl: { type: Number, default: null },
    rr: { type: Number, default: null },
    atm_strike: { type: Number, default: null },
    atm_ce_ltp: { type: Number, default: null },
    atm_pe_ltp: { type: Number, default: null },
    atm_ce_security_id: { type: String, default: null },
    atm_pe_security_id: { type: String, default: null },
    spot_price: { type: Number, default: null },
    direction_prob_30s: { type: Number, default: null },
    model_version: { type: String, default: "" },
  },
  { collection: "sea_signals", timestamps: false, strict: false },
);
seaSignalSchema.index({ ts: -1 });

export const SeaSignalModel = mongoose.model("SeaSignal", seaSignalSchema);

/** Today's IST date string (YYYY-MM-DD). */
function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/**
 * Persist one emitted SEA signal. Returns the normalized doc that should be
 * broadcast over the WS (so the live frame and the stored row match exactly).
 */
export async function insertSeaSignal(raw: Record<string, any>): Promise<SeaSignalDoc> {
  const doc: SeaSignalDoc = {
    id: String(raw.id ?? `sea-${raw.instrument ?? "?"}-${Date.now()}-${Math.round((raw.timestamp ?? 0) * 1000) % 100000}`),
    ts: Date.now(),
    date: todayIST(),
    timestamp_ist: String(raw.timestamp_ist ?? ""),
    instrument: String(raw.instrument ?? ""),
    direction: String(raw.direction ?? ""),
    action: raw.action ?? undefined,
    cohort: raw.cohort ?? undefined,
    reason: raw.reason ?? undefined,
    entry: raw.entry ?? undefined,
    tp: raw.tp ?? undefined,
    sl: raw.sl ?? undefined,
    rr: raw.rr ?? undefined,
    atm_strike: raw.atm_strike ?? undefined,
    atm_ce_ltp: raw.atm_ce_ltp ?? null,
    atm_pe_ltp: raw.atm_pe_ltp ?? null,
    atm_ce_security_id: raw.atm_ce_security_id ?? null,
    atm_pe_security_id: raw.atm_pe_security_id ?? null,
    spot_price: raw.spot_price ?? null,
    direction_prob_30s: raw.direction_prob_30s ?? null,
    model_version: raw.model_version ?? "",
  };
  await SeaSignalModel.create(doc);
  return doc;
}

/**
 * Query signals recent-first for the tray. `before` is the `ts` cursor for
 * lazy-loading older pages (pass the oldest ts already loaded); omit for the
 * newest page. Defaults to today only unless `allDays` is set.
 */
export async function querySeaSignals(opts: {
  limit?: number;
  before?: number;
  allDays?: boolean;
} = {}): Promise<SeaSignalDoc[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filter: Record<string, any> = {};
  if (!opts.allDays) filter.date = todayIST();
  if (opts.before && opts.before > 0) filter.ts = { $lt: opts.before };
  // Exclude Mongo internals (_id ObjectId, __v) — superjson can't cleanly
  // serialize ObjectId over tRPC, and the client doesn't need them.
  const rows = await SeaSignalModel.find(filter)
    .select("-_id -__v")
    .sort({ ts: -1 })
    .limit(limit)
    .lean();
  return rows as unknown as SeaSignalDoc[];
}
