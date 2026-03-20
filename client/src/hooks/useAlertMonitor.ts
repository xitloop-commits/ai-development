/**
 * useAlertMonitor — Monitors tRPC polling data for alert-worthy changes.
 * Compares previous and current state to detect:
 * - New GO signals from AI Decision Engine
 * - Module health degradation (active → error)
 * - New signals in the signals feed
 * - Position changes (new opens, closes, SL/TP hits)
 */
import { useEffect, useRef } from 'react';
import { useAlerts } from '@/contexts/AlertContext';
import type { InstrumentData, ModuleStatus, Signal, Position } from '@/lib/types';

interface MonitorData {
  instruments: InstrumentData[] | undefined;
  modules: ModuleStatus[] | undefined;
  signals: Signal[] | undefined;
  positions: Position[] | undefined;
}

/**
 * Hook that monitors live trading data and dispatches alerts
 * when significant changes are detected.
 */
export function useAlertMonitor(data: MonitorData): void {
  const { dispatchAlert } = useAlerts();

  // Store previous state for comparison
  const prevInstruments = useRef<Map<string, InstrumentData>>(new Map());
  const prevModuleStatuses = useRef<Map<string, string>>(new Map());
  const prevSignalIds = useRef<Set<string>>(new Set());
  const prevPositionIds = useRef<Map<string, Position>>(new Map());
  const isInitialized = useRef(false);

  useEffect(() => {
    // Skip the first render to avoid alerting on initial data load
    if (!isInitialized.current) {
      // Populate initial state
      if (data.instruments) {
        for (const inst of data.instruments) {
          prevInstruments.current.set(inst.name, inst);
        }
      }
      if (data.modules) {
        for (const mod of data.modules) {
          prevModuleStatuses.current.set(mod.shortName, mod.status);
        }
      }
      if (data.signals) {
        for (const sig of data.signals) {
          prevSignalIds.current.add(sig.id);
        }
      }
      if (data.positions) {
        for (const pos of data.positions) {
          prevPositionIds.current.set(pos.id, pos);
        }
      }
      isInitialized.current = true;
      return;
    }

    // --- Check for AI Decision changes (GO signals) ---
    if (data.instruments) {
      for (const inst of data.instruments) {
        const prev = prevInstruments.current.get(inst.name);

        // New GO signal detected
        if (inst.aiDecision === 'GO' && prev?.aiDecision !== 'GO') {
          dispatchAlert(
            'go_signal',
            `${inst.displayName} — GO SIGNAL`,
            `AI Decision: GO with ${(inst.aiConfidence * 100).toFixed(0)}% confidence. ${inst.aiRationale}`,
            inst.name,
          );
        }

        // Update previous state
        prevInstruments.current.set(inst.name, inst);
      }
    }

    // --- Check for module health degradation ---
    if (data.modules) {
      for (const mod of data.modules) {
        const prevStatus = prevModuleStatuses.current.get(mod.shortName);

        // Module went from active/warning to error
        if (
          mod.status === 'error' &&
          prevStatus !== 'error' &&
          prevStatus !== undefined &&
          prevStatus !== 'idle'
        ) {
          dispatchAlert(
            'module_down',
            `${mod.name} — DOWN`,
            `Module stopped responding. Last message: ${mod.message}`,
          );
        }

        prevModuleStatuses.current.set(mod.shortName, mod.status);
      }
    }

    // --- Check for new signals ---
    if (data.signals) {
      for (const sig of data.signals) {
        if (!prevSignalIds.current.has(sig.id)) {
          // Only alert on high-severity signals to reduce noise
          if (sig.severity === 'high') {
            dispatchAlert(
              'new_signal',
              `${sig.instrument} — ${sig.type.replace(/_/g, ' ').toUpperCase()}`,
              sig.description,
              sig.instrument,
            );
          }
          prevSignalIds.current.add(sig.id);
        }
      }
      // Keep the set from growing unbounded
      if (prevSignalIds.current.size > 500) {
        const signalIdArray = Array.from(prevSignalIds.current);
        prevSignalIds.current = new Set(signalIdArray.slice(-200));
      }
    }

    // --- Check for position changes ---
    if (data.positions) {
      const currentPositionMap = new Map<string, Position>();
      for (const pos of data.positions) {
        currentPositionMap.set(pos.id, pos);
      }

      // Check for new positions
      for (const pos of data.positions) {
        const prevPos = prevPositionIds.current.get(pos.id);

        if (!prevPos) {
          // New position opened
          dispatchAlert(
            'position_opened',
            `Position Opened — ${pos.instrument}`,
            `${pos.type} @ Strike ${pos.strike}, Entry: ₹${pos.entryPrice.toFixed(2)}, Qty: ${pos.quantity}`,
            pos.instrument,
          );
        } else if (prevPos.status === 'OPEN' && pos.status === 'CLOSED') {
          // Position closed
          const pnlStr = pos.pnl >= 0 ? `+₹${pos.pnl.toFixed(2)}` : `-₹${Math.abs(pos.pnl).toFixed(2)}`;

          // Determine if it was SL or TP hit
          if (pos.pnl < 0) {
            dispatchAlert(
              'stop_loss_hit',
              `Stop Loss Hit — ${pos.instrument}`,
              `${pos.type} @ Strike ${pos.strike} closed. P&L: ${pnlStr} (${pos.pnlPercent.toFixed(1)}%)`,
              pos.instrument,
            );
          } else {
            dispatchAlert(
              'target_profit_hit',
              `Target Profit Hit — ${pos.instrument}`,
              `${pos.type} @ Strike ${pos.strike} closed. P&L: ${pnlStr} (+${pos.pnlPercent.toFixed(1)}%)`,
              pos.instrument,
            );
          }
        }
      }

      // Update previous positions
      prevPositionIds.current = currentPositionMap;
    }
  }, [data.instruments, data.modules, data.signals, data.positions, dispatchAlert]);
}
