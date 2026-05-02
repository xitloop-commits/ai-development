/**
 * G5 — vitest client-side setup.
 *
 * Runs once per test file in jsdom-environment tests:
 * - Registers `@testing-library/jest-dom` matchers (`toBeInTheDocument`,
 *   `toHaveClass`, etc.) so they're available on `expect()` everywhere.
 * - Cleans up DOM between tests via React Testing Library's `cleanup()`.
 *
 * No-op for node-env tests since none of the imports execute side
 * effects on bare load (the matcher registration only runs when called).
 */
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
