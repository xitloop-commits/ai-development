/** Bottom-centre fullscreen toggle for a chart pane (shared, 2026-08-13).
 *  Expands the pane to fill the viewport (parent applies `fixed inset-0`);
 *  Esc or a second click restores. Used by InstrumentChartPage's grid panes
 *  and the NSE/MCX MultiChartPage panes. */
export function PaneFullscreenBtn({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={active ? "Exit fullscreen (Esc)" : "Fullscreen this pane"}
      className="absolute bottom-1 left-1/2 -translate-x-1/2 z-30 rounded border border-border/60 bg-background/80 p-1 text-muted-foreground opacity-40 hover:opacity-100 hover:text-foreground backdrop-blur transition-opacity"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {active ? (
          <path d="M9 3v6H3M21 9h-6V3M3 15h6v6M15 21v-6h6" />
        ) : (
          <path d="M8 3H3v5M21 8V3h-5M3 16v5h5M16 21h5v-5" />
        )}
      </svg>
    </button>
  );
}
