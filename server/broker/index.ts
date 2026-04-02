/**
 * Broker Module — Public API
 *
 * Re-exports everything consumers need from the broker service.
 */

// Types
export type {
  BrokerAdapter,
  BrokerConfigDoc,
  BrokerServiceStatus,
  OrderParams,
  ModifyParams,
  OrderResult,
  Order,
  Trade,
  Position,
  MarginInfo,
  Instrument,
  OptionChainData,
  OptionChainRow,
  SubscribeParams,
  TickData,
  TickCallback,
  OrderUpdate,
  OrderUpdateCallback,
  BrokerCredentials,
  BrokerSettings,
  BrokerConnection,
  BrokerCapabilities,
} from "./types";

// Config CRUD
export {
  BrokerConfigModel,
  getBrokerConfig,
  getActiveBrokerConfig,
  getAllBrokerConfigs,
  upsertBrokerConfig,
  setActiveBroker,
  updateBrokerCredentials,
  updateBrokerConnection,
  updateBrokerSettings,
  deleteBrokerConfig,
} from "./brokerConfig";

// Service
export {
  registerAdapter,
  getRegisteredAdapters,
  getRegisteredAdaptersMeta,
  getActiveBroker,
  initBrokerService,
  switchBroker,
  toggleKillSwitch,
  isKillSwitchActive,
  getBrokerServiceStatus,
  _resetForTesting,
} from "./brokerService";
export type { AdapterFactory, AdapterMeta } from "./brokerService";

// tRPC Router
export { brokerRouter } from "./brokerRouter";

// REST Routes
export { registerBrokerRoutes } from "./brokerRoutes";

// Tick Bus
export { tickBus } from "./tickBus";
