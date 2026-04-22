/**
 * TodayPnlBar v3.stories.tsx
 *
 * Rolling window marker system with fixed marker range and symmetric buffering.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { TodayPnlBar, DEFAULT_BAR_CONFIG, type BarConfig } from "./TodayPnlBar.v3";

const meta = {
  title: "Components/TodayPnlBar v3 (Fixed Range Rolling Window)",
  component: TodayPnlBar,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Rolling window marker system with zone-based increments. " +
          "Shows configurable number of markers (default 15) that auto-position around current P&L.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    pnl: {
      control: { type: "number", step: 500 },
      description: "Today's realized P&L in rupees",
    },
    tradingPool: {
      control: { type: "number" },
      description: "Capital used as divisor for % calculation",
    },
    visibleMarkers: {
      control: { type: "number", min: 5, max: 30, step: 1 },
      description: "Number of markers visible in rolling window (default 15)",
    },
    openTradeCount: {
      control: { type: "number", min: 0, max: 100 },
      description: "Number of currently-open trades",
    },
    exitAllEnabled: {
      control: { type: "boolean" },
      description: "Whether user can exit trades",
    },
    config: {
      control: { type: "object" },
      description: "Bar configuration",
    },
  },
} satisfies Meta<typeof TodayPnlBar>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Default & Playground ────────────────────────────────────────────

export const Default: Story = {
  args: {
    pnl: 0,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    visibleMarkers: 15,
    config: DEFAULT_BAR_CONFIG,
  },
};

export const Playground: Story = {
  args: {
    pnl: 0,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    visibleMarkers: 15,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Interactive playground. Adjust P&L, trading pool, and visibleMarkers using controls. " +
          "Watch the rolling window auto-position around current P&L.",
      },
    },
  },
};

// ─── Zone Testing ────────────────────────────────────────────────────

export const LossZone: Story = {
  args: {
    pnl: -1000,
    tradingPool: 100000,
    openTradeCount: 2,
    exitAllEnabled: true,
    visibleMarkers: 15,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Loss zone (-2% to +5%). Markers at 1% increments. " +
          "Red marker and fill (negative P&L).",
      },
    },
  },
};

export const TargetZone: Story = {
  args: {
    pnl: 5000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    visibleMarkers: 15,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "At target (+5%). Green marker (positive P&L). " +
          "Rolling window shows markers from loss zone through gift zones.",
      },
    },
  },
};

export const GiftG1Zone: Story = {
  args: {
    pnl: 8000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    visibleMarkers: 15,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Gift zone G1 (+5% to +10%). Markers at 2% increments. " +
          "Green marker. Window centered around 8%.",
      },
    },
  },
};

export const GiftG2Zone: Story = {
  args: {
    pnl: 18000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    visibleMarkers: 15,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Gift zone G2 (+10% to +25%). Markers at 3% increments. " +
          "Green marker. Window auto-positioned.",
      },
    },
  },
};

export const GiftG3Zone: Story = {
  args: {
    pnl: 35000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    visibleMarkers: 15,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Gift zone G3 (+25% to +50%). Markers at 4% increments. " +
          "Green marker. King zone starts to appear.",
      },
    },
  },
};

export const KingZone: Story = {
  args: {
    pnl: 60000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    visibleMarkers: 15,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "King zone (+50% onwards). Markers at 5% increments. " +
          "King max = current P&L + 20% = 80%. " +
          "Window shows 15 markers centered around current position.",
      },
    },
  },
};

// ─── Visible Markers Count ───────────────────────────────────────────

export const FewMarkers: Story = {
  args: {
    pnl: 15000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    visibleMarkers: 8,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Only 8 markers visible. Tighter rolling window. " +
          "Use for smaller screens or focused view.",
      },
    },
  },
};

export const ManyMarkers: Story = {
  args: {
    pnl: 15000,
    tradingPool: 100000,
    openTradeCount: 3,
    exitAllEnabled: true,
    visibleMarkers: 25,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "25 markers visible. Wider rolling window. " +
          "Use for larger screens to see more context.",
      },
    },
  },
};

// ─── Edge Cases ───────────────────────────────────────────────────────

export const ZeroPnL: Story = {
  args: {
    pnl: 0,
    tradingPool: 100000,
    openTradeCount: 0,
    exitAllEnabled: true,
    visibleMarkers: 15,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "At zero P&L. Marker is gray (neutral). " +
          "Window centered on zero with markers from loss zone through gift zones.",
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
    visibleMarkers: 15,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "100% gain. King max = 120%. " +
          "Window extends to show high P&L levels with 5% increments.",
      },
    },
  },
};

export const ExtremeLoss: Story = {
  args: {
    pnl: -3000,
    tradingPool: 100000,
    openTradeCount: 2,
    exitAllEnabled: true,
    visibleMarkers: 15,
    config: DEFAULT_BAR_CONFIG,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Below loss cap (-3%). Red marker. " +
          "Window shows loss zone markers at 1% increments.",
      },
    },
  },
};

// ─── Custom Config ───────────────────────────────────────────────────

export const CustomConfig: Story = {
  args: {
    pnl: 3000,
    tradingPool: 100000,
    openTradeCount: 2,
    exitAllEnabled: true,
    visibleMarkers: 15,
    config: {
      lossCap: -5,
      target: 10,
      giftMax: 100,
      circuitBreaker: -8,
    },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Custom config with wider loss cap (-5%) and higher target (+10%). " +
          "Rolling window adapts to show appropriate marker zones.",
      },
    },
  },
};
