import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

// Node 18 compat: import.meta.dirname only exists in Node ≥ 21.2
const __dirname = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const templateRoot = path.resolve(__dirname);

export default defineConfig({
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
    include: ["server/**/*.test.ts", "server/**/*.spec.ts"],
    fileParallelism: false,
    testTimeout: 15000,
  },
});
