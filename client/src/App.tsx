import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AlertProvider } from "./contexts/AlertContext";
import { InstrumentFilterProvider } from "./contexts/InstrumentFilterContext";
import MainScreen from "./components/MainScreen";

function App() {
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
              <MainScreen />
            </TooltipProvider>
          </InstrumentFilterProvider>
        </AlertProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
