import { useState, useEffect, useRef, useId, type ReactNode } from 'react';
import { FileText, ShieldCheck, CheckCircle2, ScanSearch, Check } from 'lucide-react';
import { AsklepiosExtractLogo } from '@/components/brand/AsklepiosExtractLogo';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// Estimated durations per pipeline step (ms)
const STEP_DURATIONS = [10_000, 90_000, 30_000]; // classifier, extractor, judge
// Progress range [lo, hi] per step index (0=classifier, 1=extractor, 2=judge, 3=manual)
const STEP_RANGES: [number, number][] = [[0, 25], [25, 50], [50, 75], [75, 100]];
// Duration of the "Manuelle Prüfung" animation before handing off
const MANUAL_DURATION_MS = 2_500;

interface Props {
  onCancel: () => void;
  /** Set to true when the AI pipeline (Classifier → Extractor → Judge) has finished. */
  pipelineDone?: boolean;
  /** Called after the manual-review animation completes (~2–3 s after pipelineDone). */
  onReadyForReview?: () => void;
}

export function ExtractingScreen({ onCancel, pipelineDone = false, onReadyForReview }: Props) {
  const ringGradId = useId().replace(/:/g, '');
  const [pct, setPct] = useState(0);
  const [activeStep, setActiveStep] = useState(0); // 0=classifier 1=extractor 2=judge 3=manual
  const startRef = useRef(Date.now());

  // ── Time-based progress animation for steps 0–2 ──────────────────────────
  useEffect(() => {
    if (pipelineDone) return;

    const tick = () => {
      const elapsed = Date.now() - startRef.current;
      let cumTime = 0;

      for (let i = 0; i < STEP_DURATIONS.length; i++) {
        const duration = STEP_DURATIONS[i] ?? 10_000;
        const range = STEP_RANGES[i] ?? ([0, 25] as [number, number]);
        if (elapsed < cumTime + duration) {
          const stepElapsed = elapsed - cumTime;
          const stepProgress = stepElapsed / duration;
          const [lo, hi] = range;
          setPct(lo + stepProgress * (hi - lo));
          setActiveStep(i);
          return;
        }
        cumTime += duration;
      }

      // All estimated time elapsed — cap just below 75% (manual not started yet)
      setPct(74);
      setActiveStep(2);
    };

    tick();
    const iv = setInterval(tick, 200);
    return () => clearInterval(iv);
  }, [pipelineDone]);

  // ── When pipeline finishes: animate manual step 75 → 100%, then call back ─
  useEffect(() => {
    if (!pipelineDone) return;

    setActiveStep(3);
    setPct(75);

    const animStart = Date.now();
    let raf: number;

    const animate = () => {
      const progress = Math.min((Date.now() - animStart) / MANUAL_DURATION_MS, 1);
      setPct(75 + progress * 25);

      if (progress < 1) {
        raf = requestAnimationFrame(animate);
      } else {
        setTimeout(() => onReadyForReview?.(), 300);
      }
    };

    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [pipelineDone, onReadyForReview]);

  // Derived SVG ring values
  const circumference = 2 * Math.PI * 88;
  const dashOffset = circumference - (pct / 100) * circumference;
  const displayPct = Math.round(pct);

  return (
    <Card className="relative overflow-hidden border-white/10 bg-[#020617] text-white">
      {/* Soft background gradients */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(1000px_500px_at_15%_0%,rgba(59,130,246,0.22),transparent_55%),radial-gradient(800px_440px_at_85%_15%,rgba(168,85,247,0.20),transparent_50%),radial-gradient(600px_440px_at_50%_110%,rgba(16,185,129,0.14),transparent_55%)]" />
      </div>

      <div className="relative flex flex-col gap-5 px-6 py-6 sm:px-10 sm:py-8">
        {/* Top row: Badge + Logo */}
        <div className="flex items-center justify-between gap-4">
          <Badge
            variant="outline"
            className="border-white/15 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/70"
          >
            Agentic Workflow aktiv · Kann bis zu 5 Minuten dauern.
          </Badge>
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/15 bg-white/10">
            <AsklepiosExtractLogo className="h-6 w-6 text-white" />
          </div>
        </div>

        {/* Main row: Percent ring + Headline */}
        <div className="grid grid-cols-1 items-center gap-6 sm:grid-cols-[auto,1fr]">
          {/* Percent ring (replaces timer) */}
          <div className="relative mx-auto h-40 w-40 shrink-0 sm:mx-0 sm:h-44 sm:w-44">
            <svg viewBox="0 0 200 200" className="h-full w-full -rotate-90" aria-hidden>
              <defs>
                <linearGradient id={ringGradId} x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#3B82F6" />
                  <stop offset="50%" stopColor="#A855F7" />
                  <stop offset="100%" stopColor="#10B981" />
                </linearGradient>
              </defs>
              <circle cx="100" cy="100" r="88" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4" />
              <circle
                cx="100"
                cy="100"
                r="88"
                fill="none"
                stroke={`url(#${ringGradId})`}
                strokeWidth="4"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                className="transition-[stroke-dashoffset] duration-300 ease-linear"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-4xl font-bold tabular-nums tracking-tight text-white sm:text-5xl">
                {displayPct}%
              </span>
              <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.22em] text-white/45">
                {activeStep === 3 ? 'Vorbereitung...' : 'Fortschritt'}
              </span>
            </div>
          </div>

          {/* Headline */}
          <div className="text-center sm:text-left">
            <h2 className="text-base font-semibold leading-snug text-white/90 sm:text-lg">
              Asklepios legt deine Assistenzperson an
            </h2>
            <p className="mt-1 text-sm text-white/55">
              Vertrag wird analysiert und Stammdaten werden vorbereitet.
            </p>
            <p className="mt-4 text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl lg:text-5xl">
              Über{' '}
              <span className="bg-gradient-to-r from-emerald-300 via-emerald-200 to-teal-200 bg-clip-text text-transparent">
                30 Datenfelder
              </span>
            </p>
            <p className="mt-2 text-sm text-white/55">
              Lehn dich zurück – der Agent übernimmt.
            </p>
          </div>
        </div>

        {/* 4 step tiles with active / done / pending states */}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-4">
          <StepTile
            index={0}
            activeStep={activeStep}
            icon={<ScanSearch className="h-4 w-4" />}
            iconBg="bg-emerald-500/15 border-emerald-300/25"
            iconColor="text-emerald-200"
            title="Agent 1 · Klassifizierung"
            description="Erkennt den Dokumenttyp."
          />
          <StepTile
            index={1}
            activeStep={activeStep}
            icon={<FileText className="h-4 w-4" />}
            iconBg="bg-blue-500/15 border-blue-300/25"
            iconColor="text-blue-200"
            title="Agent 2 · Datenextraktion"
            description="Extrahiert Stammdaten & Vertragswerte."
          />
          <StepTile
            index={2}
            activeStep={activeStep}
            icon={<ShieldCheck className="h-4 w-4" />}
            iconBg="bg-purple-500/15 border-purple-300/25"
            iconColor="text-purple-200"
            title="Agent 3 · Qualitätscheck"
            description="Markiert unsichere Felder."
          />
          <StepTile
            index={3}
            activeStep={activeStep}
            icon={<CheckCircle2 className="h-4 w-4" />}
            iconBg="bg-white/10 border-white/15"
            iconColor="text-white/55"
            title="Schritt 4 · Manuelle Prüfung"
            description={activeStep === 3 ? 'Vorbereitung der Überprüfung...' : 'Markierte Felder anpassen.'}
          />
        </div>

        {/* Horizontal progress bar */}
        <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-linear"
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Cancel */}
        <div className="flex items-center justify-center pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="h-8 text-xs font-medium text-white/55 hover:bg-white/5 hover:text-white"
          >
            Analyse abbrechen
          </Button>
        </div>
      </div>
    </Card>
  );
}

