/**
 * AiPaperTab — Placeholder while ML model pipeline is being built.
 *
 * The old AI Decision Engine (heuristic rule-based Python script) has been
 * removed. It will be replaced by an ML model trained on TFA feature data.
 * Once the ML model inference layer is built, this tab will show live
 * model signals vs. user trade outcomes.
 */
import { Bot, FlaskConical } from 'lucide-react';

export default function AiPaperTab() {
  return (
    <div className="flex flex-col items-center justify-center py-16 space-y-4 text-center">
      <div className="relative">
        <Bot className="h-12 w-12 text-muted-foreground/30" />
        <FlaskConical className="h-5 w-5 text-violet-pulse/60 absolute -bottom-1 -right-1" />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-semibold text-foreground">ML Model Coming Soon</p>
        <p className="text-[11px] text-muted-foreground max-w-xs leading-relaxed">
          The rule-based Decision Engine has been retired. A trained ML model
          (built on TFA feature data) will power this tab once the model
          training pipeline is complete.
        </p>
      </div>
      <div className="flex items-center gap-2 px-3 py-1.5 rounded border border-violet-pulse/20 bg-violet-pulse/5">
        <span className="text-[9px] text-violet-pulse tracking-wider uppercase font-bold">Pipeline</span>
        <span className="text-[9px] text-muted-foreground">TFA → Record → Train → Infer → RCA</span>
      </div>
    </div>
  );
}
