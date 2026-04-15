/**
 * Broker Config — MongoDB Model & CRUD Helpers
 *
 * Manages the `broker_configs` collection. One document per broker.
 * Stores credentials, settings, connection status, and capabilities.
 */

import mongoose, { Schema, type Document } from "mongoose";
import type {
  BrokerConfigDoc,
  BrokerCredentials,
  BrokerSettings,
  BrokerConnection,
  BrokerCapabilities,
  TokenStatus,
  ConnectionStatus,
} from "./types";

// ─── Mongoose Schema ────────────────────────────────────────────

const credentialsSchema = new Schema<BrokerCredentials>(
  {
    accessToken: { type: String, default: "" },
    clientId: { type: String, default: "" },
    updatedAt: { type: Number, default: 0 },
    expiresIn: { type: Number, default: 86400000 }, // 24h in ms
    status: {
      type: String,
      enum: ["valid", "expired", "unknown"],
      default: "unknown",
    },
  },
  { _id: false }
);

const settingsSchema = new Schema<BrokerSettings>(
  {
    orderEntryOffset: { type: Number, default: 1.0 },
    defaultSL: { type: Number, default: 2.0 },
    defaultTP: { type: Number, default: 5.0 },
    orderType: {
      type: String,
      enum: ["LIMIT", "MARKET", "SL", "SL-M"],
      default: "LIMIT",
    },
    productType: {
      type: String,
      enum: ["INTRADAY", "CNC", "MARGIN"],
      default: "INTRADAY",
    },
    dailyTargetPercent: { type: Number, default: 5.0 },
    tradeTargetOptions: { type: Number, default: 30 },
    tradeTargetOther: { type: Number, default: 2 },
    trailingStopEnabled: { type: Boolean, default: false },
    trailingStopPercent: { type: Number, default: 1.0 },
    defaultQty: { type: Number, default: 1 },
  },
  { _id: false }
);

const connectionSchema = new Schema<BrokerConnection>(
  {
    apiStatus: {
      type: String,
      enum: ["connected", "disconnected", "error"],
      default: "disconnected",
    },
    wsStatus: {
      type: String,
      enum: ["connected", "disconnected", "error"],
      default: "disconnected",
    },
    lastApiCall: { type: Number, default: null },
    lastWsTick: { type: Number, default: null },
    latencyMs: { type: Number, default: null },
  },
  { _id: false }
);

const capabilitiesSchema = new Schema<BrokerCapabilities>(
  {
    bracketOrder: { type: Boolean, default: false },
    coverOrder: { type: Boolean, default: false },
    websocket: { type: Boolean, default: false },
    optionChain: { type: Boolean, default: false },
    gtt: { type: Boolean, default: false },
    amo: { type: Boolean, default: false },
  },
  { _id: false }
);

const brokerConfigSchema = new Schema<BrokerConfigDoc & Document>(
  {
    brokerId: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, required: true },
    isActive: { type: Boolean, default: false },
    isPaperBroker: { type: Boolean, default: false },
    sandboxMode: { type: Boolean, default: false },
    credentials: { type: credentialsSchema, default: () => ({}) },
    settings: { type: settingsSchema, default: () => ({}) },
    connection: { type: connectionSchema, default: () => ({}) },
    capabilities: { type: capabilitiesSchema, default: () => ({}) },
  },
  {
    timestamps: true,
    collection: "broker_configs",
  }
);

export const BrokerConfigModel = mongoose.model(
  "BrokerConfig",
  brokerConfigSchema
);

// ─── CRUD Helpers ───────────────────────────────────────────────

/**
 * Get a broker config by brokerId.
 */
export async function getBrokerConfig(
  brokerId: string
): Promise<BrokerConfigDoc | null> {
  const doc = await BrokerConfigModel.findOne({ brokerId }).lean();
  return doc ? docToConfig(doc) : null;
}

/**
 * Get the currently active broker config.
 */
export async function getActiveBrokerConfig(): Promise<BrokerConfigDoc | null> {
  const doc = await BrokerConfigModel.findOne({ isActive: true }).lean();
  return doc ? docToConfig(doc) : null;
}

/**
 * Get all broker configs.
 */
export async function getAllBrokerConfigs(): Promise<BrokerConfigDoc[]> {
  const docs = await BrokerConfigModel.find().lean();
  return docs.map(docToConfig);
}

/**
 * Create or update a broker config (upsert by brokerId).
 */
export async function upsertBrokerConfig(
  config: Partial<BrokerConfigDoc> & { brokerId: string }
): Promise<BrokerConfigDoc> {
  const doc = await BrokerConfigModel.findOneAndUpdate(
    { brokerId: config.brokerId },
    { $set: config },
    { upsert: true, returnDocument: "after", lean: true }
  );
  return docToConfig(doc!);
}

/**
 * Set a broker as active (deactivates all others).
 */
