import type { Meta, StoryObj } from "@storybook/react";
import { StatusBadge } from "./StatusBadge";

const meta = {
  title: "Components/StatusBadge",
  component: StatusBadge,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Status pill shown in the TradingDesk trade row. Closed trades use `exitReason` to pick the icon/color (TP_HIT → green ✓ TP, SL_HIT → red ✗ SL, anything else → neutral CLOSED).",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    status: {
      control: { type: "select" },
      options: ["OPEN", "PENDING", "CLOSED", "CANCELLED", "REJECTED", "BROKER_DESYNC"],
    },
    exitReason: {
      control: { type: "select" },
      options: [
        undefined,
        "TP_HIT",
        "SL_HIT",
        "MOMENTUM_EXIT",
        "VOLATILITY_EXIT",
        "AGE_EXIT",
        "STALE_PRICE_EXIT",
        "DISCIPLINE_EXIT",
        "AI_EXIT",
        "MANUAL",
        "EOD",
        "EXPIRY",
      ],
    },
  },
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { status: "OPEN" } };
export const Playground: Story = { args: { status: "OPEN" } };

export const Open: Story = { args: { status: "OPEN" } };
export const Pending: Story = { args: { status: "PENDING" } };
export const ClosedTP: Story = { args: { status: "CLOSED", exitReason: "TP_HIT" } };
export const ClosedSL: Story = { args: { status: "CLOSED", exitReason: "SL_HIT" } };
export const ClosedManual: Story = { args: { status: "CLOSED", exitReason: "MANUAL" } };
export const ClosedMomentum: Story = { args: { status: "CLOSED", exitReason: "MOMENTUM_EXIT" } };
export const Cancelled: Story = { args: { status: "CANCELLED" } };
export const Rejected: Story = { args: { status: "REJECTED" } };
export const Desync: Story = { args: { status: "BROKER_DESYNC" } };
