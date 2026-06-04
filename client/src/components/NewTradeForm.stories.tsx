import type { Meta, StoryObj } from "@storybook/react";
import NewTradeForm from "./NewTradeForm";
import type { ResolvedInstrument } from "@/lib/tradeTypes";

/**
 * NewTradeForm renders a single <tr> (the inline new-trade entry row inside
 * the TradingDesk table). The Harness wraps it in a 16-column table so the
 * cells line up exactly as they do in TodaySection.
 *
 * Storybook caveat: the preview decorator stubs every tRPC query to `null`,
 * so `useMarketOpen` reads every instrument as "closed" and the instrument
 * dropdown renders empty. The rest of the row — B/S, CE/PE, SL/TP editor,
 * quantity popover, entry input, OK/X — renders and is interactive. Live
 * expiry/strike/LTP need a running server and are not exercised here.
 */

const resolvedInstruments: ResolvedInstrument[] = [
  { name: "NIFTY_50", securityId: "13", exchange: "IDX_I", mode: "full" },
  { name: "BANKNIFTY", securityId: "25", exchange: "IDX_I", mode: "full" },
  { name: "CRUDEOIL", securityId: "294", exchange: "MCX_COMM", mode: "full" },
  { name: "NATURALGAS", securityId: "295", exchange: "MCX_COMM", mode: "full" },
];

type HarnessProps = React.ComponentProps<typeof NewTradeForm>;

function Harness(props: HarnessProps) {
  return (
    <table className="w-full table-fixed border-collapse text-xs">
      <colgroup>
        {Array.from({ length: 16 }).map((_, i) => <col key={i} />)}
      </colgroup>
      <tbody>
        <NewTradeForm {...props} />
      </tbody>
    </table>
  );
}

const meta = {
  title: "Components/NewTradeForm",
  component: Harness,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Inline new-trade entry row: instrument · expiry · strike · CE/PE · B/S · SL/TP/TSL · quantity · entry price · OK/X. Used inside TodaySection when '+ NEW TRADE' is clicked. tRPC provider is wired by the Storybook preview decorator (queries stubbed to null).",
      },
    },
  },
  tags: ["autodocs"],
  args: {
    channel: "my-live" as const,
    availableCapital: 74100,
    instruments: ["NIFTY 50", "BANK NIFTY", "CRUDE OIL", "NATURAL GAS"],
    resolvedInstruments,
    onSubmit: async (trade: unknown) => console.log("submit", trade),
    onCancel: () => console.log("cancel"),
    loading: false,
    dayOpenedAt: 1_717_300_000_000,
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Form opened on an existing day — left columns show the day's index/capital/target. */
export const Default: Story = {
  args: {
    dayValues: {
      dayIndex: 3,
      tradeCapital: 75000,
      targetAmount: 3750,
      targetPercent: 5,
      projCapital: 78750,
    },
  },
};

/** Form opened on a fresh day (no day values yet) — left cell shows the "NEW" tag. */
export const NewRow: Story = {
  args: { dayValues: undefined },
};

/** Submit in flight — the OK button shows a spinner and is disabled. */
export const Loading: Story = {
  args: {
    loading: true,
    dayValues: {
      dayIndex: 3,
      tradeCapital: 75000,
      targetAmount: 3750,
      targetPercent: 5,
      projCapital: 78750,
    },
  },
};

/** AI paper channel — violet tone. */
export const AiPaper: Story = {
  args: { channel: "ai-paper" },
};

/** Testing sandbox channel — amber tone. */
export const TestingSandbox: Story = {
  args: { channel: "testing-sandbox" },
};