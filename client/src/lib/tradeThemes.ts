import type { Channel, Workspace } from './tradeTypes';
import { channelToWorkspace, isLiveChannel } from './tradeTypes';

export const INSTRUMENT_COLORS: Record<string, { bg: string; text: string }> = {
  'NIFTY 50': { bg: 'bg-blue-500/15', text: 'text-blue-400' },
  'BANK NIFTY': { bg: 'bg-purple-500/15', text: 'text-purple-400' },
  'CRUDE OIL': { bg: 'bg-amber-500/15', text: 'text-amber-400' },
  'NATURAL GAS': { bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
};

export function getInstrumentStyle(name: string) {
  return INSTRUMENT_COLORS[name] ?? { bg: 'bg-slate-500/15', text: 'text-slate-400' };
}

/** Manual order controls allowed on My-* and Testing-* channels (not on AI channels). */
export function supportsManualControls(channel: Channel): boolean {
  const ws = channelToWorkspace(channel);
  return ws === 'my' || ws === 'testing';
}

/** Badge label + classes for a channel (workspace × mode). */
export function getChannelBadgeMeta(channel: Channel): { label: string; className: string } {
  const ws = channelToWorkspace(channel);
  const live = isLiveChannel(channel);
  switch (ws) {
    case 'my':
      return live
        ? { label: 'MY LIVE', className: 'bg-bullish/20 text-bullish' }
        : { label: 'MY PAPER', className: 'bg-bullish/15 text-bullish/80' };
    case 'ai':
      return live
        ? { label: 'AI LIVE', className: 'bg-violet-pulse/20 text-violet-pulse' }
        : { label: 'AI PAPER', className: 'bg-violet-pulse/15 text-violet-pulse/80' };
    case 'testing':
      return live
        ? { label: 'TEST LIVE', className: 'bg-warning-amber/20 text-warning-amber' }
        : { label: 'TEST', className: 'bg-warning-amber/15 text-warning-amber/80' };
  }
}

export interface WorkspaceThemeMeta {
  text: string;
  textSoft: string;
  textDim: string;
  rowBg: string;
  rowBgHover: string;
  todayBg: string;
  todayAltBg: string;
  summaryBg: string;
  summaryBorder: string;
  borderStrong: string;
  borderSoft: string;
  button: string;
  buttonActive: string;
}

/** Theme is keyed by workspace (color identity), not channel — Live and Paper share a tone. */
export function getWorkspaceThemeMeta(workspace: Workspace): WorkspaceThemeMeta {
  switch (workspace) {
    case 'my':
      return {
        text: 'text-bullish',
        textSoft: 'text-bullish/80',
        textDim: 'text-bullish/60',
        rowBg: 'bg-bullish/[0.04]',
        rowBgHover: 'hover:bg-bullish/[0.08]',
        todayBg: 'bg-bullish/[0.08]',
        todayAltBg: 'bg-bullish/[0.04]',
        summaryBg: 'bg-bullish/20',
        summaryBorder: 'border-bullish/30',
        borderStrong: 'border-l-bullish',
        borderSoft: 'border-l-bullish/50',
        button: 'bg-bullish/15 text-bullish hover:bg-bullish/25',
        buttonActive: 'bg-bullish/20 text-bullish',
      };
    case 'testing':
      return {
        text: 'text-warning-amber',
        textSoft: 'text-warning-amber/80',
        textDim: 'text-warning-amber/60',
        rowBg: 'bg-warning-amber/[0.04]',
        rowBgHover: 'hover:bg-warning-amber/[0.08]',
        todayBg: 'bg-warning-amber/[0.08]',
        todayAltBg: 'bg-warning-amber/[0.04]',
        summaryBg: 'bg-warning-amber/20',
        summaryBorder: 'border-warning-amber/30',
        borderStrong: 'border-l-warning-amber',
        borderSoft: 'border-l-warning-amber/50',
        button: 'bg-warning-amber/15 text-warning-amber hover:bg-warning-amber/25',
        buttonActive: 'bg-warning-amber/20 text-warning-amber',
      };
    case 'ai':
    default:
      return {
        text: 'text-violet-pulse',
        textSoft: 'text-violet-pulse/80',
        textDim: 'text-violet-pulse/60',
        rowBg: 'bg-violet-pulse/[0.04]',
        rowBgHover: 'hover:bg-violet-pulse/[0.08]',
        todayBg: 'bg-violet-pulse/[0.08]',
        todayAltBg: 'bg-violet-pulse/[0.04]',
        summaryBg: 'bg-violet-pulse/20',
        summaryBorder: 'border-violet-pulse/30',
        borderStrong: 'border-l-violet-pulse',
        borderSoft: 'border-l-violet-pulse/50',
        button: 'bg-violet-pulse/15 text-violet-pulse hover:bg-violet-pulse/25',
        buttonActive: 'bg-violet-pulse/20 text-violet-pulse',
      };
  }
}

/** Convenience: theme directly from a channel. */
export function getChannelThemeMeta(channel: Channel): WorkspaceThemeMeta {
  return getWorkspaceThemeMeta(channelToWorkspace(channel));
}
