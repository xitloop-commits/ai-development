/**
 * G5 — DisciplineOverlay (substituted for the plan's
 * `SettingsOverlay/DisciplineSection.test.tsx`, which would target a
 * file that doesn't exist).
 *
 * Coverage targets the two pure presentational helpers exported from
 * `DisciplineOverlay.tsx` — they encode the user-visible discipline
 * status semantics:
 *
 *   - `ScoreGauge` — colour + label for "Excellent" (≥80) / "Needs Work"
 *     (60–79) / "Critical" (<60). These thresholds are what the operator
 *     sees on the live dashboard; off-by-one mistakes here are silent.
 *   - `ViolationsList` — empty-state celebrates "No violations today";
 *     populated state shows hard vs soft severity icons + "(overridden)"
 *     suffix when the trade was force-pushed.
 *
 * Out of scope (would need a tRPC mock harness): the full overlay
 * round-trip with `getDashboard.useQuery`. Adding a `@/lib/trpc` mock
 * is left for a follow-up so the same harness can serve TradingDesk +
 * SettingsOverlay tests later.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScoreGauge, ViolationsList } from "./DisciplineOverlay";

describe("ScoreGauge — discipline-score thresholds", () => {
  it('renders "Excellent" label for score >= 80', () => {
    render(<ScoreGauge score={85} />);
    expect(screen.getByText("Excellent")).toBeInTheDocument();
  });

  it('renders "Excellent" exactly at the 80 threshold (locked boundary)', () => {
    render(<ScoreGauge score={80} />);
    expect(screen.getByText("Excellent")).toBeInTheDocument();
  });

  it('renders "Needs Work" label for 60 <= score < 80', () => {
    render(<ScoreGauge score={70} />);
    expect(screen.getByText("Needs Work")).toBeInTheDocument();
  });

  it('renders "Needs Work" exactly at the 60 threshold', () => {
    render(<ScoreGauge score={60} />);
    expect(screen.getByText("Needs Work")).toBeInTheDocument();
  });

  it('renders "Critical" for score < 60', () => {
    render(<ScoreGauge score={45} />);
    expect(screen.getByText("Critical")).toBeInTheDocument();
  });

  it("renders the numeric score in the SVG body", () => {
    const { container } = render(<ScoreGauge score={73} />);
    expect(container.textContent).toContain("73");
  });

  it("uses the green stroke colour at 'Excellent' threshold", () => {
    const { container } = render(<ScoreGauge score={90} />);
    const colored = container.querySelectorAll('circle[stroke^="#"]');
    // Two circles: a static dark-grey track + the foreground stroke.
    // The foreground is the 2nd circle and reflects the threshold colour.
    const fg = colored[1] as SVGCircleElement;
    expect(fg.getAttribute("stroke")).toBe("#00FF87");
  });

  it("uses the amber stroke colour for 'Needs Work'", () => {
    const { container } = render(<ScoreGauge score={70} />);
    const fg = container.querySelectorAll('circle[stroke^="#"]')[1] as SVGCircleElement;
    expect(fg.getAttribute("stroke")).toBe("#FFB800");
  });

  it("uses the red stroke colour for 'Critical'", () => {
    const { container } = render(<ScoreGauge score={40} />);
    const fg = container.querySelectorAll('circle[stroke^="#"]')[1] as SVGCircleElement;
    expect(fg.getAttribute("stroke")).toBe("#FF3B5C");
  });
});

describe("ViolationsList — daily violation rendering", () => {
  it("celebrates an empty day with the 'excellent discipline' line", () => {
    render(<ViolationsList violations={[]} />);
    expect(screen.getByText(/No violations today/i)).toBeInTheDocument();
    expect(screen.getByText(/excellent discipline/i)).toBeInTheDocument();
  });

  it("renders each populated violation's description", () => {
    const violations = [
      {
        ruleId: "circuitBreaker",
        ruleName: "Circuit Breaker",
        severity: "hard" as const,
        description: "Daily loss exceeded -2.5% threshold",
        timestamp: new Date("2026-04-01T10:30:00Z"),
        overridden: false,
      },
      {
        ruleId: "cooldown",
        ruleName: "Cooldown",
        severity: "soft" as const,
        description: "Cooldown active — 3m remaining",
        timestamp: new Date("2026-04-01T10:35:00Z"),
        overridden: false,
      },
    ];
    render(<ViolationsList violations={violations as any} />);

    expect(screen.getByText(/Daily loss exceeded/)).toBeInTheDocument();
    expect(screen.getByText(/Cooldown active/)).toBeInTheDocument();
  });

  it('appends "(overridden)" suffix when the trade was force-pushed past the rule', () => {
    const violations = [
      {
        ruleId: "tradeLimits",
        ruleName: "Trade Limits",
        severity: "hard" as const,
        description: "Max trades exceeded",
        timestamp: new Date(),
        overridden: true,
      },
    ];
    render(<ViolationsList violations={violations as any} />);
    expect(screen.getByText(/\(overridden\)/i)).toBeInTheDocument();
  });

  it("does not show the override suffix for non-overridden violations", () => {
    const violations = [
      {
        ruleId: "tradeLimits",
        ruleName: "Trade Limits",
        severity: "hard" as const,
        description: "Max trades exceeded",
        timestamp: new Date(),
        overridden: false,
      },
    ];
    render(<ViolationsList violations={violations as any} />);
    expect(screen.queryByText(/\(overridden\)/i)).not.toBeInTheDocument();
  });
});
