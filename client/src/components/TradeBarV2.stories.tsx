/**
 * TradeBarV2.stories.tsx — redesign preview.
 *
 * Proportional risk∶reward bar with baked-in ₹ P&L and one state-aware readout.
 * Same prop contract as TradeBar, so these mirror the original stories for a
 * side-by-side compare (Components/TradeBar vs Components/TradeBarV2).
 */

import type { Meta, StoryObj } from "@storybook/react";
import { TradeBarV2 } from "./TradeBarV2";

const meta = {
  title: "Components/TradeBarV2",
  component: TradeBarV2,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Redesign: RISK (entry→stop, red) and REWARD (entry→TP, green) drawn at " +
          "true proportional widths, a solid P&L fill from entry→LTP, and a single " +
          "state-aware readout (₹ P&L · % · RR / TSL · distance to TP).",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    isBuy: { control: { type: "boolean" } },
    entryPrice: { control: { type: "number", step: 1 } },
    ltp: { control: { type: "number", step: 1 } },
    slPercent: { control: { type: "number", step: 0.5 }, description: "Stop = entry − SL%. Negative once trailed into profit (TSL)" },
    tpPercent: { control: { type: "number", step: 0.5 } },
    units: { control: { type: "number", step: 25 }, description: "Position size (lots × lot size) → drives ₹ P&L" },
    roundTripCharges: { control: { type: "number", step: 1 } },
    compact: { control: { type: "boolean" } },
    onStopLossHit: { action: "stop hit" },
    onTakeProfitHit: { action: "take profit hit" },
  },
  decorators: [
    (Story) => (
      <div style={{ width: "100%", padding: "24px 12px" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TradeBarV2>;

export default meta;
type Story = StoryObj<typeof meta>;

// entry 271 → Stop(5%) 257.45, TP(10%) 298.10. units 750 → live ₹ P&L shows.
const base = {
  isBuy: true as const,
  entryPrice: 271,
  ltp: 285,
  slPercent: 5,
  tpPercent: 10,
  units: 750,
  roundTripCharges: 40,
};

export const Playground: Story = { args: { ...base, compact: false, trailingEnabled: true } };

export const SlMode: Story = {
  args: { ...base, trailingEnabled: false, ltp: 265 },
  parameters: { docs: { description: { story: "Trailing OFF in settings → the stop is a plain fixed SL (never trails, stays red)." } } },
};

export const BuyInProfit: Story = {
  args: { ...base, ltp: 290 },
  parameters: { docs: { description: { story: "In profit — green fill from entry to LTP, ₹ P&L positive." } } },
};

export const BuyInLoss: Story = {
  args: { ...base, ltp: 262 },
  parameters: { docs: { description: { story: "In loss — red fill from entry back toward the stop." } } },
};

export const BadRiskReward: Story = {
  args: { ...base, slPercent: 5.4, tpPercent: 1.4, ltp: 273 },
  parameters: { docs: { description: { story: "The RR-0.3 case: a sliver of green reward against a wall of red risk — instantly readable." } } },
};

export const StopTrailedIntoProfit: Story = {
  args: { ...base, ltp: 292, slPercent: -3 },
  parameters: { docs: { description: { story: "Stop trailed into profit — the entry→stop band turns gold (locked), readout shows TSL." } } },
};

export const TslRunning: Story = {
  args: { ...base, ltp: 292, slPercent: -3, tslActivatedAt: Date.now() - 95_000 },
  parameters: { docs: { description: { story: "TSL active — the readout shows a live mm:ss clock next to the locked stop." } } },
};

export const NearMaxExtends: Story = {
  args: { ...base, ltp: 305 },
  parameters: { docs: { description: { story: "LTP past TP — the scale auto-extends so the pointer never pins to the edge." } } },
};

export const SellInProfit: Story = {
  args: { isBuy: false, entryPrice: 145, ltp: 132, slPercent: 5, tpPercent: 10, units: 750, roundTripCharges: 40 },
  parameters: { docs: { description: { story: "SELL — favourable (price falling) still reads left→right, mirrored." } } },
};

export const Compact: Story = {
  args: { ...base, compact: true },
  parameters: { docs: { description: { story: "Compact — bar + pointer only, for the tight table cell." } } },
};
