/**
 * modelVersions.ts — what trained models exist on disk (T94).
 *
 * Backs the AI menu's model switch. Version directories are timestamp-named
 * (YYYYMMDD_HHMMSS), so a reverse sort is chronological. `LATEST` is a text file
 * holding the version string SEA loads at startup.
 *
 * Each entry carries the headline metrics from that version's own metrics.json,
 * so the operator picks on evidence rather than on a date. Metrics are read
 * best-effort — an older version missing the file still appears, just without
 * numbers, because being unable to show the AUC is no reason to hide a model you
 * might want to roll back to.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";

export interface ModelVersionInfo {
  version: string;
  /** True for the version SEA loads at startup (models/<inst>/LATEST). */
  isLatest: boolean;
  /** Mean AUC across binary heads, when metrics.json has it. */
  auc: number | null;
  /** Head count in this version, when known. */
  heads: number | null;
  /** Training window from the manifest, when present. */
  trainedFrom: string | null;
  trainedTo: string | null;
  /** Feature count this version was TRAINED on (training_manifest.feature_count). */
  featureCount: number | null;
  /**
   * Can this version actually run right now?
   *
   * The feature config is SHARED across versions (config/model_feature_config/
   * <inst>_feature_config.json), not stored per model. So a version trained on a
   * different column count can never be loaded — the pipeline always builds the
   * CURRENT feature set, and LightGBM rejects the shape:
   *   "number of features in data (482) is not the same as in training data (470)"
   * Older pre-retrain models are therefore permanently unusable, not merely old.
   */
  compatible: boolean;
  /** Why it can't run, for the UI to show. Null when it can. */
  incompatibleReason: string | null;
}

const INSTRUMENTS = ["nifty50", "banknifty"];
const modelsRoot = () => resolve(process.cwd(), "models");

/** Read `LATEST` for an instrument, or null when absent/unreadable. */
function readLatest(inst: string): string | null {
  try {
    const p = join(modelsRoot(), inst, "LATEST");
    if (!existsSync(p)) return null;
    const v = readFileSync(p, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

/** Pull the headline numbers out of a version's sidecars. Never throws. */
/** Feature count the CURRENT pipeline builds for an instrument. */
function currentFeatureCount(inst: string): number | null {
  try {
    const p = resolve(process.cwd(), "config", "model_feature_config", `${inst}_feature_config.json`);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(j.final_features) ? j.final_features.length : null;
  } catch {
    return null;
  }
}

function readMetrics(inst: string, version: string): Omit<ModelVersionInfo, "version" | "isLatest"> {
  const out = {
    auc: null as number | null, heads: null as number | null,
    trainedFrom: null as string | null, trainedTo: null as string | null,
    featureCount: null as number | null,
    compatible: true, incompatibleReason: null as string | null,
  };
  const dir = join(modelsRoot(), inst, version);
  try {
    const mp = join(dir, "metrics.json");
    if (existsSync(mp)) {
      const m = JSON.parse(readFileSync(mp, "utf8"));
      // Shape varies across trainer versions — accept the common spellings
      // rather than pinning one and silently showing nothing for older runs.
      const aucs: number[] = [];
      const walk = (o: unknown): void => {
        if (!o || typeof o !== "object") return;
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
          if (typeof v === "number" && /auc/i.test(k) && v > 0 && v <= 1) aucs.push(v);
          else if (v && typeof v === "object") walk(v);
        }
      };
      walk(m);
      if (aucs.length) out.auc = Math.round((aucs.reduce((s, x) => s + x, 0) / aucs.length) * 1000) / 1000;
      if (typeof m.heads === "number") out.heads = m.heads;
    }
    const tp = join(dir, "training_manifest.json");
    if (existsSync(tp)) {
      const t = JSON.parse(readFileSync(tp, "utf8"));
      out.trainedFrom = t.date_from ?? t.dateFrom ?? null;
      out.trainedTo = t.date_to ?? t.dateTo ?? null;
      if (out.heads == null && Array.isArray(t.targets)) out.heads = t.targets.length;
      if (typeof t.feature_count === "number") out.featureCount = t.feature_count;
    }
    if (out.heads == null) {
      out.heads = readdirSync(dir).filter((f) => f.endsWith(".lgbm")).length || null;
    }
  } catch {
    /* best-effort — a version with no readable metrics still lists */
  }

  // Compatibility LAST, so it sees whatever featureCount we managed to read.
  const need = currentFeatureCount(inst);
  if (need != null && out.featureCount != null && out.featureCount !== need) {
    out.compatible = false;
    out.incompatibleReason =
      `trained on ${out.featureCount} features, the pipeline now builds ${need} — ` +
      `the feature config is shared across versions, so this model cannot be loaded`;
  }
  return out;
}

/** Every trained version per instrument, newest first. */
export function listModelVersions(): Record<string, ModelVersionInfo[]> {
  const out: Record<string, ModelVersionInfo[]> = {};
  for (const inst of INSTRUMENTS) {
    const dir = join(modelsRoot(), inst);
    if (!existsSync(dir)) { out[inst] = []; continue; }
    const latest = readLatest(inst);
    let versions: string[] = [];
    try {
      versions = readdirSync(dir)
        // Timestamp dirs only — skips LATEST, LATEST_HEADS.json and the
        // LATEST.bak-* files left behind by manual switches.
        .filter((n) => /^\d{8}_\d{6}$/.test(n) && statSync(join(dir, n)).isDirectory())
        .sort()
        .reverse();
    } catch {
      versions = [];
    }
    out[inst] = versions.map((v) => ({
      version: v,
      isLatest: v === latest,
      ...readMetrics(inst, v),
    }));
  }
  return out;
}