function StepTile({
  index,
  activeStep,
  icon,
  iconBg,
  iconColor,
  title,
  description,
}: {
  index: number;
  activeStep: number;
  icon: ReactNode;
  iconBg: string;
  iconColor: string;
  title: string;
  description: string;
}) {
  const isActive = index === activeStep;
  const isDone = index < activeStep;
  const isPending = index > activeStep;

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border px-3 py-2.5 backdrop-blur-sm transition-all duration-500',
        isActive && 'border-primary/50 bg-primary/10 ring-1 ring-primary/40 animate-glow-asklepios',
        isDone && 'border-white/[0.06] bg-white/[0.03]',
        isPending && 'border-white/[0.06] bg-white/[0.03] opacity-40',
      )}
    >
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border',
          isDone ? 'border-emerald-400/30 bg-emerald-500/20' : iconBg,
        )}
      >
        {isDone ? (
          <Check className="h-4 w-4 text-emerald-300" />
        ) : (
          <span className={cn(iconColor, isActive && 'text-white')}>{icon}</span>
        )}
      </div>
      <div className="min-w-0">
        <p
          className={cn(
            'truncate text-xs font-semibold',
            isActive ? 'text-white' : isDone ? 'text-white/80' : 'text-white/45',
          )}
        >
          {title}
        </p>
        <p
          className={cn(
            'truncate text-[11px]',
            isActive ? 'text-white/70' : isDone ? 'text-white/45' : 'text-white/30',
          )}
        >
          {description}
        </p>
      </div>
    </div>
  );
}
