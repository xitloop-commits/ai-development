/**
 * T128 — SEA detects the UNION of both enabled books' AI cohorts.
 *
 * SEA is one process with one cohort set, but the two books can want different
 * cohorts. Before this, whichever tab you last viewed decided what SEA fired —
 * which silently made live place scalp signals its own config had switched off.
 * Now a cohort fires if ANY enabled book wants it, and each book filters at
 * placement.
 *
 * Driven through the REAL `syncCohortsFromAiConfig` + `getCohortState`, not a
 * mirror — a copy of the union logic would keep passing if the real one broke.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Persistence + broadcast are side effects; stub them so the test touches only
// the in-memory cohort state.
vi.mock("fs", () => ({
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));
vi.mock("./broker/tickBus", () => ({ tickBus: { emitSeaControl: vi.fn() } }));

const cohortsByBook: Record<string, any> = {};
const common: { revPct: number } = { revPct: 0.18 };
vi.mock("./portfolio/aiModeConfig", () => ({
  getAiConfig: (book: string, _kind: string) => ({ cohorts: cohortsByBook[book] }),
  getCommonConfig: () => common,
}));

const tradingMode: { aiPaperEnabled?: boolean; aiLiveEnabled?: boolean } = {};
vi.mock("./userSettings", () => ({
  getUserSettings: async () => ({ tradingMode }),
}));

import { syncCohortsFromAiConfig, getCohortState, setCohort } from "./seaControl";

beforeEach(() => {
  // paper races Scalp + MA; live takes MA only — the 2026-07-23 race split.
  cohortsByBook.paper = { scalp: true, trend: false, ma: true, swing: false };
  cohortsByBook.live = { scalp: false, trend: false, ma: true, swing: false };
  common.revPct = 0.18;
  tradingMode.aiPaperEnabled = true;
  tradingMode.aiLiveEnabled = true;
  // Reset the module's cohort flags to a known state.
  setCohort("scalp", false);
  setCohort("trend", false);
  setCohort("ma", false);
});

describe("syncCohortsFromAiConfig — union of enabled books", () => {
  it("fires a cohort when ANY enabled book wants it", async () => {
    await syncCohortsFromAiConfig();
    const s = getCohortState();
    expect(s.scalp).toBe(true); // paper wants it
    expect(s.ma).toBe(true);    // both want it
    expect(s.trend).toBe(false); // neither
  });

  it("drops a book's cohorts entirely when its AI is switched off", async () => {
    // Scalp is ONLY paper's. Turn paper's AI off and scalp must stop firing,
    // even though live is still on.
    tradingMode.aiPaperEnabled = false;
    await syncCohortsFromAiConfig();
    const s = getCohortState();
    expect(s.scalp).toBe(false); // paper is off, and only paper wanted scalp
    expect(s.ma).toBe(true);     // live still wants MA
  });

  it("goes quiet when neither book's AI is on", async () => {
    tradingMode.aiPaperEnabled = false;
    tradingMode.aiLiveEnabled = false;
    await syncCohortsFromAiConfig();
    const s = getCohortState();
    expect(s.scalp).toBe(false);
    expect(s.ma).toBe(false);
    expect(s.trend).toBe(false);
  });

  it("pushes revPct from the COMMON block — one value, no per-book ambiguity", async () => {
    // T129 — revPct is a single detector parameter; it no longer matters which
    // book is on. Whatever Settings holds is what SEA gets.
    common.revPct = 0.25;
    await syncCohortsFromAiConfig();
    expect(getCohortState().revPct).toBe(0.25);
  });
});
