/**
 * SettingsOverlay — True fullscreen overlay for Settings.
 * Reuses all section components from the Settings page.
 * Triggered by Ctrl+S, dismissed by Esc or close button.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  Wallet,
  Zap,
  ShieldCheck,
  Clock,
  CalendarClock,
  Receipt,
  Landmark,
  ChevronRight,
  Settings,
  X,
} from 'lucide-react';
import {
  BrokerConfigSection,
  OrderExecutionSection,
  DisciplineSection,
  TimeWindowsSection,
  ExpiryControlsSection,
  ChargesSection,
  CapitalManagementSection,
} from '@/pages/Settings';

type SettingsSection =
  | 'broker'
  | 'execution'
  | 'discipline'
  | 'timeWindows'
  | 'expiry'
  | 'charges'
  | 'capital';

interface SectionItem {
  id: SettingsSection;
  label: string;
  icon: React.ElementType;
  description: string;
}

const SECTIONS: SectionItem[] = [
  { id: 'broker', label: 'Broker Config', icon: Wallet, description: 'Active broker, credentials, connection status' },
  { id: 'execution', label: 'Order Execution', icon: Zap, description: 'Entry offset, SL/TP, targets, trailing stop' },
  { id: 'discipline', label: 'Discipline', icon: ShieldCheck, description: 'Circuit breaker, trade limits, pre-trade gate, streaks' },
  { id: 'timeWindows', label: 'Time Windows', icon: Clock, description: 'NSE & MCX trading time restrictions' },
  { id: 'expiry', label: 'Expiry Controls', icon: CalendarClock, description: 'Per-instrument expiry day rules' },
  { id: 'charges', label: 'Charges', icon: Receipt, description: 'Brokerage, STT, GST, and other charge rates' },
  { id: 'capital', label: 'Capital Management', icon: Landmark, description: 'Reset initial capital, pool allocation' },
];

interface SettingsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SettingsOverlay({ open, onOpenChange }: SettingsOverlayProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('broker');
  const [isAnimating, setIsAnimating] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  // Handle open/close animation
  useEffect(() => {
    if (open) {
      setIsVisible(true);
      // Trigger enter animation on next frame
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsAnimating(true);
        });
      });
    } else {
      setIsAnimating(false);
      // Wait for exit animation before unmounting
      const timer = setTimeout(() => {
        setIsVisible(false);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Handle Esc key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        e.stopPropagation();
        onOpenChange(false);
      }
    },
    [open, onOpenChange]
  );

  useEffect(() => {
    if (open) {
      window.addEventListener('keydown', handleKeyDown, true);
      return () => window.removeEventListener('keydown', handleKeyDown, true);
    }
  }, [open, handleKeyDown]);

  // Prevent body scroll when overlay is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [open]);

  const renderSection = () => {
    switch (activeSection) {
      case 'broker':
        return <BrokerConfigSection />;
      case 'execution':
        return <OrderExecutionSection />;
      case 'discipline':
        return <DisciplineSection />;
      case 'timeWindows':
        return <TimeWindowsSection />;
      case 'expiry':
        return <ExpiryControlsSection />;
      case 'charges':
        return <ChargesSection />;
      case 'capital':
        return <CapitalManagementSection />;
      default:
        return null;
    }
  };

  const currentSection = SECTIONS.find((s) => s.id === activeSection);

  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-background/80 backdrop-blur-sm transition-opacity duration-200 ${
          isAnimating ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={() => onOpenChange(false)}
      />

      {/* Fullscreen Panel */}
      <div
        className={`absolute inset-0 flex flex-col bg-background border-t border-border transition-all duration-200 ${
          isAnimating
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 translate-y-2'
        }`}
      >
        {/* Header */}
        <div className="shrink-0 px-6 py-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-primary" />
            <h1 className="font-display text-base font-bold tracking-tight text-foreground">
              Settings
            </h1>
            <span className="text-[9px] text-muted-foreground tracking-widest uppercase ml-2">
              Ctrl+S to toggle
            </span>
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close settings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body: Sidebar + Content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar Navigation */}
          <div className="w-60 shrink-0 border-r border-border overflow-y-auto py-4 px-3">
            <nav className="space-y-0.5">
              {SECTIONS.map((section) => {
                const isActive = activeSection === section.id;
                const Icon = section.icon;
                return (
                  <button
                    key={section.id}
                    onClick={() => setActiveSection(section.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-left transition-all ${
                      isActive
                        ? 'bg-primary/10 border border-primary/20 text-foreground'
                        : 'hover:bg-accent text-muted-foreground hover:text-foreground border border-transparent'
                    }`}
                  >
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-primary' : ''}`} />
                    <div className="flex-1 min-w-0">
                      <span className={`text-[10px] font-bold tracking-wider uppercase block ${isActive ? 'text-primary' : ''}`}>
                        {section.label}
                      </span>
                      <span className="text-[8px] text-muted-foreground truncate block mt-0.5">
                        {section.description}
                      </span>
                    </div>
                    {isActive && (
                      <ChevronRight className="h-3 w-3 text-primary shrink-0" />
                    )}
                  </button>
                );
              })}
            </nav>

            {/* Footer hint */}
            <div className="mt-6 px-3">
              <span className="text-[9px] text-muted-foreground tracking-wider uppercase">
                Settings are persisted to MongoDB
              </span>
            </div>
          </div>

          {/* Main Content */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden p-6">
            {/* Section Header */}
            <div className="mb-5 max-w-3xl">
              <div className="flex items-center gap-2 mb-1">
                {currentSection && <currentSection.icon className="h-4 w-4 text-primary" />}
                <h2 className="font-display text-base font-bold tracking-tight text-foreground">
                  {currentSection?.label}
                </h2>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {currentSection?.description}
              </p>
            </div>

            {/* Section Content */}
            <div className="animate-fade-in-up max-w-3xl">
              {renderSection()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
