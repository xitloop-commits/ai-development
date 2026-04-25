import type { Meta, StoryObj } from "@storybook/react";
import { RatingIcon } from "./RatingIcon";

const meta = {
  title: "Components/RatingIcon",
  component: RatingIcon,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component: "Emoji rating icon for a TradingDesk day row (👑🏆💰👍⭐🎁🏁).",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    rating: {
      control: { type: "select" },
      options: ["jackpot", "crown", "double_trophy", "trophy", "star", "gift", "finish", "future"],
    },
  },
} satisfies Meta<typeof RatingIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { rating: "star" } };
export const Playground: Story = { args: { rating: "trophy" } };

export const Jackpot: Story = { args: { rating: "jackpot" } };
export const Crown: Story = { args: { rating: "crown" } };
export const DoubleTrophy: Story = { args: { rating: "double_trophy" } };
export const Trophy: Story = { args: { rating: "trophy" } };
export const Star: Story = { args: { rating: "star" } };
export const Gift: Story = { args: { rating: "gift" } };
export const Finish: Story = { args: { rating: "finish" } };
export const Future: Story = { args: { rating: "future" } };
