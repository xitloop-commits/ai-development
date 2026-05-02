import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
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
    resolve: {
      alias: {
        "@": path.resolve(templateRoot, "client", "src"),
        "@shared": path.resolve(templateRoot, "shared"),
        "@assets": path.resolve(templateRoot, "attached_assets"),
      },
    },
    test: {
      environment: "node",
      include: [
        "server/**/*.test.ts",
        "server/**/*.spec.ts",
        // Client-side tests are allowed only for pure logic (helpers,
        // memo equality fns, etc.) — DOM-rendering tests need jsdom and
        // @testing-library/react which are not installed.
        "client/src/**/*.test.ts",
      ],
      // G3 — every Mongo-touching test runs against a per-file in-memory
      // server (see setup.mongo.ts). Removes the shared-state hazard
      // that forced fileParallelism: false. Total wall-clock now scales
      // with worker count instead of being serial.
      setupFiles: ["./server/__tests__/setup.mongo.ts"],
      fileParallelism: true,
      // First run downloads the Mongo binary (~80MB). Bump default
      // 15s timeout so the very first test file in a fresh checkout
      // doesn't fail at the MongoMemoryServer.create() step.
      testTimeout: 30000,
      hookTimeout: 60000,
    },
  };
});
