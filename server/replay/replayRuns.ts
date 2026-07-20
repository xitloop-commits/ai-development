/**
 * replayRuns.ts — isolated storage for tick-replay output (T97).
 *
 * A replay run is a MODEL-QUALITY EXPERIMENT, not trading. Its trades are held
 * in their own document and are connected to nothing: no capital pool, no day
 * index, no compounding, no EOD square-off, no kill switch. Two runs over the
 * same recorded day are directly comparable, which is the whole point.
 *
 * WHY A SEPARATE COLLECTION rather than tagging trades inside the paper book:
 * isolation by construction beats isolation by remembering to filter. Every
 * aggregation site (day P&L, charges, capital, clawback, day completion, the
 * summary row, the session summary) would otherwise have to know to exclude
 * replay trades, and missing ONE silently corrupts the paper book's numbers.
 * Here a replay simply cannot pollute paper, because the trades are not in that
 * document at all.
 *
 * Note this is also a fix, not just a feature: before T97 replay trades took the
 * live path and landed in `paper` with no marker whatsoever, so replayed and
 * genuine paper trades were byte-indistinguishable.
 */
import mongoose, { Schema } from "mongoose";
import type { TradeRecord } from "../portfolio/state";
import { tradeRecordSchema } from "../portfolio/state";

export type ReplayRunStatus = "RUNNING" | "COMPLETED" | "ABORTED";

export interface ReplayRun {
  /** Stable id, also the display handle: `R-<date>-<hhmmss>`. */
  runId: string;
  /** The RECORDED date being replayed (YYYY-MM-DD), not the wall-clock date. */
  date: string;
  speed: number;
  status: ReplayRunStatus;
  /** Model version per instrument at the moment the run started — the thing
   *  under test. `{ nifty50: "20260718_161937", … }` */
  models: Record<string, string>;
  /** Cohorts enabled for the run, so a later comparison can tell whether a
   *  difference came from the model or from what was allowed to fire. */
  cohorts: Record<string, boolean>;
  /** Notional capital the run sizes against. Never touches a real pool. */
  openingCapital: number;
  startedAt: number;
  endedAt: number | null;
  trades: TradeRecord[];
  /** Denormalised totals so the run list doesn't have to load every trade. */
  totalPnl: number;
  totalCharges: number;
  tradeCount: number;
  /** Free-text so a run can be labelled ("nifty 4-Jul, new model"). */
  note?: string | null;
}

const replayRunSchema = new Schema(
  {
    runId: { type: String, required: true, unique: true, index: true },
    date: { type: String, required: true, index: true },
    speed: { type: Number, default: 1 },
    status: { type: String, enum: ["RUNNING", "COMPLETED", "ABORTED"], default: "RUNNING" },
    models: { type: Schema.Types.Mixed, default: {} },
    cohorts: { type: Schema.Types.Mixed, default: {} },
    openingCapital: { type: Number, default: 100000 },
    startedAt: { type: Number, default: () => Date.now() },
    endedAt: { type: Number, default: null },
    trades: { type: [tradeRecordSchema], default: [] },
    totalPnl: { type: Number, default: 0 },
    totalCharges: { type: Number, default: 0 },
    tradeCount: { type: Number, default: 0 },
    note: { type: String, default: null },
  },
  { collection: "replay_runs" },
);

export const ReplayRunModel =
  (mongoose.models.ReplayRun as mongoose.Model<any>) ??
  mongoose.model("ReplayRun", replayRunSchema);

/**
 * The run currently accepting trades, held in memory.
 *
 * Deliberately a module singleton mirroring `tickReplay`'s own state: one replay
 * at a time. Read on the hot path (every AI signal), so it must not be a DB
 * round-trip. `null` means "not replaying" — and then nothing anywhere routes to
 * a run, which is what keeps live/paper trading unaffected.
 */
let activeRunId: string | null = null;

export function getActiveRunId(): string | null {
  return activeRunId;
}

/** True while a replay run is accepting trades. */
export function isReplayRunActive(): boolean {
  return activeRunId !== null;
}

function makeRunId(date: string): string {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
  return `R-${date}-${hh}${mm}${ss}`;
}

/** Open a run and make it the trade sink. Returns the created document. */
export async function startRun(input: {
  date: string;
  speed: number;
  models: Record<string, string>;
  cohorts: Record<string, boolean>;
  openingCapital?: number;
  note?: string | null;
}): Promise<ReplayRun> {
  const runId = makeRunId(input.date);
  const doc = {
    runId,
    date: input.date,
    speed: input.speed,
    status: "RUNNING" as const,
    models: input.models,
    cohorts: input.cohorts,
    openingCapital: input.openingCapital ?? 100000,
    startedAt: Date.now(),
    endedAt: null,
    trades: [],
    totalPnl: 0,
    totalCharges: 0,
    tradeCount: 0,
    note: input.note ?? null,
  };
  await ReplayRunModel.create(doc);
  activeRunId = runId;
  return doc as ReplayRun;
}

/** Close the active run. Safe to call when none is open. */
export async function endRun(status: Exclude<ReplayRunStatus, "RUNNING"> = "COMPLETED"): Promise<void> {
  const runId = activeRunId;
  activeRunId = null; // clear FIRST — a slow write must not keep routing trades
  if (!runId) return;
  try {
    await ReplayRunModel.updateOne({ runId }, { $set: { status, endedAt: Date.now() } });
  } catch {
    /* the run is already un-routed; a missing end stamp is cosmetic */
  }
}

