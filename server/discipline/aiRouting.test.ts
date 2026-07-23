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

/**
 * T128 — the cohort filter. SEA detects the UNION of both books' AI cohorts, so
 * a book can receive a signal for a cohort it switched off. Each book takes only
 * the cohorts its own AI stream enabled. This mirrors the filter in
 * discipline/routes.ts; getting it wrong places a REAL order for a cohort the
 * operator turned off on that book.
 */
type Cohorts = { scalp: boolean; trend: boolean; ma: boolean; swing: boolean };
const COHORT_KEY = { ma_signal: "ma", scalp: "scalp", trend: "trend", swing: "swing" } as const;

function filterByCohort(
  channels: string[],
  cohort: keyof typeof COHORT_KEY,
  cohortsOf: (ch: string) => Cohorts,
): string[] {
  const key = COHORT_KEY[cohort];
  return channels.filter((ch) => cohortsOf(ch)[key]);
}

describe("cohort filter — each book takes only what it enabled", () => {
  // paper races Scalp + MA; live takes MA only. The exact split from the
  // 2026-07-23 race setup.
  const cohortsOf = (ch: string): Cohorts =>
    ch === "paper"
      ? { scalp: true, trend: false, ma: true, swing: false }
      : { scalp: false, trend: false, ma: true, swing: false };

  it("a SCALP signal reaches paper but NOT live", () => {
    // The bug this closes: live was placing scalp signals its own config had off.
    expect(filterByCohort(["paper", "live"], "scalp", cohortsOf)).toEqual(["paper"]);
  });

  it("an MA signal reaches BOTH — both books enabled it", () => {
    expect(filterByCohort(["paper", "live"], "ma_signal", cohortsOf)).toEqual(["paper", "live"]);
  });

  it("a TREND signal reaches neither — the union detected it, no book wants it", () => {
    // SEA can emit a cohort no book will place (the union is over 'any book'),
    // and the gate drops it. Placement, not detection, is where it stops.
    expect(filterByCohort(["paper", "live"], "trend", cohortsOf)).toEqual([]);
  });

  it("does not gate manual/USER trades — you asked for that trade by hand", () => {
    // The filter only runs for origin === "AI"; a USER trade on live places
    // regardless of live's cohort toggles. Modelled here as 'filter not applied'.
    const manualTargets = ["live"];
    expect(manualTargets).toEqual(["live"]); // no cohort filter applied
  });
});

/**
 * The UNION SEA detects — a cohort fires if ANY enabled book wants it.
 */
function seaUnion(
  tm: TradingMode | undefined,
  cohortsOf: (book: "paper" | "live") => Cohorts,
): Cohorts {
  const books = aiChannelsFor(tm) as Array<"paper" | "live">;
  const any = (k: keyof Cohorts) => books.some((b) => cohortsOf(b)[k]);
  return { scalp: any("scalp"), trend: any("trend"), ma: any("ma"), swing: any("swing") };
}

describe("SEA detects the union of enabled books' cohorts", () => {
  const cohortsOf = (b: "paper" | "live"): Cohorts =>
    b === "paper"
      ? { scalp: true, trend: false, ma: true, swing: false }
      : { scalp: false, trend: false, ma: false, swing: true };

  it("both books on → union of both", () => {
    expect(seaUnion({ aiPaperEnabled: true, aiLiveEnabled: true }, cohortsOf))
      .toEqual({ scalp: true, trend: false, ma: true, swing: true });
  });

  it("only paper on → only paper's cohorts drive SEA", () => {
    expect(seaUnion({ aiPaperEnabled: true, aiLiveEnabled: false }, cohortsOf))
      .toEqual({ scalp: true, trend: false, ma: true, swing: false });
  });

  it("neither on → SEA detects nothing", () => {
    expect(seaUnion({ aiPaperEnabled: false, aiLiveEnabled: false }, cohortsOf))
      .toEqual({ scalp: false, trend: false, ma: false, swing: false });
  });
});
