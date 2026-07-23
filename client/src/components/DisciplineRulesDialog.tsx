/**
 * DisciplineRulesDialog — every discipline rule in one place, editable.
 *
 * Opened from the shield CTA on the app bar. Each rule has an ON/OFF pill plus
 * its thresholds; changes apply IMMEDIATELY (no Apply button) because a rule you
 * meant to switch off but left staged is a rule that is still blocking — or
 * still permitting — real orders.
 *
 * `updateSettings` validates each module as a WHOLE object (not a partial), so
 * every patch sends the complete sub-object with the current values merged in.
 *
 * Deliberately NOT here: the carry-forward internals and IV-classifier tunables.
 * They are deep, interdependent config, not on/off policy, and belong in the
 * Settings page where they can be explained.
 */
import { trpc } from '@/lib/trpc';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertTriangle } from 'lucide-react';
import { InfoDot } from './InfoDot';

/** A numeric threshold belonging to a rule. */
interface Field {
  prop: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}

/** One rule = one settings key with an `enabled` flag and 0+ thresholds. */
interface Rule {
  key: string;
  label: string;
  hint: string;
  fields?: Field[];
}

const GROUPS: { title: string; rules: Rule[] }[] = [
  {
    title: 'Circuit breaker',
    rules: [
      {
        key: 'dailyLossLimit',
        label: 'Daily loss limit',
        hint: 'Stop trading once the day is down this much of capital.',
        fields: [{ prop: 'thresholdPercent', label: 'Limit', min: 0, max: 100, step: 0.5, suffix: '%' }],
      },
      {
        key: 'maxConsecutiveLosses',
        label: 'Consecutive losses',
        hint: 'Pause after this many losses in a row.',
        fields: [
          { prop: 'maxLosses', label: 'Losses', min: 1, max: 20 },
          { prop: 'cooldownMinutes', label: 'Cooldown', min: 0, max: 720, suffix: 'm' },
        ],
      },
    ],
  },
  {
    title: 'Trade limits',
    rules: [
      {
        key: 'maxTradesPerDay',
        label: 'Max trades / day',
        hint: 'Hard cap on how many trades can be placed in a session.',
        fields: [{ prop: 'limit', label: 'Limit', min: 1, max: 100 }],
      },
      {
        key: 'maxOpenPositions',
        label: 'Max open positions',
        hint: 'How many trades may be open at once.',
        fields: [{ prop: 'limit', label: 'Limit', min: 1, max: 50 }],
      },
      {
        key: 'preventDuplicatePositions',
        label: 'One position per instrument',
        hint: 'ON blocks a second trade on the same underlying while one is open.',
      },
      {
        key: 'revengeCooldown',
        label: 'Revenge cooldown',
        hint: 'Forced wait after a loss, so the next trade is not a reaction.',
        fields: [{ prop: 'durationMinutes', label: 'Wait', min: 0, max: 720, suffix: 'm' }],
      },
    ],
  },
  {
    title: 'Time windows',
    rules: [
      {
        key: 'noTradingAfterOpen',
        label: 'No trading after open',
        hint: 'Skip the opening minutes, where spreads are widest.',
        fields: [
          { prop: 'nseMinutes', label: 'NSE', min: 0, max: 60, suffix: 'm' },
          { prop: 'mcxMinutes', label: 'MCX', min: 0, max: 60, suffix: 'm' },
        ],
      },
      {
        key: 'noTradingBeforeClose',
        label: 'No trading before close',
        hint: 'Stop opening new trades near the bell.',
        fields: [
          { prop: 'nseMinutes', label: 'NSE', min: 0, max: 60, suffix: 'm' },
          { prop: 'mcxMinutes', label: 'MCX', min: 0, max: 60, suffix: 'm' },
        ],
      },
    ],
  },
  {
    title: 'Position sizing',
    rules: [
      {
        key: 'maxPositionSize',
        label: 'Max position size',
        hint: 'Largest single trade, as % of capital.',
        fields: [{ prop: 'percentOfCapital', label: 'Max', min: 0, max: 100, step: 1, suffix: '%' }],
      },
      {
        key: 'maxTotalExposure',
        label: 'Max total exposure',
        hint: 'Largest combined open exposure, as % of capital.',
        fields: [{ prop: 'percentOfCapital', label: 'Max', min: 0, max: 100, step: 1, suffix: '%' }],
      },
    ],
  },
  {
    title: 'Journal & streaks',
    rules: [
      {
        key: 'journalEnforcement',
        label: 'Journal enforcement',
        hint: 'Block new trades once this many are left unjournaled.',
        fields: [{ prop: 'maxUnjournaled', label: 'Allowed', min: 0, max: 100 }],
      },
      {
        key: 'winningStreakReminder',
        label: 'Winning streak reminder',
        hint: 'Nudge after a good run — the point where size creeps up.',
        fields: [{ prop: 'triggerAfterDays', label: 'After', min: 1, max: 365, suffix: 'd' }],
      },
      {
        key: 'losingStreakAutoReduce',
        label: 'Losing streak auto-reduce',
        hint: 'Cut size automatically after a bad run.',
        fields: [
          { prop: 'triggerAfterDays', label: 'After', min: 1, max: 365, suffix: 'd' },
          { prop: 'reduceByPercent', label: 'Cut', min: 0, max: 100, suffix: '%' },
        ],
      },
    ],
  },
];

