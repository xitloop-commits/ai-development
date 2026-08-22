/**
 * seaLineStore — SERVER-AUTHORITATIVE indicator-line series pushed BY SEA (T169-B,
 * option B). SEA already computes the premium SMA5/MA ribbon line + state on every
 * candle close (premium_ribbon.py); it POSTs each closed value here so the chart
 * draws the EXACT numbers the signal decision used — no client re-calculation, no
 * drift.
 *
 * One rolling series per (instrument, date, securityId, kind) — kind is the line
 * source, "sma5" or "ma". In-memory only: it accumulates over the live session
 * (SEA runs from pre-open), and a restart simply re-warms as SEA keeps posting;
 * the chart falls back to its own compute while a series is empty. Deduped by
 * bucket time so a re-post of the same candle overwrites rather than duplicates.
 */
import { logFolderFor } from "./seaSignals";

/** One closed-candle sample SEA posts for a contract's ribbon. */
export interface SeaLineSample {
  /** Bucket-start epoch seconds (raw, UTC) of the closed candle. */
  t: number;
  /** The smoothing-line value (SMA5 or 20-EMA) at that close. */
  line: number;
  /** Trend state SEA assigned: 1 up, -1 down, 0 flat/warmup. */
  state: -1 | 0 | 1;
  /** The (HA or raw) close the state compared against. */
  close: number;
  /** Slope ANGLE (degrees) SEA computed — drives the trend/angle/run readout. */
  deg: number;
}

export type SeaLineKind = "sma5" | "ma";

/** Keep at most one trading day of 1-min candles per series (~6.5h + slack). */
const MAX_SAMPLES = 600;

const store = new Map<string, SeaLineSample[]>();

function key(instrument: string, date: string, securityId: string, kind: SeaLineKind): string {
  return `${logFolderFor(instrument)}:${date}:${securityId}:${kind}`;
}

/**
 * Append (or overwrite by bucket time) one closed-candle sample. Series stay in
 * time order; a re-post of the newest bucket replaces it (SEA may re-close the
 * same candle after a config change). Returns the stored sample.
 */
export function insertSeaLine(
  instrument: string,
  date: string,
  securityId: string,
  kind: SeaLineKind,
  sample: SeaLineSample,
): SeaLineSample {
  const k = key(instrument, date, securityId, kind);
  let arr = store.get(k);
  if (!arr) { arr = []; store.set(k, arr); }
  const last = arr[arr.length - 1];
  if (last && last.t === sample.t) {
    arr[arr.length - 1] = sample; // same candle re-closed → overwrite
  } else if (last && sample.t < last.t) {
    // Out-of-order (shouldn't happen live) — insert in place, keep sorted.
    const i = arr.findIndex((s) => s.t >= sample.t);
    if (i >= 0 && arr[i].t === sample.t) arr[i] = sample;
    else arr.splice(i < 0 ? arr.length : i, 0, sample);
  } else {
    arr.push(sample);
  }
  if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
  return sample;
}

/** The stored series for one contract+kind, oldest→newest (empty if none yet). */
export function getSeaLines(
  instrument: string,
  date: string,
  securityId: string,
  kind: SeaLineKind,
): SeaLineSample[] {
  return store.get(key(instrument, date, securityId, kind)) ?? [];
}

/** Test hook — wipe all series. */
export function _resetSeaLineStore(): void {
  store.clear();
}
