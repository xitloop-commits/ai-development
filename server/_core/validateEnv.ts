/**
 * Boot-time environment summary.
 *
 * Reads `process.env`, classifies each known var (required / optional /
 * feature-gated), and logs a single block at boot so misconfig is loud
 * rather than silent. Never fatal — the server tolerates anything (dev
 * mode is graceful), but operators see exactly which features are
 * disabled by missing config.
 *
 * Format:
 *   [BOOT:Env] Environment configuration:
 *     ✓ MONGODB_URI               mongodb://localhost:27017/lucky_baskar
 *     ✓ INTERNAL_API_SECRET       (set, length=64)
 *     ⚠ TELEGRAM_BOT_TOKEN        (missing — desync alerts will be silent)
 *     ⚠ DHAN_CLIENT_ID            (missing — token-refresh job disabled)
 */
import { createLogger } from "../broker/logger";

const log = createLogger("BOOT", "Env");

interface EnvSpec {
  name: string;
  /**
   * What happens when this var is missing or empty:
   *   - "fatal":  server can't function (logged as ✗ — but we still don't
   *               throw; the connect-time error is more actionable than
   *               a boot-time abort).
   *   - "warn":   degraded behaviour — log the consequence (⚠).
   *   - "ok":     informational — value or "default" shown (✓).
   */
  ifMissing: "fatal" | "warn" | "ok";
  /** Operator-facing one-liner explaining what missing means. */
  consequence?: string;
  /** When true, mask the value in output (only show length / prefix). */
  secret?: boolean;
}

const ENV_REGISTRY: EnvSpec[] = [
  // ─── Server core ─────────────────────────────────────────────
  { name: "NODE_ENV", ifMissing: "ok" },
  { name: "PORT", ifMissing: "ok" },
  { name: "HTTP_HOST", ifMissing: "ok" },

  // ─── Database (required) ─────────────────────────────────────
  {
    name: "MONGODB_URI",
    ifMissing: "fatal",
    consequence: "MongoDB layer disabled — every Mongo-backed read/write will fail. Set it in .env.",
  },

  // ─── B1 internal-API auth ────────────────────────────────────
  {
    name: "INTERNAL_API_SECRET",
    ifMissing: "warn",
    consequence: "auth middleware in warn-only mode; /api/* requests pass through without token check.",
    secret: true,
  },
  {
    name: "REQUIRE_INTERNAL_AUTH",
    ifMissing: "ok",
    consequence: "(unset → warn-only enforcement; set to 'true' for production).",
  },

  // ─── Telegram (alerts) ───────────────────────────────────────
  {
    name: "TELEGRAM_BOT_TOKEN",
    ifMissing: "warn",
    consequence: "RCA desync kill-switch + B6 fatal-handler alerts will be silent.",
    secret: true,
  },
  {
    name: "TELEGRAM_CHAT_ID",
    ifMissing: "warn",
    consequence: "RCA desync kill-switch + B6 fatal-handler alerts will be silent.",
  },

  // ─── Dhan token-refresh job ──────────────────────────────────
  {
    name: "DHAN_CLIENT_ID",
    ifMissing: "warn",
    consequence: "headless Dhan token-refresh job disabled (operator must refresh tokens manually).",
  },
  {
    name: "DHAN_PIN",
    ifMissing: "warn",
    consequence: "headless Dhan token-refresh job disabled.",
    secret: true,
  },
  {
    name: "DHAN_TOTP_SECRET",
    ifMissing: "warn",
    consequence: "headless Dhan token-refresh job disabled.",
    secret: true,
  },

  // ─── Python pipeline base URLs ───────────────────────────────
  { name: "BROKER_URL", ifMissing: "ok" },
  { name: "DASHBOARD_URL", ifMissing: "ok" },
];

interface EvaluatedEntry {
  name: string;
  status: "ok" | "warn" | "fatal";
  display: string;
  consequence?: string;
}

function maskValue(value: string): string {
  if (value.length <= 4) return "***";
  return `(set, length=${value.length})`;
}

function maskUri(uri: string): string {
  // mongodb://user:password@host/db → mongodb://USER:***@host/db
  return uri.replace(/(:\/\/[^:]+:)[^@]+(@)/, "$1***$2");
}

function evaluateEnv(): EvaluatedEntry[] {
  const results: EvaluatedEntry[] = [];
  for (const spec of ENV_REGISTRY) {
    const raw = process.env[spec.name];
    const present = raw !== undefined && raw !== "";
    if (present) {
      let display: string;
      if (spec.secret) {
        display = maskValue(raw!);
      } else if (spec.name === "MONGODB_URI") {
        display = maskUri(raw!);
      } else {
        display = raw!;
      }
      results.push({ name: spec.name, status: "ok", display });
    } else {
      results.push({
        name: spec.name,
        status: spec.ifMissing,
        display: "(missing)",
        consequence: spec.consequence,
      });
    }
  }
  return results;
}

export function validateEnv(): void {
  const entries = evaluateEnv();
  const nameWidth = Math.max(...entries.map((e) => e.name.length));

  log.important("Environment configuration:");
  for (const entry of entries) {
    const icon = entry.status === "ok" ? "✓" : entry.status === "warn" ? "⚠" : "✗";
    const padded = entry.name.padEnd(nameWidth, " ");
    const tail = entry.consequence ? `  ${entry.display} — ${entry.consequence}` : `  ${entry.display}`;
    const line = `  ${icon} ${padded}${tail}`;
    if (entry.status === "ok") log.info(line);
    else if (entry.status === "warn") log.warn(line);
    else log.error(line);
  }

  const fatalCount = entries.filter((e) => e.status === "fatal").length;
  const warnCount = entries.filter((e) => e.status === "warn").length;
  const okCount = entries.filter((e) => e.status === "ok").length;
  log.info(`Summary: ${okCount} set, ${warnCount} warn, ${fatalCount} fatal.`);
}
