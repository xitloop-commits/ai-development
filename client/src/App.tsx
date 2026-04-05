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

function isTradingDeskMockupRoute() {
  if (typeof window === "undefined") return false;

  const params = new URLSearchParams(window.location.search);
  return (
    params.get("mockup") === "trading-desk-current" ||
    window.location.pathname === "/mockups/trading-desk-current"
  );
}

function App() {
  const showTradingDeskMockup = isTradingDeskMockupRoute();

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <AlertProvider>
          <InstrumentFilterProvider>
            <TooltipProvider>
              <Toaster
                theme="dark"
                toastOptions={{
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
