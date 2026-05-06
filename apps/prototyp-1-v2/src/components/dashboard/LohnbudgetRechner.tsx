import { useState, useMemo, useCallback } from 'react';
import { Calculator, ChevronDown, ChevronUp, RotateCcw, Info, Building2, User } from 'lucide-react';
import { formatCHF } from '@asklepios/core';
import { cn } from '@/lib/utils';

// ─── FAK-Sätze nach Kanton ────────────────────────────────────────────
const FAK_SAETZE: Record<string, number> = {
  'Aargau': 0.0145,
  'Appenzell AR': 0.016,
  'Appenzell AI': 0.016,
  'Baselland': 0.013,
  'Basel-Stadt': 0.0165,
  'Bern': 0.015,
  'Freiburg': 0.0227,
  'Genf': 0.0222,
  'Glarus': 0.014,
  'Graubünden': 0.015,
  'Jura': 0.0275,
  'Luzern': 0.0135,
  'Neuenburg': 0.018,
  'Nidwalden': 0.015,
  'Obwalden': 0.014,
  'St. Gallen': 0.018,
  'Solothurn': 0.0125,
  'Schaffhausen': 0.013,
  'Schwyz': 0.013,
  'Tessin': 0.016,
  'Thurgau': 0.014,
  'Uri': 0.017,
  'Waadt': 0.0237,
  'Wallis': 0.025,
  'Zug': 0.0135,
  'Zürich': 0.01025,
};

const KANTONE = Object.keys(FAK_SAETZE).sort();

type Abrechnungsverfahren = '' | 'ordentlich';
type Ferienzuschlag = '' | 'kein' | '8.33' | '10.64' | '13.04' | '15.56';

// ─── Festwerte ─────────────────────────────────────────────────────────
const AHV_IV_EO_SATZ = 0.053;
const ALV_SATZ = 0.011;
const VK_SATZ = 0.05 * 0.1055; // 0.5275%
// MVP: Abrechnungsverfahren aktuell nur "Ordentlich" unterstützt. (Quellensteuer/VS-AN-FAK out of scope)

const FERIENZUSCHLAG_MAP: Record<string, number> = {
  '': 0,
  'kein': 0,
  '8.33': 0.0833,
  '10.64': 0.1064,
  '13.04': 0.1304,
  '15.56': 0.1556,
};

interface Inputs {
  // Metadaten
  jahr: string;
  ortDatum: string;
  agName: string;
  agStrasse: string;
  agPlzOrt: string;
  anName: string;
  anStrasse: string;
  anPlzOrt: string;
  // Rechnung
  kanton: string;
  abrechnungsverfahren: Abrechnungsverfahren;
  stundenlohn: string;
  anzahlStunden: string;
  ferienzuschlag: Ferienzuschlag;
  // Optionale Sätze
  ktvAg: string;
  buAg: string;
  ktvAn: string;
  nbuAn: string;
}

const DEFAULT_INPUTS: Inputs = {
  jahr: new Date().getFullYear().toString(),
  ortDatum: '',
  agName: '',
  agStrasse: '',
  agPlzOrt: '',
  anName: '',
  anStrasse: '',
  anPlzOrt: '',
  kanton: '',
  abrechnungsverfahren: '',
  stundenlohn: '',
  anzahlStunden: '',
  ferienzuschlag: '',
  ktvAg: '',
  buAg: '',
  ktvAn: '',
  nbuAn: '',
};

function parseNum(v: string): number | null {
  if (v === '' || v === undefined || v === null) return null;
  const n = parseFloat(v.replace(',', '.'));
  return isNaN(n) ? null : n;
}

function fmtPct(v: number): string {
  return (v * 100).toFixed(2) + '%';
}

function fmtChf(v: number | null): string {
  if (v === null || v === undefined) return '–';
  return formatCHF(v);
}

