import { useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AlertProvider } from "./contexts/AlertContext";
import { InstrumentFilterProvider } from "./contexts/InstrumentFilterContext";
import { CapitalProvider } from "./contexts/CapitalContext";
import MainScreen from "./components/MainScreen";
import { CredentialGate } from "./components/CredentialGate";
import { SetupBrokerModal } from "./components/SetupBrokerModal";
import TradingDeskMockupPage from "./mockups/TradingDeskMockupPage";
import HeadToHeadPage from "./pages/HeadToHeadPage";

function isTradingDeskMockupRoute() {
  if (typeof window === "undefined") return false;

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
                position="bottom-center"
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
                <TradingDeskMockupPage />
              ) : showHeadToHead ? (
                <HeadToHeadPage />
              ) : (
                <>
                  <SetupBrokerModal />
                  <CredentialGate>
                    <CapitalProvider>
                      <MainScreen />
                    </CapitalProvider>
                  </CredentialGate>
                </>
              )}
            </TooltipProvider>
          </InstrumentFilterProvider>
        </AlertProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
