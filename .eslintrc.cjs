/**
 * G1 — ESLint config (Phase G of IMPLEMENTATION_PLAN_v2).
 *
 * Goals:
 *   - Catch floating promises BEFORE they ship (the most common
 *     silent-error class in this codebase).
 *   - Forbid raw `console.*` in committed code (F6 introduced pino —
 *     `console.warn` / `console.error` are still permitted as escape
 *     hatches; `console.log` warns).
 *   - Surface unused vars and `:any` regressions.
 *
 * Legacy `.eslintrc.cjs` format (ESLint 8). The plan calls for this
 * format explicitly; ESLint 9's flat-config rewrite was deferred
 * because it doesn't support `.eslintrc.cjs` at all.
 */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    project: ["./tsconfig.eslint.json"],
    tsconfigRootDir: __dirname,
    ecmaFeatures: { jsx: true },
  },
  plugins: ["@typescript-eslint", "promise", "react", "react-hooks", "import", "unused-imports"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended",
  ],
  settings: {
    react: { version: "detect" },
  },
  env: {
    node: true,
    browser: true,
    es2022: true,
  },
  rules: {
    // Floating promises — PERF-E2 cleanup landed; rule promoted to
    // error per plan §G1. Every async call site now either awaits,
    // catches, or explicitly marks `void` for fire-and-forget. New
    // unawaited promises will fail CI.
    "@typescript-eslint/no-floating-promises": "error",

    // Style/correctness
    "prefer-const": "error",
    "no-unused-vars": "off", // disabled in favour of the TS-aware variant below
    // PERF-E3 cleanup — auto-fixable unused-imports rule does the
    // import-removal sweep; the unused-vars rule below still warns on
    // genuinely unused locals/args (which `--fix` deliberately won't
    // remove because the side effects are unknowable).
    "unused-imports/no-unused-imports": "error",
    "@typescript-eslint/no-unused-vars": ["error", {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    }],

    // F6 made pino the structured logger. console.log in source code is
    // a regression; console.warn / console.error are kept as escape
    // hatches for code paths that genuinely cannot import the logger
    // (e.g. the logger module itself, or top-level fatalHandlers fallback).
    "no-console": ["warn", { allow: ["warn", "error"] }],

    // Tracked separately under PERF-E1 (~128 existing `:any` cases get
    // disable-line + TODO comments, not all-fixed in this PR).
    "@typescript-eslint/no-explicit-any": "warn",

    // React hooks — exhaustive-deps as a warn so we get the visibility
    // without making it a merge-blocker.
    "react-hooks/exhaustive-deps": "warn",

    // Promise plugin — duplicate-of no-floating-promises but covers
    // patterns the TS rule misses (e.g. async forEach).
    "promise/always-return": "off",      // too strict for this codebase
    "promise/no-nesting": "warn",
    "promise/no-promise-in-callback": "warn",

    // We use `react/jsx-uses-react` from the plugin's recommended set;
    // explicitly disable `react/react-in-jsx-scope` since Vite + new
    // JSX transform doesn't need it.
    "react/react-in-jsx-scope": "off",
    "react/prop-types": "off", // TypeScript handles this

    // Cosmetic: rules-of-hooks would flag `Don't` literal as needing
    // `&apos;`. Doesn't affect rendering — JSX text auto-escapes.
    "react/no-unescaped-entities": "off",
  },
  overrides: [
    // Test files have looser rules — easier mocking and `any` casts.
    {
      files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/__tests__/**"],
      rules: {
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unused-vars": "off",
        "@typescript-eslint/no-floating-promises": "off",
        "no-console": "off",
        // vi.hoisted() runs before imports — `require()` is the only way
        // to bring `node:events` etc. into scope inside the factory.
        "@typescript-eslint/no-var-requires": "off",
      },
    },
    // Storybook stories — same deal.
    {
      files: ["**/*.stories.tsx", "**/*.stories.ts"],
      rules: {
        "no-console": "off",
        "@typescript-eslint/no-explicit-any": "off",
      },
    },
    // Logger module is allowed to use console.* internally — that's
    // the whole point. Same for fatalHandlers (uses console.error as a
    // last-resort escape valve before exit).
    {
      files: ["server/broker/logger.ts", "server/_core/fatalHandlers.ts"],
      rules: {
        "no-console": "off",
      },
    },
    // Vite client config + boot scripts are CommonJS-shaped or top-
    // level — relax a few rules.
    {
      files: ["*.config.{ts,cjs,mjs}", "scripts/**"],
      rules: {
        "@typescript-eslint/no-floating-promises": "off",
        "no-console": "off",
      },
    },
  ],
  ignorePatterns: [
    "dist/",
    "node_modules/",
    "coverage/",
    ".pnpm-store/",
    "client/src/components/ui/**",  // shadcn/ui generated components
    "tfa_bot/",                     // python only
    "python_modules/",              // python only
    "models/",                      // model artefacts
    "data/",                        // parquet files
    "logs/",
    "**/*.d.ts",
  ],
};
