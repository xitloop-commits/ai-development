/**
 * Cross-agent exit-request contracts (C3 / C4).
 *
 * Three hops in the exit pipeline:
 *
 *   DA → RCA (this file: DisciplineExitRequest)
 *     "Some positions need to exit. Here's the reason + scope.
 *      Figure out which ones, validate, and fan out."
 *
 *   SEA → RCA (this file: AiSignalRequest)
 *     "Continuous-analysis says do X on this instrument. Validate
 *      against current position state before forwarding to TEA."
 *
 *   RCA → TEA (server/executor/types.ts: ExitTradeRequest)
 *     "Exit positionId on channel. Single-position, broker-bound."
 *
 * The TEA→PA boundary still uses the existing PA-shaped audit enum
 * (server/portfolio/state.ts: ExitReason / ExitTriggeredBy) — those are
 * persisted in Mongo and remapping them is a separate migration.
 *
 * This file owns ONLY the DA→RCA and SEA→RCA hop types so we have a
 * single source of truth for what those messages look like across the
 * Node code AND any future Python client.
 */

/**
 * Why an exit is being requested. The union of reasons that DA / RCA /
 * SEA might emit. PA's stored ExitReason is a subset, mapped at the
 * TEA→PA boundary by mapExitReasonToPaReason.
 */
export type ExitReasonCode =
  | "MOMENTUM_EXIT"
  | "VOLATILITY_EXIT"
  | "SL_HIT"
  | "TP_HIT"
  | "AGE_EXIT"
  | "STALE_PRICE_EXIT"
  | "DISCIPLINE_EXIT"
  | "AI_EXIT"
  | "MANUAL"
  | "EOD"
  | "EXPIRY";

/**
 * Who fired the exit. Audit-trail only — TEA / PA write this through
 * to the trade record so dashboards can answer "who closed this?".
 */
export type ExitTriggeredBy =
  | "RCA"
  | "BROKER"
  | "DISCIPLINE"
  | "AI"
  | "USER"
  | "PA";

/**
 * Channel-equivalent enum. Re-stated here (not imported from
 * server/portfolio/state) so this file has zero server-side imports
 * and can be consumed by client + future Python helper without
 * dragging the full server graph into a build.
 */
export type ChannelCode =
  | "ai-live"
  | "ai-paper"
  | "my-live"
  | "my-paper"
  | "testing-live"
  | "testing-sandbox";

// ─── DA → RCA: DisciplineExitRequest ─────────────────────────────

/**
 * Scope determines WHICH open positions get exited:
 *
 *   ALL         — every open position on the listed channels
 *   INSTRUMENT  — every open position on `instrument` across channels
 *   TRADE_IDS   — explicit trade IDs (e.g. carry-forward FAIL list)
 */
export type DisciplineExitScope =
  | { kind: "ALL" }
  | { kind: "INSTRUMENT"; instrument: string }
  | { kind: "TRADE_IDS"; tradeIds: string[] };

/**
 * The DA→RCA push payload. Populated by Discipline Agent when:
 *   - cap-grace deadline expires without operator acknowledgment
 *   - carry-forward eval FAILs on at least one position
 *   - operator manually requests an exit through Settings UI
 *
 * RCA receives this, walks open positions per scope, and fans out one
 * RCA→TEA exit per affected trade. The aggregated response counts
 * exited / failed and per-trade details for the dashboard.
 */
export interface DisciplineExitRequest {
  reason: ExitReasonCode;
  /** Operator-facing detail string for the audit log. */
  detail?: string;
  /** Restrict the fan-out to specific channels; defaults to RCA's
   *  monitored channel list when omitted. */
  channels?: ChannelCode[];
  scope: DisciplineExitScope;
}

export interface DisciplineExitResponse {
  exited: number;
  failed: number;
  details: Array<{ tradeId: string; ok: boolean; error?: string }>;
}

// ─── SEA → RCA: AiSignalRequest ──────────────────────────────────

/**
 * Continuous-analysis signal from SEA. EXIT closes matching open
 * positions; MODIFY_SL / MODIFY_TP adjust the bracket on the broker.
 *
 * Spec note: SEA emits OPINIONS at instrument level. RCA validates
 * against current position state before forwarding to TEA — see the
 * exit-decision-matrix in RiskControlAgent_Spec_v2.0 §9.
 */
export type AiSignalKind = "EXIT" | "MODIFY_SL" | "MODIFY_TP";

export interface AiSignalRequest {
  /** Instrument key (e.g. "NIFTY_50", "BANKNIFTY", "CRUDEOIL"). */
  instrument: string;
  signal: AiSignalKind;
  /** Model confidence 0..1. RCA may use this to weight conflict-resolution. */
  confidence?: number;
  /**
   * Required when signal is MODIFY_SL or MODIFY_TP — the new price
   * RCA should ask TEA to set on the broker bracket.
   */
  newPrice?: number;
  /** Operator/dashboard string for the audit log. */
  detail?: string;
}

export interface AiSignalResponse {
  acted: number;
  skipped: number;
  /** Per-trade detail for the dashboard. */
  details?: Array<{ tradeId: string; action: "EXITED" | "MODIFIED" | "SKIPPED"; reason?: string }>;
}
