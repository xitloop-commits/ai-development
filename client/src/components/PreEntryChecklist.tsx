/**
 * PreEntryChecklist — Interactive step-by-step GO/NO-GO overlay
 * before placing a trade. Evaluates 8 risk factors and gives
 * a readiness score.
 */
import { useState, useMemo } from 'react';
import {
  Shield, ShieldCheck, ShieldAlert, ShieldX,
  CheckCircle2, XCircle, AlertTriangle, ChevronRight,
  TrendingUp, TrendingDown, Activity, Clock, BarChart3,
  Newspaper, Target, Scale, X,
} from 'lucide-react';
import type { InstrumentData } from '@/lib/types';

interface ChecklistItem {
  id: string;
  label: string;
  category: string;
  icon: React.ElementType;
  evaluate: (data: InstrumentData) => CheckResult;
}

interface CheckResult {
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  score: number; // 0-100
}

// ─── Checklist evaluation functions ───

function evalSRAlignment(data: InstrumentData): CheckResult {
  const dir = data.tradeDirection;
  if (!dir || dir === 'WAIT') {
    return { status: 'fail', detail: 'No trade direction set — AI says WAIT', score: 0 };
  }

  const sup = data.supportAnalysis;
  const res = data.resistanceAnalysis;

  if (dir === 'GO_CALL') {
    // For bullish: support should be strong, resistance should be weak or far
    const supStrength = sup?.strength || 0;
    const resPrediction = res?.prediction;
    if (supStrength >= 70 && resPrediction === 'BREAKOUT') {
      return { status: 'pass', detail: `Strong support (${supStrength}%) + breakout expected at resistance`, score: 95 };
    }
    if (supStrength >= 50) {
      return { status: 'pass', detail: `Moderate support (${supStrength}%) holding. ${resPrediction === 'BOUNCE' ? 'Resistance may hold — watch closely' : ''}`, score: 70 };
    }
    return { status: 'warn', detail: `Weak support (${supStrength}%). Price may break down.`, score: 40 };
  } else {
    // GO_PUT: resistance should be strong, support should be weak
    const resStrength = res?.strength || 0;
    const supPrediction = sup?.prediction;
    if (resStrength >= 70 && supPrediction === 'BREAKDOWN') {
      return { status: 'pass', detail: `Strong resistance (${resStrength}%) + breakdown expected at support`, score: 95 };
    }
    if (resStrength >= 50) {
      return { status: 'pass', detail: `Moderate resistance (${resStrength}%) holding. ${supPrediction === 'BOUNCE' ? 'Support may hold — watch closely' : ''}`, score: 70 };
    }
    return { status: 'warn', detail: `Weak resistance (${resStrength}%). Price may break up.`, score: 40 };
  }
}

function evalIVAssessment(data: InstrumentData): CheckResult {
  const iv = data.ivAssessment;
  if (!iv || iv.assessment === 'UNKNOWN') {
    return { status: 'warn', detail: 'IV data not available', score: 50 };
  }
  if (iv.assessment === 'CHEAP') {
    return { status: 'pass', detail: `IV is cheap at ${iv.atm_iv}% — options are underpriced`, score: 90 };
  }
  if (iv.assessment === 'FAIR') {
    return { status: 'pass', detail: `IV is fair at ${iv.atm_iv}% — normal pricing`, score: 70 };
  }
  return { status: 'warn', detail: `IV is expensive at ${iv.atm_iv}% — options overpriced, theta decay risk`, score: 35 };
}

function evalThetaRisk(data: InstrumentData): CheckResult {
  const theta = data.thetaAssessment;
  if (!theta || theta.days_to_expiry === null) {
    return { status: 'warn', detail: 'Theta/expiry data not available', score: 50 };
  }
  if (theta.days_to_expiry >= 5) {
    return { status: 'pass', detail: `${theta.days_to_expiry} days to expiry — comfortable time decay`, score: 90 };
  }
  if (theta.days_to_expiry >= 2) {
    return { status: 'warn', detail: `${theta.days_to_expiry} days to expiry — theta accelerating (-₹${theta.theta_per_day}/day)`, score: 50 };
  }
  return { status: 'fail', detail: `Only ${theta.days_to_expiry} day(s) to expiry — extreme theta decay (-₹${theta.theta_per_day}/day)`, score: 15 };
}

