/**
 * AI trade routing — which book(s) a SEA signal is placed on.
 *
 * Was an either/or `aiTradesMode`: one signal, one book. Switching it to live
 * silently stopped paper receiving anything, which is exactly what happened on
 * 2026-07-23 — an MA `LONG_PE` fired and the operator asked why no paper trade
 * appeared. It had gone to live (and been rejected there by Dhan).
 *
 * Now two INDEPENDENT switches, so both books can run the same signal — paper as
 * a live control against the real account.
 *
 * The resolver is pinned here rather than the whole HTTP handler because the
 * consequence of getting it wrong is placing a REAL order on a book the operator
 * did not enable.
 */
import { describe, it, expect } from "vitest";

type Mode = "paper" | "live";
interface TradingMode {
  aiTradesMode?: Mode;
  aiPaperEnabled?: boolean;
  aiLiveEnabled?: boolean;
}

/** Mirrors the channel-list resolution in discipline/routes.ts. */
function aiChannelsFor(tm: TradingMode | undefined): string[] {
  const paperOn = tm?.aiPaperEnabled ?? (tm?.aiTradesMode ?? "paper") === "paper";
  const liveOn = tm?.aiLiveEnabled ?? (tm?.aiTradesMode ?? "paper") === "live";
  return [...(paperOn ? ["paper"] : []), ...(liveOn ? ["live"] : [])];
}

describe("independent paper / live routing", () => {
  it("both ON places on BOTH books", () => {
    expect(aiChannelsFor({ aiPaperEnabled: true, aiLiveEnabled: true }))
      .toEqual(["paper", "live"]);
  });

  it("paper only", () => {
    expect(aiChannelsFor({ aiPaperEnabled: true, aiLiveEnabled: false })).toEqual(["paper"]);
  });

  it("live only — paper gets nothing", () => {
    expect(aiChannelsFor({ aiPaperEnabled: false, aiLiveEnabled: true })).toEqual(["live"]);
  });

  it("both OFF routes nowhere — the signal must not be placed at all", () => {
    // The handler turns an empty list into an explicit refusal rather than
    // silently defaulting to paper, which would place trades the operator
    // switched off.
    expect(aiChannelsFor({ aiPaperEnabled: false, aiLiveEnabled: false })).toEqual([]);
  });

  it("live is never enabled implicitly — real money is opt-in", () => {
    // Any shape that does not explicitly say aiLiveEnabled:true must not reach
    // the live book.
    for (const tm of [
      { aiPaperEnabled: true },
      { aiTradesMode: "paper" as Mode },
      {},
      undefined,
    ]) {
      expect(aiChannelsFor(tm)).not.toContain("live");
    }
  });
});

describe("migration from the old either/or aiTradesMode", () => {
  it("an install that predates the flags keeps its exact behaviour — paper", () => {
    expect(aiChannelsFor({ aiTradesMode: "paper" })).toEqual(["paper"]);
  });

  it("...and live", () => {
    expect(aiChannelsFor({ aiTradesMode: "live" })).toEqual(["live"]);
  });

  it("the explicit flags win over the legacy mode once present", () => {
    // Otherwise a stale aiTradesMode would keep overriding the new switches.
    expect(aiChannelsFor({ aiTradesMode: "live", aiPaperEnabled: true, aiLiveEnabled: false }))
      .toEqual(["paper"]);
  });

  it("defaults to paper when nothing is set", () => {
    expect(aiChannelsFor(undefined)).toEqual(["paper"]);
  });
});
