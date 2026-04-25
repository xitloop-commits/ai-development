import type { Workspace } from './tradeTypes';

export const INSTRUMENT_COLORS: Record<string, { bg: string; text: string }> = {
  'NIFTY 50': { bg: 'bg-blue-500/15', text: 'text-blue-400' },
  'BANK NIFTY': { bg: 'bg-purple-500/15', text: 'text-purple-400' },
  'CRUDE OIL': { bg: 'bg-amber-500/15', text: 'text-amber-400' },
  'NATURAL GAS': { bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
};

export function getInstrumentStyle(name: string) {
  return INSTRUMENT_COLORS[name] ?? { bg: 'bg-slate-500/15', text: 'text-slate-400' };
}

export function supportsManualControls(workspace: Workspace): boolean {
  return workspace === 'live' || workspace === 'paper_manual';
}

export function getWorkspaceBadgeMeta(workspace: Workspace): { label: string; className: string } {
  switch (workspace) {
    case 'live':
      return { label: 'LIVE', className: 'bg-bullish/20 text-bullish' };
    case 'paper_manual':
      return { label: 'MANUAL PAPER', className: 'bg-warning-amber/20 text-warning-amber' };
    default:
      return { label: 'AI PAPER', className: 'bg-violet-pulse/20 text-violet-pulse' };
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

export function getWorkspaceThemeMeta(workspace: Workspace): WorkspaceThemeMeta {
  switch (workspace) {
    case 'live':
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
    case 'paper_manual':
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
