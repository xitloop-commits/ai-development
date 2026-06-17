/**
 * InstrumentBar.stories.tsx
 *
 * The per-instrument bar is always the strike scale (it never flips to a trade
 * view). A thin demo wrapper flattens the nested strike props into draggable
 * controls (spot, ltp, strikeStep…) and a `withTrades` toggle that adds a couple
 * of persistent entry markers.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { InstrumentBar, type OptionSide, type TradeDirection } from "./InstrumentBar";
import type { OiLevel } from "@/hooks/useOptionChainLevels";

interface DemoProps {
  name?: string;
  expiry?: string;
  side: OptionSide;
  direction: TradeDirection;
  spot: number;
  ltp: number;
  strikeStep: number;
  showTrail: boolean;
  showZoneLabels: boolean;
  withTrades: boolean;
  withOiLevels: boolean;
}

/** Sample option-chain OI levels around the ATM: put-OI peak below (supports),
 *  call-OI peak above (resistances), plus two off-window strikes for overflow. */
function buildSampleOi(atm: number, step: number): { levels: OiLevel[]; oiMax: number; maxPain: number } {
  const lvl = (
    strike: number,
    isSupport: boolean,
    isResistance: boolean,
    callOI: number,
    callOIChange: number,
    callLean: OiLevel["call"]["lean"],
    putOI: number,
    putOIChange: number,
    putLean: OiLevel["put"]["lean"],
  ): OiLevel => ({
    strike,
    isSupport,
    isResistance,
    call: { oi: callOI, oiChange: callOIChange, trend: callOIChange > callOI * 0.02 ? "up" : callOIChange < -callOI * 0.02 ? "down" : "flat", lean: callLean },
    put: { oi: putOI, oiChange: putOIChange, trend: putOIChange > putOI * 0.02 ? "up" : putOIChange < -putOI * 0.02 ? "down" : "flat", lean: putLean },
  });
  const levels: OiLevel[] = [
    lvl(atm - step * 4, true, false, 28000, -2500, "unwind", 95000, 9500, "writer"), // off-window (left)
    lvl(atm - step * 2, true, false, 42000, 800, "flat", 112000, 13000, "writer"),
    lvl(atm - step, true, false, 38000, 0, "flat", 84000, -6000, "covering"),
    lvl(atm + step, false, true, 104000, 12000, "buyer", 30000, -900, "flat"),
    lvl(atm + step * 2, false, true, 120000, 14000, "writer", 26000, 0, "flat"),
    lvl(atm + step * 5, false, true, 72000, 5000, "buyer", 21000, 0, "flat"), // off-window (right)
  ];
  return { levels, oiMax: 120000, maxPain: atm };
}

function InstrumentBarDemo({
  name,
  expiry,
  side,
  direction,
  spot,
  ltp,
  strikeStep,
  showTrail,
  showZoneLabels,
  withTrades,
  withOiLevels,
}: DemoProps) {
  const atm = Math.round(ltp / strikeStep) * strikeStep;
  const tradeMarkers = withTrades
    ? [
        { price: atm, isBuy: true },
        { price: atm - strikeStep * 2, isBuy: false },
      ]
    : [];
  const oi = withOiLevels ? buildSampleOi(atm, strikeStep) : null;
  return (
    <InstrumentBar
      name={name}
      expiry={expiry}
      side={side}
      direction={direction}
      strike={{
        spot,
        ltp,
        strikeStep,
        windowEachSide: 3,
        showTrail,
        showZoneLabels,
        tradeMarkers,
        oiLevels: oi?.levels,
        oiMax: oi?.oiMax,
        maxPainStrike: oi?.maxPain,
      }}
    />
  );
}

const meta = {
  title: "Components/InstrumentBar",
  component: InstrumentBarDemo,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Always the strike scale: expiry · CE/PE · LONG/SHORT · StrikeBar. Each " +
          "trade leaves a persistent marker (green=BUY, red=SELL) — toggle `withTrades`. " +
          "Drag `ltp` to move the pointer; the bar never flips to a trade view.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    name: { control: { type: "text" } },
    expiry: { control: { type: "text" } },
    side: { control: { type: "inline-radio" }, options: ["CE", "PE"] },
    direction: { control: { type: "inline-radio" }, options: ["LONG", "SHORT"] },
    spot: { control: { type: "number", step: 1 } },
    ltp: { control: { type: "number", step: 1 }, description: "Underlying LTP pointer" },
    strikeStep: { control: { type: "number", step: 1 } },
    showTrail: { control: { type: "boolean" }, description: "Footprint heatmap" },
    showZoneLabels: { control: { type: "boolean" }, description: "ITM/ATM/OTM labels" },
    withTrades: { control: { type: "boolean" }, description: "Add sample entry markers" },
    withOiLevels: { control: { type: "boolean" }, description: "Add sample option-chain OI support/resistance markers" },
  },
  args: {
    name: "nifty50",
    expiry: "30 Jun",
    side: "CE",
    direction: "LONG",
    spot: 23393,
    ltp: 23393,
    strikeStep: 50,
    showTrail: false,
    showZoneLabels: false,
    withTrades: false,
    withOiLevels: false,
  },
  decorators: [
    (Story) => (
      <div style={{ width: "100%", padding: "24px 12px" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof InstrumentBarDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  parameters: { docs: { description: { story: "Ready strike scale + toggles. Drag `ltp` to move the pointer." } } },
};

export const WithEntryMarkers: Story = {
  args: { withTrades: true },
  parameters: { docs: { description: { story: "Two persistent entry markers (green BUY + red SELL) left by prior trades." } } },
};

export const Put: Story = {
  args: { side: "PE" },
};

export const OiMarkers: Story = {
  args: { withOiLevels: true },
  parameters: { docs: { description: { story: "Option-chain OI marks merged onto the strike axis: CE above the track / PE below, height ∝ OI, ▲/▼ = OI change (amber = under pressure), 'MP' = max-pain. Hover for the full CE+PE numbers." } } },
};
