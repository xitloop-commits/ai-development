/*
 * Terminal Noir — Settings Page (Placeholder)
 * Sidebar navigation with 6 sections: Broker Config, Order Execution,
 * Discipline, Time Windows, Expiry Controls, Charges.
 * Will be implemented in Feature 4.
 */
import { useState } from 'react';
import {
  Settings, Globe, Crosshair, Shield, Clock,
  Calendar, Receipt, ChevronRight,
} from 'lucide-react';

const SETTINGS_SECTIONS = [
  {
    id: 'broker',
    label: 'Broker Config',
    icon: Globe,
    description: 'Active broker, credentials, connection status, token management',
  },
  {
    id: 'execution',
    label: 'Order Execution',
    icon: Crosshair,
    description: 'Order entry offset, SL/TP defaults, order type, product type',
  },
  {
    id: 'discipline',
    label: 'Discipline',
    icon: Shield,
    description: 'Loss limits, trade limits, cooldowns, pre-trade gate, journal enforcement',
  },
  {
    id: 'time-windows',
    label: 'Time Windows',
    icon: Clock,
    description: 'No-trading first/last N minutes, lunch break pause, per-exchange config',
  },
  {
    id: 'expiry',
    label: 'Expiry Controls',
    icon: Calendar,
    description: 'Per-instrument expiry rules, auto-exit, position size reduction near expiry',
  },
  {
    id: 'charges',
    label: 'Charges',
    icon: Receipt,
    description: 'Brokerage, STT, exchange fees, GST, SEBI, stamp duty rates',
  },
] as const;

type SectionId = typeof SETTINGS_SECTIONS[number]['id'];

function BrokerConfigSection() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-4 rounded border border-border bg-secondary/20">
        <div>
          <div className="text-[10px] text-muted-foreground tracking-wider uppercase mb-1">Active Broker</div>
          <div className="text-sm font-bold text-foreground">Dhan</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-bullish animate-pulse-glow" />
          <span className="text-[10px] text-bullish font-bold tracking-wider">CONNECTED</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="p-3 rounded border border-border">
          <div className="text-[9px] text-muted-foreground tracking-wider uppercase mb-1">Client ID</div>
          <div className="text-[12px] tabular-nums text-foreground">1101615161</div>
        </div>
        <div className="p-3 rounded border border-border">
          <div className="text-[9px] text-muted-foreground tracking-wider uppercase mb-1">API Latency</div>
          <div className="text-[12px] tabular-nums text-bullish">45ms</div>
        </div>
        <div className="p-3 rounded border border-border">
          <div className="text-[9px] text-muted-foreground tracking-wider uppercase mb-1">Token Status</div>
          <div className="text-[12px] text-bullish font-bold">Valid</div>
        </div>
        <div className="p-3 rounded border border-border">
          <div className="text-[9px] text-muted-foreground tracking-wider uppercase mb-1">Token Expires</div>
          <div className="text-[12px] tabular-nums text-muted-foreground">23h 45m</div>
        </div>
      </div>
      <button className="w-full py-2 rounded border border-info-cyan/30 bg-info-cyan/5 text-info-cyan text-[10px] font-bold tracking-wider hover:bg-info-cyan/10 transition-colors">
        UPDATE ACCESS TOKEN
      </button>
    </div>
  );
}

function PlaceholderSection({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <Settings className="h-8 w-8 text-muted-foreground/20 mb-3" />
      <p className="text-[12px] text-muted-foreground font-bold">{title} — Coming Soon</p>
      <p className="text-[10px] text-muted-foreground/60 mt-1 text-center max-w-md">
        {description}
      </p>
    </div>
  );
}

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SectionId>('broker');
  const currentSection = SETTINGS_SECTIONS.find(s => s.id === activeSection)!;

  return (
    <div className="container py-6">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-foreground">
          Settings
        </h1>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Configure broker, execution, discipline, time windows, expiry controls, and charges
        </p>
      </div>

      {/* Two-column: Sidebar + Content */}
      <div className="grid grid-cols-[240px_1fr] gap-4">
        {/* Sidebar Navigation */}
        <div className="border border-border rounded-md bg-card overflow-hidden self-start sticky top-[110px]">
          <div className="px-3 py-2.5 border-b border-border bg-secondary/30">
            <span className="text-[9px] font-bold text-info-cyan tracking-wider uppercase">
              Configuration
            </span>
          </div>
          <nav className="p-1.5">
            {SETTINGS_SECTIONS.map((section) => {
              const Icon = section.icon;
              const isActive = activeSection === section.id;
              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={`
                    w-full flex items-center gap-2 px-3 py-2 rounded text-left transition-all
                    ${isActive
                      ? 'bg-primary/10 text-primary border border-primary/20'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary/30 border border-transparent'
                    }
                  `}
                >
                  <Icon className={`h-3.5 w-3.5 ${isActive ? 'text-primary' : ''}`} />
                  <span className="text-[11px] font-bold tracking-wider">{section.label}</span>
                  {isActive && <ChevronRight className="h-3 w-3 ml-auto" />}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Content Area */}
        <div className="border border-border rounded-md bg-card">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <currentSection.icon className="h-4 w-4 text-primary" />
            <span className="text-[11px] font-bold text-foreground tracking-wider uppercase">
              {currentSection.label}
            </span>
          </div>
          <div className="p-4">
            {activeSection === 'broker' ? (
              <BrokerConfigSection />
            ) : (
              <PlaceholderSection
                title={currentSection.label}
                description={currentSection.description}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
