import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AlertProvider } from "./contexts/AlertContext";
import { InstrumentFilterProvider } from "./contexts/InstrumentFilterContext";
import AppLayout from "./components/AppLayout";
import Dashboard from "./pages/Dashboard";
import PositionTracker from "./pages/PositionTracker";
import Discipline from "./pages/Discipline";
import TradeJournal from "./pages/TradeJournal";
import Settings from "./pages/Settings";

function Router() {
  return (
    <AppLayout>
      <Switch>
        <Route path={"/"} component={Dashboard} />
        <Route path={"/tracker"} component={PositionTracker} />
        <Route path={"/discipline"} component={Discipline} />
        <Route path={"/journal"} component={TradeJournal} />
        <Route path={"/settings"} component={Settings} />
        <Route path={"/404"} component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

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
              <Router />
            </TooltipProvider>
          </InstrumentFilterProvider>
        </AlertProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
