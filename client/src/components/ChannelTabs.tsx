/**
 * ChannelTabs — Workspace tab strip (AI / My / Testing).
 *
 * Each tab represents one workspace. Clicking a different tab opens a
 * confirm popover ("switch channels?") and on confirm switches the
 * active channel via CapitalContext.
 *
 * Last-used mode memory: switching FROM a workspace stores its current
 * mode (live / paper / sandbox) in `lastModeForWs`. Switching BACK to
 * that workspace lands on the same mode without needing to hoist state
 * into the React tree. The state is shared with `ChannelModeToggle`
 * (which still lives in AppBar.tsx) — see `lastModeForWs` export.
 *
 * Extracted from AppBar.tsx during UI-119 so it has its own test surface.
 */
import { useEffect, useState } from 'react';
import {
  type Channel,
  type Workspace,
  type Mode,
  channelOf,
  channelToWorkspace,
  channelToMode,
} from '@/lib/tradeTypes';
import { useCapital } from '@/contexts/CapitalContext';
import { ConfirmPopover } from './ConfirmPopover';

export const TAB_DEFS: Array<{
  ws: Workspace;
  label: string;
  tone: { active: string; idle: string };
}> = [
  { ws: 'ai',      label: 'AI Trades',  tone: { active: 'bg-violet-pulse/15 text-violet-pulse',     idle: 'text-muted-foreground hover:text-foreground hover:bg-secondary/50' } },
  { ws: 'my',      label: 'My Trades',  tone: { active: 'bg-bullish/15 text-bullish',               idle: 'text-muted-foreground hover:text-foreground hover:bg-secondary/50' } },
  { ws: 'testing', label: 'Testing',    tone: { active: 'bg-warning-amber/15 text-warning-amber',   idle: 'text-muted-foreground hover:text-foreground hover:bg-secondary/50' } },
];

/**
 * Module-level memory of the last-used mode per workspace. Mutated by
 * both `ChannelTabs` (via the useEffect that mirrors the active mode)
 * and `ChannelModeToggle` (when the user toggles mode within a tab).
 */
export const lastModeForWs: Record<Workspace, Mode> = {
  ai: 'paper',
  my: 'paper',
  testing: 'sandbox',
};

export function ChannelTabs() {
  const { channel, setChannel } = useCapital() as any;
  const currentWs = channelToWorkspace(channel);
  const currentMode = channelToMode(channel);

  // Keep module-level memory in sync with the active channel.
  useEffect(() => {
    lastModeForWs[currentWs] = currentMode;
  }, [currentWs, currentMode]);

  const [confirmTarget, setConfirmTarget] = useState<Channel | null>(null);

  const requestTabSwitch = (ws: Workspace) => {
    if (ws === currentWs) return;
    setConfirmTarget(channelOf(ws, lastModeForWs[ws]));
  };

  const onConfirmSwitch = () => {
    if (!confirmTarget) return;
    setChannel(confirmTarget);
    setConfirmTarget(null);
  };

  return (
    <div className="relative flex items-stretch self-stretch">
      {TAB_DEFS.map(({ ws, label, tone }) => {
        const isActive = ws === currentWs;
        return (
          <button
            key={ws}
            onClick={() => requestTabSwitch(ws)}
            className={`px-4 text-[0.625rem] font-bold tracking-wider uppercase transition-colors border-r border-border ${
              isActive ? tone.active : tone.idle
            }`}
          >
            {label}
            {isActive && currentMode === 'live' && (
              <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-bullish animate-pulse" />
            )}
          </button>
        );
      })}
      <ConfirmPopover
        open={!!confirmTarget}
        anchor="center"
        message={
          confirmTarget
            ? `Switch from ${channel} to ${confirmTarget}? Open positions on the source remain; new orders route to the target.`
            : ''
        }
        onConfirm={onConfirmSwitch}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}

export default ChannelTabs;