export function LohnbudgetRechner() {
  const [inputs, setInputs] = useState<Inputs>(DEFAULT_INPUTS);
  const [showMeta, setShowMeta] = useState(false);
  const [showAdressaten, setShowAdressaten] = useState(false);

  const set = useCallback(<K extends keyof Inputs>(key: K, value: Inputs[K]) => {
    setInputs(prev => ({ ...prev, [key]: value }));
  }, []);

  const reset = useCallback(() => setInputs(DEFAULT_INPUTS), []);

  // ─── Berechnung ───────────────────────────────────────────────────
  const result = useMemo(() => {
    const stundenlohn = parseNum(inputs.stundenlohn);
    const anzahlStunden = parseNum(inputs.anzahlStunden);
    const kanton = inputs.kanton;
    const verfahren = inputs.abrechnungsverfahren;
    const fzSatz = FERIENZUSCHLAG_MAP[inputs.ferienzuschlag] ?? 0;

    if (stundenlohn === null || anzahlStunden === null || !kanton || !verfahren) {
      return null;
    }

    const fakSatz = FAK_SAETZE[kanton] ?? 0;

    // Stufe 1: Bruttolohn
    const arbeitslohnStd = stundenlohn;
    const arbeitslohnJahr = stundenlohn * anzahlStunden;
    const ferienzuschlagStd = arbeitslohnStd * fzSatz;
    const ferienzuschlagJahr = arbeitslohnJahr * fzSatz;
    const bruttolohnStd = arbeitslohnStd + ferienzuschlagStd;
    const bruttolohnJahr = arbeitslohnJahr + ferienzuschlagJahr;

    // Stufe 2: AG-Beiträge
    const ahvAg = bruttolohnStd * AHV_IV_EO_SATZ;
    const alvAg = bruttolohnStd * ALV_SATZ;
    const fakAg = bruttolohnStd * fakSatz;
    const vkAg = bruttolohnStd * VK_SATZ;
    const ktvAgSatz = parseNum(inputs.ktvAg);
    const buAgSatz = parseNum(inputs.buAg);
    const ktvAgStd = ktvAgSatz !== null ? bruttolohnStd * ktvAgSatz : null;
    const buAgStd = buAgSatz !== null ? bruttolohnStd * buAgSatz : null;

    const agBetraegeStd = [ahvAg, alvAg, fakAg, vkAg, ktvAgStd, buAgStd].filter((v): v is number => v !== null);
    const totalAgStd = agBetraegeStd.reduce((a, b) => a + b, 0);

    const ahvAgJahr = bruttolohnJahr * AHV_IV_EO_SATZ;
    const alvAgJahr = bruttolohnJahr * ALV_SATZ;
    const fakAgJahr = bruttolohnJahr * fakSatz;
    const vkAgJahr = bruttolohnJahr * VK_SATZ;
    const ktvAgJahr = ktvAgSatz !== null ? bruttolohnJahr * ktvAgSatz : null;
    const buAgJahr = buAgSatz !== null ? bruttolohnJahr * buAgSatz : null;

    const agBetraegeJahr = [ahvAgJahr, alvAgJahr, fakAgJahr, vkAgJahr, ktvAgJahr, buAgJahr].filter((v): v is number => v !== null);
    const totalAgJahr = agBetraegeJahr.reduce((a, b) => a + b, 0);

    // Totalaufwand AG
    const totalAufwandAgStd = bruttolohnStd + totalAgStd;
    const totalAufwandAgJahr = bruttolohnJahr + totalAgJahr;

    // Stufe 3: AN-Beiträge
    const ahvAn = bruttolohnStd * AHV_IV_EO_SATZ;
    const alvAn = bruttolohnStd * ALV_SATZ;
    const ktvAnSatz = parseNum(inputs.ktvAn);
    const nbuAnSatz = parseNum(inputs.nbuAn);
    const ktvAnStd = ktvAnSatz !== null ? bruttolohnStd * ktvAnSatz : null;
    const nbuAnStd = nbuAnSatz !== null ? bruttolohnStd * nbuAnSatz : null;

    const anBetraegeStd = [ahvAn, alvAn, ktvAnStd, nbuAnStd].filter((v): v is number => v !== null);
    const totalAnStd = anBetraegeStd.reduce((a, b) => a + b, 0);

    const ahvAnJahr = bruttolohnJahr * AHV_IV_EO_SATZ;
    const alvAnJahr = bruttolohnJahr * ALV_SATZ;
    const ktvAnJahr = ktvAnSatz !== null ? bruttolohnJahr * ktvAnSatz : null;
    const nbuAnJahr = nbuAnSatz !== null ? bruttolohnJahr * nbuAnSatz : null;
    const anBetraegeJahr = [ahvAnJahr, alvAnJahr, ktvAnJahr, nbuAnJahr].filter((v): v is number => v !== null);
    const totalAnJahr = anBetraegeJahr.reduce((a, b) => a + b, 0);

    // Nettolohn
    const nettolohnStd = bruttolohnStd - totalAnStd;
    const nettolohnJahr = bruttolohnJahr - totalAnJahr;

    // Adressaten
    const beitraegeAusgleichskasseJahr = ahvAgJahr + alvAgJahr + vkAgJahr + ahvAnJahr + alvAnJahr;

    const beitraegeFakJahr = fakAgJahr;

    const praemienKtJahr = [ktvAgJahr, ktvAnJahr].filter((v): v is number => v !== null);
    const totalKtJahr = praemienKtJahr.length > 0 ? praemienKtJahr.reduce((a, b) => a + b, 0) : null;

    const praemienUnfallJahr = [buAgJahr, nbuAnJahr].filter((v): v is number => v !== null);
    const totalUnfallJahr = praemienUnfallJahr.length > 0 ? praemienUnfallJahr.reduce((a, b) => a + b, 0) : null;

    return {
      // Lohn
      arbeitslohnStd, arbeitslohnJahr,
      ferienzuschlagStd, ferienzuschlagJahr, fzSatz,
      bruttolohnStd, bruttolohnJahr,
      // AG
      ahvAg, alvAg, fakAg, vkAg, ktvAgStd, buAgStd,
      ahvAgJahr, alvAgJahr, fakAgJahr, vkAgJahr, ktvAgJahr, buAgJahr,
      totalAgStd, totalAgJahr,
      fakSatz,
      ktvAgSatz, buAgSatz,
      // Totalaufwand
      totalAufwandAgStd, totalAufwandAgJahr,
      // AN
      ahvAn, alvAn, ktvAnStd, nbuAnStd,
      ahvAnJahr, alvAnJahr, ktvAnJahr, nbuAnJahr,
      totalAnStd, totalAnJahr,
      ktvAnSatz, nbuAnSatz,
      // Netto
      nettolohnStd, nettolohnJahr,
      // Adressaten
      beitraegeAusgleichskasseJahr, beitraegeFakJahr,
      totalKtJahr, totalUnfallJahr,
      kanton,
      verfahren,
    };
  }, [inputs]);

  return (
    <div className="p-5 rounded-xl border bg-card space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
            <Calculator className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="font-semibold">Lohnbudget Stundenlohn</h2>
            <p className="text-xs text-muted-foreground">CH-Lohnkostenrechner · Brutto → Netto</p>
          </div>
        </div>
        <button
          onClick={reset}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-muted-foreground hover:bg-muted transition-colors"
          title="Zurücksetzen"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset
        </button>
      </div>

      {/* Meta toggle */}
      <button
        onClick={() => setShowMeta(!showMeta)}
        className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors w-full"
      >
        {showMeta ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        <Building2 className="w-3.5 h-3.5" />
        Dokumentangaben (AG / AN Adressen)
      </button>

      {showMeta && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 rounded-lg bg-muted/50 border border-border/50">
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Building2 className="w-3 h-3" /> Arbeitgebende/r
            </p>
            <InputField label="Jahr" value={inputs.jahr} onChange={v => set('jahr', v)} placeholder="2026" />
            <InputField label="Ort, Datum" value={inputs.ortDatum} onChange={v => set('ortDatum', v)} placeholder="Bern, 25.03.2026" />
            <InputField label="Vorname, Name" value={inputs.agName} onChange={v => set('agName', v)} />
            <InputField label="Strasse" value={inputs.agStrasse} onChange={v => set('agStrasse', v)} />
            <InputField label="PLZ, Ort" value={inputs.agPlzOrt} onChange={v => set('agPlzOrt', v)} />
          </div>
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <User className="w-3 h-3" /> Arbeitnehmende/r
            </p>
            <div className="h-[32px]" />
            <div className="h-[32px]" />
            <InputField label="Vorname, Name" value={inputs.anName} onChange={v => set('anName', v)} />
            <InputField label="Strasse" value={inputs.anStrasse} onChange={v => set('anStrasse', v)} />
            <InputField label="PLZ, Ort" value={inputs.anPlzOrt} onChange={v => set('anPlzOrt', v)} />
          </div>
        </div>
      )}

      {/* Pflichtfelder */}
      <div className="space-y-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Pflichtangaben</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <SelectField
            label="Kanton"
            value={inputs.kanton}
            onChange={v => set('kanton', v)}
            options={[{ value: '', label: 'Auswählen…' }, ...KANTONE.map(k => ({ value: k, label: k }))]}
          />
          <SelectField
            label="Abrechnungsverfahren"
            value={inputs.abrechnungsverfahren}
            onChange={v => set('abrechnungsverfahren', v as Abrechnungsverfahren)}
            options={[
              { value: '', label: 'Auswählen…' },
              { value: 'ordentlich', label: 'Ordentliches' },
            ]}
          />
          <InputField label="Stundenlohn (CHF)" value={inputs.stundenlohn} onChange={v => set('stundenlohn', v)} placeholder="33.00" type="number" />
          <InputField label="Anzahl Stunden / Jahr" value={inputs.anzahlStunden} onChange={v => set('anzahlStunden', v)} placeholder="1200" type="number" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <SelectField
            label="Ferienzuschlag"
            value={inputs.ferienzuschlag}
            onChange={v => set('ferienzuschlag', v as Ferienzuschlag)}
            options={[
              { value: '', label: 'Auswählen…' },
              { value: 'kein', label: 'Kein' },
              { value: '8.33', label: '8.33% (4 Wo.)' },
              { value: '10.64', label: '10.64% (5 Wo.)' },
              { value: '13.04', label: '13.04% (6 Wo.)' },
              { value: '15.56', label: '15.56% (7 Wo.)' },
            ]}
          />
        </div>
      </div>

      {/* Optionale Sätze */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Optionale Beiträge</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <InputField label="KTV-Satz AG" value={inputs.ktvAg} onChange={v => set('ktvAg', v)} placeholder="z.B. 0.007" type="number" />
          <InputField label="BU-Satz AG" value={inputs.buAg} onChange={v => set('buAg', v)} placeholder="z.B. 0.005" type="number" />
          <InputField label="KTV-Satz AN" value={inputs.ktvAn} onChange={v => set('ktvAn', v)} placeholder="z.B. 0.007" type="number" />
          <InputField label="Nichtberufsunfallversicherung (NBU) Satz AN" value={inputs.nbuAn} onChange={v => set('nbuAn', v)} placeholder="z.B. 0.01" type="number" />
        </div>
      </div>

      {/* ─── ERGEBNISSE ──────────────────────────────────────────────── */}
      {result && (
        <div className="space-y-4 pt-2">
          <div className="h-px bg-gradient-to-r from-transparent via-border to-transparent" />

          {/* Lohn */}
          <ResultSection title="Lohn" color="blue">
            <ResultRow label="Arbeitslohn" std={result.arbeitslohnStd} jahr={result.arbeitslohnJahr} />
            {result.fzSatz > 0 && (
              <ResultRow label={`Ferienzuschlag (${fmtPct(result.fzSatz)})`} std={result.ferienzuschlagStd} jahr={result.ferienzuschlagJahr} muted />
            )}
            <ResultRow label="Bruttolohn AN" std={result.bruttolohnStd} jahr={result.bruttolohnJahr} bold />
          </ResultSection>

          {/* AG-Beiträge */}
          <ResultSection title="Beiträge Arbeitgebende/r" color="amber">
            <ResultRow label={`AHV/IV/EO (${fmtPct(AHV_IV_EO_SATZ)})`} std={result.ahvAg} jahr={result.ahvAgJahr} />
            <ResultRow label={`ALV (${fmtPct(ALV_SATZ)})`} std={result.alvAg} jahr={result.alvAgJahr} />
            <ResultRow label={`FAK ${result.kanton} (${fmtPct(result.fakSatz)})`} std={result.fakAg} jahr={result.fakAgJahr} />
            <ResultRow label={`VK (${fmtPct(VK_SATZ)})`} std={result.vkAg} jahr={result.vkAgJahr} />
            {result.ktvAgStd !== null && <ResultRow label={`KTV AG (${fmtPct(result.ktvAgSatz!)})`} std={result.ktvAgStd} jahr={result.ktvAgJahr!} muted />}
            {result.buAgStd !== null && <ResultRow label={`BU AG (${fmtPct(result.buAgSatz!)})`} std={result.buAgStd} jahr={result.buAgJahr!} muted />}
            <ResultRow label="Total AG-Beiträge" std={result.totalAgStd} jahr={result.totalAgJahr} bold />
          </ResultSection>

          {/* Totalaufwand AG */}
          <div className="bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border border-emerald-500/20 rounded-lg p-3">
            <ResultRow label="⟶ Totalaufwand Arbeitgebende/r" std={result.totalAufwandAgStd} jahr={result.totalAufwandAgJahr} bold highlight />
          </div>

          {/* AN-Beiträge */}
          <ResultSection title="Abzüge Arbeitnehmende/r" color="rose">
            <ResultRow label={`AHV/IV/EO (${fmtPct(AHV_IV_EO_SATZ)})`} std={result.ahvAn} jahr={result.ahvAnJahr} />
            <ResultRow label={`ALV (${fmtPct(ALV_SATZ)})`} std={result.alvAn} jahr={result.alvAnJahr} />
            {result.ktvAnStd !== null && <ResultRow label={`KTV AN (${fmtPct(result.ktvAnSatz!)})`} std={result.ktvAnStd} jahr={result.ktvAnJahr!} muted />}
            {result.nbuAnStd !== null && <ResultRow label={`Nichtberufsunfallvers. AN (${fmtPct(result.nbuAnSatz!)})`} std={result.nbuAnStd} jahr={result.nbuAnJahr!} muted />}
            <ResultRow label="Total AN-Abzüge" std={result.totalAnStd} jahr={result.totalAnJahr} bold />
          </ResultSection>

          {/* Nettolohn */}
          <div className="bg-gradient-to-r from-blue-500/10 to-indigo-500/10 border border-blue-500/20 rounded-lg p-3">
            <ResultRow label="⟶ Nettolohn Arbeitnehmende/r" std={result.nettolohnStd} jahr={result.nettolohnJahr} bold highlight />
          </div>

          {/* Adressaten */}
          <button
            onClick={() => setShowAdressaten(!showAdressaten)}
            className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            {showAdressaten ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            Leistungen nach Adressaten
          </button>

          {showAdressaten && (
            <div className="space-y-2 p-3 rounded-lg bg-muted/50 border border-border/50">
              <AdressatRow label="Beiträge an Ausgleichskasse" value={result.beitraegeAusgleichskasseJahr} />
              <AdressatRow label="Beiträge an FAK" value={result.beitraegeFakJahr} />
              {result.totalKtJahr !== null && <AdressatRow label="Prämien an KT-Versicherer" value={result.totalKtJahr} />}
              {result.totalUnfallJahr !== null && <AdressatRow label="Prämien an Unfallversicherer" value={result.totalUnfallJahr} />}
            </div>
          )}

          {/* Scope Info */}
          <div className="space-y-2">
            <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-500/5 border border-blue-500/10">
              <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Rechner basiert auf Schweizer Sozialversicherungssätzen (AHV/IV/EO, ALV, FAK).
                VK-Satz = 5% × 10.55%. FAK-Sätze und kantonale Bestimmungen gemäss aktuellem Stand.
              </p>
            </div>
            <div className="p-3 rounded-lg bg-gray-50 border border-gray-200/60">
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">Aktuell nicht berücksichtigt</p>
              <div className="flex flex-wrap gap-1.5">
                {['BVG (Berufliche Vorsorge)', 'Quellensteuer', 'Nachtdienst-Zuschläge'].map(label => (
                  <span key={label} className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-200/80 text-gray-500">
                    {label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Hinweis wenn nicht alle Pflichtfelder ausgefüllt */}
      {!result && inputs.stundenlohn && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <Info className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <p className="text-xs text-muted-foreground">
            Bitte alle Pflichtfelder ausfüllen: Kanton, Abrechnungsverfahren, Stundenlohn, Anzahl Stunden.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Sub-Components ─────────────────────────────────────────────────────

function InputField({ label, value, onChange, placeholder, type = 'text' }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        step={type === 'number' ? 'any' : undefined}
        className="w-full px-3 py-1.5 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
      />
    </div>
  );
}

function SelectField({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-1.5 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all appearance-none cursor-pointer"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function ResultSection({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  const colorMap: Record<string, string> = {
    blue: 'from-blue-500 to-blue-600',
    amber: 'from-amber-500 to-orange-500',
    rose: 'from-rose-500 to-pink-500',
    emerald: 'from-emerald-500 to-teal-500',
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 mb-2">
        <div className={cn("w-1.5 h-1.5 rounded-full bg-gradient-to-r", colorMap[color] || colorMap.blue)} />
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{title}</p>
      </div>
      <div className="space-y-0.5">
        {/* Header */}
        <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-2 pb-1">
          <span />
          <span className="text-[10px] font-semibold text-muted-foreground/60 w-24 text-right">Pro Stunde</span>
          <span className="text-[10px] font-semibold text-muted-foreground/60 w-28 text-right">Pro Jahr</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function ResultRow({ label, std, jahr, bold, muted: isMuted, highlight }: {
  label: string;
  std: number;
  jahr: number;
  bold?: boolean;
  muted?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className={cn(
      "grid grid-cols-[1fr_auto_auto] gap-2 px-2 py-1 rounded",
      bold && !highlight && 'bg-muted/50 border border-border/30',
      highlight && 'font-semibold',
    )}>
      <span className={cn(
        "text-xs",
        bold ? 'font-semibold' : '',
        isMuted ? 'text-muted-foreground/70' : 'text-foreground',
      )}>
        {label}
      </span>
      <span className={cn(
        "text-xs tabular-nums w-24 text-right",
        bold ? 'font-semibold' : '',
        isMuted ? 'text-muted-foreground/70' : 'text-foreground',
      )}>
        {fmtChf(std)}
      </span>
      <span className={cn(
        "text-xs tabular-nums w-28 text-right",
        bold ? 'font-semibold' : '',
        isMuted ? 'text-muted-foreground/70' : 'text-foreground',
      )}>
        {fmtChf(jahr)}
      </span>
    </div>
  );
}

function AdressatRow({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  return (
    <div className="flex items-center justify-between px-2 py-1">
      <span className="text-xs text-foreground">{label}</span>
      <span className="text-xs font-medium tabular-nums">{fmtChf(value)} / Jahr</span>
    </div>
  );
}
