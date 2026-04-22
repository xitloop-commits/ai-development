/**
 * TodayPnlBar.stories.tsx
 *
 * Storybook stories for interactive component testing.
 * Test the piecewise scaling and layout behavior with different P&L scenarios.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { TodayPnlBar, DEFAULT_BAR_CONFIG, type BarConfig } from "./TodayPnlBar";

const meta = {
  title: "Components/TodayPnlBar",
  component: TodayPnlBar,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Today's P&L progress bar with adaptive piecewise scaling. " +
          "Tests the risk, target, and gift zones with real-time visualization.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    pnl: {
      control: { type: "number" },
      description: "Today's realized P&L in rupees",
    },
    tradingPool: {
      control: { type: "number" },
      description: "Capital used as divisor for % calculation",
    },
    openTradeCount: {
      control: { type: "number", min: 0, max: 100 },
      description: "Number of currently-open trades",
    },
    exitAllEnabled: {
      control: { type: "boolean" },
      description: "Whether user can exit trades in this workspace",
    },
    config: {
      control: { type: "object" },
      description: "Bar configuration (loss cap, target, gift max, etc.)",
    },
    onExitAll: {
      action: "clicked",
      description: "Callback when Exit All button is clicked",
    },
  },
} satisfies Meta<typeof TodayPnlBar>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Default ──────────────────────────────────────────────────────────────

export const Default: Story = {
  args: {
    pnl: 0,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
};

// ─── P&L Scenarios ────────────────────────────────────────────────────────

export const Zero: Story = {
  args: {
    pnl: 0,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "P&L at zero. Marker should be centered. " +
          "Left-edge labels should be readable and spaced (not jammed). " +
          "This validates the piecewise scaling fix.",
      },
    },
  },
};

export const SmallGain: Story = {
  args: {
    pnl: 1000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Small 1% gain. Green fill should appear on the right. " +
          "Detail ticks (1% increments) should appear around the marker.",
      },
    },
  },
};

export const Target: Story = {
  args: {
    pnl: 5000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "At target (5% gain). Marker should turn GREEN (positive P&L). " +
          "Fill should reach 60% of bar (target zone endpoint). " +
          "CAP anchor should be highlighted.",
      },
    },
  },
};

export const BigGain: Story = {
  args: {
    pnl: 25000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "25% gain. Marker enters gift zone (5% → 50%). " +
          "Milestones (10, 25) should appear. Right edge extends in 25% steps. " +
          "Marker stays cyan (not danger, not near target).",
      },
    },
  },
};

export const ExtremeGain: Story = {
  args: {
    pnl: 100000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "100% gain. Right edge extends significantly. " +
          "Component handles extreme values gracefully.",
      },
    },
  },
};

export const SmallLoss: Story = {
  args: {
    pnl: -1000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "1% loss. Red fill appears on the left side. " +
          "Marker stays cyan (outside danger zone at -1%).",
      },
    },
  },
};

export const AtLossCap: Story = {
  args: {
    pnl: -2000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "At loss cap (-2%). Marker at the edge of danger zone. " +
          "Should still be cyan (danger starts at ≤ -2.3%).",
      },
    },
  },
};

export const BelowLossCap: Story = {
  args: {
    pnl: -3000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Below loss cap (-3%). Marker enters danger zone. " +
          "Marker should turn RED. Loss anchor (LOSS) highlighted.",
      },
    },
  },
};

export const ExtremeLoss: Story = {
  args: {
    pnl: -50000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Extreme loss (-50%). Component should handle gracefully. " +
          "Marker clamped to left edge (below loss cap). Red danger state.",
      },
    },
  },
};

// ─── Trading Pool Variations ──────────────────────────────────────────────

export const SmallPool: Story = {
  args: {
    pnl: 500,
    tradingPool: 10000,
    openTradeCount: 1,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story: "Small trading pool (₹10K). 5% gain at ₹500 P&L. Scale verification.",
      },
    },
  },
};

export const LargePool: Story = {
  args: {
    pnl: 500000,
    tradingPool: 1000000,
    openTradeCount: 5,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story: "Large trading pool (₹1M). 50% gain at ₹500K P&L. Right edge extends.",
      },
    },
  },
};

// ─── Custom Config ────────────────────────────────────────────────────────

export const CustomConfig: Story = {
  args: {
    pnl: 3000,
    tradingPool: 100000,
    openTradeCount: 2,
    exitAllEnabled: true,
    config: {
      lossCap: -5,
      circuitBreaker: -7,
      target: 10,
      giftMax: 100,
      partialExits: [
        { percent: 3, closePct: 50, label: "Half-exit at 3%" },
        { percent: 7, closePct: 100, label: "Full-exit at 7%" },
      ],
    },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Custom config with wider bands (loss cap -5%, target +10%) " +
          "and partial-exit markers at 3% and 7%. " +
          "Partial exits render as amber diamonds on the bar.",
      },
    },
  },
};

export const WithCircuitBreaker: Story = {
  args: {
    pnl: -4000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    config: {
      lossCap: -2,
      circuitBreaker: -3,
      target: 5,
      giftMax: 50,
    },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Custom circuit breaker separate from loss cap. " +
          "At -4%, below both CB (-3%) and loss cap (-2%). " +
          "Should have 4 anchors: CB, LOSS, 0, CAP.",
      },
    },
  },
};

// ─── Exit Button States ───────────────────────────────────────────────────

export const ExitButtonVisible: Story = {
  args: {
    pnl: 2500,
    tradingPool: 100000,
    openTradeCount: 5,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
    onExitAll: () => alert("Exiting all positions!"),
  },
  parameters: {
    docs: {
      description: {
        story:
          "Exit All button visible (5 open trades, exits enabled). " +
          "Button travels with marker at top.",
      },
    },
  },
};

export const ExitButtonHidden: Story = {
  args: {
    pnl: 2500,
    tradingPool: 100000,
    openTradeCount: 0,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story: "Exit All button hidden (no open trades).",
      },
    },
  },
};

export const ExitButtonDisabled: Story = {
  args: {
    pnl: 2500,
    tradingPool: 100000,
    openTradeCount: 5,
    exitAllEnabled: false,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Exit All button hidden (exits disabled in this workspace, " +
          "even though trades are open).",
      },
    },
  },
};

// ─── Special States ───────────────────────────────────────────────────────

export const SessionHalted: Story = {
  args: {
    pnl: 5000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    config: {
      ...DEFAULT_BAR_CONFIG,
      sessionHalted: true,
    },
  },
  parameters: {
    docs: {
      description: {
        story: '"SESSION HALTED" overlay displayed. Component still shows state.',
      },
    },
  },
};

export const ZeroTradingPool: Story = {
  args: {
    pnl: 100,
    tradingPool: 0,
    openTradeCount: 0,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Zero trading pool. Component handles gracefully " +
          "(current % calculated as 0). No crash.",
      },
    },
  },
};

// ─── Interactive Playground ───────────────────────────────────────────────

export const Playground: Story = {
  args: {
    pnl: 0,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Interactive playground. Adjust P&L, trading pool, and config " +
          "using the controls panel on the right. Watch behavior in real-time.",
      },
    },
  },
};
