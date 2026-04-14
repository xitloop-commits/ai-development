/**
 * sync-memory.mjs
 *
 * Syncs docs/memory/ (git-tracked) ↔ Claude's local memory path.
 *
 * Usage:
 *   node scripts/sync-memory.mjs pull   # repo → Claude (run after git pull on new machine)
 *   node scripts/sync-memory.mjs push   # Claude → repo (run before git commit after Claude session)
 */

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const REPO_MEMORY = path.join(REPO_ROOT, "docs", "memory");

// Derive the Claude memory path from the repo root — same algorithm Claude uses.
// Claude replaces path separators with "-" and prefixes with "c-" on Windows.
function claudeMemoryPath() {
  const repoAbs = REPO_ROOT.replace(/\\/g, "/"); // normalize
  // e.g. C:/Users/Admin/ai-development/ai-development
  // → c--Users-Admin-ai-development-ai-development
  const slug = repoAbs
    .replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase() + "-") // "C:" → "c-"
    .replace(/\//g, "-");                                       // slashes → dashes
  return path.join(os.homedir(), ".claude", "projects", slug, "memory");
}

const CLAUDE_MEMORY = claudeMemoryPath();
const direction = process.argv[2];

if (!["pull", "push"].includes(direction)) {
  console.error("Usage: node scripts/sync-memory.mjs pull|push");
  process.exit(1);
}

const [src, dst] =
  direction === "pull"
    ? [REPO_MEMORY, CLAUDE_MEMORY]
    : [CLAUDE_MEMORY, REPO_MEMORY];

console.log(`\n${direction.toUpperCase()}: ${src} → ${dst}\n`);

fs.mkdirSync(dst, { recursive: true });

const files = fs.readdirSync(src).filter((f) => f.endsWith(".md"));
for (const file of files) {
  fs.copyFileSync(path.join(src, file), path.join(dst, file));
  console.log(`  copied ${file}`);
}

console.log(`\nDone. ${files.length} file(s) synced.\n`);
