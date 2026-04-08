# Trade Executor Agent — Project Folder Structure Changes

## 1. New Executor Module
- `server/executor/`
  - Core service and all submodules (sanity, idempotency, normalization, order manager, event handler, recovery, etc.)
  - Dedicated logger (executorLogger.ts)

## 2. Centralized Settings
- `server/executor/executorSettings.ts` (or .json/.yaml)
  - All trade execution settings managed here

## 3. Database Models
- `server/executor/models/Order.ts`
- `server/executor/models/OrderEvent.ts`
- `server/executor/models/ExecutionLog.ts`

## 4. API Integration
- `server/executor/executorRouter.ts` (or update `server/routers.ts`)
  - Expose executor endpoints (submitTrade, getOrderStatus, getExecutionLog)

## 5. Remove/Refactor Legacy Logic
- Remove/refactor trade execution logic from:
  - `python_modules/`
  - `server/capital/`
  - Any direct broker calls in other modules

## 6. Testing
- `server/executor/__tests__/`
  - Unit, integration, and regression tests for the executor

## 7. Documentation
- `docs/specs/` and `docs/diagrams/`
  - Store all executor specs, plans, and diagrams

---

**Summary:**
A new `server/executor/` directory will house all Trade Executor Agent logic, settings, models, and tests. Legacy trade execution code will be removed from other modules, and all settings will be centralized for maintainability and clarity.
