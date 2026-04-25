import type { Meta, StoryObj } from "@storybook/react";
import { InstrumentTag } from "./InstrumentTag";

const meta = {
  title: "Components/InstrumentTag",
  component: InstrumentTag,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component: "Color-coded tag chip used in TradingDesk rows to identify the underlying instrument.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    name: {
      control: { type: "select" },
      options: ["NIFTY 50", "BANK NIFTY", "CRUDE OIL", "NATURAL GAS", "UNKNOWN"],
    },
  },
} satisfies Meta<typeof InstrumentTag>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { name: "NIFTY 50" } };
export const Playground: Story = { args: { name: "NIFTY 50" } };

export const Nifty: Story = { args: { name: "NIFTY 50" } };
export const BankNifty: Story = { args: { name: "BANK NIFTY" } };
export const CrudeOil: Story = { args: { name: "CRUDE OIL" } };
export const NaturalGas: Story = { args: { name: "NATURAL GAS" } };
export const Unknown: Story = { args: { name: "XYZ" } };
