import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

// Node 18 compat: import.meta.dirname only exists in Node ≥ 21.2
const __dirname = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const templateRoot = path.resolve(__dirname);

export default defineConfig(({ mode }) => {
  // Load .env (and .env.test if present) into process.env so tests
  // that read MONGODB_URI / INTERNAL_API_SECRET / etc. behave like the
  // server boot path (which uses `dotenv/config`). loadEnv only returns
  // VITE_-prefixed vars by default; passing "" as the prefix grabs all.
  const env = loadEnv(mode, templateRoot, "");
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }

  return {
    root: templateRoot,
    // G5 — react plugin wires the new JSX transform so test files don't
    // need `import React from 'react'`. Same plugin the main vite.config
    // uses; pulling it in here keeps test JSX behaviour identical to dev.
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(templateRoot, "client", "src"),
        "@shared": path.resolve(templateRoot, "shared"),
        "@assets": path.resolve(templateRoot, "attached_assets"),
      },
    },
    test: {
      // Default to node — server tests + pure-logic client tests run here.
      environment: "node",
      include: [
        "server/**/*.test.ts",
        "server/**/*.spec.ts",
        "client/src/**/*.test.ts",
        // G5 — DOM-rendering client tests. The matching glob in
        // `environmentMatchGlobs` below switches them to jsdom; node
        // env is the wrong shape for React rendering.
        "client/src/**/*.test.tsx",
      ],
      // G5 — per-file environment selection. Node for server, jsdom
      // for any .test.tsx (which by convention contain JSX render
      // calls). Vitest 2.x supports this without splitting configs.
      environmentMatchGlobs: [
        ["client/src/**/*.test.tsx", "jsdom"],
      ],
      // G3 — every Mongo-touching test runs against a per-file in-memory
      // server (see setup.mongo.ts). Removes the shared-state hazard
      // that forced fileParallelism: false. Total wall-clock now scales
      // with worker count instead of being serial.
      // G5 — `client.setup.ts` registers @testing-library/jest-dom
      // matchers. Loads in every test file but only takes effect when
      // jsdom is active (no-op on the node-env tests).
      setupFiles: [
        "./server/__tests__/setup.mongo.ts",
        "./client/src/__tests__/setup.client.ts",
      ],
      fileParallelism: true,
      // First run downloads the Mongo binary (~80MB). Bump default
      // 15s timeout so the very first test file in a fresh checkout
      // doesn't fail at the MongoMemoryServer.create() step.
      testTimeout: 30000,
      hookTimeout: 60000,
      // G5 — coverage via @vitest/coverage-v8. `pnpm test --coverage`
      // produces a text summary on stdout + lcov for CI tooling.
      coverage: {
        provider: "v8",
        reporter: ["text", "lcov"],
        include: ["client/src/**", "server/**"],
        exclude: [
          "**/*.test.{ts,tsx}",
          "**/*.spec.{ts,tsx}",
          "**/__tests__/**",
          "**/*.stories.{ts,tsx}",
          "client/src/components/ui/**", // shadcn/ui generated
          "**/*.d.ts",
        ],
      },
    },
  };
});
