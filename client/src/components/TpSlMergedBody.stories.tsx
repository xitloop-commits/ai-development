import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { TpSlMergedBody, type TpSlMergedBodyProps } from "./TpSlMergedBody";

function Harness(initial: Partial<TpSlMergedBodyProps>) {
  const [slPrice, setSlPrice] = useState(initial.slPrice ?? "");
  const [tpPrice, setTpPrice] = useState(initial.tpPrice ?? "");
  return (
    <div className="w-56 p-3 rounded border border-border bg-card">
      <TpSlMergedBody
        isBuy={initial.isBuy ?? true}
        entryPrice={initial.entryPrice ?? 100}
        slPrice={slPrice}
        setSlPrice={setSlPrice}
        tpPrice={tpPrice}
        setTpPrice={setTpPrice}
        trailingStopEnabled={initial.trailingStopEnabled ?? false}
        trailingStopPrice={initial.trailingStopPrice ?? null}
        onCommit={() => console.log("commit", { slPrice, tpPrice })}
        onCancel={() => console.log("cancel")}
      />
    </div>
  );
}

const meta = {
  title: "Components/TpSlMergedBody",
  component: Harness,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "TP/SL edit popover body used inside TodayTradeRow. Shows SL/TP price inputs with % deltas and a read-only trailing-stop status (ON + live trail price, or OFF). Trailing is enabled globally in Settings.",
      },
    },
  },
  tags: ["autodocs"],
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { isBuy: true, entryPrice: 100 } };
export const Playground: Story = { args: { isBuy: true, entryPrice: 100, slPrice: "95", tpPrice: "110" } };

export const BuyTrade: Story = {
  args: { isBuy: true, entryPrice: 100, slPrice: "95", tpPrice: "110" },
};

export const SellTrade: Story = {
  args: { isBuy: false, entryPrice: 100, slPrice: "105", tpPrice: "90" },
};

export const TrailingEnabled: Story = {
  args: { isBuy: true, entryPrice: 100, slPrice: "95", tpPrice: "110", trailingStopEnabled: true, trailingStopPrice: 98.5 },
};

export const EmptyEdit: Story = {
  args: { isBuy: true, entryPrice: 100, slPrice: "", tpPrice: "" },
};

export const TightStops: Story = {
  args: { isBuy: true, entryPrice: 587, slPrice: "585", tpPrice: "591" },
};
