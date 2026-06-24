/**
 * Instruments Configuration
 *
 * Single source of truth for all tradable instruments.
 * Includes the 4 core instruments (seeded by default) plus any user-added instruments.
 */

import mongoose, { Schema } from "mongoose";
import { createLogger } from "./broker/logger";

const log = createLogger("BOOT", "Instruments");

export interface InstrumentConfig {
  key: string;              // 'NIFTY_50' — unique identifier
  displayName: string;      // 'NIFTY 50'
  exchange: "NSE" | "MCX" | "BSE";
  exchangeSegment: string;  // 'IDX_I' | 'MCX_COMM' | 'NSE_EQ'
  underlying: string | null; // security ID for option chain, null for auto-resolve
  autoResolve: boolean;     // true for MCX futures (monthly security ID changes)
  symbolName: string | null; // for scrip master lookup when autoResolve is true
  isDefault: boolean;       // true = cannot be deleted from UI
  addedAt: number;          // UTC ms timestamp
  hotkey: string | null;    // keyboard hotkey (e.g., '1', '2', 'q', 'w') — null if not assigned
  color: string;            // base hex colour (e.g. '#3B82F6') — single source for every
                            // instrument-specific UI shade (pill, cards, signals). User-editable.
}

/**
 * Curated preset palette for auto-assigning colours to new instruments.
 * Mirrors INSTRUMENT_PALETTE on the client (client/src/lib/tradeThemes.ts) —
 * keep the two in sync. First four match the legacy default pill colours.
 */
export const INSTRUMENT_PALETTE: string[] = [
  "#3B82F6", "#A855F7", "#F59E0B", "#10B981",
  "#EF4444", "#06B6D4", "#EC4899", "#84CC16",
  "#F97316", "#8B5CF6", "#14B8A6", "#F43F5E",
];

const FALLBACK_INSTRUMENT_COLOR = "#64748B"; // slate-500

/** Pick the first palette colour not already in use; wrap around if all taken. */
export function pickNextColor(used: string[]): string {
  return (
    INSTRUMENT_PALETTE.find((c) => !used.includes(c)) ??
    INSTRUMENT_PALETTE[used.length % INSTRUMENT_PALETTE.length]
  );
}

const instrumentConfigSchema = new Schema<InstrumentConfig>(
  {
    key: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, required: true },
    exchange: { type: String, enum: ["NSE", "MCX", "BSE"], required: true },
    exchangeSegment: { type: String, required: true },
    underlying: { type: String, default: null },
    autoResolve: { type: Boolean, default: false },
    symbolName: { type: String, default: null },
    isDefault: { type: Boolean, default: false },
    addedAt: { type: Number, default: () => Date.now() },
    hotkey: { type: String, default: null, index: true },
    color: { type: String, default: FALLBACK_INSTRUMENT_COLOR },
  },
  { collection: "instruments" }
);

export const InstrumentModel =
  mongoose.models.instruments ||
  mongoose.model<InstrumentConfig>("instruments", instrumentConfigSchema);

// --- Default Instruments (4 core instruments) ---

export const DEFAULT_INSTRUMENTS: InstrumentConfig[] = [
  {
    key: "NIFTY_50",
    displayName: "NIFTY 50",
    exchange: "NSE",
    exchangeSegment: "IDX_I",
    underlying: "13",
    autoResolve: false,
    symbolName: null,
    isDefault: true,
    addedAt: 0,
    hotkey: "1",
    color: "#3B82F6", // blue-500 (legacy pill colour)
  },
  {
    key: "BANKNIFTY",
    displayName: "BANK NIFTY",
    exchange: "NSE",
    exchangeSegment: "IDX_I",
    underlying: "25",
    autoResolve: false,
    symbolName: null,
    isDefault: true,
    addedAt: 0,
    hotkey: "2",
    color: "#A855F7", // purple-500 (legacy pill colour)
  },
  {
    key: "CRUDEOIL",
    displayName: "CRUDE OIL",
    exchange: "MCX",
    exchangeSegment: "MCX_COMM",
    underlying: null,
    autoResolve: true,
    symbolName: "CRUDEOIL",
    isDefault: true,
    addedAt: 0,
    hotkey: "3",
    color: "#F59E0B", // amber-500 (legacy pill colour)
  },
  {
    key: "NATURALGAS",
    displayName: "NATURAL GAS",
    exchange: "MCX",
    exchangeSegment: "MCX_COMM",
    underlying: null,
    autoResolve: true,
    symbolName: "NATURALGAS",
    isDefault: true,
    addedAt: 0,
    hotkey: "4",
    color: "#10B981", // emerald-500 (legacy pill colour)
  },
];

// --- CRUD Functions ---

/**
 * Get all configured instruments from the database.
 */
export async function getAllInstruments(): Promise<InstrumentConfig[]> {
  return await InstrumentModel.find({}).lean();
}

