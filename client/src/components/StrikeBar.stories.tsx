/**
 * StrikeBar.stories.tsx
 *
 * Ready-state strike scale: a rolling window of option strikes (ITM · ATM ·
 * OTM) with the underlying LTP as the moving pointer. As `spot` changes, the
 * visible 7-strike window re-centres on ATM. Use these to iterate on the visual.
 */

import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { StrikeBar } from "./StrikeBar";
import type { OiLevel } from "@/hooks/useOptionChainLevels";

const meta = {
  title: "Components/StrikeBar",
  component: StrikeBar,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Strike-axis sibling of TradeBar. Plots a rolling window of strikes " +
          "(default 3 ITM · ATM · 3 OTM) with the underlying LTP as the pointer. " +
          "CE: strikes below spot are ITM; PE mirrors it. Window re-centres on ATM " +
          "as the spot moves (TodayPnlBar-style rolling).",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    spot: { control: { type: "number", step: 1 }, description: "Anchor price for ATM + window" },
    ltp: { control: { type: "number", step: 1 }, description: "Live LTP pointer (defaults to spot) — move it to test the pointer within a fixed window" },
    strikeStep: { control: { type: "number", step: 1 }, description: "Gap between strikes" },
    atmStrike: { control: { type: "number", step: 1 }, description: "ATM strike (default round(spot/step)*step)" },
    side: { control: { type: "inline-radio" }, options: ["CE", "PE"], description: "Moneyness labelling" },
    showZoneLabels: { control: { type: "boolean" }, description: "Show ITM / ATM / OTM zone labels (default false)" },
    showTrail: { control: { type: "boolean" }, description: "Leave a fading footprint trail of recent LTP positions" },
    supports: { control: { type: "object" }, description: "Support price levels (array) — emerald dashed markers" },
    resistances: { control: { type: "object" }, description: "Resistance price levels (array) — red dashed markers" },
    oiLevels: { control: { type: "object" }, description: "Option-chain OI levels (top CE/PE OI strikes, current expiry) — two-sided OI markers" },
    oiMax: { control: { type: "number", step: 1000 }, description: "Largest single-side OI across oiLevels (normalises height/opacity)" },
    maxPainStrike: { control: { type: "number", step: 1 }, description: "Max-pain strike — violet 'MP' marker" },
    entryMarker: { control: { type: "number", step: 1 }, description: "Placed trade-entry price (blue 'E'); hover+click also places it" },
    onPlaceEntry: { action: "place entry" },
    onEnterTrade: { action: "enter trade" },
    windowEachSide: { control: { type: "number", step: 1 }, description: "Strikes each side of centre (default 3 → 7)" },
    compact: { control: { type: "boolean" }, description: "Hide strike labels for tight cells" },
  },
  decorators: [
    (Story) => (
      <div style={{ width: "100%", padding: "24px 12px" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StrikeBar>;

export default meta;
type Story = StoryObj<typeof meta>;

// NIFTY-ish: spot 23393, step 50 → ATM 23400.
const base = {
  spot: 23393,
  ltp: 23393,
  strikeStep: 50,
  side: "CE" as const,
  showZoneLabels: true,
  windowEachSide: 3,
};

// Sample option-chain OI levels around NIFTY 23400 (current expiry). Put-OI
// peaks below spot (supports), Call-OI peaks above (resistances). Two strikes
// (23200, 23650) sit OUTSIDE the visible 23250–23550 window to demo the edge
// overflow (◂N / ▸N) markers. Leans cover the quadrants (writer / buyer /
// covering / unwind / flat).
const sampleOiLevels: OiLevel[] = [
  { strike: 23200, isSupport: true, isResistance: false, // off-window (left)
    call: { oi: 30000, oiChange: -2500, trend: "down", lean: "unwind" },
    put: { oi: 95000, oiChange: 9500, trend: "up", lean: "writer" } },
  { strike: 23300, isSupport: true, isResistance: false,
    call: { oi: 42000, oiChange: 800, trend: "flat", lean: "flat" },
    put: { oi: 112000, oiChange: 13000, trend: "up", lean: "writer" } },
  { strike: 23350, isSupport: true, isResistance: false,
    call: { oi: 38000, oiChange: 0, trend: "flat", lean: "flat" },
    put: { oi: 84000, oiChange: -6000, trend: "down", lean: "covering" } },
  { strike: 23450, isSupport: false, isResistance: true,
    call: { oi: 104000, oiChange: 12000, trend: "up", lean: "buyer" },
    put: { oi: 30000, oiChange: -900, trend: "flat", lean: "flat" } },
  { strike: 23500, isSupport: false, isResistance: true,
    call: { oi: 120000, oiChange: 14000, trend: "up", lean: "writer" },
    put: { oi: 26000, oiChange: 0, trend: "flat", lean: "flat" } },
  { strike: 23650, isSupport: false, isResistance: true, // off-window (right)
    call: { oi: 72000, oiChange: 5000, trend: "up", lean: "buyer" },
    put: { oi: 21000, oiChange: 0, trend: "flat", lean: "flat" } },
];
const sampleOiMax = 120000;
const sampleMaxPain = 23400;
const oiBase = { ...base, showZoneLabels: false, oiLevels: sampleOiLevels, oiMax: sampleOiMax, maxPainStrike: sampleMaxPain };

export const Playground: Story = { args: { ...base, compact: false } };

export const NiftyAtm: Story = {
  args: base,
  parameters: { docs: { description: { story: "NIFTY, spot near ATM 23400 — pointer sits mid-bar." } } },
};

export const Put: Story = {
  args: { ...base, side: "PE" },
  parameters: { docs: { description: { story: "PE — moneyness mirrored (strikes above spot are ITM)." } } },
};

export const SpotMovedUp: Story = {
  args: { ...base, spot: 23510 },
  parameters: { docs: { description: { story: "Spot moved up past 23500 — window rolls right to keep the pointer centred." } } },
};

export const PointerTravel: Story = {
  args: { ...base, ltp: 23290 },
  parameters: { docs: { description: { story: "LTP pulled below ATM while spot (window) stays fixed — watch the pointer travel left across the strikes." } } },
};

export const WithSupportResistance: Story = {
  args: { ...base, supports: [23280, 23330], resistances: [23460, 23520] },
  parameters: { docs: { description: { story: "Support (emerald) below and resistance (red) above the LTP — dashed markers on the strike scale, only those within the visible window show." } } },
};

export const WithEntryMarker: Story = {
  args: { ...base, entryMarker: 23420 },
  parameters: { docs: { description: { story: "Trade-entry marker (blue 'E') pre-placed at 23420. Hover the bar to aim a preview, click to place. onEnterTrade fires once when the LTP crosses the placed marker." } } },
};

export const EntryTriggered: Story = {
  args: { ...base, entryMarker: 23393 },
  parameters: { docs: { description: { story: "Entry marker placed at the current LTP — onEnterTrade fires immediately on load (check the Actions panel). In the live app it fires when the LTP first reaches the placed marker." } } },
};

export const ZoneLabelsOff: Story = {
  args: { ...base, showZoneLabels: false },
  parameters: { docs: { description: { story: "ITM / ATM / OTM labels turned off via showZoneLabels=false." } } },
};

export const BankNifty: Story = {
  args: { spot: 54144, ltp: 54144, strikeStep: 100, side: "CE", windowEachSide: 3 },
  parameters: { docs: { description: { story: "BANKNIFTY, step 100." } } },
};

export const Compact: Story = {
  args: { ...base, compact: true },
  parameters: { docs: { description: { story: "Compact (no strike labels) — how it renders inside a tight table cell." } } },
};

// ── Option-chain OI markers (current expiry) ────────────────────────────────

export const OiMarkers: Story = {
  args: { ...oiBase },
  parameters: {
    docs: {
      description: {
        story:
          "Two-sided OI marks merged onto the strike axis: Call OI ABOVE the track (red), " +
          "Put OI BELOW (green); height/opacity ∝ OI. ▲/▼ on each = OI building/unwinding; " +
          "arrow colour = buyer/seller lean (wall-colour = defended, amber = under pressure). " +
          "Violet 'MP' = max-pain. Hover any marker for the full CE + PE numbers.",
      },
    },
  },
};

export const OiMarkersCompact: Story = {
  args: { ...oiBase, compact: true },
  parameters: { docs: { description: { story: "Compact (no strike labels) — how it renders inside a tight table cell on the instrument bar." } } },
};

export const OiMarkersPut: Story = {
  args: { ...oiBase, side: "PE" },
  parameters: { docs: { description: { story: "OI marks are identical in CE and PE — they're underlying strike levels, not side-specific. Only the strike-tick ITM/OTM colouring flips." } } },
};

// Dev preview of the flying-balloon S/R alerts: cycle the per-strike leans every
// ~2s so balloons keep firing (green floats up = strengthening, red floats down =
// weakening). In the live desk these fire only on real lean changes.
function SrBalloonDemo() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 2200);
    return () => clearInterval(id);
  }, []);
  const cycle = ["writer", "buyer", "flat", "covering", "unwind"] as const;
  const levels: OiLevel[] = sampleOiLevels
    .filter((l) => l.strike >= 23250 && l.strike <= 23550) // inside the visible window
    .map((l, i) => ({
      ...l,
      call: { ...l.call, lean: cycle[(tick + i) % cycle.length], trend: "up" },
      put: { ...l.put, lean: cycle[(tick + i + 2) % cycle.length], trend: "up" },
    }));
  return (
    <div style={{ padding: "48px 12px" }}>
      <StrikeBar {...oiBase} oiLevels={levels} />
    </div>
  );
}

export const OiBalloons: Story = {
  args: oiBase,
  render: () => <SrBalloonDemo />,
  parameters: {
    docs: {
      description: {
        story:
          "Dev preview of the flying-balloon S/R alerts. Leans cycle every ~2s so balloons keep " +
          "popping: green floats UP (strengthening), red floats DOWN (weakening), labelled per side. " +
          "In the live desk they fire only on a real lean change.",
      },
    },
  },
};
