import type { Meta, StoryObj } from "@storybook/react";
import { StatusBadge } from "./StatusBadge";

const meta = {
  title: "Components/StatusBadge",
  component: StatusBadge,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component: "Status pill shown in the TradingDesk trade row (OPEN/PENDING/CLOSED_TP/CLOSED_SL/…).",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    status: {
      control: { type: "select" },
      options: ["OPEN", "PENDING", "CLOSED_TP", "CLOSED_SL", "CLOSED_PARTIAL", "CANCELLED", "REJECTED", "UNKNOWN"],
    },
  },
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { status: "OPEN" } };
export const Playground: Story = { args: { status: "OPEN" } };

export const Open: Story = { args: { status: "OPEN" } };
export const Pending: Story = { args: { status: "PENDING" } };
export const ClosedTP: Story = { args: { status: "CLOSED_TP" } };
export const ClosedSL: Story = { args: { status: "CLOSED_SL" } };
export const ClosedPartial: Story = { args: { status: "CLOSED_PARTIAL" } };
export const Cancelled: Story = { args: { status: "CANCELLED" } };
export const Rejected: Story = { args: { status: "REJECTED" } };