/** Append a trade to the active run and refresh its denormalised totals. */
export async function appendTrade(runId: string, trade: TradeRecord): Promise<void> {
  await ReplayRunModel.updateOne(
    { runId },
    {
      $push: { trades: trade },
      $inc: {
        tradeCount: 1,
        totalPnl: trade.pnl ?? 0,
        totalCharges: trade.charges ?? 0,
      },
    },
  );
}

/** Replace a trade in a run (exit fills, SL/TP moves) and re-derive totals. */
export async function updateTradeInRun(runId: string, trade: TradeRecord): Promise<void> {
  const run = await ReplayRunModel.findOne({ runId }).lean();
  if (!run) return;
  const trades: TradeRecord[] = (run.trades ?? []).map((t: TradeRecord) =>
    t.id === trade.id ? trade : t,
  );
  await ReplayRunModel.updateOne({ runId }, { $set: { trades, ...deriveTotals(trades) } });
}

/** Totals from the trade list. Mirrors the day-record convention: an OPEN trade
 *  contributes its GROSS unrealised, a settled one its NET pnl. */
export function deriveTotals(trades: TradeRecord[]): {
  totalPnl: number;
  totalCharges: number;
  tradeCount: number;
} {
  let totalPnl = 0;
  let totalCharges = 0;
  for (const t of trades) {
    totalCharges += t.charges ?? 0;
    totalPnl += t.status === "OPEN" ? (t.unrealizedPnl ?? 0) : (t.pnl ?? 0);
  }
  return {
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalCharges: Math.round(totalCharges * 100) / 100,
    tradeCount: trades.length,
  };
}

/**
 * Replace the whole trade list of a run and re-derive its totals.
 *
 * Safe as a wholesale write because a run is single-writer while it is the
 * active sink — unlike a day record, nothing else appends to it concurrently,
 * so there is no snapshot to clobber.
 */
export async function updateRunTrades(runId: string, trades: TradeRecord[]): Promise<void> {
  await ReplayRunModel.updateOne({ runId }, { $set: { trades, ...deriveTotals(trades) } });
}

/** One run with its trades. */
export async function getRun(runId: string): Promise<ReplayRun | null> {
  return (await ReplayRunModel.findOne({ runId }).lean()) as ReplayRun | null;
}

/** Run list for the Replay tab — newest first, WITHOUT the trade arrays. */
export async function listRuns(limit = 50): Promise<Omit<ReplayRun, "trades">[]> {
  return (await ReplayRunModel.find({}, { trades: 0 })
    .sort({ startedAt: -1 })
    .limit(limit)
    .lean()) as unknown as Omit<ReplayRun, "trades">[];
}

/**
 * Headline + breakdown for one run, used by the comparison.
 *
 * Reports MORE than net P&L on purpose: over a single replayed day a model can
 * win on net while losing on hit rate (one lucky trade), or vice versa. Charges
 * are separated because they scale with trade COUNT — a model that fires twice
 * as often can look worse purely on cost, which is a real finding but a
 * different one from "it predicts worse".
 */
export function summariseRun(run: ReplayRun) {
  const trades = run.trades ?? [];
  const closed = trades.filter((t) => t.status !== "OPEN");
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const grossPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0) + run.totalCharges;

  const by = (keyOf: (t: TradeRecord) => string) => {
    const m = new Map<string, { n: number; wins: number; pnl: number }>();
    for (const t of closed) {
      const k = keyOf(t) || "(none)";
      const r = m.get(k) ?? { n: 0, wins: 0, pnl: 0 };
      r.n += 1;
      if ((t.pnl ?? 0) > 0) r.wins += 1;
      r.pnl = Math.round((r.pnl + (t.pnl ?? 0)) * 100) / 100;
      m.set(k, r);
    }
    return Object.fromEntries(m);
  };

  return {
    runId: run.runId,
    date: run.date,
    status: run.status,
    models: run.models,
    cohorts: run.cohorts,
    note: run.note ?? null,
    startedAt: run.startedAt,
    tradeCount: trades.length,
    closedCount: closed.length,
    openCount: trades.length - closed.length,
    netPnl: Math.round(run.totalPnl * 100) / 100,
    grossPnl: Math.round(grossPnl * 100) / 100,
    charges: Math.round(run.totalCharges * 100) / 100,
    winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
    avgWin: wins.length ? Math.round((wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length) * 100) / 100 : 0,
    avgLoss: closed.length - wins.length
      ? Math.round((closed.filter((t) => (t.pnl ?? 0) <= 0).reduce((s, t) => s + (t.pnl ?? 0), 0) / (closed.length - wins.length)) * 100) / 100
      : 0,
    byCohort: by((t) => t.cohort ?? ""),
    byStrategy: by((t) => t.exitStrategy ?? "sprint"),
    byExitReason: by((t) => t.exitReason ?? ""),
  };
}

/** Delete a run outright — these are experiments, not records to keep forever. */
export async function deleteRun(runId: string): Promise<void> {
  await ReplayRunModel.deleteOne({ runId });
}

/**
 * Recover from a crash: any run left RUNNING at boot can never receive more
 * trades, so mark it aborted rather than leaving a run that looks live forever.
 */
export async function abandonStaleRuns(): Promise<number> {
  const res = await ReplayRunModel.updateMany(
    { status: "RUNNING" },
    { $set: { status: "ABORTED", endedAt: Date.now() } },
  );
  return res.modifiedCount ?? 0;
}
