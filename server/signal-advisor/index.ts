/**
 * signal-advisor — "CLAUD SAYS" option-chain verdict engine.
 *
 * On each request for an instrument we:
 *   1. fetch a fresh full option chain from the active broker (per-strike CE/PE
 *      OI, OI-change, LTP, IV, volume + spot),
 *   2. append it as the newest page in that instrument's ROLLOVER NOTEBOOK
 *      (a server-side, in-RAM conversation kept per instrument),
 *   3. replay the whole notebook to Claude so it judges the *current* snapshot
 *      in light of how the chain has been evolving,
 *   4. store Claude's verdict back into the notebook and return it.
 *
 * The notebook is a rollover window: it keeps the most recent
 * MAX_SNAPSHOTS pages; each new page rolls the oldest off. This bounds cost and
 * context even at a 1-request/minute cadence (the eventual auto mode). For now
 * the trigger is a manual button click — the notebook logic is identical either
 * way.
 *
 * State is in-RAM and per server session: it survives across requests but is
 * cleared on restart. No history is sent from the client — the client only
 * names the instrument; this module owns the memory.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getActiveBroker } from "../broker/brokerService";
import { getInstrumentByKey } from "../instruments";
import { createLogger } from "../broker/logger";

const log = createLogger("BSA", "SignalAdvisor");

// ── Tunables (one-number tweaks; safe to change later) ───────────
const MODEL = "claude-opus-4-8";
const MAX_SNAPSHOTS = 60; // rollover window — ~1 hour at 1 req/min
const MAX_TOKENS = 1024; // the verdict is small

// ── Public verdict shape (what the UI renders) ───────────────────
export interface ClaudeVerdict {
  action: "WAIT" | "ENTER";
  side: "CE" | "PE" | "NONE";
  longShort: "LONG" | "SHORT" | "NONE";
  strike: number; // 0 when N/A
  entry: number; // suggested option premium entry; 0 when N/A
  sl: number; // 0 when N/A
  tp: number; // 0 when N/A
  confidence: number; // 0-100
  reason: string; // one short line
}

export interface AnalyzeResult extends ClaudeVerdict {
  /** Echoed context so the card can show what was analysed. */
  spot: number;
  expiry: string;
  snapshotCount: number; // how many pages are in the notebook now
  at: string; // ISO timestamp of this analysis
}

// ── Structured-output schema — forces Claude to answer in this exact
//    JSON shape (no free text to parse). All fields required; we use
//    "NONE"/0 sentinels instead of null to stay inside the structured-
//    output JSON-schema subset. ──────────────────────────────────
const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["WAIT", "ENTER"] },
    side: { type: "string", enum: ["CE", "PE", "NONE"] },
    longShort: { type: "string", enum: ["LONG", "SHORT", "NONE"] },
    strike: { type: "number" },
    entry: { type: "number" },
    sl: { type: "number" },
    tp: { type: "number" },
    confidence: { type: "integer" },
    reason: { type: "string" },
  },
  required: ["action", "side", "longShort", "strike", "entry", "sl", "tp", "confidence", "reason"],
} as const;

const SYSTEM_PROMPT = `You are an expert Indian-markets options trader analysing ONE instrument's live option chain.

You receive a time-ordered series of option-chain snapshots for THIS instrument (oldest first). Each snapshot has the spot/futures price, the expiry, and a per-strike table of CE and PE open interest (OI), OI change since prior day, last traded price (LTP), implied volatility (IV), and volume. The LAST snapshot is the most recent — that is the moment you are deciding on.

Decide whether to ENTER a trade RIGHT NOW or WAIT, using BOTH:
- how the chain has EVOLVED across the snapshots (OI building/unwinding, PCR drifting, walls shifting, premiums moving), and
- the structure of the latest snapshot (PCR, max-pain magnet, CE/PE walls, where OI is being added).

Rules:
- Only ENTER when there is a clear, aligned edge (direction + structure + evolution agree). Otherwise WAIT.
- ENTER LONG a CE for an up-bias; ENTER LONG a PE for a down-bias. Use SHORT only if you explicitly mean to sell that option.
- Pick a concrete strike, a suggested entry premium (from the chain LTP), a stop-loss and a take-profit premium.
- There is no sure thing. Let "confidence" honestly reflect uncertainty; near pinned max-pain or in a dead range, prefer WAIT with low confidence.
- When action is WAIT, set side/longShort to "NONE" and strike/entry/sl/tp to 0.
- "reason" must be ONE short plain-English sentence (max ~140 chars).

Respond ONLY with the structured verdict.`;

