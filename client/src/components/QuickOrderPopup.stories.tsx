/**
 * QuickOrderPopup.stories.tsx
 *
 * Compact horizontal popup for placing quick orders via hotkeys.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { QuickOrderPopup } from "./QuickOrderPopup";

const meta = {
  title: "Components/QuickOrderPopup",
  component: QuickOrderPopup,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Quick order entry popup triggered by hotkeys (1, 2, 3...). " +
          "Compact horizontal interface for placing call/put options in single row. " +
          "Auto-fills ATM strike, LTP, SL/Target from live data.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    isOpen: {
      control: { type: "boolean" },
      description: "Whether popup is visible",
    },
    instrumentKey: {
      control: { type: "text" },
      description: "Instrument identifier (NIFTY_50, BANKNIFTY, etc.)",
    },
    instrumentName: {
      control: { type: "text" },
      description: "Display name for instrument",
    },
    isLoading: {
      control: { type: "boolean" },
      description: "Loading state during order submission",
    },
    onClose: {
      action: "closed",
      description: "Callback when popup closes",
    },
    onSubmit: {
      action: "submitted",
      description: "Callback when order is submitted",
    },
  },
} satisfies Meta<typeof QuickOrderPopup>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Default & Playground ────────────────────────────────────────────

export const Default: Story = {
  args: {
    isOpen: true,
    instrumentKey: "NIFTY_50",
    instrumentName: "NIFTY 50",
    resolvedInstruments: [
      {
        name: "NIFTY_50",
        securityId: "NSE_EQ|NIFTY50",
        exchange: "NSE",
      },
    ],
    isLoading: false,
  },
};

export const Playground: Story = {
  args: {
    isOpen: true,
    instrumentKey: "NIFTY_50",
    instrumentName: "NIFTY 50",
    resolvedInstruments: [
      {
        name: "NIFTY_50",
        securityId: "NSE_EQ|NIFTY50",
        exchange: "NSE",
      },
    ],
    isLoading: false,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Interactive playground. Toggle isOpen to see popup open/close. " +
          "Adjust instrument to see different underlyings. " +
          "Check console for onSubmit and onClose events.",
      },
    },
  },
};

// ─── Instrument Types ────────────────────────────────────────────────

export const Nifty50: Story = {
  args: {
    isOpen: true,
    instrumentKey: "NIFTY_50",
    instrumentName: "NIFTY 50",
    resolvedInstruments: [
      {
        name: "NIFTY_50",
        securityId: "NSE_EQ|NIFTY50",
        exchange: "NSE",
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story: "Quick order for NIFTY 50 options.",
      },
    },
  },
};

export const BankNifty: Story = {
  args: {
    isOpen: true,
    instrumentKey: "BANKNIFTY",
    instrumentName: "BANKNIFTY",
    resolvedInstruments: [
      {
        name: "BANKNIFTY",
        securityId: "NSE_EQ|BANKNIFTY",
        exchange: "NSE",
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story: "Quick order for BANKNIFTY options.",
      },
    },
  },
};

export const CrudeOil: Story = {
  args: {
    isOpen: true,
    instrumentKey: "CRUDEOIL",
    instrumentName: "CRUDE OIL",
    resolvedInstruments: [
      {
        name: "CRUDEOIL",
        securityId: "MCX|CRUDEOIL",
        exchange: "MCX",
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story: "Quick order for CRUDE OIL options.",
      },
    },
  },
};

export const NaturalGas: Story = {
  args: {
    isOpen: true,
    instrumentKey: "NATURALGAS",
    instrumentName: "NATURAL GAS",
    resolvedInstruments: [
      {
        name: "NATURALGAS",
        securityId: "MCX|NATURALGAS",
        exchange: "MCX",
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story: "Quick order for NATURAL GAS options.",
      },
    },
  },
};

// ─── States ───────────────────────────────────────────────────────────

export const Closed: Story = {
  args: {
    isOpen: false,
    instrumentKey: "NIFTY_50",
    instrumentName: "NIFTY 50",
  },
  parameters: {
    docs: {
      description: {
        story: "Popup closed state (not visible).",
      },
    },
  },
};

export const Loading: Story = {
  args: {
    isOpen: true,
    instrumentKey: "NIFTY_50",
    instrumentName: "NIFTY 50",
    isLoading: true,
  },
  parameters: {
    docs: {
      description: {
        story: "Loading state during order submission.",
      },
    },
  },
};

// ─── Error/Edge Cases ─────────────────────────────────────────────────

export const NoResolvedInstruments: Story = {
  args: {
    isOpen: true,
    instrumentKey: "NIFTY_50",
    instrumentName: "NIFTY 50",
    resolvedInstruments: undefined,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Without resolved instruments data. Useful for testing fallback behavior " +
          "when instrument resolution data is not available.",
      },
    },
  },
};

export const LongInstrumentName: Story = {
  args: {
    isOpen: true,
    instrumentKey: "NIFTY_50",
    instrumentName: "NIFTY 50 INDEX OPTIONS AUGUST 2026",
    resolvedInstruments: [
      {
        name: "NIFTY_50",
        securityId: "NSE_EQ|NIFTY50",
        exchange: "NSE",
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story: "With longer instrument name to test UI layout.",
      },
    },
  },
};
