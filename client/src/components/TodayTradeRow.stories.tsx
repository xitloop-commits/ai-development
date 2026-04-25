import type { Meta, StoryObj } from "@storybook/react";
import { TodayTradeRow } from "./TodayTradeRow";
import {
  makeDay,
  mockOpenTrade,
  mockClosedTpTrade,
  mockClosedSlTrade,
  mockShortTrade,
} from "@/mockups/tradeFixtures";

function TableWrap({ children }: { children: React.ReactNode }) {
  return (
    <table className="w-full table-fixed border-collapse text-xs">
      <colgroup>
        {Array.from({ length: 16 }).map((_, i) => <col key={i} />)}
      </colgroup>
      <tbody>{children}</tbody>
    </table>
  );
}

const day = makeDay({ trades: [mockOpenTrade] });

const meta = {
  title: "Components/TodayTradeRow",
  component: TodayTradeRow,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Single trade row inside the Today section. Memoized on trade.id/status/ltp/SL/TP — ticks only re-render the affected row, not the whole table.",
      },
    },
  },
  tags: ["autodocs"],
  decorators: [(Story: any) => <TableWrap><Story /></TableWrap>],
  args: {
    day,
    isFirst: true,
    showNet: true,
    canManageTrades: true,
    workspace: "live" as const,
    onExit: () => console.log("exit"),
    onUpdateTpSl: (id: string, patch: unknown) => console.log("tp/sl", id, patch),
  },
} satisfies Meta<typeof TodayTradeRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { trade: mockOpenTrade } };
export const Playground: Story = { args: { trade: mockOpenTrade } };
export const OpenTrade: Story = { args: { trade: mockOpenTrade } };
export const ClosedTP: Story = { args: { trade: mockClosedTpTrade } };
export const ClosedSL: Story = { args: { trade: mockClosedSlTrade } };
export const TrailingStop: Story = {
  args: { trade: { ...mockOpenTrade, trailingStopEnabled: true } },
};
export const ShortTrade: Story = { args: { trade: mockShortTrade } };
export const SecondaryRow: Story = { args: { trade: mockOpenTrade, isFirst: false } };
export const PaperWorkspace: Story = { args: { trade: mockOpenTrade, workspace: "paper_manual" } };
export const AiManaged: Story = {
  args: { trade: mockOpenTrade, workspace: "paper", canManageTrades: false },
};
export const Gross: Story = { args: { trade: mockClosedTpTrade, showNet: false } };
export const ExitLoading: Story = { args: { trade: mockOpenTrade, exitLoading: true } };
