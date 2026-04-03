/**
 * SettingsOverlay — Full-screen dialog overlay for Settings.
 * Reuses all section components from the Settings page.
 * Triggered by Ctrl+S, dismissed by Esc.
 */
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Wallet,
  Zap,
  ShieldCheck,
  Clock,
  CalendarClock,
  Receipt,
  ChevronRight,
  Settings,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { toast } from 'sonner';
import {
  BrokerConfigSection,
  OrderExecutionSection,
  DisciplineSection,
  TimeWindowsSection,
  ExpiryControlsSection,
  ChargesSection,
} from '@/pages/Settings';

type SettingsSection =
  | 'broker'
  | 'execution'
  | 'discipline'
  | 'timeWindows'
  | 'expiry'
  | 'charges';

interface SectionItem {
  id: SettingsSection;
  label: string;
  icon: React.ElementType;
  description: string;
}

const SECTIONS: SectionItem[] = [
  { id: 'broker', label: 'Broker Config', icon: Wallet, description: 'Active broker, credentials, connection status' },
  { id: 'execution', label: 'Order Execution', icon: Zap, description: 'Entry offset, SL/TP, order & product type' },
  { id: 'discipline', label: 'Discipline', icon: ShieldCheck, description: 'Trade limits, loss limits, checklist rules' },
  { id: 'timeWindows', label: 'Time Windows', icon: Clock, description: 'NSE & MCX trading time restrictions' },
  { id: 'expiry', label: 'Expiry Controls', icon: CalendarClock, description: 'Per-instrument expiry day rules' },
  { id: 'charges', label: 'Charges', icon: Receipt, description: 'Brokerage, STT, GST, and other charge rates' },
];

interface SettingsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SettingsOverlay({ open, onOpenChange }: SettingsOverlayProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('broker');

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
      default:
        return null;
    }
  };

  const currentSection = SECTIONS.find((s) => s.id === activeSection);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[85vh] p-0 gap-0 bg-background border-border overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border">
          <DialogTitle className="flex items-center gap-2 text-base font-display font-bold tracking-tight">
            <Settings className="h-4 w-4 text-primary" />
            Settings
            <span className="text-[9px] text-muted-foreground tracking-widest uppercase ml-2">
              Ctrl+S to toggle
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar Navigation */}
          <div className="w-56 shrink-0 border-r border-border overflow-y-auto py-3 px-2">
            <nav className="space-y-0.5">
              {SECTIONS.map((section) => {
                const isActive = activeSection === section.id;
                const Icon = section.icon;
                return (
                  <button
                    key={section.id}
                    onClick={() => setActiveSection(section.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-left transition-all ${
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
          </div>

          {/* Main Content */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden p-6">
            {/* Section Header */}
            <div className="mb-5">
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
            <div className="animate-fade-in-up max-w-2xl">
              {renderSection()}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
