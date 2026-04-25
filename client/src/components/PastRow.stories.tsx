import type { Meta, StoryObj } from "@storybook/react";
import { PastRow } from "./PastRow";
import {
  makeDay,
  mockGreenDay,
  mockRedDay,
  mockGiftDay,
  mockJackpotDay,
  mockClosedTpTrade,
  mockClosedSlTrade,
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

const meta = {
  title: "Components/PastRow",
  component: PastRow,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Single past-day summary row rendered in the TradingDesk table. Memoized with custom equality so tick updates don't re-render it.",
      },
    },
  },
  tags: ["autodocs"],
  decorators: [(Story: any) => <TableWrap><Story /></TableWrap>],
} satisfies Meta<typeof PastRow>;

export default meta;
type Story = StoryObj<typeof meta>;

const dayWithTrades = makeDay({
  trades: [mockClosedTpTrade, mockClosedSlTrade],
  instruments: ["NIFTY 50", "BANK NIFTY"],
});

export const Default: Story = { args: { day: mockGreenDay, showNet: true, workspace: "live" } };
export const Playground: Story = { args: { day: dayWithTrades, showNet: true, workspace: "live" } };
export const GreenDay: Story = { args: { day: mockGreenDay, showNet: true, workspace: "live" } };
export const RedDay: Story = { args: { day: mockRedDay, showNet: true, workspace: "live" } };
export const GiftDay: Story = { args: { day: mockGiftDay, showNet: true, workspace: "paper_manual" } };
export const JackpotDay: Story = { args: { day: mockJackpotDay, showNet: true, workspace: "live" } };
export const HighlightedDay: Story = { args: { day: mockGreenDay, showNet: true, workspace: "live", highlighted: true } };
export const Gross: Story = { args: { day: mockGreenDay, showNet: false, workspace: "live" } };
export const PaperWorkspace: Story = { args: { day: mockGreenDay, showNet: true, workspace: "paper" } };