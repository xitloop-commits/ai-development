/**
 * Module 2b: Cooldowns
 *
 * - Revenge trade cooldown: mandatory pause after a stop-loss hit
 * - Consecutive loss cooldown: extended pause after N consecutive losses
 *
 * If both cooldowns overlap, the longer one takes precedence (they don't stack).
 * The revenge cooldown timer doesn't start until the user acknowledges the loss
 * (if requireAcknowledgment is enabled).
 */

import type { DisciplineState, DisciplineAgentSettings, ModuleCheckResult, CooldownState } from "./types";

export interface CooldownResult extends ModuleCheckResult {
  remainingSeconds?: number;
  cooldownType?: string;
  requiresAcknowledgment?: boolean;
}

/**
 * Check if any cooldown is currently active and blocking trades.
 */
export function checkCooldown(
  state: DisciplineState,
  settings: DisciplineAgentSettings
): CooldownResult {
  if (!state.activeCooldown) {
    return { passed: true };
  }

  const cooldown = state.activeCooldown;
  const now = new Date();

  // Check if cooldown has expired
  if (now >= cooldown.endsAt) {
    return { passed: true, cooldownType: cooldown.type };
  }

  // Cooldown is active — check if acknowledgment is required
  if (cooldown.type === "revenge" && settings.revengeCooldown.requireAcknowledgment && !cooldown.acknowledged) {
    return {
      passed: false,
      reason: "Acknowledge your loss before the cooldown timer starts",
      cooldownType: "revenge",
      requiresAcknowledgment: true,
    };
  }

  const remainingMs = cooldown.endsAt.getTime() - now.getTime();
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const remainingMin = Math.ceil(remainingSeconds / 60);

  return {
    passed: false,
    reason: `${cooldown.type === "revenge" ? "Revenge trade" : "Consecutive loss"} cooldown active — ${remainingMin} min remaining`,
    remainingSeconds,
    cooldownType: cooldown.type,
  };
}

/**
 * Create a revenge cooldown state after a stop-loss hit.
 */
export function createRevengeCooldown(
  settings: DisciplineAgentSettings,
  triggerTradeId?: string
): CooldownState | null {
  if (!settings.revengeCooldown.enabled) return null;

  const now = new Date();
  const durationMs = settings.revengeCooldown.durationMinutes * 60 * 1000;

  // If acknowledgment is required, the cooldown timer hasn't started yet
  // The endsAt will be recalculated when acknowledgment is received
  const endsAt = settings.revengeCooldown.requireAcknowledgment
    ? new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) // Far future — until acknowledged
    : new Date(now.getTime() + durationMs);

  return {
    type: "revenge",
    startedAt: now,
    endsAt,
    acknowledged: !settings.revengeCooldown.requireAcknowledgment,
    triggerTrade: triggerTradeId,
  };
}

/**
 * Create a consecutive loss cooldown.
 */
export function createConsecutiveLossCooldown(
  settings: DisciplineAgentSettings
): CooldownState | null {
  if (!settings.maxConsecutiveLosses.enabled) return null;

  const now = new Date();
  const durationMs = settings.maxConsecutiveLosses.cooldownMinutes * 60 * 1000;

  return {
    type: "consecutive_loss",
    startedAt: now,
    endsAt: new Date(now.getTime() + durationMs),
    acknowledged: true, // No acknowledgment needed for consecutive loss cooldown
  };
}

/**
 * Process loss acknowledgment — starts the actual cooldown timer.
 * Returns the updated cooldown state.
 */
export function acknowledgeLoss(
  cooldown: CooldownState,
  settings: DisciplineAgentSettings
): CooldownState {
  const now = new Date();
  const durationMs = settings.revengeCooldown.durationMinutes * 60 * 1000;

  return {
    ...cooldown,
    acknowledged: true,
    startedAt: now,
    endsAt: new Date(now.getTime() + durationMs),
  };
}

/**
 * Determine which cooldown should be active when both could apply.
 * The longer remaining cooldown takes precedence.
 */
export function resolveOverlappingCooldowns(
  existing: CooldownState | undefined,
  incoming: CooldownState
): CooldownState {
  if (!existing) return incoming;

  const now = new Date();

  // If existing has expired, use incoming
  if (now >= existing.endsAt) return incoming;

  // Use whichever has the later end time
  return existing.endsAt > incoming.endsAt ? existing : incoming;
}
