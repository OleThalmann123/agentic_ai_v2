import { useState, useEffect, useRef, useId, type ReactNode } from 'react';
import { FileText, ShieldCheck, CheckCircle2, ScanSearch } from 'lucide-react';
import { AsklepiosExtractLogo } from '@/components/brand/AsklepiosExtractLogo';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

/** Anzeige-Dauer: länger als typische Extraktion, damit der Ring nicht auf 0 springt bevor fertig. */
const TOTAL_SECONDS = 300;

interface Props {
  onCancel: () => void;
}

export function ExtractingScreen({ onCancel }: Props) {
  const ringGradId = useId().replace(/:/g, '');
  const [remaining, setRemaining] = useState(TOTAL_SECONDS);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const tick = () => {
      const elapsed = (Date.now() - startRef.current) / 1000;
      setRemaining(Math.max(0, TOTAL_SECONDS - Math.floor(elapsed)));
    };
    tick();
    const iv = setInterval(tick, 500);
    return () => clearInterval(iv);
  }, []);

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const timeStr = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  const progressPct = ((TOTAL_SECONDS - remaining) / TOTAL_SECONDS) * 100;

  const circumference = 2 * Math.PI * 88;
  const dashOffset = circumference - (progressPct / 100) * circumference;

  return (
    <Card className="relative overflow-hidden border-white/10 bg-[#020617] text-white">
      {/* Soft background gradients (decorative) */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(1000px_500px_at_15%_0%,rgba(59,130,246,0.22),transparent_55%),radial-gradient(800px_440px_at_85%_15%,rgba(168,85,247,0.20),transparent_50%),radial-gradient(600px_440px_at_50%_110%,rgba(16,185,129,0.14),transparent_55%)]" />
      </div>

      <div className="relative flex flex-col gap-5 px-6 py-6 sm:px-10 sm:py-8">
        {/* Top row: Badge + Logo mark */}
        <div className="flex items-center justify-between gap-4">
          <Badge
            variant="outline"
            className="border-white/15 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/70"
          >
            Agentic Workflow aktiv · ca. 3–5 Min.
          </Badge>
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/15 bg-white/10">
            <AsklepiosExtractLogo className="h-6 w-6 text-white" />
          </div>
        </div>

        {/* Main row: Timer + Headline */}
        <div className="grid grid-cols-1 items-center gap-6 sm:grid-cols-[auto,1fr]">
          {/* Timer ring */}
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
                className="transition-[stroke-dashoffset] duration-500 ease-linear"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-4xl font-bold tabular-nums tracking-tight text-white sm:text-5xl">
                {timeStr}
              </span>
              <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.22em] text-white/45">
                verbleibend
              </span>
            </div>
          </div>

          {/* Headline + hero message. „Über 30 Datenfelder" = größte Aussage. */}
          <div className="text-center sm:text-left">
            <h2 className="text-base font-semibold leading-snug text-white/90 sm:text-lg">
              Asklepios_extract legt deine Assistenzperson an
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

        {/* 4 compact steps */}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-4">
          <StepItem
            icon={<ScanSearch className="h-4 w-4 text-emerald-200" />}
            iconBg="bg-emerald-500/15 border-emerald-300/25"
            title="Agent 1 · Klassifizierung"
            description="Erkennt den Dokumenttyp."
          />
          <StepItem
            icon={<FileText className="h-4 w-4 text-blue-200" />}
            iconBg="bg-blue-500/15 border-blue-300/25"
            title="Agent 2 · Datenextraktion"
            description="Extrahiert Stammdaten & Vertragswerte."
          />
          <StepItem
            icon={<ShieldCheck className="h-4 w-4 text-purple-200" />}
            iconBg="bg-purple-500/15 border-purple-300/25"
            title="Agent 3 · Qualitätscheck"
            description="Markiert unsichere Felder."
          />
          <StepItem
            icon={<CheckCircle2 className="h-4 w-4 text-white/55" />}
            iconBg="bg-white/10 border-white/15"
            title="Schritt 4 · Manuelle Prüfung"
            description="Markierte Felder anpassen."
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

function StepItem({
  icon,
  iconBg,
  title,
  description,
}: {
  icon: ReactNode;
  iconBg: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 backdrop-blur-sm">
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${iconBg}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold text-white">{title}</p>
        <p className="truncate text-[11px] text-white/55">{description}</p>
      </div>
    </div>
  );
}
