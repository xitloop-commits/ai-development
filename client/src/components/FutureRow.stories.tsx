import type { Meta, StoryObj } from "@storybook/react";
import { FutureRow } from "./FutureRow";
import { makeDay, mockFutureDay } from "@/mockups/tradeFixtures";

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
  title: "Components/FutureRow",
  component: FutureRow,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Dimmed projected-day row rendered for future days in the compounding table. Memoized on projection values only.",
      },
    },
  },
  tags: ["autodocs"],
  decorators: [(Story: any) => <TableWrap><Story /></TableWrap>],
} satisfies Meta<typeof FutureRow>;

export default meta;
type Story = StoryObj<typeof meta>;

const day250 = makeDay({ dayIndex: 250, status: "FUTURE", rating: "finish", tradeCapital: 2475000, targetAmount: 123750, projCapital: 2598750 });

export const Default: Story = { args: { day: mockFutureDay, isDay250: false, channel: "my-live" } };
export const Playground: Story = { args: { day: mockFutureDay, isDay250: false, channel: "my-live" } };
export const Day250: Story = { args: { day: day250, isDay250: true, channel: "my-live" } };
export const Highlighted: Story = { args: { day: mockFutureDay, isDay250: false, channel: "my-live", highlighted: true } };
export const PaperWorkspace: Story = { args: { day: mockFutureDay, isDay250: false, channel: "ai-paper" } };