function evalNewsSentiment(data: InstrumentData): CheckResult {
  const news = data.newsDetail;
  if (!news) {
    return { status: 'warn', detail: 'No news sentiment data available', score: 50 };
  }

  const dir = data.tradeDirection;
  const isBullish = news.sentiment === 'Bullish';
  const isBearish = news.sentiment === 'Bearish';

  if (dir === 'GO_CALL' && isBullish) {
    return { status: 'pass', detail: `News is bullish (${news.bull_score} bull / ${news.bear_score} bear) — aligns with CALL`, score: 85 };
  }
  if (dir === 'GO_PUT' && isBearish) {
    return { status: 'pass', detail: `News is bearish (${news.bear_score} bear / ${news.bull_score} bull) — aligns with PUT`, score: 85 };
  }
  if (news.sentiment === 'Neutral') {
    return { status: 'warn', detail: `News is neutral — no strong directional bias`, score: 55 };
  }
  // Opposite sentiment
  return { status: 'fail', detail: `News is ${news.sentiment} but trade is ${dir} — sentiment conflict!`, score: 20 };
}

function evalRiskReward(data: InstrumentData): CheckResult {
  const setup = data.tradeSetup;
  if (!setup) {
    return { status: 'warn', detail: 'No trade setup available — cannot assess R:R', score: 40 };
  }
  if (setup.risk_reward >= 2.5) {
    return { status: 'pass', detail: `Excellent R:R of 1:${setup.risk_reward} — high reward potential`, score: 95 };
  }
  if (setup.risk_reward >= 1.5) {
    return { status: 'pass', detail: `Good R:R of 1:${setup.risk_reward} — acceptable risk`, score: 75 };
  }
  if (setup.risk_reward >= 1) {
    return { status: 'warn', detail: `Marginal R:R of 1:${setup.risk_reward} — barely worth the risk`, score: 45 };
  }
  return { status: 'fail', detail: `Poor R:R of 1:${setup.risk_reward} — risk exceeds reward`, score: 10 };
}

function evalPCRTrend(data: InstrumentData): CheckResult {
  const pcr = data.pcrRatio;
  const dir = data.tradeDirection;

  if (pcr === 0) {
    return { status: 'warn', detail: 'PCR data not available', score: 50 };
  }

  if (dir === 'GO_CALL') {
    if (pcr >= 1.2) return { status: 'pass', detail: `PCR ${pcr.toFixed(2)} — strong put writing supports bullish view`, score: 90 };
    if (pcr >= 0.8) return { status: 'warn', detail: `PCR ${pcr.toFixed(2)} — neutral, no strong OI bias`, score: 55 };
    return { status: 'fail', detail: `PCR ${pcr.toFixed(2)} — heavy call writing suggests bearish bias`, score: 20 };
  } else if (dir === 'GO_PUT') {
    if (pcr <= 0.7) return { status: 'pass', detail: `PCR ${pcr.toFixed(2)} — heavy call writing supports bearish view`, score: 90 };
    if (pcr <= 1.0) return { status: 'warn', detail: `PCR ${pcr.toFixed(2)} — neutral, no strong OI bias`, score: 55 };
    return { status: 'fail', detail: `PCR ${pcr.toFixed(2)} — strong put writing suggests bullish bias`, score: 20 };
  }
  return { status: 'warn', detail: `PCR ${pcr.toFixed(2)} — no direction to evaluate against`, score: 50 };
}

function evalAIConfidence(data: InstrumentData): CheckResult {
  const conf = data.aiConfidence;
  if (conf >= 0.75) {
    return { status: 'pass', detail: `AI confidence is high at ${(conf * 100).toFixed(0)}%`, score: 90 };
  }
  if (conf >= 0.55) {
    return { status: 'warn', detail: `AI confidence is moderate at ${(conf * 100).toFixed(0)}% — proceed with caution`, score: 60 };
  }
  return { status: 'fail', detail: `AI confidence is low at ${(conf * 100).toFixed(0)}% — high uncertainty`, score: 25 };
}

function evalRiskFlags(data: InstrumentData): CheckResult {
  const flags = data.riskFlags || [];
  const dangerCount = flags.filter(f => f.type === 'danger').length;
  const warnCount = flags.filter(f => f.type === 'warning').length;

  if (dangerCount === 0 && warnCount === 0) {
    return { status: 'pass', detail: 'No risk flags detected — clean setup', score: 95 };
  }
  if (dangerCount === 0 && warnCount <= 2) {
    return { status: 'warn', detail: `${warnCount} warning(s): ${flags.map(f => f.text).join('; ')}`, score: 60 };
  }
  if (dangerCount >= 1) {
    return { status: 'fail', detail: `${dangerCount} danger flag(s): ${flags.filter(f => f.type === 'danger').map(f => f.text).join('; ')}`, score: 15 };
  }
  return { status: 'warn', detail: `${warnCount} warning(s) detected`, score: 45 };
}

