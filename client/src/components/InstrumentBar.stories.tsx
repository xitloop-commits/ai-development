/**
 * InstrumentBar.stories.tsx
 *
 * The per-instrument bar across its three states:
 *   ready  → StrikeBar  (strikes + underlying LTP)
 *   open   → TradeBar   (live trade levels)
 *   closed → TradeBar   (frozen snapshot at close)
 */

import type { Meta, StoryObj } from "@storybook/react";
import { InstrumentBar } from "./InstrumentBar";

const strike = { spot: 23393, strikeStep: 50, side: "CE" as const, windowEachSide: 3 };
const trade = { isBuy: true, entryPrice: 271, ltp: 290, slPercent: 5, tpPercent: 10, tslPercent: 1, charges: 2 };

const meta = {
  title: "Components/InstrumentBar",
  component: InstrumentBar,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Wrapper that switches inner bar by state: ready → StrikeBar, " +
          "open → live TradeBar, closed → frozen TradeBar snapshot.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    state: { control: { type: "inline-radio" }, options: ["ready", "open", "closed"] },
    name: { control: { type: "text" }, description: "Instrument name label" },
    side: { control: { type: "inline-radio" }, options: ["CE", "PE"], description: "Option side (ready-state moneyness)" },
    direction: { control: { type: "inline-radio" }, options: ["LONG", "SHORT"], description: "Trade direction toggle" },
    onSideChange: { action: "side change" },
    onDirectionChange: { action: "direction change" },
  },
  args: {
    name: "nifty50",
    side: "CE",
    direction: "LONG",
    strike,
    trade,
  },
  decorators: [
    (Story) => (
      <div style={{ width: "100%", padding: "24px 12px" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof InstrumentBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  args: { state: "ready" },
  parameters: { docs: { description: { story: "Ready — strike scale, awaiting a trade. Flip the `state` control to open/closed (both strike + trade are supplied)." } } },
};

export const Open: Story = {
  args: { state: "open" },
  parameters: { docs: { description: { story: "Open — live trade bar (entry/SL/TSL/LTP/TP)." } } },
};

export const Closed: Story = {
  args: { state: "closed", trade: { ...trade, ltp: 298 } },
  parameters: { docs: { description: { story: "Closed — frozen TradeBar snapshot at the exit price; no live timers." } } },
};
