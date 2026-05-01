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
      fileParallelism: false,
      testTimeout: 15000,
    },
  };
});