// ── Per-instrument rollover notebook (in-RAM) ────────────────────
// One conversation per instrument key. Alternating user (snapshot) /
// assistant (verdict JSON) turns. Trimmed to the last MAX_SNAPSHOTS pairs.
const notebooks = new Map<string, Anthropic.MessageParam[]>();

/** Test/shutdown hook — drop all notebooks (or one instrument's). */
export function clearNotebooks(instrument?: string): void {
  if (instrument) notebooks.delete(instrument.toUpperCase());
  else notebooks.clear();
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  // Lazy — only constructed on first real use; reads ANTHROPIC_API_KEY from env.
  if (!client) client = new Anthropic();
  return client;
}

// ── Chain → compact snapshot text ────────────────────────────────
function buildSnapshotText(chain: any, expiry: string, capturedAt: string): string {
  const rows = (chain.rows ?? []).map((r: any) => ({
    k: r.strike,
    ceOI: r.callOI,
    ceOIchg: r.callOIChange,
    ceLTP: r.callLTP,
    ceIV: r.callIV,
    ceVol: r.callVolume,
    peOI: r.putOI,
    peOIchg: r.putOIChange,
    peLTP: r.putLTP,
    peIV: r.putIV,
    peVol: r.putVolume,
  }));
  return [
    `SNAPSHOT @ ${capturedAt} IST`,
    `expiry=${expiry} spot=${chain.spotPrice}`,
    `strikes (k=strike, ce*/pe* = call/put OI, OIchg, LTP, IV, Vol):`,
    JSON.stringify(rows),
  ].join("\n");
}

// ── Resolve an instrument key → broker chain params ──────────────
async function resolveChainParams(
  instrument: string,
): Promise<{ key: string; underlying: string; exchangeSegment: string } | null> {
  const cfg = await getInstrumentByKey(instrument);
  if (!cfg) return null;
  // Index instruments carry a numeric underlying security id; MCX commodities
  // auto-resolve from their symbol name. getOptionChain accepts either.
  const underlying = cfg.underlying ?? cfg.symbolName ?? cfg.key;
  return { key: cfg.key, underlying, exchangeSegment: cfg.exchangeSegment };
}

function nearestExpiry(list: string[]): string {
  return (
    [...list].sort(
      (a, b) => new Date(`${a}T00:00:00`).getTime() - new Date(`${b}T00:00:00`).getTime(),
    )[0] ?? ""
  );
}

// ── Main entry — fetch chain, ask Claude, return verdict ─────────
export async function analyzeInstrument(instrument: string): Promise<AnalyzeResult> {
  const broker = getActiveBroker();
  if (!broker) throw new Error("No active broker — cannot fetch the option chain.");

  const params = await resolveChainParams(instrument);
  if (!params) throw new Error(`Unknown instrument "${instrument}".`);

  const expiries = await broker.getExpiryList(params.underlying, params.exchangeSegment);
  const expiry = nearestExpiry(expiries);
  if (!expiry) throw new Error(`No expiries available for ${params.key}.`);

  const chain = await broker.getOptionChain(params.underlying, expiry, params.exchangeSegment);
  const capturedAt = new Date().toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
  });

  // Append the fresh snapshot as the newest page in this instrument's notebook.
  const history = notebooks.get(params.key) ?? [];
  history.push({ role: "user", content: buildSnapshotText(chain, expiry, capturedAt) });

  // Call Claude with the WHOLE notebook + forced structured JSON output.
  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
    messages: history,
  });

  // output_config.format guarantees the first text block is valid JSON.
  const textBlock = resp.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("Claude returned no verdict.");
  const verdict = JSON.parse(textBlock.text) as ClaudeVerdict;

  // Store Claude's verdict as the assistant turn, then roll the window.
  history.push({ role: "assistant", content: textBlock.text });
  while (history.length > MAX_SNAPSHOTS * 2) history.shift();
  notebooks.set(params.key, history);

  log.info(
    `${params.key}: ${verdict.action}${verdict.action === "ENTER" ? ` ${verdict.longShort} ${verdict.strike} ${verdict.side} (conf ${verdict.confidence})` : ""} — notebook=${history.length / 2} pages`,
  );

  return {
    ...verdict,
    spot: chain.spotPrice ?? 0,
    expiry,
    snapshotCount: history.length / 2,
    at: new Date().toISOString(),
  };
}
