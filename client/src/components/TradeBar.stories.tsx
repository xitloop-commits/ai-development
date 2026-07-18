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
    exitPhase: {
      control: { type: "select" },
      options: [undefined, "cooling", "wide", "breakeven", "trailing", "target-bank"],
      description: "Exit-strategy phase badge (T84 runway/anchor staged stop)",
    },
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

// ── Exit-strategy phases (T84) ──────────────────────────────────────────
// All three strategies BUY the same option at the same moment and share a
// 5-min cooling window (a wide −25% stop). They differ only in what they do
// with a WINNER: Sprint trails a target, Runway rides it to the peak, Anchor
// banks a fixed amount. The badge (top-left) shows the current staged-stop phase.

export const SharedCooling: Story = {
  args: { ...base, slPercent: 25, ltp: 274, exitPhase: "cooling" },
  parameters: { docs: { description: { story: "Shared start for all three — the first 5 minutes keep a wide −25% net so a normal wiggle can't kick a fresh trade out." } } },
};

export const Sprint: Story = {
  args: { ...base, ltp: 292, slPercent: -3, tpPercent: 12, trailingEnabled: true },
  parameters: { docs: { description: { story: "🔵 Sprint — disciplined day-trader. Trails the stop up behind price AND inches the target ahead, so a big winner isn't capped; sells on whichever comes first — target, stop, or the 30-min time limit (MA-Signal also on a trend-flip). Legacy TP/SL path — no staged-phase badge." } } },
};

export const RunwayBreakeven: Story = {
  args: { ...base, slPercent: 0, ltp: 285, exitPhase: "breakeven" },
  parameters: { docs: { description: { story: "🟢 Runway — once it's up halfway to target the stop is pulled to entry (breakeven): the trade can no longer lose." } } },
};

export const RunwayTrailing: Story = {
  args: { ...base, ltp: 305, slPercent: -8, tpPercent: 15, trailingEnabled: true, exitPhase: "trailing" },
  parameters: { docs: { description: { story: "🟢 Runway — near/past target it switches to pure trailing: the stop rides 15% below the running peak and never takes a fixed profit, so it rides the move as far as it goes. Its winners are the biggest." } } },
};

export const AnchorBreakeven: Story = {
  args: { ...base, slPercent: 0, ltp: 288, exitPhase: "breakeven" },
  parameters: { docs: { description: { story: "🟠 Anchor — same breakeven lock as Runway: a winner won't be allowed to turn into a loss." } } },
};

export const AnchorTargetBank: Story = {
  args: { ...base, slPercent: 0, ltp: 298, tpPercent: 10, exitPhase: "target-bank" },
  parameters: { docs: { description: { story: "🟠 Anchor — the moment price reaches the target it banks the fixed profit and leaves (LTP sitting on TP). No ride — steady small wins; the flip side is a trade that never reaches target and turns down takes the loss." } } },
};
