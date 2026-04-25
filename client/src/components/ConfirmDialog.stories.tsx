import type { Meta, StoryObj } from "@storybook/react";
import { ConfirmDialog } from "./ConfirmDialog";

const meta = {
  title: "Components/ConfirmDialog",
  component: ConfirmDialog,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "Full-screen confirm/cancel modal used by TradingDesk before destructive trade actions.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    open: { control: "boolean" },
    title: { control: "text" },
    message: { control: "text" },
  },
  args: {
    onConfirm: () => console.log("confirm clicked"),
    onCancel: () => console.log("cancel clicked"),
  },
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    open: true,
    title: "Exit Trade",
    message: "Are you sure you want to exit this position?",
  },
};

export const Playground: Story = {
  args: {
    open: true,
    title: "Confirm action",
    message: "This cannot be undone.",
  },
};

export const Closed: Story = {
  args: {
    open: false,
    title: "Exit Trade",
    message: "Are you sure you want to exit this position?",
  },
};

export const LongMessage: Story = {
  args: {
    open: true,
    title: "Exit All Open Trades",
    message:
      "You are about to exit 7 open trades across NIFTY 50, BANK NIFTY and CRUDE OIL. Realized P&L will be booked at current LTP. This cannot be undone.",
  },
};

export const ClearWorkspace: Story = {
  args: {
    open: true,
    title: "Clear Testing Workspace",
    message: "This will remove all paper trades and reset the compounding timeline. Continue?",
  },
};
