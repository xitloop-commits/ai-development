/**
 * WatchlistPane — the left pane of the Stocks workspace (30% width).
 *
 * A search box (typeahead over the Dhan scrip master, NSE cash equities) with an
 * "add" dropdown, and below it the persisted watchlist (the stock master). Live
 * LTP + buy/sell land in a later iteration; this is the search + list.
 */
import { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";

export function WatchlistPane() {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounce the search input (200ms).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  // Close the results dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const utils = trpc.useUtils();
  const listQ = trpc.stocks.list.useQuery();
  const searchQ = trpc.stocks.search.useQuery(
    { query: debounced },
    { enabled: debounced.length >= 1, staleTime: 60_000, refetchOnWindowFocus: false },
  );
  const addMut = trpc.stocks.add.useMutation({
    onSuccess: () => { utils.stocks.list.invalidate(); utils.stocks.quotes.invalidate(); },
  });
  const removeMut = trpc.stocks.remove.useMutation({
    onSuccess: () => { utils.stocks.list.invalidate(); utils.stocks.quotes.invalidate(); },
  });

  const watchlist = listQ.data ?? [];
  const added = new Set(watchlist.map((s) => s.securityId));
  const results = searchQ.data ?? [];

  // Live LTP + today's change per stock, polled every 3s (one batched call).
  const quotesQ = trpc.stocks.quotes.useQuery(undefined, {
    enabled: watchlist.length > 0,
    refetchInterval: 3_000,
    refetchOnWindowFocus: true,
  });
  const quotes = quotesQ.data ?? {};

  return (
    <div className="flex flex-col h-full border-r border-border bg-card/40">
      {/* Search */}
      <div ref={boxRef} className="relative p-2 border-b border-border shrink-0">
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Search NSE stocks…"
          className="w-full px-2 py-1.5 text-xs rounded bg-background border border-border focus:border-info-cyan outline-none placeholder:text-muted-foreground"
        />
        {open && debounced.length >= 1 && (
          <div className="absolute left-2 right-2 top-full mt-1 z-30 max-h-80 overflow-auto rounded border border-border bg-popover shadow-lg">
            {searchQ.isFetching && results.length === 0 && (
              <div className="px-2 py-2 text-[0.625rem] text-muted-foreground">Searching…</div>
            )}
            {!searchQ.isFetching && results.length === 0 && (
              <div className="px-2 py-2 text-[0.625rem] text-muted-foreground">No matches.</div>
            )}
            {results.map((r) => {
              const isAdded = added.has(r.securityId);
              return (
                <button
                  key={r.securityId}
                  onClick={() => {
                    if (isAdded) return;
                    addMut.mutate(r);
                    setQuery("");
                    setOpen(false);
                  }}
                  disabled={isAdded}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/50 disabled:cursor-default"
                >
                  <span className="text-xs font-bold text-foreground w-24 shrink-0 truncate">{r.symbol}</span>
                  <span className="text-[0.625rem] text-muted-foreground truncate flex-1">{r.name}</span>
                  <span className={`text-[0.5rem] font-bold shrink-0 ${isAdded ? "text-bullish" : "text-info-cyan"}`}>
                    {isAdded ? "✓ added" : "+ add"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Watchlist */}
      <div className="flex-1 overflow-auto scrollbar-thin">
        {watchlist.length === 0 ? (
          <div className="px-3 py-8 text-center text-[0.625rem] text-muted-foreground leading-relaxed">
            Search and add NSE stocks to build your watchlist.
          </div>
        ) : (
          watchlist.map((s) => {
            const q = quotes[s.securityId];
            const hasChange = q && q.ltp > 0 && q.prevClose > 0;
            const up = (q?.change ?? 0) >= 0;
            return (
              <div
                key={s.securityId}
                className="group flex items-center gap-2 px-2 py-1.5 border-b border-border/50 hover:bg-muted/30"
              >
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-xs font-bold text-foreground truncate">{s.symbol}</span>
                  <span className="text-[0.5625rem] text-muted-foreground truncate">{s.name}</span>
                </div>

                {/* Live LTP + today's change (polled every 3s). */}
                <div className="flex flex-col items-end tabular-nums shrink-0 min-w-[64px]">
                  <span className="text-xs font-bold text-foreground">
                    {q && q.ltp > 0
                      ? q.ltp.toFixed(2)
                      : q && q.prevClose > 0
                        ? q.prevClose.toFixed(2)
                        : "—"}
                  </span>
                  {hasChange && (
                    <span className={`text-[0.5625rem] font-semibold ${up ? "text-bullish" : "text-destructive"}`}>
                      {up ? "+" : ""}{q.change.toFixed(2)} ({up ? "+" : ""}{q.changePct.toFixed(2)}%)
                    </span>
                  )}
                </div>

                <button
                  onClick={() => removeMut.mutate({ securityId: s.securityId })}
                  className="opacity-0 group-hover:opacity-100 text-[0.625rem] text-destructive px-1.5 py-0.5 rounded hover:bg-destructive/10 transition-opacity shrink-0"
                  title="Remove from watchlist"
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
