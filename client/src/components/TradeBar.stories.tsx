/**
 * TradeBar.stories.tsx
 *
 * Self-contained per-trade price scale. Lower bound at min(stop, entry)−15%,
 * upper at TP+headroom (auto-extends as LTP nears it). Markers: the real Stop
 * (entry − slPercent%), Entry, TP, and the live LTP triangle. The bar shows ONE
 * stop driven by the trade's actual stop price — once it trails into profit
 * (slPercent goes negative) the same marker turns gold and is labelled TSL.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { TradeBar } from "./TradeBar";

const meta = {
  title: "Components/TradeBar",
  component: TradeBar,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Self-contained price scale. Markers: Stop (entry − slPercent%), Entry, " +
          "TP (entry + TP%), and the live LTP triangle. slPercent is the live " +
          "distance to the REAL stop — negative once the stop trails into profit, " +
          "where the marker turns gold/TSL. BUY draws favourable to the right; SELL " +
          "mirrors it. Emits stop-loss-hit / take-profit-hit callbacks.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    isBuy: { control: { type: "boolean" }, description: "BUY (up is good) vs SELL (down is good)" },
    entryPrice: { control: { type: "number", step: 1 }, description: "Entry price" },
    ltp: { control: { type: "number", step: 1 }, description: "Live last-traded price (pointer)" },
    slPercent: { control: { type: "number", step: 0.5 }, description: "Distance to the real stop % → Stop = entry − SL%. Negative = stop in profit (TSL)" },
    tpPercent: { control: { type: "number", step: 0.5 }, description: "Take-profit % → TP = entry + TP% (default 10)" },
    compact: { control: { type: "boolean" }, description: "Hide labels for tight cells" },
    onStopLossHit: { action: "stop hit" },
    onTakeProfitHit: { action: "take profit hit" },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 260, padding: "24px 12px" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TradeBar>;

export default meta;
type Story = StoryObj<typeof meta>;

// Reference: entry 271 → Stop(5%) 257.45, TP(10%) 298.10.
const base = {
  isBuy: true as const,
  entryPrice: 271,
  ltp: 285,
  slPercent: 5,
  tpPercent: 10,
};

export const Playground: Story = {
  args: { ...base, compact: false },
};

export const BuyInProfit: Story = {
  args: { ...base, ltp: 290 },
  parameters: { docs: { description: { story: "BUY in profit — LTP between entry and TP, stop still below entry." } } },
};

export const BuyInLoss: Story = {
  args: { ...base, ltp: 262 },
  parameters: { docs: { description: { story: "BUY in loss — LTP between the stop and entry." } } },
};

export const TslPending: Story = {
  args: { ...base, trailingEnabled: true, tslGatePrice: 277 },
  parameters: { docs: { description: { story: "Trailing on but not armed yet — a thin gold TSL marker sits at the activation gate until the stop trails into profit." } } },
};

export const StopTrailedIntoProfit: Story = {
  args: { ...base, ltp: 292, slPercent: -3 },
  parameters: { docs: { description: { story: "Stop trailed into profit (slPercent negative) — the marker turns gold and is labelled TSL; the entry→stop band shows locked profit." } } },
};

export const NearMaxExtends: Story = {
  args: { ...base, ltp: 400 },
  parameters: { docs: { description: { story: "LTP near the top — the upper bound auto-extends +10% so the pointer never pins to the edge." } } },
};

export const SellInProfit: Story = {
  args: { isBuy: false, entryPrice: 145, ltp: 132, slPercent: 5, tpPercent: 10 },
  parameters: { docs: { description: { story: "SELL — favourable (price falling) still reads left→right, mirrored." } } },
};

export const Compact: Story = {
  args: { ...base, compact: true },
  parameters: { docs: { description: { story: "Compact (no labels) — how it renders inside the tight table cell." } } },
};