/**
 * Get a single instrument by key.
 */
export async function getInstrumentByKey(
  key: string
): Promise<InstrumentConfig | null> {
  return await InstrumentModel.findOne({ key }).lean();
}

/**
 * Add a new instrument to the database.
 * Throws if the key already exists.
 */
export async function addInstrument(
  config: Omit<InstrumentConfig, "isDefault" | "addedAt" | "color"> & { color?: string }
): Promise<InstrumentConfig> {
  // Auto-assign the next free palette colour when the caller doesn't pick one.
  const existing = await getAllInstruments();
  const color =
    config.color ??
    pickNextColor(existing.map((i) => i.color).filter(Boolean) as string[]);

  const newInstrument: InstrumentConfig = {
    ...config,
    color,
    isDefault: false,
    addedAt: Date.now(),
  };

  await InstrumentModel.create(newInstrument);
  // Return the created instrument
  return newInstrument;
}

/**
 * Set an instrument's base colour (hex like '#3B82F6').
 * Applies to default and user-added instruments alike.
 */
export async function setInstrumentColor(key: string, color: string): Promise<void> {
  const instrument = await getInstrumentByKey(key);
  if (!instrument) {
    throw new Error(`Instrument ${key} not found`);
  }
  await InstrumentModel.updateOne({ key }, { $set: { color } });
}

/**
 * Remove a non-default instrument.
 * Throws if isDefault is true.
 */
export async function removeInstrument(key: string): Promise<void> {
  const instrument = await getInstrumentByKey(key);
  if (!instrument) {
    throw new Error(`Instrument ${key} not found`);
  }
  if (instrument.isDefault) {
    throw new Error(`Cannot delete default instrument: ${key}`);
  }

  await InstrumentModel.deleteOne({ key });
}

/**
 * Assign a hotkey to an instrument.
 * If the hotkey is already assigned to another instrument, swap them.
 */
export async function assignHotkey(instrumentKey: string, hotkey: string | null): Promise<void> {
  const instrument = await getInstrumentByKey(instrumentKey);
  if (!instrument) {
    throw new Error(`Instrument ${instrumentKey} not found`);
  }

  // If removing the hotkey, just update
  if (!hotkey) {
    await InstrumentModel.updateOne({ key: instrumentKey }, { $set: { hotkey: null } });
    return;
  }

  // Check if this hotkey is already assigned to another instrument
  const existingInstrument = await InstrumentModel.findOne({ hotkey, key: { $ne: instrumentKey } });

  if (existingInstrument) {
    // Swap the hotkeys
    const oldHotkey = instrument.hotkey || null;
    await Promise.all([
      InstrumentModel.updateOne({ key: instrumentKey }, { $set: { hotkey } }),
      InstrumentModel.updateOne({ key: existingInstrument.key }, { $set: { hotkey: oldHotkey } }),
    ]);
  } else {
    // Just assign the hotkey
    await InstrumentModel.updateOne({ key: instrumentKey }, { $set: { hotkey } });
  }
}

/**
 * Seed default instruments into the database if they don't exist.
 * Called once at server startup — idempotent.
 */
export async function seedDefaultInstruments(): Promise<void> {
  try {
    const existingCount = await InstrumentModel.countDocuments({});
    if (existingCount === 0) {
      // First run: insert all defaults
      await InstrumentModel.insertMany(DEFAULT_INSTRUMENTS, {
        ordered: false,
      }).catch((err) => {
        // Ignore duplicate key errors
        if (err.code !== 11000) {
          throw err;
        }
      });
      log.important("Seeded 4 default instruments");
    } else {
      // Subsequent runs: ensure defaults exist, upsert any missing
      for (const defaultInst of DEFAULT_INSTRUMENTS) {
        await InstrumentModel.updateOne(
          { key: defaultInst.key },
          { $setOnInsert: defaultInst },
          { upsert: true }
        );
      }
    }

    // Backfill colour on any instrument saved before the colour field existed.
    // Defaults get their canonical colour; user-added ones get the next free
    // palette colour. Idempotent — only touches docs missing a colour.
    const missing = await InstrumentModel.find({
      $or: [{ color: { $exists: false } }, { color: null }, { color: "" }],
    }).lean();
    if (missing.length > 0) {
      const used = (await getAllInstruments())
        .map((i) => i.color)
        .filter(Boolean) as string[];
      for (const m of missing) {
        const def = DEFAULT_INSTRUMENTS.find((d) => d.key === m.key)?.color;
        const color = def ?? pickNextColor(used);
        used.push(color);
        await InstrumentModel.updateOne({ key: m.key }, { $set: { color } });
      }
      log.important(`Backfilled colour on ${missing.length} instrument(s)`);
    }
  } catch (err) {
    log.error("Error seeding default instruments", err as Error);
    throw err;
  }
}
