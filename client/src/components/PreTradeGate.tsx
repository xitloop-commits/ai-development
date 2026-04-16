/**
 * PreTradeGate — Inline pre-trade checklist confirmation
 *
 * Shown before a trade is submitted. Contains 7 checks:
 *   1. Plan alignment (soft)
 *   2. Pre-entry checklist done (soft)
 *   3. R:R ratio acceptable (hard)
 *   4. Position size within limits (hard — auto-checked)
 *   5. Total exposure within limits (hard — auto-checked)
 *   6. Emotional state (hard)
 *   7. Stop loss defined (soft)
 *
 * Hard checks block the trade. Soft checks show warnings but allow override.
 */
import { useState, useMemo } from 'react';
import {
  Shield,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

type EmotionalState = 'calm' | 'anxious' | 'revenge' | 'fomo' | 'greedy' | 'neutral';

interface PreTradeGateProps {
  /** Estimated R:R ratio from AI or manual input */
  riskReward?: number;
  /** Position value as % of capital */
  positionPercent: number;
  /** Max position size % from settings */
  maxPositionPercent: number;
  /** Total exposure % including this trade */
  exposurePercent: number;
  /** Max exposure % from settings */
  maxExposurePercent: number;
  /** Whether stop loss is defined */
  hasStopLoss: boolean;
  /** Called when gate is passed (all hard checks ok) */
  onPass: (data: { emotionalState: EmotionalState; planAligned: boolean; checklistDone: boolean }) => void;
  /** Called when user cancels */
  onCancel: () => void;
}

interface CheckItem {
  id: string;
  label: string;
  type: 'hard' | 'soft';
  autoCheck?: boolean;
  passed: boolean;
  description?: string;
}

export default function PreTradeGate({
  riskReward,
  positionPercent,
  maxPositionPercent,
  exposurePercent,
  maxExposurePercent,
  hasStopLoss,
  onPass,
  onCancel,
}: PreTradeGateProps) {
  const [planAligned, setPlanAligned] = useState(false);
  const [checklistDone, setChecklistDone] = useState(false);
  const [emotionalState, setEmotionalState] = useState<EmotionalState>('calm');
  const [expanded, setExpanded] = useState(true);

  const blockedEmotions: EmotionalState[] = ['revenge', 'fomo'];

  const checks = useMemo<CheckItem[]>(() => [
    {
      id: 'plan',
      label: 'Trade aligned with plan',
      type: 'soft',
      passed: planAligned,
      description: 'Is this trade part of your pre-market analysis?',
    },
    {
      id: 'checklist',
      label: 'Pre-entry checklist done',
      type: 'soft',
      passed: checklistDone,
      description: 'Have you reviewed support/resistance, volume, and trend?',
    },
    {
      id: 'rr',
      label: `R:R ratio ≥ 1.5${riskReward ? ` (current: 1:${riskReward.toFixed(1)})` : ''}`,
      type: 'hard',
      autoCheck: true,
      passed: riskReward === undefined || riskReward >= 1.5,
      description: riskReward !== undefined && riskReward < 1.5 ? 'Risk:Reward ratio too low' : undefined,
    },
    {
      id: 'position',
      label: `Position size ≤ ${maxPositionPercent}% (current: ${positionPercent.toFixed(1)}%)`,
      type: 'hard',
      autoCheck: true,
      passed: positionPercent <= maxPositionPercent,
    },
    {
      id: 'exposure',
      label: `Total exposure ≤ ${maxExposurePercent}% (current: ${exposurePercent.toFixed(1)}%)`,
      type: 'hard',
      autoCheck: true,
      passed: exposurePercent <= maxExposurePercent,
    },
    {
      id: 'emotion',
      label: `Emotional state: ${emotionalState}`,
      type: 'hard',
      passed: !blockedEmotions.includes(emotionalState),
      description: blockedEmotions.includes(emotionalState) ? 'Step away and calm down before trading' : undefined,
    },
    {
      id: 'stoploss',
      label: 'Stop loss defined',
      type: 'soft',
      passed: hasStopLoss,
      description: !hasStopLoss ? 'Consider setting a stop loss for risk management' : undefined,
    },
  ], [planAligned, checklistDone, emotionalState, riskReward, positionPercent, maxPositionPercent, exposurePercent, maxExposurePercent, hasStopLoss]);

  const hardFails = checks.filter((c) => c.type === 'hard' && !c.passed);
  const softFails = checks.filter((c) => c.type === 'soft' && !c.passed);
  const allHardPassed = hardFails.length === 0;
  const passedCount = checks.filter((c) => c.passed).length;

  const handleSubmit = () => {
    if (!allHardPassed) return;
    onPass({ emotionalState, planAligned, checklistDone });
  };

  return (
    <div className="border border-info-cyan/20 rounded-md bg-card overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-info-cyan/5 hover:bg-info-cyan/10 transition-colors"
      >
        <Shield className="h-3.5 w-3.5 text-info-cyan" />
        <span className="text-[0.625rem] font-bold uppercase tracking-wider text-info-cyan">
          Pre-Trade Gate
        </span>
        <span className="text-[0.5625rem] text-muted-foreground ml-1">
          {passedCount}/{checks.length} checks passed
        </span>
        <div className="ml-auto flex items-center gap-1">
          {!allHardPassed && (
            <span className="text-[0.5rem] text-loss-red font-bold uppercase">BLOCKED</span>
          )}
          {expanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
        </div>
      </button>

      {expanded && (
        <div className="p-3 space-y-3">
          {/* Checks */}
          <div className="space-y-1.5">
            {checks.map((check) => (
              <div key={check.id} className="flex items-start gap-2">
                {check.passed ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-profit-green mt-0.5 flex-shrink-0" />
                ) : check.type === 'hard' ? (
                  <XCircle className="h-3.5 w-3.5 text-loss-red mt-0.5 flex-shrink-0" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 text-warning-amber mt-0.5 flex-shrink-0" />
                )}
                <div className="flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[0.625rem] ${check.passed ? 'text-muted-foreground' : check.type === 'hard' ? 'text-loss-red' : 'text-warning-amber'}`}>
                      {check.label}
                    </span>
                    {check.type === 'hard' && !check.autoCheck && (
                      <span className="text-[0.4375rem] text-loss-red/60 uppercase">required</span>
                    )}
                    {check.type === 'soft' && (
                      <span className="text-[0.4375rem] text-muted-foreground/40 uppercase">optional</span>
                    )}
                  </div>
                  {check.description && !check.passed && (
                    <div className="text-[0.5rem] text-muted-foreground/60 mt-0.5">{check.description}</div>
                  )}
                </div>

                {/* Interactive toggles for manual checks */}
                {check.id === 'plan' && (
                  <button
                    onClick={() => setPlanAligned(!planAligned)}
                    className={`text-[0.5rem] px-2 py-0.5 rounded border transition-colors ${
                      planAligned ? 'bg-profit-green/10 border-profit-green/30 text-profit-green' : 'border-border text-muted-foreground hover:border-muted-foreground'
                    }`}
                  >
                    {planAligned ? 'Yes' : 'No'}
                  </button>
                )}
                {check.id === 'checklist' && (
                  <button
                    onClick={() => setChecklistDone(!checklistDone)}
                    className={`text-[0.5rem] px-2 py-0.5 rounded border transition-colors ${
                      checklistDone ? 'bg-profit-green/10 border-profit-green/30 text-profit-green' : 'border-border text-muted-foreground hover:border-muted-foreground'
                    }`}
                  >
                    {checklistDone ? 'Done' : 'Not yet'}
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Emotional State Selector */}
          <div>
            <span className="text-[0.5625rem] text-muted-foreground uppercase tracking-wider block mb-1.5">Emotional State</span>
            <div className="flex gap-1 flex-wrap">
              {(['calm', 'neutral', 'anxious', 'fomo', 'revenge', 'greedy'] as EmotionalState[]).map((state) => {
                const isBlocked = blockedEmotions.includes(state);
                const isSelected = emotionalState === state;
                return (
                  <button
                    key={state}
                    onClick={() => setEmotionalState(state)}
                    className={`text-[0.5625rem] px-2 py-1 rounded border transition-colors capitalize ${
                      isSelected
                        ? isBlocked
                          ? 'bg-loss-red/10 border-loss-red/40 text-loss-red'
                          : 'bg-profit-green/10 border-profit-green/40 text-profit-green'
                        : 'border-border text-muted-foreground hover:border-muted-foreground'
                    }`}
                  >
                    {state}
                    {isBlocked && isSelected && ' ✕'}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1 border-t border-border">
            {!allHardPassed && (
              <div className="flex-1 text-[0.5625rem] text-loss-red">
                {hardFails.length} hard check{hardFails.length > 1 ? 's' : ''} failed — trade blocked
              </div>
            )}
            {allHardPassed && softFails.length > 0 && (
              <div className="flex-1 text-[0.5625rem] text-warning-amber">
                {softFails.length} warning{softFails.length > 1 ? 's' : ''} — proceed with caution
              </div>
            )}
            {allHardPassed && softFails.length === 0 && (
              <div className="flex-1 text-[0.5625rem] text-profit-green">All checks passed</div>
            )}
            <button
              onClick={onCancel}
              className="px-3 py-1.5 rounded border border-border text-[0.625rem] text-muted-foreground hover:bg-card transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!allHardPassed}
              className={`px-4 py-1.5 rounded text-[0.625rem] font-bold uppercase tracking-wider transition-colors ${
                allHardPassed
                  ? 'bg-profit-green/20 text-profit-green hover:bg-profit-green/30 border border-profit-green/30'
                  : 'bg-border text-muted-foreground/40 cursor-not-allowed'
              }`}
            >
              Confirm Trade
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
