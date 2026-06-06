/**
 * InstrumentBar.stories.tsx
 *
 * Uses a thin demo wrapper so the nested strike/trade props are exposed as
 * flat, draggable controls (spot, ltp, strikeStep, entryPrice…). That lets you
 * move the pointer / trail in the ready state and the LTP in the open state
 * directly from the Storybook controls.
 *
 *   ready  → StrikeBar  (strikes + underlying LTP)
 *   open   → TradeBar   (live trade levels)
 *   closed → TradeBar   (frozen snapshot at close)
 */

import type { Meta, StoryObj } from "@storybook/react";
import { InstrumentBar, type InstrumentBarState, type OptionSide, type TradeDirection } from "./InstrumentBar";

interface DemoProps {
  state: InstrumentBarState;
  name?: string;
  expiry?: string;
  side: OptionSide;
  direction: TradeDirection;
  // strike (ready)
  spot: number;
  ltp: number;
  strikeStep: number;
  showTrail: boolean;
  showZoneLabels: boolean;
  // trade (open / closed)
  isBuy: boolean;
  entryPrice: number;
  tradeLtp: number;
  slPercent: number;
  tpPercent: number;
}

function InstrumentBarDemo({
  state,
  name,
  expiry,
  side,
  direction,
  spot,
  ltp,
  strikeStep,
  showTrail,
  showZoneLabels,
  isBuy,
  entryPrice,
  tradeLtp,
  slPercent,
  tpPercent,
}: DemoProps) {
  return (
    <InstrumentBar
      state={state}
      name={name}
      expiry={expiry}
      side={side}
      direction={direction}
      strike={{ spot, ltp, strikeStep, windowEachSide: 3, showTrail, showZoneLabels }}
      trade={{ isBuy, entryPrice, ltp: tradeLtp, slPercent, tpPercent, charges: 2 }}
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
          "Wrapper that switches inner bar by state: ready → StrikeBar, " +
          "open → live TradeBar, closed → frozen TradeBar snapshot. Drag `ltp` " +
          "to move the pointer (ready) or `tradeLtp` (open/closed).",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    state: { control: { type: "inline-radio" }, options: ["ready", "open", "closed"] },
    name: { control: { type: "text" }, description: "Instrument name label" },
    expiry: { control: { type: "text" }, description: "Expiry chip (ready)" },
    side: { control: { type: "inline-radio" }, options: ["CE", "PE"] },
    direction: { control: { type: "inline-radio" }, options: ["LONG", "SHORT"] },
    spot: { control: { type: "number", step: 1 }, description: "Ready: window anchor" },
    ltp: { control: { type: "number", step: 1 }, description: "Ready: underlying LTP pointer" },
    strikeStep: { control: { type: "number", step: 1 } },
    showTrail: { control: { type: "boolean" }, description: "Ready: footprint heatmap" },
    showZoneLabels: { control: { type: "boolean" }, description: "Ready: ITM/ATM/OTM labels" },
    isBuy: { control: { type: "boolean" }, description: "Open/closed: BUY vs SELL" },
    entryPrice: { control: { type: "number", step: 1 }, description: "Open/closed: entry premium" },
    tradeLtp: { control: { type: "number", step: 1 }, description: "Open/closed: live premium" },
    slPercent: { control: { type: "number", step: 0.5 } },
    tpPercent: { control: { type: "number", step: 0.5 } },
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
    isBuy: true,
    entryPrice: 271,
    tradeLtp: 290,
    slPercent: 5,
    tpPercent: 10,
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

export const Ready: Story = {
  args: { state: "ready" },
  parameters: { docs: { description: { story: "Ready — strike scale + toggles. Drag `ltp` to move the pointer; flip `state` to open/closed." } } },
};

export const Open: Story = {
  args: { state: "open" },
  parameters: { docs: { description: { story: "Open — live trade bar. Drag `tradeLtp`." } } },
};

export const Closed: Story = {
  args: { state: "closed", tradeLtp: 298 },
  parameters: { docs: { description: { story: "Closed — frozen TradeBar snapshot at the exit price." } } },
};