// ─── Checklist items definition ───

const CHECKLIST_ITEMS: ChecklistItem[] = [
  { id: 'sr', label: 'S/R Alignment', category: 'Technical', icon: Target, evaluate: evalSRAlignment },
  { id: 'iv', label: 'IV Assessment', category: 'Options', icon: Activity, evaluate: evalIVAssessment },
  { id: 'theta', label: 'Theta Risk', category: 'Options', icon: Clock, evaluate: evalThetaRisk },
  { id: 'news', label: 'News Sentiment', category: 'Macro', icon: Newspaper, evaluate: evalNewsSentiment },
  { id: 'rr', label: 'Risk:Reward', category: 'Setup', icon: Scale, evaluate: evalRiskReward },
  { id: 'pcr', label: 'PCR Trend', category: 'OI', icon: BarChart3, evaluate: evalPCRTrend },
  { id: 'ai', label: 'AI Confidence', category: 'AI', icon: Shield, evaluate: evalAIConfidence },
  { id: 'flags', label: 'Risk Flags', category: 'Risk', icon: AlertTriangle, evaluate: evalRiskFlags },
];

// ─── Component ───

interface PreEntryChecklistProps {
  data: InstrumentData;
  onClose: () => void;
  onConfirm?: () => void;
}

export default function PreEntryChecklist({ data, onClose, onConfirm }: PreEntryChecklistProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());

  const results = useMemo(() => {
    return CHECKLIST_ITEMS.map(item => ({
      ...item,
      result: item.evaluate(data),
    }));
  }, [data]);

  const overallScore = useMemo(() => {
    const scores = results.map(r => r.result.score);
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }, [results]);

  const passCount = results.filter(r => r.result.status === 'pass').length;
  const warnCount = results.filter(r => r.result.status === 'warn').length;
  const failCount = results.filter(r => r.result.status === 'fail').length;

  const readiness = overallScore >= 70 ? 'GO' : overallScore >= 45 ? 'CAUTION' : 'NO_GO';
  const allReviewed = reviewed.size >= results.length;

  const handleStepClick = (index: number) => {
    setCurrentStep(index);
    setReviewed(prev => new Set(prev).add(results[index].id));
  };

  const handleNext = () => {
    setReviewed(prev => new Set(prev).add(results[currentStep].id));
    if (currentStep < results.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  const statusIcon = (status: string) => {
    if (status === 'pass') return <CheckCircle2 className="h-4 w-4 text-bullish" />;
    if (status === 'warn') return <AlertTriangle className="h-4 w-4 text-warning-amber" />;
    return <XCircle className="h-4 w-4 text-destructive" />;
  };

  const statusColor = (status: string) => {
    if (status === 'pass') return 'border-bullish/30 bg-bullish/5';
    if (status === 'warn') return 'border-warning-amber/30 bg-warning-amber/5';
    return 'border-destructive/30 bg-destructive/5';
  };

  const ReadinessIcon = readiness === 'GO' ? ShieldCheck : readiness === 'CAUTION' ? ShieldAlert : ShieldX;
  const readinessColor = readiness === 'GO' ? 'text-bullish' : readiness === 'CAUTION' ? 'text-warning-amber' : 'text-destructive';
  const readinessBg = readiness === 'GO' ? 'bg-bullish/10 border-bullish/30' : readiness === 'CAUTION' ? 'bg-warning-amber/10 border-warning-amber/30' : 'bg-destructive/10 border-destructive/30';

  const current = results[currentStep];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-xl mx-4 bg-card border border-border rounded-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary/20">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-info-cyan" />
            <span className="font-display text-sm font-bold tracking-wider text-foreground">
              PRE-ENTRY CHECKLIST
            </span>
            <span className="text-[0.625rem] text-muted-foreground">
              — {data.displayName} {data.tradeDirection === 'GO_CALL' ? 'CALL' : data.tradeDirection === 'GO_PUT' ? 'PUT' : 'WAIT'}
            </span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Step Navigation */}
        <div className="flex border-b border-border overflow-x-auto">
          {results.map((item, i) => {
            const isActive = i === currentStep;
            const isReviewed = reviewed.has(item.id);
            return (
              <button
                key={item.id}
                onClick={() => handleStepClick(i)}
                className={`flex items-center gap-1 px-3 py-2 text-[0.5625rem] font-bold tracking-wider uppercase whitespace-nowrap transition-all border-b-2 ${
                  isActive
                    ? 'border-info-cyan text-info-cyan bg-info-cyan/5'
                    : isReviewed
                    ? `border-transparent ${item.result.status === 'pass' ? 'text-bullish/70' : item.result.status === 'warn' ? 'text-warning-amber/70' : 'text-destructive/70'}`
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {isReviewed ? statusIcon(item.result.status) : <span className="text-[0.625rem] tabular-nums w-4 text-center">{i + 1}</span>}
                <span className="hidden sm:inline">{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Current Step Detail */}
        <div className="p-4 space-y-3 min-h-[180px]">
          <div className="flex items-center gap-2">
            <current.icon className={`h-5 w-5 ${
              current.result.status === 'pass' ? 'text-bullish' :
              current.result.status === 'warn' ? 'text-warning-amber' : 'text-destructive'
            }`} />
            <div>
              <div className="text-sm font-bold text-foreground">{current.label}</div>
              <div className="text-[0.5625rem] text-muted-foreground tracking-wider uppercase">{current.category}</div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {statusIcon(current.result.status)}
              <span className={`text-xs font-bold ${
                current.result.status === 'pass' ? 'text-bullish' :
                current.result.status === 'warn' ? 'text-warning-amber' : 'text-destructive'
              }`}>
                {current.result.status === 'pass' ? 'PASS' : current.result.status === 'warn' ? 'CAUTION' : 'FAIL'}
              </span>
            </div>
          </div>

          <div className={`rounded border p-3 ${statusColor(current.result.status)}`}>
            <p className="text-[0.6875rem] text-foreground leading-relaxed">{current.result.detail}</p>
          </div>

          {/* Score bar */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[0.5625rem] text-muted-foreground tracking-wider uppercase">Step Score</span>
              <span className={`text-[0.625rem] font-bold tabular-nums ${
                current.result.score >= 70 ? 'text-bullish' :
                current.result.score >= 45 ? 'text-warning-amber' : 'text-destructive'
              }`}>{current.result.score}/100</span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-secondary/50 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  current.result.score >= 70 ? 'bg-bullish' :
                  current.result.score >= 45 ? 'bg-warning-amber' : 'bg-destructive'
                }`}
                style={{ width: `${current.result.score}%` }}
              />
            </div>
          </div>

          {/* Next button */}
          {currentStep < results.length - 1 && (
            <button
              onClick={handleNext}
              className="flex items-center gap-1 text-[0.625rem] font-bold tracking-wider text-info-cyan hover:text-info-cyan/80 transition-colors"
            >
              NEXT: {results[currentStep + 1].label}
              <ChevronRight className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Summary Footer */}
        <div className="border-t border-border px-4 py-3 bg-secondary/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded border ${readinessBg}`}>
                <ReadinessIcon className={`h-5 w-5 ${readinessColor}`} />
                <span className={`text-sm font-bold tracking-wider ${readinessColor}`}>
                  {readiness === 'GO' ? 'READY' : readiness === 'CAUTION' ? 'CAUTION' : 'NOT READY'}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[0.5625rem]">
                <span className="text-bullish font-bold">{passCount} pass</span>
                <span className="text-warning-amber font-bold">{warnCount} warn</span>
                <span className="text-destructive font-bold">{failCount} fail</span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className="text-[0.5rem] text-muted-foreground tracking-wider uppercase">Overall</div>
                <div className={`text-lg font-bold tabular-nums ${readinessColor}`}>{overallScore}%</div>
              </div>
              {allReviewed && readiness === 'GO' && onConfirm && (
                <button
                  onClick={onConfirm}
                  className="px-4 py-2 rounded bg-bullish/20 border border-bullish/40 text-bullish text-xs font-bold tracking-wider hover:bg-bullish/30 transition-colors"
                >
                  CONFIRM ENTRY
                </button>
              )}
              {allReviewed && readiness !== 'GO' && (
                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded bg-destructive/20 border border-destructive/40 text-destructive text-xs font-bold tracking-wider hover:bg-destructive/30 transition-colors"
                >
                  ABORT
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
