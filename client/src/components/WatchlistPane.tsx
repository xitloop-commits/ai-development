/**
 * WatchlistPane — the left pane of the Stocks workspace (30% width).
 *
 * A search box (typeahead over the Dhan scrip master, NSE cash equities) with an
 * "add" dropdown, and below it the persisted watchlist (the stock master). Live
 * LTP + buy/sell land in a later iteration; this is the search + list.
 */
import { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { useInstrumentTick } from "@/hooks/useTickStream";
import { useFeedSubscriptions } from "@/hooks/useFeedControl";
import { useStagedOrders } from "@/contexts/StagedOrdersContext";

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

  // Clicking a watchlist stock stages a draft BUY order in the desk (right pane).
  const { stage } = useStagedOrders();

  // Subscribe every watchlist stock on the live feed (full mode → LTP ticks + a
  // prev-close packet) for REAL-TIME updates. useFeedSubscriptions re-subscribes
  // only when the id-set changes and releases all subs when this pane unmounts.
  useFeedSubscriptions(watchlist.map((s) => ({ securityId: s.securityId, exchange: "NSE_EQ" })));

  // Fallback/seed: a batched OHLC quote (LTP + prev close) for the whole
  // watchlist, polled slowly. The WS tick only fires once a stock trades, so
  // illiquid names would stay blank; this guarantees every row shows a price.
  const quotesQ = trpc.stocks.quotes.useQuery(undefined, {
    enabled: watchlist.length > 0,
    refetchInterval: 5_000,
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
          watchlist.map((s) => (
            <WatchlistRow
              key={s.securityId}
              stock={s}
              fallback={quotes[s.securityId]}
              onPick={() => stage({ securityId: s.securityId, symbol: s.symbol })}
              onRemove={() => removeMut.mutate({ securityId: s.securityId })}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface WatchlistRowProps {
  stock: { securityId: string; symbol: string; name: string };
  /** Batched-quote seed (LTP + prev close) used until/unless the WS ticks. */
  fallback?: { ltp: number; prevClose: number };
  onPick: () => void;
  onRemove: () => void;
}

/**
 * One watchlist row — subscribes to its OWN stock's live ticks so it re-renders
 * only on its own tick (never a global fan-out). Price = the live WS LTP when it
 * has ticked, otherwise the batched-quote fallback (so illiquid names that never
 * tick still show a price). Change = LTP − prevClose. Clicking the row stages a
 * draft BUY order; the ✕ removes it from the watchlist.
 */
function WatchlistRow({ stock, fallback, onPick, onRemove }: WatchlistRowProps) {
  const tick = useInstrumentTick("NSE_EQ", stock.securityId);
  // Prefer the live WS tick; fall back to the polled quote when it hasn't ticked.
  const ltp = tick && tick.ltp > 0 ? tick.ltp : fallback?.ltp ?? 0;
  const prevClose = tick && tick.prevClose > 0 ? tick.prevClose : fallback?.prevClose ?? 0;
  const hasChange = ltp > 0 && prevClose > 0;
  const change = hasChange ? ltp - prevClose : 0;
  const changePct = hasChange ? (change / prevClose) * 100 : 0;
  const up = change >= 0;

  return (
    <div
      onClick={onPick}
      className="group relative flex items-center gap-2 px-2.5 py-1.5 border-b border-border/50 hover:bg-muted/30 cursor-pointer"
      title={`Add a buy order for ${stock.symbol}`}
    >
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-xs font-bold text-foreground truncate">{stock.symbol}</span>
        <span className="text-[0.5625rem] text-muted-foreground truncate">{stock.name}</span>
      </div>

      {/* Live LTP + today's change (real-time ticks). Right-aligns to the same
          edge as the index rows — the remove ✕ is absolute so it never insets it. */}
      <div className="flex flex-col items-end tabular-nums shrink-0 min-w-[64px]">
        <span className="text-xs font-bold text-foreground">
          {ltp > 0 ? ltp.toFixed(2) : prevClose > 0 ? prevClose.toFixed(2) : "—"}
        </span>
        {hasChange && (
          <span className={`text-[0.5625rem] font-semibold ${up ? "text-bullish" : "text-destructive"}`}>
            {up ? "+" : ""}{change.toFixed(2)} ({up ? "+" : ""}{changePct.toFixed(2)}%)
          </span>
        )}
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-[0.625rem] text-destructive px-1.5 py-0.5 rounded bg-background/80 hover:bg-destructive/10 transition-opacity"
        title="Remove from watchlist"
      >
        ✕
      </button>
    </div>
  );
}
