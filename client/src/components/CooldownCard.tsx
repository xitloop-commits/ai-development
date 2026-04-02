/**
 * CooldownCard — Countdown timer card shown after a stop-loss hit or consecutive losses.
 *
 * Two states:
 *   1. Awaiting acknowledgment: "I accept the loss" button
 *   2. Timer running: countdown with progress ring
 */
import { useState, useEffect } from 'react';
import { Clock, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface CooldownCardProps {
  type: 'revenge' | 'consecutive_loss';
  endsAt: Date;
  acknowledged: boolean;
  onAcknowledge: () => void;
  onExpired: () => void;
}

export default function CooldownCard({
  type,
  endsAt,
  acknowledged,
  onAcknowledge,
  onExpired,
}: CooldownCardProps) {
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [acknowledgmentText, setAcknowledgmentText] = useState('');

  useEffect(() => {
    if (!acknowledged) return;

    const interval = setInterval(() => {
      const now = new Date();
      const remaining = Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 1000));
      setRemainingSeconds(remaining);

      if (remaining <= 0) {
        clearInterval(interval);
        onExpired();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [acknowledged, endsAt, onExpired]);

  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  const isRevenge = type === 'revenge';
  const title = isRevenge ? 'Revenge Trade Cooldown' : 'Consecutive Loss Cooldown';
  const borderColor = isRevenge ? 'border-warning-amber/30' : 'border-loss-red/30';
  const bgColor = isRevenge ? 'bg-warning-amber/5' : 'bg-loss-red/5';
  const textColor = isRevenge ? 'text-warning-amber' : 'text-loss-red';

  // Acknowledgment state
  if (!acknowledged) {
    const requiredText = 'I accept the loss';
    const isValid = acknowledgmentText.toLowerCase().trim() === requiredText.toLowerCase();

    return (
      <div className={`border ${borderColor} rounded-md ${bgColor} p-4 space-y-3`}>
        <div className="flex items-center gap-2">
          <AlertTriangle className={`h-5 w-5 ${textColor}`} />
          <div>
            <div className={`text-sm font-bold font-display ${textColor}`}>{title}</div>
            <div className="text-[9px] text-muted-foreground">
              Acknowledge your loss before the cooldown timer starts
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-[9px] text-muted-foreground block">
            Type "{requiredText}" to acknowledge:
          </label>
          <input
            type="text"
            value={acknowledgmentText}
            onChange={(e) => setAcknowledgmentText(e.target.value)}
            placeholder={requiredText}
            className="w-full px-3 py-2 rounded border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:border-warning-amber/50"
          />
          <button
            onClick={onAcknowledge}
            disabled={!isValid}
            className={`w-full py-2 rounded text-[10px] font-bold uppercase tracking-wider transition-colors ${
              isValid
                ? 'bg-warning-amber/20 text-warning-amber hover:bg-warning-amber/30 border border-warning-amber/30'
                : 'bg-border text-muted-foreground/40 cursor-not-allowed'
            }`}
          >
            Start Cooldown Timer
          </button>
        </div>
      </div>
    );
  }

  // Timer running
  if (remainingSeconds <= 0) return null;

  // Progress ring
  const radius = 28;
  const circumference = 2 * Math.PI * radius;
  const totalDuration = isRevenge ? 15 * 60 : 30 * 60; // default durations
  const progress = ((totalDuration - remainingSeconds) / totalDuration) * circumference;

  return (
    <div className={`border ${borderColor} rounded-md ${bgColor} p-4`}>
      <div className="flex items-center gap-4">
        {/* Progress Ring */}
        <svg width="70" height="70" viewBox="0 0 70 70" className="flex-shrink-0">
          <circle cx="35" cy="35" r={radius} fill="none" stroke="#1a2332" strokeWidth="4" />
          <circle
            cx="35" cy="35" r={radius}
            fill="none"
            stroke={isRevenge ? '#FFB800' : '#FF3B5C'}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference - progress}
            transform="rotate(-90 35 35)"
            style={{ transition: 'stroke-dashoffset 1s linear' }}
          />
          <text x="35" y="32" textAnchor="middle" className="fill-foreground font-display text-sm font-bold">
            {minutes}:{seconds.toString().padStart(2, '0')}
          </text>
          <text x="35" y="44" textAnchor="middle" className="fill-muted-foreground text-[7px] uppercase">
            remaining
          </text>
        </svg>

        {/* Info */}
        <div className="flex-1">
          <div className="flex items-center gap-1.5">
            <Clock className={`h-4 w-4 ${textColor}`} />
            <span className={`text-sm font-bold font-display ${textColor}`}>{title}</span>
          </div>
          <p className="text-[9px] text-muted-foreground mt-1 leading-relaxed">
            {isRevenge
              ? 'Take a deep breath. Review your trade. The market will still be there when the timer ends.'
              : 'Multiple consecutive losses detected. This extended cooldown protects your capital from emotional decisions.'}
          </p>
        </div>
      </div>
    </div>
  );
}
