/**
 * TradeBar.stories.tsx
 *
 * Self-contained per-trade price scale (V1). Fixed Entry−15% → Entry+50% scale
 * (upper auto-extends as the LTP approaches it), with SL / Entry / TSL / TP
 * markers and a live LTP triangle. Use these to iterate on the visual.
 *
 * Note: TSL is timer-gated — it activates only after the LTP holds above
 * entry + charges + 1% for 5 seconds, so it won't appear in a static snapshot;
 * use the live Storybook canvas (set ltp above the gate and wait 5s).
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
          "Self-contained price scale: lower bound fixed at Entry−15%, upper at " +
          "Entry+50% (auto-extends +10% as LTP nears it). Markers: SL (entry−SL%), " +
          "Entry, TSL (timer-gated, forward-only), TP (entry+TP%), and the live LTP " +
          "triangle. BUY draws favourable to the right; SELL mirrors it. Emits " +
          "stop-loss-hit / take-profit-hit / tsl-activated callbacks.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    isBuy: { control: { type: "boolean" }, description: "BUY (up is good) vs SELL (down is good)" },
    entryPrice: { control: { type: "number", step: 1 }, description: "Entry price" },
    ltp: { control: { type: "number", step: 1 }, description: "Live last-traded price (pointer)" },
    slPercent: { control: { type: "number", step: 0.5 }, description: "Hard-stop % → SL = entry − SL% (default 5)" },
    tpPercent: { control: { type: "number", step: 0.5 }, description: "Take-profit % → TP = entry + TP% (default 10)" },
    tslPercent: { control: { type: "number", step: 0.5 }, description: "Trailing distance % once TSL activates (default 1)" },
    charges: { control: { type: "number", step: 0.5 }, description: "Per-unit charges added to the TSL activation gate" },
    compact: { control: { type: "boolean" }, description: "Hide labels for tight cells" },
    onStopLossHit: { action: "stop loss hit" },
    onTakeProfitHit: { action: "take profit hit" },
    onTslActivated: { action: "tsl activated" },
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

// Reference: entry 271 → SL(5%) 257.45, TP(10%) 298.10. Scale 230.35 → 406.50.
const base = {
  isBuy: true as const,
  entryPrice: 271,
  ltp: 285,
  slPercent: 5,
  tpPercent: 10,
  tslPercent: 1,
  charges: 2,
};

export const Playground: Story = {
  args: { ...base, compact: false },
};

export const BuyInProfit: Story = {
  args: { ...base, ltp: 290 },
  parameters: { docs: { description: { story: "BUY in profit — LTP between entry and TP. Hold 5s above the gate and the TSL marker activates." } } },
};

export const BuyInLoss: Story = {
  args: { ...base, ltp: 262 },
  parameters: { docs: { description: { story: "BUY in loss — LTP between SL and entry; TSL never arms." } } },
};

export const NearMaxExtends: Story = {
  args: { ...base, ltp: 400 },
  parameters: { docs: { description: { story: "LTP near the +50% top — the upper bound auto-extends +10% so the pointer never pins to the edge." } } },
};

export const SellInProfit: Story = {
  args: { isBuy: false, entryPrice: 145, ltp: 132, slPercent: 5, tpPercent: 10, tslPercent: 1, charges: 1 },
  parameters: { docs: { description: { story: "SELL — favourable (price falling) still reads left→right, mirrored." } } },
};

export const Compact: Story = {
  args: { ...base, compact: true },
  parameters: { docs: { description: { story: "Compact (no labels) — how it renders inside the tight table cell." } } },
};