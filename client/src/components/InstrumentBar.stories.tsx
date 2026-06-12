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
}: DemoProps) {
  const atm = Math.round(ltp / strikeStep) * strikeStep;
  const tradeMarkers = withTrades
    ? [
        { price: atm, isBuy: true },
        { price: atm - strikeStep * 2, isBuy: false },
      ]
    : [];
  return (
    <InstrumentBar
      name={name}
      expiry={expiry}
      side={side}
      direction={direction}
      strike={{ spot, ltp, strikeStep, windowEachSide: 3, showTrail, showZoneLabels, tradeMarkers }}
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
