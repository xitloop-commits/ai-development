/**
 * StrikeBar.stories.tsx
 *
 * Ready-state strike scale: a rolling window of option strikes (ITM · ATM ·
 * OTM) with the underlying LTP as the moving pointer. As `spot` changes, the
 * visible 7-strike window re-centres on ATM. Use these to iterate on the visual.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { StrikeBar } from "./StrikeBar";

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