export function DisciplineRulesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = trpc.discipline.getSettings.useQuery(undefined, { enabled: open });
  const utils = trpc.useUtils();
  const save = trpc.discipline.updateSettings.useMutation({
    onSuccess: () => { void utils.discipline.getSettings.invalidate(); },
    onError: (e) => window.alert(`Could not save: ${e.message}`),
  });
  const s = q.data as Record<string, any> | undefined;

  /** Merge into the CURRENT sub-object — the schema rejects partial modules. */
  const patch = (key: string, changes: Record<string, unknown>) => {
    if (!s?.[key]) return;
    save.mutate({ [key]: { ...s[key], ...changes } } as never);
  };

  const liveOn = s?.liveEnforcement?.enabled ?? true;
  const simOn = s?.simulationEnforcement?.enabled ?? true;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-1.5">
            Discipline rules
            <InfoDot text="Changes save immediately — no Apply. Carry-forward and IV-classifier tuning stay in Settings; they are interdependent config rather than on/off policy." />
          </DialogTitle>
        </DialogHeader>

        {q.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}

        {s && (
          <div className="space-y-4">
            {/* Master switches first — they override every rule below. */}
            <div className="rounded-lg border border-border p-2.5 space-y-2">
              <span className="flex items-center gap-1.5">
                <span className="text-[0.6875rem] font-bold">Enforcement</span>
                <InfoDot text="Master switches. OFF means every rule below is skipped for that book — nothing checks a trade before it is placed." />
              </span>
              {([
                ['liveEnforcement', 'Live', 'live · live', liveOn],
                ['simulationEnforcement', 'Paper', 'paper', simOn],
              ] as const).map(([key, label, sub, on]) => (
                <div key={key} className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[0.6875rem] font-bold">{label}</div>
                    <div className="text-[0.5625rem] text-muted-foreground font-mono">{sub}</div>
                  </div>
                  <Pill
                    on={on}
                    danger={key === 'liveEnforcement'}
                    onClick={() => {
                      if (key === 'liveEnforcement' && on &&
                        !window.confirm(
                          'Turn OFF live discipline?\n\nReal-money orders will skip EVERY rule — loss cap, ' +
                          'position caps, R:R gate, cooldowns. Nothing will stop a bad trade.',
                        )
                      ) return;
                      save.mutate({ [key]: { enabled: !on } } as never);
                    }}
                  />
                </div>
              ))}
              {!liveOn && (
                <div className="flex items-start gap-1.5 text-[0.5625rem] text-loss-red">
                  <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                  <span>Live discipline is OFF — real orders are running with no limits.</span>
                </div>
              )}
            </div>

            {/* Pre-trade gate — nested, so it gets its own row. */}
            <div className="rounded-lg border border-border p-2.5 space-y-2">
              <div className="text-[0.6875rem] font-bold">Pre-trade gate</div>
              <RuleRow
                label="Gate enabled"
                hint="Master switch for the checks run before an order is sent."
                on={!!s.preTradeGate?.enabled}
                onToggle={() => patch('preTradeGate', { enabled: !s.preTradeGate?.enabled })}
              />
              <RuleRow
                label="Minimum reward : risk"
                hint="Reject a trade whose target is not this many times its stop."
                on={!!s.preTradeGate?.minRiskReward?.enabled}
                onToggle={() =>
                  patch('preTradeGate', {
                    minRiskReward: {
                      ...s.preTradeGate.minRiskReward,
                      enabled: !s.preTradeGate?.minRiskReward?.enabled,
                    },
                  })
                }
                fields={[{ prop: 'ratio', label: 'Ratio', min: 0, max: 20, step: 0.1 }]}
                values={s.preTradeGate?.minRiskReward ?? {}}
                onField={(prop, v) =>
                  patch('preTradeGate', {
                    minRiskReward: { ...s.preTradeGate.minRiskReward, [prop]: v },
                  })
                }
              />
            </div>

            {GROUPS.map((g) => (
              <div key={g.title} className="rounded-lg border border-border p-2.5 space-y-2">
                <div className="text-[0.6875rem] font-bold">{g.title}</div>
                {g.rules.map((r) => (
                  <RuleRow
                    key={r.key}
                    label={r.label}
                    hint={r.hint}
                    on={!!s[r.key]?.enabled}
                    onToggle={() => patch(r.key, { enabled: !s[r.key]?.enabled })}
                    fields={r.fields}
                    values={s[r.key] ?? {}}
                    onField={(prop, v) => patch(r.key, { [prop]: v })}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Pill({ on, onClick, danger }: { on: boolean; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-[0.625rem] font-bold shrink-0 transition-colors ${
        on ? 'bg-bullish/15 text-bullish'
          : danger ? 'bg-loss-red/20 text-loss-red' : 'bg-muted text-muted-foreground'
      }`}
    >
      {on ? 'ON' : 'OFF'}
    </button>
  );
}

function RuleRow({
  label, hint, on, onToggle, fields, values, onField,
}: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
  fields?: Field[];
  values?: Record<string, any>;
  onField?: (prop: string, v: number) => void;
}) {
  return (
    <div className="border-t border-border/40 pt-1.5 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-[0.6875rem] font-bold">{label}</span>
          <InfoDot text={hint} />
        </span>
        <Pill on={on} onClick={onToggle} />
      </div>
      {fields && fields.length > 0 && (
        // Thresholds stay visible but greyed when the rule is off — hiding them
        // makes it impossible to see what a rule WOULD do before enabling it.
        <div className={`flex gap-3 mt-1 ${on ? '' : 'opacity-40'}`}>
          {fields.map((f) => (
            <label key={f.prop} className="flex items-center gap-1 text-[0.5625rem] text-muted-foreground">
              {f.label}
              <input
                type="number"
                min={f.min}
                max={f.max}
                step={f.step ?? 1}
                value={values?.[f.prop] ?? 0}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= f.min && v <= f.max) onField?.(f.prop, v);
                }}
                className="w-14 rounded border border-border bg-background px-1 py-0.5 text-[0.625rem] tabular-nums text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              {f.suffix}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
