import type { Meta, StoryObj } from "@storybook/react";
import { useRef } from "react";
import { TodaySection } from "./TodaySection";
import {
  makeDay,
  mockOpenTrade,
  mockClosedTpTrade,
} from "@/mockups/tradeFixtures";
import type { CapitalState } from "@/lib/tradeTypes";

const fallbackCapital: CapitalState = {
  tradingPool: 75000,
  reservePool: 25000,
  currentDayIndex: 3,
  targetPercent: 5,
  availableCapital: 74100,
  netWorth: 100000,
  cumulativePnl: 893,
  cumulativeCharges: 42,
  todayPnl: 320,
  todayTarget: 545,
  quarterlyProjection: { quarterLabel: "Q1", projectedCapital: 0 },
};

type HarnessProps = Omit<React.ComponentProps<typeof TodaySection>, 'todayRef'>;

function Harness(props: HarnessProps) {
  const ref = useRef<HTMLTableRowElement>(null);
  return (
    <table className="w-full table-fixed border-collapse text-xs">
      <colgroup>
        {Array.from({ length: 16 }).map((_, i) => <col key={i} />)}
      </colgroup>
      <tbody>
        <TodaySection {...props} todayRef={ref} />
      </tbody>
    </table>
  );
}

const baseDay = makeDay({ dayIndex: 3, trades: [mockOpenTrade] });

const meta = {
  title: "Components/TodaySection",
  component: Harness,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "The today-day section of the TradingDesk table — renders trade rows, the new-trade form, and the summary row. Pulls `trpc.capital.updateTrade` for TP/SL edits (provider wired via Storybook preview decorator).",
      },
    },
  },
  tags: ["autodocs"],
  args: {
    capital: fallbackCapital,
    showNet: true,
    onExitTrade: (id: string) => console.log("exit", id),
    onExitAll: () => console.log("exit all"),
    onPlaceTrade: async (t: unknown) => console.log("place", t),
    getLiveLtp: () => undefined,
    channel: "my-live" as const,
    allDays: [baseDay],
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { day: baseDay } };
export const Playground: Story = { args: { day: baseDay } };

export const Empty: Story = {
  args: { day: makeDay({ dayIndex: 3, trades: [], instruments: [], totalPnl: 0, actualCapital: 0 }) },
};

export const WithTrades: Story = {
  args: { day: makeDay({ dayIndex: 3, trades: [mockOpenTrade, mockClosedTpTrade] }) },
};

export const PaperManual: Story = { args: { day: baseDay, channel: "testing-sandbox" } };

export const AiPaper: Story = { args: { day: baseDay, channel: "ai-paper" } };

export const Loading: Story = {
  args: { day: baseDay, exitLoading: true, placeLoading: true },
};

export const Gross: Story = { args: { day: baseDay, showNet: false } };
