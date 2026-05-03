import { lazy, Suspense, useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AlertProvider } from "./contexts/AlertContext";
import { InstrumentFilterProvider } from "./contexts/InstrumentFilterContext";
import { CapitalProvider } from "./contexts/CapitalContext";
import MainScreen from "./components/MainScreen";
import { CredentialGate } from "./components/CredentialGate";

// Mockup + H2H pages are reached only via specific URL params (?mockup=…, ?view=h2h),
// so they shouldn't be in the main bundle. Lazy-load them.
const TradingDeskMockupPage = lazy(() => import("./mockups/TradingDeskMockupPage"));
const HeadToHeadPage = lazy(() => import("./pages/HeadToHeadPage"));

function isTradingDeskMockupRoute() {
  if (typeof window === "undefined") return false;

  // H6 — mockup pages are dev-only. In production builds, hitting
  // ?mockup=… or /mockups/… redirects to "/" so the mockup tree never
  // renders. Vite tree-shakes the lazy-import chunk too because the
  // call to `<TradingDeskMockupPage />` is unreachable.
  if (!import.meta.env.DEV) return false;

  const params = new URLSearchParams(window.location.search);
  return (
    params.get("mockup") === "trading-desk-current" ||
    window.location.pathname === "/mockups/trading-desk-current"
  );
}

function isHeadToHeadRoute() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "h2h" || window.location.pathname === "/h2h";
}

function App() {
  const showTradingDeskMockup = isTradingDeskMockupRoute();
  const showHeadToHead = isHeadToHeadRoute();

  // H6 — in production, if a user lands on a mockup URL, redirect to
  // home instead of silently rendering MainScreen at the wrong URL.
  // Single replaceState so the mockup URL doesn't pollute history.
  useEffect(() => {
    if (import.meta.env.DEV) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const isMockupUrl =
      params.get("mockup") === "trading-desk-current" ||
      window.location.pathname.startsWith("/mockups/");
    if (isMockupUrl) {
      window.history.replaceState({}, "", "/");
    }
  }, []);

  // Enter fullscreen on first user interaction
  useEffect(() => {
    const enterFullscreen = () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      }
      document.removeEventListener('click', enterFullscreen);
      document.removeEventListener('keydown', enterFullscreen);
    };
    document.addEventListener('click', enterFullscreen, { once: true });
    document.addEventListener('keydown', enterFullscreen, { once: true });
    return () => {
      document.removeEventListener('click', enterFullscreen);
      document.removeEventListener('keydown', enterFullscreen);
    };
  }, []);

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <AlertProvider>
          <InstrumentFilterProvider>
            <TooltipProvider>
              <Toaster
                theme="dark"
                position="bottom-right"
                offset={{ bottom: 96, right: 16 }}
                closeButton
                toastOptions={{
                  duration: 6000,
                  classNames: {
                    toast: "font-mono !rounded-md !shadow-lg",
                    info: "!bg-[oklch(0.15_0.03_210)] !border-info-cyan/30 !text-info-cyan",
                    error: "!bg-[oklch(0.15_0.03_25)] !border-destructive/30 !text-destructive",
                    warning: "!bg-[oklch(0.15_0.03_55)] !border-warning-amber/30 !text-warning-amber",
                    success: "!bg-[oklch(0.15_0.03_145)] !border-bullish/30 !text-bullish",
                  },
                  style: {
                    background: 'oklch(0.15 0.01 250)',
                    border: '1px solid oklch(0.25 0.01 250)',
                    color: 'oklch(0.82 0.01 250)',
                    fontFamily: "'JetBrains Mono', monospace",
                  },
                }}
              />
              {showTradingDeskMockup ? (
                <Suspense fallback={<div className="p-4 text-xs text-muted-foreground">Loading mockup…</div>}>
                  <TradingDeskMockupPage />
                </Suspense>
              ) : showHeadToHead ? (
                <Suspense fallback={<div className="p-4 text-xs text-muted-foreground">Loading…</div>}>
                  <HeadToHeadPage />
                </Suspense>
              ) : (
                <CredentialGate>
                  <CapitalProvider>
                    <MainScreen />
                  </CapitalProvider>
                </CredentialGate>
              )}
            </TooltipProvider>
          </InstrumentFilterProvider>
        </AlertProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
