/**
 * Instruments Configuration
 *
 * Single source of truth for all tradable instruments.
 * Includes the 4 core instruments (seeded by default) plus any user-added instruments.
 */

import mongoose, { Schema, Document } from "mongoose";

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
  },
  { collection: "instruments", _id: false }
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
  config: Omit<InstrumentConfig, "isDefault" | "addedAt">
): Promise<InstrumentConfig> {
  const newInstrument: InstrumentConfig = {
    ...config,
    isDefault: false,
    addedAt: Date.now(),
  };

  const result = await InstrumentModel.create(newInstrument);
  return result.toObject();
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
      console.log("[Instruments] Seeded 4 default instruments");
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
  } catch (err) {
    console.error("[Instruments] Error seeding default instruments:", err);
    throw err;
  }
}