export async function setActiveBroker(
  brokerId: string
): Promise<BrokerConfigDoc | null> {
  // Deactivate all
  await BrokerConfigModel.updateMany({}, { $set: { isActive: false } });
  // Activate the target
  const doc = await BrokerConfigModel.findOneAndUpdate(
    { brokerId },
    { $set: { isActive: true } },
    { returnDocument: "after", lean: true }
  );
  return doc ? docToConfig(doc) : null;
}

/**
 * Update broker credentials.
 */
export async function updateBrokerCredentials(
  brokerId: string,
  credentials: Partial<BrokerCredentials>
): Promise<BrokerConfigDoc | null> {
  const updateFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(credentials)) {
    updateFields[`credentials.${key}`] = value;
  }

  const doc = await BrokerConfigModel.findOneAndUpdate(
    { brokerId },
    { $set: updateFields },
    { returnDocument: "after", lean: true }
  );
  return doc ? docToConfig(doc) : null;
}

/**
 * Update broker connection status.
 */
export async function updateBrokerConnection(
  brokerId: string,
  connection: Partial<BrokerConnection>
): Promise<BrokerConfigDoc | null> {
  const updateFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(connection)) {
    updateFields[`connection.${key}`] = value;
  }

  const doc = await BrokerConfigModel.findOneAndUpdate(
    { brokerId },
    { $set: updateFields },
    { returnDocument: "after", lean: true }
  );
  return doc ? docToConfig(doc) : null;
}

/**
 * Update broker settings.
 */
export async function updateBrokerSettings(
  brokerId: string,
  settings: Partial<BrokerSettings>
): Promise<BrokerConfigDoc | null> {
  const updateFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    updateFields[`settings.${key}`] = value;
  }

  const doc = await BrokerConfigModel.findOneAndUpdate(
    { brokerId },
    { $set: updateFields },
    { returnDocument: "after", lean: true }
  );
  return doc ? docToConfig(doc) : null;
}

/**
 * Delete a broker config.
 */
export async function deleteBrokerConfig(brokerId: string): Promise<boolean> {
  const result = await BrokerConfigModel.deleteOne({ brokerId });
  return result.deletedCount === 1;
}

// ─── Helper ─────────────────────────────────────────────────────

/** Strip Mongoose internals and return a clean BrokerConfigDoc. */
function docToConfig(doc: Record<string, any>): BrokerConfigDoc {
  return {
    brokerId: doc.brokerId,
    displayName: doc.displayName,
    isActive: doc.isActive,
    isPaperBroker: doc.isPaperBroker ?? false,
    sandboxMode: doc.sandboxMode ?? false,
    credentials: {
      accessToken: doc.credentials?.accessToken ?? "",
      clientId: doc.credentials?.clientId ?? "",
      updatedAt: doc.credentials?.updatedAt ?? 0,
      expiresIn: doc.credentials?.expiresIn ?? 86400000,
      status: doc.credentials?.status ?? "unknown",
    },
    settings: {
      orderEntryOffset: doc.settings?.orderEntryOffset ?? 1.0,
      defaultSL: doc.settings?.defaultSL ?? 2.0,
      defaultTP: doc.settings?.defaultTP ?? 5.0,
      orderType: doc.settings?.orderType ?? "LIMIT",
      productType: doc.settings?.productType ?? "INTRADAY",
      dailyTargetPercent: doc.settings?.dailyTargetPercent ?? 5.0,
      tradeTargetOptions: doc.settings?.tradeTargetOptions ?? 30,
      tradeTargetOther: doc.settings?.tradeTargetOther ?? 2,
      trailingStopEnabled: doc.settings?.trailingStopEnabled ?? false,
      trailingStopPercent: doc.settings?.trailingStopPercent ?? 1.0,
      defaultQty: doc.settings?.defaultQty ?? 1,
    },
    connection: {
      apiStatus: doc.connection?.apiStatus ?? "disconnected",
      wsStatus: doc.connection?.wsStatus ?? "disconnected",
      lastApiCall: doc.connection?.lastApiCall ?? null,
      lastWsTick: doc.connection?.lastWsTick ?? null,
      latencyMs: doc.connection?.latencyMs ?? null,
    },
    capabilities: {
      bracketOrder: doc.capabilities?.bracketOrder ?? false,
      coverOrder: doc.capabilities?.coverOrder ?? false,
      websocket: doc.capabilities?.websocket ?? false,
      optionChain: doc.capabilities?.optionChain ?? false,
      gtt: doc.capabilities?.gtt ?? false,
      amo: doc.capabilities?.amo ?? false,
    },
    // auth sub-doc (clientId, pin, totpSecret) — not in the schema but stored
    // directly in MongoDB by dhan-update-credentials.mjs; pass through as-is
    // so tokenManager can read it without going to raw MongoDB
    auth: doc.auth ?? {},
  };
}
