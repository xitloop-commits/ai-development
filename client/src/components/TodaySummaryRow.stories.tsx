import type { Meta, StoryObj } from "@storybook/react";
import { TodaySummaryRow } from "./TodaySummaryRow";
import { makeDay, mockOpenTrade, mockClosedTpTrade } from "@/mockups/tradeFixtures";

const day = makeDay({ dayIndex: 3, trades: [mockOpenTrade, mockClosedTpTrade] });
const openCount = day.trades.filter((t) => t.status === "OPEN").length;

/** Wrap the <tr> in a 17-column table so it lays out like the real TradingDesk. */
function Harness(props: React.ComponentProps<typeof TodaySummaryRow>) {
  return (
    <table className="w-full table-fixed border-collapse text-xs">
      <colgroup>
        {Array.from({ length: 17 }).map((_, i) => <col key={i} />)}
      </colgroup>
      <tbody>
        <TodaySummaryRow {...props} />
      </tbody>
    </table>
  );
}

const meta = {
  title: "Components/TodaySummaryRow",
  component: Harness,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Day-summary row at the bottom of the today cycle. Enhancements: target " +
          "progress % (P&L% cell), win/loss tally (Entry cell), realized-vs-open + " +
          "open-exposure (hover the P&L cell), and a state tint (green target-hit / " +
          "red heavy-loss).",
      },
    },
  },
  tags: ["autodocs"],
  args: {
    day,
    trades: day.trades,
    totalPnl: day.totalPnl,
    showNet: true,
    canManageTrades: true,
    openTradeCount: openCount,
    cycleDateLabel: "Today",
    summaryBorder: "border-bullish/30",
    lastClosedTrade: mockClosedTpTrade,
    onExitAll: () => console.log("exit all"),
    onRepeatLastOrder: () => console.log("repeat last"),
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const TargetHit: Story = {
  args: { totalPnl: day.targetAmount + 50 },
  parameters: { docs: { description: { story: "Target reached — row tints green." } } },
};

export const HeavyLoss: Story = {
  args: { totalPnl: -(day.targetAmount + 50) },
  parameters: { docs: { description: { story: "Loss ≥ the day's target — row tints red." } } },
};

export const NoTrades: Story = {
  args: {
    day: makeDay({ dayIndex: 3, trades: [] }),
    trades: [],
    totalPnl: 0,
    openTradeCount: 0,
    lastClosedTrade: null,
  },
};
