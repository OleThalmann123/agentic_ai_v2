import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { supabase } from '@asklepios/core';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { getCityFromChPlz, isValidChPlz } from '@/utils/chPlz';
import asklepiosMark from '@/assets/asklepios-mark.svg';
import { AsklepiosExtractLogo } from '@/components/brand/AsklepiosExtractLogo';
import { UploadCloud, CheckCircle2, FileText, AlertCircle, HelpCircle, User, ArrowLeft, Loader2, Share2, Copy, Check, ShieldCheck, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ExtractingScreen } from './ExtractingScreen';
import { runDocumentPipeline, readFileAsArrayBuffer } from '@asklepios/core';
import { ContractExtractionResult, IDPField, ConfidenceLevel, BinaryStatus } from '@asklepios/core';
import type { PipelineTrace } from '@asklepios/core';

const formatAIWarning = (code: string) => {
  const map: Record<string, string> = {
    'FEHLENDE_AHV_NUMMER': 'AHV-Nummer fehlt im Dokument',
    'KANTON_ABGELEITET': 'Wohnsitzkanton wurde automatisch anhand der PLZ abgeleitet',
    'FEHLENDE_SOZIALVERSICHERUNGSANGABEN': 'Sozialversicherungsabzüge konnten nicht gefunden werden',
    'UNVOLLSTAENDIGE_ADRESSE': 'Adresse der Assistenzperson ist unvollständig',
    'LOHN_NICHT_ERKANNT': 'Bruttolohn konnte nicht eindeutig bestimmt werden'
  };
  return map[code] || code.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
};
const REQUIRED_FIELDS = [
  'firstName',
  'lastName',
  'birthDate',
  'ahvNumber',
  'contractStart',
  'hoursPerWeek',
  'hourlyRate',
  // NBU-Felder sind nicht mehr pauschal Pflicht. Sie werden dynamisch in
  // isRequired() als Pflicht markiert, wenn das Pensum ≥ 8h/Woche beträgt.
];

const PIPELINE_TIMEOUT_MS = 300_000;
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${label} (Timeout nach ${Math.round(ms / 1000)}s)`)), ms);
    promise.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

const normalizeCountryToIso2 = (raw: string) => {
  const v = raw.trim();
  if (!v) return '';
  const u = v.toUpperCase();
  if (/^[A-Z]{2}$/.test(u)) return u;
  const map: Record<string, string> = {
    schweiz: 'CH',
    switzerland: 'CH',
    suisse: 'CH',
    italien: 'IT',
    italy: 'IT',
    italia: 'IT',
    deutschland: 'DE',
    germany: 'DE',
    österreich: 'AT',
    oesterreich: 'AT',
    austria: 'AT',
    frankreich: 'FR',
    france: 'FR',
    liechtenstein: 'LI',
  };
  return map[v.toLowerCase()] || v;
};

const extractSuggestedIso2 = (text?: string) => {
  if (!text) return null;
  const m = text.match(/sollte\s+['"]?([A-Z]{2})['"]?/i);
  return m?.[1]?.toUpperCase() ?? null;
};

const FIELD_LABELS: Record<string, string> = {
  'assistant.first_name': 'Vorname',
  'assistant.last_name': 'Nachname',
  'assistant.street': 'Strasse',
  'assistant.zip': 'PLZ',
  'assistant.city': 'Ort',
  'assistant.country': 'Nationalität',
  'assistant.phone': 'Telefon (optional)',
  'assistant.email': 'E-Mail',
  'assistant.birth_date': 'Geburtsdatum',
  'assistant.ahv_number': 'AHV-Nummer',
  'assistant.gender': 'Geschlecht',
  'assistant.civil_status': 'Zivilstand',
  'assistant.residence_permit': 'Aufenthaltsstatus',
  'contract_terms.start_date': 'Vertragsbeginn',
  'contract_terms.end_date': 'Vertragsende',
  'contract_terms.is_indefinite': 'Unbefristet',
  'contract_terms.hours_per_week': 'Stunden/Woche',
  'contract_terms.notice_period_days': 'Kündigungsfrist (Tage)',
  'wage.wage_type': 'Lohnart',
  'wage.hourly_rate': 'Stundenlohn (CHF)',
  'wage.vacation_weeks': 'Ferien (Wochen)',
  'wage.holiday_supplement_pct': 'Ferienzuschlag %',
  'wage.payment_iban': 'Lohnkonto (IBAN)',
  'social_insurance.canton': 'Wohnsitzkanton',
  'social_insurance.accounting_method': 'Abrechnungsverfahren',
  'social_insurance.nbu_total_rate_pct': 'Nichtberufsunfallversicherung (NBU) Gesamtprämiensatz (%) – manuell eingeben',
  'social_insurance.nbu_employer_pct': 'Nichtberufsunfallversicherung (NBU) AG-Prämienanteil (%) – aus Vertrag',
  'social_insurance.nbu_employee_pct': 'Nichtberufsunfallversicherung (NBU) AN-Prämienanteil (%) – aus Vertrag',
  'social_insurance.nbu_employer_voluntary': 'AG übernimmt Nichtberufsunfallversicherung (NBU) freiwillig',
};

/** UI-Feld-Schlüssel → Extraktions-Pfad (für Status, Review, Popup) */
const FIELD_KEY_TO_PATH: Record<string, string> = {
  firstName: 'assistant.first_name',
  lastName: 'assistant.last_name',
  street: 'assistant.street',
  plz: 'assistant.zip',
  city: 'assistant.city',
  country: 'assistant.country',
  phone: 'assistant.phone',
  email: 'assistant.email',
  birthDate: 'assistant.birth_date',
  gender: 'assistant.gender',
  ahvNumber: 'assistant.ahv_number',
  civilStatus: 'assistant.civil_status',
  residencePermit: 'assistant.residence_permit',
  contractStart: 'contract_terms.start_date',
  contractEnd: 'contract_terms.end_date',
  contractUnbefristet: 'contract_terms.is_indefinite',
  noticePeriodDays: 'contract_terms.notice_period_days',
  hoursPerWeek: 'contract_terms.hours_per_week',
  wageType: 'wage.wage_type',
  hourlyRate: 'wage.hourly_rate',
  vacationWeeks: 'wage.vacation_weeks',
  vacationSurcharge: 'wage.holiday_supplement_pct',
  iban: 'wage.payment_iban',
  billingMethod: 'social_insurance.accounting_method',
  canton: 'social_insurance.canton',
  nbuTotal: 'social_insurance.nbu_total_rate_pct',
  nbuEmployer: 'social_insurance.nbu_employer_pct',
  nbuEmployee: 'social_insurance.nbu_employee_pct',
  nbuEmployerVoluntary: 'social_insurance.nbu_employer_voluntary',
};

const PATH_TO_FIELD_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_KEY_TO_PATH).map(([k, v]) => [v, k]),
);

/** Reihenfolge „Prüfen“/„Ergänzen“-Popup: wie Hauptformular (Stammdaten → Vertrag → Lohn → NBU). */
const REVIEW_POPUP_PATH_ORDER: readonly string[] = [
  'assistant.first_name',
  'assistant.last_name',
  'assistant.street',
  'assistant.zip',
  'assistant.city',
  'assistant.birth_date',
  'assistant.ahv_number',
  'assistant.gender',
  'assistant.phone',
  'assistant.email',
  'assistant.country',
  'assistant.civil_status',
  'assistant.residence_permit',
  'contract_terms.start_date',
  'contract_terms.is_indefinite',
  'contract_terms.end_date',
  'contract_terms.notice_period_days',
  'contract_terms.hours_per_week',
  'wage.wage_type',
  'wage.hourly_rate',
  'wage.vacation_weeks',
  'wage.holiday_supplement_pct',
  'wage.payment_iban',
  'social_insurance.accounting_method',
  'social_insurance.canton',
  'social_insurance.nbu_total_rate_pct',
  'social_insurance.nbu_employer_pct',
  'social_insurance.nbu_employee_pct',
  'social_insurance.nbu_employer_voluntary',
];

function popupAttentionPathOrderIndex(path: string): number {
  const i = REVIEW_POPUP_PATH_ORDER.indexOf(path);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

const SWISS_CANTON_OPTIONS: [string, string][] = [
  ['AG', 'Aargau'],
  ['AI', 'Appenzell Innerrhoden'],
  ['AR', 'Appenzell Ausserrhoden'],
  ['BE', 'Bern'],
  ['BL', 'Basel-Landschaft'],
  ['BS', 'Basel-Stadt'],
  ['FR', 'Freiburg'],
  ['GE', 'Genf'],
  ['GL', 'Glarus'],
  ['GR', 'Graubünden'],
  ['JU', 'Jura'],
  ['LU', 'Luzern'],
  ['NE', 'Neuenburg'],
  ['NW', 'Nidwalden'],
  ['OW', 'Obwalden'],
  ['SG', 'St. Gallen'],
  ['SH', 'Schaffhausen'],
  ['SO', 'Solothurn'],
  ['SZ', 'Schwyz'],
  ['TG', 'Thurgau'],
  ['TI', 'Tessin'],
  ['UR', 'Uri'],
  ['VD', 'Waadt'],
  ['VS', 'Wallis'],
  ['ZG', 'Zug'],
  ['ZH', 'Zürich'],
];

// Grobe Ableitung Wohnsitzkanton aus PLZ-Präfix.
const ZIP_PREFIX_TO_CANTON: Record<string, string> = {
  '28': 'BE', '29': 'BE', '30': 'BE', '31': 'BE', '33': 'BE', '34': 'BE', '35': 'BE', '36': 'BE', '37': 'BE', '38': 'BE', '39': 'BE',
  '54': 'LU', '55': 'LU', '60': 'LU', '61': 'LU',
  '80': 'ZH', '81': 'ZH', '82': 'ZH', '83': 'ZH', '84': 'ZH', '85': 'ZH',
};

/** Verhindert doppelte Pipeline-Läufe für dieselbe Datei (z. B. React Strict Mode). */
const EXTRACTION_IN_FLIGHT = new Map<string, Promise<void>>();
function extractionDedupeKey(file: File) {
  return `${file.name}\0${file.size}\0${file.lastModified}`;
}

const TOAST_EXTRACTION_LOADING = 'extraction-loading';
const TOAST_EXTRACTION_RESULT = 'extraction-result';

function parseLooseNumber(input: string): number | null {
  const s = input.trim().replace('%', '').replace(/\s/g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function holidayPctToUiPercentString(value: unknown): string {
  if (value === null || value === undefined) return '';
  const n = typeof value === 'number' ? value : parseLooseNumber(String(value));
  if (n === null) return String(value).trim();
  // In den extrahierten Daten kommt der Ferienzuschlag typischerweise als Dezimal (z. B. 0.0833).
  const pct = n <= 1 ? n * 100 : n;
  return String(Number(pct.toFixed(2)));
}

function uiPercentStringToHolidayFractionString(value: string): string {
  const n = parseLooseNumber(value);
  if (n === null) return value.trim();
  // UI ist Prozent (z. B. 8.33) → persistiert wird Dezimal (z. B. 0.0833)
  const fraction = n / 100;
  return String(Number(fraction.toFixed(4)));
}

function pctFieldToUiPercentString(value: unknown): string {
  if (value === null || value === undefined) return '';
  const n = typeof value === 'number' ? value : parseLooseNumber(String(value));
  if (n === null) return String(value).trim();
  // Nichtberufsunfallversicherungs-Raten sind typischerweise 0.5–3%. Agent liefert Dezimal (0.012 = 1.2%).
  // Heuristik: ≤ 0.5 → Dezimal (×100), > 0.5 → bereits Prozent.
  const pct = n <= 0.5 ? n * 100 : n;
  if (pct > 10) return '';
  return String(Number(pct.toFixed(2)));
}

function shareFieldToUiString(value: unknown): string {
  if (value === null || value === undefined) return '';
  const n = typeof value === 'number' ? value : parseLooseNumber(String(value));
  if (n === null) return String(value).trim();
  if (n >= 0 && n <= 100) return String(Number(n.toFixed(0)));
  return '';
}

export type ErgaenzenSource =
  | 'insurance_policy'
  | 'bank_statement'
  | 'personal'
  | 'id_document'
  | 'address'
  | 'contract';

const ERGAENZEN_SOURCE_BY_PATH: Record<string, ErgaenzenSource> = {
  'social_insurance.nbu_total_rate_pct': 'insurance_policy',
  'social_insurance.nbu_employer_share_pct': 'insurance_policy',
  'social_insurance.nbu_employee_share_pct': 'insurance_policy',
  'wage.iban': 'bank_statement',
  'assistant.phone': 'personal',
  'assistant.email': 'personal',
  'assistant.gender': 'personal',
  'assistant.civil_status': 'personal',
  'assistant.ahv_number': 'id_document',
  'assistant.birth_date': 'id_document',
  'assistant.nationality': 'id_document',
  'assistant.residence_permit': 'id_document',
  'assistant.street': 'address',
  'assistant.zip': 'address',
  'assistant.city': 'address',
  'social_insurance.canton': 'address',
};

const SOURCE_LABELS: Record<ErgaenzenSource, { label: string; description: string }> = {
  insurance_policy: {
    label: 'Versicherungspolice',
    description: 'Aus der Unfallversicherungs-Police (NBU-Prämiensätze).',
  },
  bank_statement: {
    label: 'Kontoauszug / E-Banking',
    description: 'IBAN des Lohnkontos.',
  },
  personal: {
    label: 'Persönliche Angabe',
    description: 'Eigene Kontakt- und Personendaten.',
  },
  id_document: {
    label: 'Ausweis / AHV-Karte',
    description: 'Aus Ausweis, AHV-Karte oder Aufenthaltstitel.',
  },
  address: {
    label: 'Wohnadresse',
    description: 'Aktuelle Wohnadresse der Assistenzperson.',
  },
  contract: {
    label: 'Im Vertrag (nicht extrahierbar)',
    description: 'Steht eigentlich im Vertrag – bitte manuell nachschlagen.',
  },
};

export type PopupAttentionField = {
  path: string;
  label: string;
  missing: boolean;
  needsReview: boolean;
  hint?: string;
  source?: ErgaenzenSource;
};

/** Alle Formular-relevanten Pfade + alle vom Judge gemeldeten Pfade. */
function collectAttentionPaths(reviewPaths: string[]): string[] {
  const keys = new Set<string>(Object.values(FIELD_KEY_TO_PATH));
  for (const p of reviewPaths) keys.add(p);
  return [...keys];
}

function buildPopupAttentionFields(
  extraction: ContractExtractionResult | null,
  reviewPaths: string[],
  contractIsIndefinite: boolean,
): PopupAttentionField[] {
  if (!extraction?.contracts) return [];

  const reviewSet = new Set(reviewPaths);
  const paths = collectAttentionPaths(reviewPaths);
  const out: PopupAttentionField[] = [];
  const OPTIONAL_MISSING_PATHS = new Set<string>([
    'assistant.phone',
  ]);

  for (const path of paths) {
    const dot = path.indexOf('.');
    if (dot === -1) continue;
    const section = path.slice(0, dot) as keyof ContractExtractionResult['contracts'];
    if (section === 'employer') continue;
    const fieldName = path.slice(dot + 1);
    const contractSection = extraction.contracts[section];
    if (!contractSection || typeof contractSection !== 'object') continue;
    const rawField = (contractSection as Record<string, IDPField<unknown> | undefined>)[fieldName];
    if (!rawField) continue;

    const v = rawField.value;
    const missing =
      v === null ||
      v === undefined ||
      (typeof v === 'string' && v.trim() === '');

    const inReviewList = reviewSet.has(path);
    const lowConf =
      typeof rawField.confidence_score === 'number' && rawField.confidence_score < 0.8;
    const statusReview = (rawField as { status?: string }).status === 'review_required';

    const needsReview = inReviewList || lowConf || statusReview;

    if (
      path === 'contract_terms.end_date' &&
      contractIsIndefinite &&
      missing &&
      !needsReview
    ) {
      continue;
    }

    if (missing && !needsReview && OPTIONAL_MISSING_PATHS.has(path)) continue;
    if (!missing && !needsReview) continue;

    const sourceText = (rawField as any).source_text;
    const hasSourceInContract = typeof sourceText === 'string' && sourceText.trim().length > 0;

    let hint: string | undefined;
    if (missing) {
      hint = hasSourceInContract
        ? 'Im Vertrag vorhanden, aber nicht automatisch extrahierbar. Bitte manuell eintragen.'
        : `${FIELD_LABELS[path] || path} nicht im Vertrag vorhanden.`;
    } else {
      hint = 'Unsicherer Wert im Vertrag – bitte mit dem Arbeitsvertrag rechts abgleichen.';
    }

    const source: ErgaenzenSource | undefined = missing
      ? ERGAENZEN_SOURCE_BY_PATH[path] ?? (hasSourceInContract ? 'contract' : 'personal')
      : undefined;

    out.push({
      path,
      label: FIELD_LABELS[path] || path.replace(/\./g, ' › '),
      missing,
      needsReview,
      hint,
      source,
    });
  }

  // UX-Regel: Wenn Wohnsitzkanton Prüfbedarf hat, braucht es zwingend eine PLZ,
  // damit der Wohnsitzkanton nachvollziehbar/ableitbar ist.
  const cantonRow = out.find(r => r.path === 'social_insurance.canton');
  const plzRow = out.find(r => r.path === 'assistant.zip');
  const hasPlzValue = !!extraction?.contracts?.assistant?.zip?.value;
  if (cantonRow?.needsReview && !hasPlzValue) {
    if (plzRow) {
      plzRow.missing = true;
      plzRow.needsReview = true;
      plzRow.hint = 'Bitte PLZ ergänzen – sie wird für den Wohnsitzkanton benötigt.';
      plzRow.source = ERGAENZEN_SOURCE_BY_PATH['assistant.zip'];
    } else {
      out.unshift({
        path: 'assistant.zip',
        label: FIELD_LABELS['assistant.zip'] || 'PLZ',
        missing: true,
        needsReview: true,
        hint: 'Bitte PLZ ergänzen – sie wird für den Wohnsitzkanton benötigt.',
        source: ERGAENZEN_SOURCE_BY_PATH['assistant.zip'],
      });
    }
  }

  out.sort((a, b) => {
    if (a.missing !== b.missing) return a.missing ? -1 : 1;
    if (a.needsReview !== b.needsReview) return a.needsReview ? -1 : 1;
    const oa = popupAttentionPathOrderIndex(a.path);
    const ob = popupAttentionPathOrderIndex(b.path);
    if (oa !== ob) return oa - ob;
    return a.label.localeCompare(b.label, 'de');
  });

  return out;
}

// ─── Contract Preview (rechte Spalte im Prüfen-Modus) ─────────────────

function ContractPreview({
  contractPreviewUrl,
  contractFileName,
  contractMimeType,
  docxHtml,
}: {
  contractPreviewUrl: string | null;
  contractFileName: string;
  contractMimeType: string;
  docxHtml: string | null;
}) {
  const isPdf =
    contractMimeType.includes('pdf') ||
    contractFileName.toLowerCase().endsWith('.pdf') ||
    contractPreviewUrl?.toLowerCase().includes('.pdf') === true;
  const isImage = contractMimeType.startsWith('image/');
  const isDocx = !!docxHtml;
  const hasPreview = (contractPreviewUrl && (isPdf || isImage)) || isDocx;
  const showOpenLink = !!contractPreviewUrl && !hasPreview;

  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-slate-200 bg-slate-100/90 overflow-hidden shadow-sm">
      <div className="shrink-0 px-4 py-2 border-b border-slate-200/80 flex items-center justify-between gap-2 bg-white/60">
        <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
          Arbeitsvertrag
        </span>
        {contractPreviewUrl ? (
          <a
            href={contractPreviewUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] font-semibold text-slate-600 hover:text-slate-900 underline shrink-0"
          >
            Vertrag öffnen
          </a>
        ) : null}
      </div>
      <div className="flex-1 min-h-[240px] p-2 sm:p-3">
        {contractPreviewUrl && isPdf ? (
          <div className="w-full h-full min-h-[280px] rounded-lg border border-slate-200 bg-white overflow-hidden">
            <embed
              key={contractPreviewUrl}
              src={contractPreviewUrl}
              type="application/pdf"
              className="w-full h-full min-h-[280px]"
            />
          </div>
        ) : contractPreviewUrl && isImage ? (
          <div className="h-full overflow-auto rounded-lg border border-slate-200 bg-white flex items-start justify-center p-2">
            <img
              src={contractPreviewUrl}
              alt="Hochgeladener Vertrag"
              className="max-w-full h-auto object-contain"
            />
          </div>
        ) : isDocx ? (
          <div className="h-full overflow-auto rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
            <div
              className="prose prose-sm max-w-none prose-headings:text-slate-800 prose-p:text-slate-700 prose-table:text-sm"
              dangerouslySetInnerHTML={{ __html: docxHtml ?? '' }}
            />
          </div>
        ) : (
          <div className="h-full min-h-[200px] rounded-lg border border-dashed border-slate-300 bg-white flex flex-col items-center justify-center text-center px-4">
            <FileText className="w-10 h-10 text-slate-300 mb-2" />
            <p className="text-sm text-slate-500">
              {showOpenLink
                ? 'Für diesen Dateityp gibt es keine eingebettete Vorschau. Bitte die Datei separat öffnen.'
                : 'Keine Dateivorschau verfügbar. Bitte prüfen Sie die extrahierten Felder im Formular.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Ergänzen Source Guide (rechte Spalte im Ergänzen-Modus) ──────────

function ErgaenzenSourceGuide({ fields }: { fields: PopupAttentionField[] }) {
  const groups = useMemo(() => {
    const map = new Map<ErgaenzenSource, PopupAttentionField[]>();
    for (const f of fields) {
      if (!f.missing) continue;
      const key: ErgaenzenSource = f.source ?? 'personal';
      const arr = map.get(key) ?? [];
      arr.push(f);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [fields]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-amber-200 bg-amber-50/40 overflow-hidden shadow-sm">
      <div className="shrink-0 px-4 py-2 border-b border-amber-200/80 flex items-center gap-2 bg-amber-50/80">
        <HelpCircle className="w-4 h-4 text-amber-700" />
        <span className="text-[11px] font-semibold text-amber-900 uppercase tracking-wide">
          Nicht im Arbeitsvertrag
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3">
        <p className="text-sm text-amber-900 leading-relaxed">
          Diese Angaben stehen <span className="font-bold">nicht</span> im Vertrag. Bitte aus den folgenden Quellen ergänzen:
        </p>
        {groups.length === 0 ? (
          <div className="rounded-xl border border-amber-200 bg-white px-4 py-3 text-sm text-amber-900">
            Keine fehlenden Angaben – alles Weitere findest du im Arbeitsvertrag.
          </div>
        ) : (
          groups.map(([source, rows]) => {
            const meta = SOURCE_LABELS[source];
            return (
              <div key={source} className="rounded-xl border border-amber-200 bg-white px-4 py-3 shadow-sm">
                <div className="flex items-center gap-2 mb-1.5">
                  <Badge variant="secondary" className="bg-amber-100 text-amber-900 border-amber-200">
                    {meta.label}
                  </Badge>
                </div>
                <p className="text-xs text-slate-600 mb-2 leading-snug">{meta.description}</p>
                <ul className="text-xs text-slate-700 space-y-0.5">
                  {rows.map((r) => (
                    <li key={r.path} className="flex items-center gap-1.5">
                      <span className="inline-block w-1 h-1 rounded-full bg-amber-500" />
                      {r.label}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Review Fields List (rechte Spalte, oben) ─────────────────────────

function ReviewFieldsList({
  attentionFields,
  extraction,
}: {
  attentionFields: PopupAttentionField[];
  extraction: ContractExtractionResult | null;
}) {
  const getIdpField = (path: string): IDPField<unknown> | null => {
    if (!extraction?.contracts) return null;
    const dot = path.indexOf('.');
    if (dot === -1) return null;
    const section = path.slice(0, dot) as keyof ContractExtractionResult['contracts'];
    const fieldName = path.slice(dot + 1);
    const s = extraction.contracts[section];
    if (!s || typeof s !== 'object') return null;
    return (s as Record<string, IDPField<unknown>>)[fieldName] ?? null;
  };

  const scrollToField = (path: string) => {
    const fieldKey = PATH_TO_FIELD_KEY[path];
    if (!fieldKey) return;
    const el = document.getElementById(`field-${fieldKey}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  if (attentionFields.length === 0) {
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center rounded-2xl border border-emerald-200 bg-emerald-50/40 p-6">
        <div className="text-center">
          <ShieldCheck className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
          <p className="text-sm font-semibold text-emerald-800">Alle Felder bestätigt</p>
          <p className="text-xs text-emerald-700 mt-1">Keine Felder erfordern Prüfung.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-amber-200 bg-white overflow-hidden shadow-sm">
      <div className="shrink-0 px-4 py-2.5 border-b border-amber-200/80 flex items-center gap-2 bg-amber-50/80">
        <AlertTriangle className="w-4 h-4 text-amber-600" />
        <span className="text-[11px] font-semibold text-amber-900 uppercase tracking-wide">
          Zu prüfende Felder ({attentionFields.length})
        </span>
      </div>
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
        {attentionFields.map((field) => {
          const idpField = getIdpField(field.path);
          const conf = idpField?.confidence_score;
          const sourceText = (idpField as any)?.source_text as string | undefined;
          const value = idpField?.value;
          const hasExtractedValue = value !== null && value !== undefined && String(value).trim() !== '';

          return (
            <button
              key={field.path}
              type="button"
              onClick={() => scrollToField(field.path)}
              className="w-full text-left px-4 py-3 hover:bg-amber-50/50 transition-colors group"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                    <span className="text-xs font-semibold text-slate-800">{field.label}</span>
                    {field.missing ? (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200 shrink-0">Ergänzen</span>
                    ) : (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-200 shrink-0">Prüfen</span>
                    )}
                    {conf !== undefined && (
                      <span className="text-[9px] text-slate-400 shrink-0">{Math.round(conf * 100)}%</span>
                    )}
                  </div>
                  {hasExtractedValue && (
                    <p className="text-xs text-slate-600 truncate">
                      Wert: <span className="font-medium">{String(value)}</span>
                    </p>
                  )}
                  {sourceText && sourceText.trim() && (
                    <p className="text-[10px] text-slate-400 mt-0.5 line-clamp-1 italic">«{sourceText}»</p>
                  )}
                  {field.hint && (
                    <p className="text-[10px] text-slate-500 mt-0.5 leading-snug">{field.hint}</p>
                  )}
                </div>
                <span className="text-slate-300 group-hover:text-amber-400 transition-colors shrink-0 text-xs mt-0.5">↓</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Attention Checklist (linke Spalte oberhalb des Formulars) ────────

function AttentionChecklist({
  attentionFields,
  children,
}: {
  attentionFields: PopupAttentionField[];
  children: ReactNode;
}) {
  const hasAnyAttention = attentionFields.length > 0;

  return (
    <div className="rounded-2xl p-[1px] bg-[linear-gradient(90deg,rgba(59,130,246,0.55),rgba(168,85,247,0.50),rgba(16,185,129,0.38))] shadow-[0_22px_80px_rgba(2,6,23,0.18)]">
      <div className="relative rounded-2xl overflow-hidden bg-white">
        <div className="relative px-5 py-4 sm:px-6 sm:py-5 text-white overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_15%_0%,rgba(59,130,246,0.22),transparent_55%),radial-gradient(900px_520px_at_85%_15%,rgba(168,85,247,0.22),transparent_50%),radial-gradient(700px_520px_at_40%_120%,rgba(16,185,129,0.16),transparent_55%),linear-gradient(to_bottom,rgba(2,6,23,0.92),rgba(2,6,23,0.82))]" />
          <div className="relative flex items-start gap-4">
            <div className="w-12 h-12 rounded-2xl border border-white/15 bg-white/10 shrink-0 shadow-lg flex items-center justify-center">
              <AsklepiosExtractLogo className="w-6 h-6 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base sm:text-lg font-bold leading-tight">
                {hasAnyAttention ? 'Asklepios braucht deine Hilfe' : 'Daten bestätigen'}
              </h3>
              <p className="text-xs sm:text-sm text-white/80 mt-0.5 leading-relaxed">
                Bitte prüfe die unten markierten Felder anhand des Arbeitsvertrags rechts und ergänze fehlende Werte.
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white px-5 py-5 sm:px-6">
          {children}
        </div>
      </div>
    </div>
  );
}

// ─── Context Pane (rechte Spalte mit Kontext-Swap) ─────────────────────

function ContextPane({
  mode,
  ergaenzenFields,
  contractPreviewUrl,
  contractFileName,
  contractMimeType,
  docxHtml,
}: {
  mode: 'pruefen' | 'ergaenzen';
  ergaenzenFields: PopupAttentionField[];
  contractPreviewUrl: string | null;
  contractFileName: string;
  contractMimeType: string;
  docxHtml: string | null;
}) {
  return (
    <div
      aria-live="polite"
      className="h-full min-h-[320px] lg:min-h-0 transition-opacity duration-200"
    >
      {mode === 'pruefen' ? (
        <ContractPreview
          contractPreviewUrl={contractPreviewUrl}
          contractFileName={contractFileName}
          contractMimeType={contractMimeType}
          docxHtml={docxHtml}
        />
      ) : (
        <ErgaenzenSourceGuide fields={ergaenzenFields} />
      )}
    </div>
  );
}

// ─── Validation & Formatting Helpers ─────────────────────

/** Format AHV number as 756.XXXX.XXXX.XX while typing */
function formatAhvNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 13);
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
  if (digits.length <= 11) return `${digits.slice(0, 3)}.${digits.slice(3, 7)}.${digits.slice(7)}`;
  return `${digits.slice(0, 3)}.${digits.slice(3, 7)}.${digits.slice(7, 11)}.${digits.slice(11)}`;
}

/** Validate AHV number: must be 756.XXXX.XXXX.XX (13 digits) */
function validateAhvNumber(value: string): string | null {
  if (!value) return null; // empty = no error (handled by required check)
  const digits = value.replace(/\D/g, '');
  if (digits.length > 0 && !digits.startsWith('756')) return 'Muss mit 756 beginnen';
  if (digits.length > 0 && digits.length < 13) return `${13 - digits.length} Ziffern fehlen`;
  if (digits.length === 13) return null;
  return 'Ungültiges Format';
}

/** Validate Swiss PLZ: 4 digits, 1000-9699 */
function validatePlz(value: string): string | null {
  if (!value) return null;
  const v = value.trim();
  if (v.length !== 4) return 'PLZ muss 4 Ziffern haben';
  if (!isValidChPlz(v)) return 'Ungültige Schweizer PLZ';
  return null;
}

/** Format IBAN with spaces: CHxx xxxx xxxx xxxx xxxx x */
function formatIban(raw: string): string {
  const clean = raw.replace(/\s/g, '').toUpperCase().slice(0, 21);
  return clean.replace(/(.{4})/g, '$1 ').trim();
}

/** Validate Swiss IBAN (CH: 2 Prüfziffern + 5 Ziffern Bank + 12 alphanumerisch) */
function validateIban(value: string): string | null {
  if (!value) return null;
  const cleaned = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  if (cleaned.length > 0 && !cleaned.startsWith('CH')) return 'Muss mit CH beginnen';
  if (cleaned.length > 2 && cleaned.length < 21) return `${21 - cleaned.length} Zeichen fehlen`;
  if (cleaned.length > 21) return 'Zu viele Zeichen';
  if (cleaned.length !== 21) return null;

  // Per SWIFT IBAN Registry: CH-Format ist 2!n5!n12!c. Der Konto-Teil (letzte
  // 12 Zeichen) ist alphanumerisch – Buchstaben sind legal. KEIN OCR-Remap
  // hier: das würde valide IBANs zerstören oder falsche zu scheinbar validen
  // machen.
  if (!/^CH\d{7}[0-9A-Z]{12}$/.test(cleaned)) return 'Ungültige IBAN (Format)';

  const mod97 = (iban: string): number => {
    const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
    let remainder = 0;
    for (const ch of rearranged) {
      const code = ch.charCodeAt(0);
      if (code >= 48 && code <= 57) {
        remainder = (remainder * 10 + (code - 48)) % 97;
        continue;
      }
      if (code >= 65 && code <= 90) {
        const value = code - 55; // A=10..Z=35
        remainder = (remainder * 10 + Math.floor(value / 10)) % 97;
        remainder = (remainder * 10 + (value % 10)) % 97;
        continue;
      }
      return -1;
    }
    return remainder;
  };

  if (mod97(cleaned) !== 1) return 'Ungültige IBAN (Prüfziffer)';
  return null;
}

/** Validate positive number */
function validatePositiveNumber(value: string, label: string): string | null {
  if (!value) return null;
  const num = parseFloat(value);
  if (isNaN(num)) return `${label} muss eine Zahl sein`;
  if (num <= 0) return `${label} muss grösser als 0 sein`;
  return null;
}

interface AssistantOnboardingProps {
  onComplete: () => void;
  onClose: () => void;
  initialUploadFile?: File;
  editAssistant?: any; // To avoid circular imports, just use any or import from types
}

function MiniField({
  id,
  title,
  children,
  aiDetected = false,
  fieldStatus,
  attentionHighlight = false,
  required = false,
  hasValue = false,
  error,
  hint,
  className = ""
}: {
  id?: string,
  title: string,
  children: ReactNode,
  aiDetected?: boolean,
  fieldStatus?: 'ok' | 'review_required',
  /** Feld steht auch im Prüf-Dialog – orange hervorgehoben */
  attentionHighlight?: boolean,
  required?: boolean,
  hasValue?: boolean,
  error?: string | null,
  hint?: string,
  className?: string
}) {
  const isReviewRequired = fieldStatus === 'review_required';
  const needsCheck = isReviewRequired || attentionHighlight;
  // UX: Karten immer weiss; Status nur über Rahmen/Farbe kommunizieren.
  const borderColor = error
    ? 'border-red-300 bg-white'
    : needsCheck
      ? 'border-amber-300 bg-white'
      : 'border-slate-200 bg-white';
  // Wording-Konsistenz: überall nur "Prüfen" und "Ergänzen"
  const badgeText = needsCheck ? (hasValue ? 'Prüfen' : 'Ergänzen') : (!hasValue ? 'Optional' : 'OK');

  return (
    <div id={id} className={`p-2.5 rounded-xl border flex flex-col justify-between ${borderColor} transition-colors shadow-sm ${className}`}>
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">{title}</span>
          <div className="flex items-center gap-1">
            {aiDetected && hasValue && fieldStatus === 'ok' && !needsCheck && (
              <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 flex items-center gap-0.5">
                <ShieldCheck className="w-2.5 h-2.5" />
                OK
              </span>
            )}
            {needsCheck && (
              <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600 flex items-center gap-0.5">
                {hasValue ? <AlertTriangle className="w-2.5 h-2.5" /> : <HelpCircle className="w-2.5 h-2.5" />}
                {badgeText}
              </span>
            )}
          </div>
        </div>
        <div className="w-full">{children}</div>
      </div>
      <div className="min-h-[20px]">
        {error ? (
          <p className="text-[10px] mt-1.5 text-red-500 font-medium">{error}</p>
        ) : hint && hasValue ? (
          <p className="text-[10px] mt-1.5 text-emerald-500 font-medium">✓ {hint}</p>
        ) : !hasValue && !needsCheck ? (
          <p className="text-[10px] mt-1.5 text-slate-400">
            {required ? 'Pflichtfeld' : 'Optional'}
          </p>
        ) : null}
      </div>
    </div>
  );
}



export function AssistantOnboarding({ onComplete, onClose, initialUploadFile, editAssistant }: AssistantOnboardingProps) {
  const { employerAccess } = useAuth();
  
  const [step, setStep] = useState<'upload' | 'extracting' | 'rejected' | 'review' | 'success'>(
    editAssistant ? 'review' : (initialUploadFile ? 'extracting' : 'upload')
  );
  const [pendingExtractionToast, setPendingExtractionToast] = useState<{
    description: string;
    hasWarnings: boolean;
  } | null>(null);
  const [rejectedFileName, setRejectedFileName] = useState<string>('');
  const [pipelineDone, setPipelineDone] = useState(false);
  const [extraction, setExtraction] = useState<ContractExtractionResult | null>(null);
  const [extractionError, setExtractionError] = useState<string | null>(null);
  const [savedAssistantId, setSavedAssistantId] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);

  const confettiPieces = useMemo(() => {
    const colors = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
    return Array.from({ length: 50 }, () => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.5,
      duration: 1.2 + Math.random() * 1.5,
      size: 6 + Math.random() * 8,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotate: Math.random() * 360,
    }));
  }, []);

  // Editable fields - populated from extraction or manually
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [street, setStreet] = useState('');
  const [plz, setPlz] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('CH');
  const [phone, setPhone] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState('');
  const [ahvNumber, setAhvNumber] = useState('');
  const [civilStatus, setCivilStatus] = useState('');
  const [residencePermit, setResidencePermit] = useState('');
  const [email, setEmail] = useState('');

  const [contractStart, setContractStart] = useState('');
  const [contractEnd, setContractEnd] = useState('');
  const [contractUnbefristet, setContractUnbefristet] = useState(false);
  const [noticePeriodDays, setNoticePeriodDays] = useState('');
  const [hoursPerWeek, setHoursPerWeek] = useState('');
  const [hoursPerMonth, setHoursPerMonth] = useState('');
  const [wageType, setWageType] = useState('hourly');
  const [hourlyRate, setHourlyRate] = useState('');
  const [vacationWeeks, setVacationWeeks] = useState('4');
  const [vacationSurcharge, setVacationSurcharge] = useState('');
  const [iban, setIban] = useState('');
  /** Leer bis Extraktion oder Bearbeitung – kein stiller «Vereinfacht»-Default bei fehlendem Vertragswert */
  const [billingMethod, setBillingMethod] = useState('');
  const [canton, setCanton] = useState('');
  const [nbuTotal, setNbuTotal] = useState('');
  const [nbuEmployer, setNbuEmployer] = useState('');
  const [nbuEmployee, setNbuEmployee] = useState('');
  const [nbuEmployerVoluntary, setNbuEmployerVoluntary] = useState(false);
  const [ktvAg, setKtvAg] = useState('');
  const [ktvEmployee, setKtvEmployee] = useState('');

  const [saving, setSaving] = useState(false);
  // Binary review state
  const [reviewFields, setReviewFields] = useState<string[]>([]);
  const [attentionMode, setAttentionMode] = useState<'pruefen' | 'ergaenzen'>('pruefen');
  const [pipelineTrace, setPipelineTrace] = useState<PipelineTrace | null>(null);
  const extractionRunIdRef = useRef(0);
  const [extractingStartedAt, setExtractingStartedAt] = useState<number | null>(null);

  const [contractPreviewUrl, setContractPreviewUrl] = useState<string | null>(null);
  const [contractFileName, setContractFileName] = useState('');
  const [contractMimeType, setContractMimeType] = useState('');
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const contractUrlRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setContractPreviewFromFile = async (file: File | null) => {
    if (contractUrlRef.current) {
      URL.revokeObjectURL(contractUrlRef.current);
      contractUrlRef.current = null;
    }
    setDocxHtml(null);
    if (file) {
      const url = URL.createObjectURL(file);
      contractUrlRef.current = url;
      setContractPreviewUrl(url);
      setContractFileName(file.name);
      setContractMimeType(file.type || '');

      const isDocx = file.name.toLowerCase().endsWith('.docx') ||
        file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if (isDocx) {
        try {
          const mammoth = await import('mammoth');
          const arrayBuffer = await readFileAsArrayBuffer(file);
          const result = await mammoth.convertToHtml({ arrayBuffer });
          setDocxHtml(result.value);
        } catch (e) {
          console.warn('[Preview] DOCX-Konvertierung fehlgeschlagen:', e);
        }
      }
    } else {
      setContractPreviewUrl(null);
      setContractFileName('');
      setContractMimeType('');
    }
  };

  useEffect(() => {
    return () => {
      if (contractUrlRef.current) {
        URL.revokeObjectURL(contractUrlRef.current);
        contractUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (step === 'extracting') setExtractingStartedAt(Date.now());
    else setExtractingStartedAt(null);
  }, [step]);

  const pipelineTimingSummary = useMemo(() => {
    const t = pipelineTrace;
    if (!t?.steps?.length) return null;
    const get = (type: string) =>
      t.steps.find((s) => s.type === type)?.durationMs ?? null;
    const total = t.totalDurationMs ?? null;
    const pdf = get('pdf_extraction');
    const gate = get('contract_gate');
    const extract = get('agent_extraction');
    const judge = get('agent_judge');
    const fmt = (ms: number | null) => (ms == null ? null : `${Math.round(ms / 1000)}s`);
    const parts = [
      total != null ? `Total ${fmt(total)}` : null,
      pdf != null ? `Dokument ${fmt(pdf)}` : null,
      gate != null ? `Gate ${fmt(gate)}` : null,
      extract != null ? `Extraktion ${fmt(extract)}` : null,
      judge != null ? `Judge ${fmt(judge)}` : null,
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }, [pipelineTrace]);

  // UX: "Extraktion abgeschlossen" erst anzeigen, wenn UI wirklich im Review angekommen ist.
  useEffect(() => {
    if (step !== 'review') return;
    if (!pendingExtractionToast) return;
    toast.success('Extraktion abgeschlossen', {
      id: TOAST_EXTRACTION_RESULT,
      description: pendingExtractionToast.description,
      duration: pendingExtractionToast.hasWarnings ? 10000 : 4500,
    });
    setPendingExtractionToast(null);
  }, [step, pendingExtractionToast]);

  const popupAttentionFields = useMemo(
    () => buildPopupAttentionFields(extraction, reviewFields, contractUnbefristet),
    [extraction, reviewFields, contractUnbefristet],
  );

  const attentionFormKeys = useMemo(() => {
    const s = new Set<string>();
    for (const row of popupAttentionFields) {
      const k = PATH_TO_FIELD_KEY[row.path];
      if (k) s.add(k);
    }
    return s;
  }, [popupAttentionFields]);

  const getFieldStatus = (key: string): 'ok' | 'review_required' | undefined => {
    if (key === 'contractEnd' && contractUnbefristet) return 'ok';

    // UI-Regel: Leere Werte dürfen nie als OK erscheinen.
    if (key === 'canton' && !canton.trim()) return 'review_required';

    // NBU-Felder sind nur bei Pensum ≥ 8h/Woche gesetzlich obligatorisch.
    // Darunter zeigen wir keinen Pflicht-/Review-Hinweis.
    const _nbuHw = parseFloat(hoursPerWeek);
    const _nbuRequired = Number.isFinite(_nbuHw) && _nbuHw >= 8;
    if (_nbuRequired) {
      if (key === 'nbuTotal' && !nbuTotal.trim()) return 'review_required';
      if (key === 'nbuEmployer' && !nbuEmployer.trim()) return 'review_required';
      if (key === 'nbuEmployee' && !nbuEmployee.trim()) return 'review_required';
    }

    const field = confidenceMap[key];
    if (!field) return undefined;

    if ((field as any).status) return (field as any).status;

    const path = FIELD_KEY_TO_PATH[key];
    if (path && reviewFields.includes(path)) return 'review_required';

    return field.confidence_score >= 0.8 ? 'ok' : 'review_required';
  };

  // Trigger extraction immediately if initialUploadFile is provided
  useEffect(() => {
    if (initialUploadFile && step === 'extracting') {
      void processFile(initialUploadFile);
    }
  }, [initialUploadFile, step]);

  // Pre-fill form if editing an existing assistant
  useEffect(() => {
    if (editAssistant) {
      setSavedAssistantId(editAssistant.id);
      const data = editAssistant.contract_data || {};
      setFirstName(data.first_name || editAssistant.name?.split(' ')[0] || '');
      setLastName(data.last_name || editAssistant.name?.split(' ').slice(1).join(' ') || '');
      setStreet(data.street || '');
      setPlz(data.plz || '');
      setCity(data.city || '');
      setCountry(data.country || 'CH');
      setPhone(data.phone || '');
      setBirthDate(editAssistant.date_of_birth || data.birth_date || '');
      setGender(data.gender || '');
      setAhvNumber(data.ahv_number || '');
      setCivilStatus(data.civil_status || '');
      setResidencePermit(data.residence_permit || '');
      setEmail(editAssistant.email || '');
      setContractStart(data.contract_start || '');
      setContractEnd(data.contract_end || '');
      setContractUnbefristet(!!data.contract_unbefristet);
      setNoticePeriodDays(data.notice_period_days?.toString() || '');
      const existingHoursPerWeek = data.hours_per_week?.toString?.() || '';
      const existingHoursPerMonth = data.hours_per_month?.toString?.() || '';
      setHoursPerMonth(existingHoursPerMonth);
      setHoursPerWeek(existingHoursPerWeek || (Number.isFinite(Number(existingHoursPerMonth)) && Number(existingHoursPerMonth) > 0
        ? String(Number((Number(existingHoursPerMonth) / 4).toFixed(2)))
        : ''
      ));
      setWageType(data.wage_type || 'hourly');
      setHourlyRate(editAssistant.hourly_rate?.toString() || data.hourly_rate?.toString() || '');
      setVacationWeeks(editAssistant.vacation_weeks?.toString() || data.vacation_weeks?.toString() || '4');
      setVacationSurcharge(holidayPctToUiPercentString(data.vacation_surcharge));
      setIban(data.iban || data.payment_iban || '');
      setBillingMethod(
        data.billing_method === 'ordinary' || data.billing_method === 'standard'
          ? 'ordinary'
          : '',
      );
      setCanton(data.canton || '');
      setNbuTotal(pctFieldToUiPercentString(data.nbu_total || data.nbu_total_rate_pct));
      setNbuEmployer(shareFieldToUiString(data.nbu_employer || data.nbu_employer_pct));
      setNbuEmployee(shareFieldToUiString(data.nbu_employee || data.nbu_employee_pct));
      setNbuEmployerVoluntary(data.nbu_employer_voluntary === true);
      setKtvAg(data.ktv_ag?.toString() || '');
      setKtvEmployee(data.ktv_employee?.toString() || '');
    }
  }, [editAssistant]);

  // Confidence maps - tracks what the AI was sure about
  const [confidenceMap, setConfidenceMap] = useState<Record<string, IDPField<any>>>({});

  const populateFromExtraction = (result: ContractExtractionResult) => {
    const a = result.contracts.assistant;
    const ct = result.contracts.contract_terms;
    const w = result.contracts.wage;
    const si = result.contracts.social_insurance;

    // Build confidence map
    const cMap: Record<string, IDPField<any>> = {};
    const setField = (key: string, field: IDPField<any> | undefined, setter: (v: string) => void) => {
      if (!field) return;
      cMap[key] = field;
      if (field.value !== null && field.value !== undefined) {
        setter(String(field.value));
      }
    };

    setField('firstName', a.first_name, setFirstName);
    setField('lastName', a.last_name, setLastName);
    setField('street', a.street, setStreet);
    setField('plz', a.zip, setPlz);
    setField('city', a.city, setCity);
    setField('country', (a as any).country, setCountry);
    setField('phone', (a as any).phone, setPhone);
    setField('email', (a as any).email, setEmail);
    setField('birthDate', a.birth_date, setBirthDate);
    setField('gender', (a as any).gender, setGender);
    setField('ahvNumber', a.ahv_number, (v) => setAhvNumber(formatAhvNumber(v)));
    setField('civilStatus', a.civil_status, setCivilStatus);
    setField('residencePermit', a.residence_permit, setResidencePermit);

    if (ct) {
      setField('contractStart', ct.start_date, setContractStart);
      const indef = ct.is_indefinite?.value === true;
      setContractUnbefristet(!!indef);
      if (indef) {
        setContractEnd('');
      } else {
        setField('contractEnd', ct.end_date, setContractEnd);
      }
      if (ct.end_date) cMap.contractEnd = ct.end_date;
      if (ct.is_indefinite) cMap.contractUnbefristet = ct.is_indefinite;
      setField('hoursPerWeek', ct.hours_per_week, setHoursPerWeek);
      setField('noticePeriodDays', ct.notice_period_days, setNoticePeriodDays);
    }

    if (w) {
      setField('wageType', w.wage_type, setWageType);
      setField('hourlyRate', w.hourly_rate, setHourlyRate);
      setField('vacationWeeks', w.vacation_weeks, setVacationWeeks);
      // UI arbeitet mit Prozentwerten, Extraktion liefert typischerweise Dezimalwerte.
      if (w.holiday_supplement_pct) cMap.vacationSurcharge = w.holiday_supplement_pct;
      setVacationSurcharge(holidayPctToUiPercentString(w.holiday_supplement_pct?.value));
      setField('iban', w.payment_iban, setIban);
    }

    if (si) {
      if (si.accounting_method) {
        cMap.billingMethod = si.accounting_method;
        if (si.accounting_method.value !== null && si.accounting_method.value !== undefined) {
          setBillingMethod(String(si.accounting_method.value));
        } else {
          setBillingMethod('');
        }
      }
      setField('canton', si.canton, setCanton);
      // Nichtberufsunfallversicherungs-Gesamtprämiensatz wird NICHT aus der KI-Extraktion übernommen –
      // muss zwingend manuell gemäss Versicherungspolice eingegeben werden.
      // Die AG/AN-Aufteilung KANN hingegen aus dem Arbeitsvertrag extrahiert werden.
      if (si.nbu_employer_pct) cMap.nbuEmployer = si.nbu_employer_pct;
      if (si.nbu_employee_pct) cMap.nbuEmployee = si.nbu_employee_pct;
      if (si.nbu_employer_voluntary) cMap.nbuEmployerVoluntary = si.nbu_employer_voluntary;
      setNbuEmployer(shareFieldToUiString(si.nbu_employer_pct?.value));
      setNbuEmployee(shareFieldToUiString(si.nbu_employee_pct?.value));
      if (si.nbu_employer_voluntary?.value === true) setNbuEmployerVoluntary(true);
    }

    // UX: Wenn der Judge bereits ein konkretes ISO-Land vorschlägt, vorbefüllen,
    // damit der User nur noch "Prüfen" muss.
    const countryNote = (cMap.country as any)?.judge_justification || (cMap.country as any)?.note;
    const suggestedIso2 = extractSuggestedIso2(typeof countryNote === 'string' ? countryNote : undefined);
    if (suggestedIso2) {
      setCountry(suggestedIso2);
    } else if (cMap.country?.value != null) {
      setCountry(normalizeCountryToIso2(String(cMap.country.value)));
    }

    setConfidenceMap(cMap);
  };


  // Auto-derive Wohnsitzkanton aus PLZ (wenn noch nicht gesetzt)
  useEffect(() => {
    if (canton.trim()) return;
    const z = plz.trim();
    if (z.length !== 4) return;
    const p2 = z.substring(0, 2);
    const derived = ZIP_PREFIX_TO_CANTON[p2];
    if (derived) setCanton(derived);
  }, [plz, canton]);

  // Auto-fill Ort aus PLZ (nur wenn Ort noch leer ist)
  useEffect(() => {
    if (city.trim()) return;
    const z = plz.trim();
    if (z.length !== 4) return;
    const derivedCity = getCityFromChPlz(z);
    if (derivedCity) setCity(derivedCity);
  }, [plz, city]);

  const COUNTRY_OPTIONS = [
    { value: 'CH', label: 'Schweiz (CH)' },
    { value: 'DE', label: 'Deutschland (DE)' },
    { value: 'AT', label: 'Österreich (AT)' },
    { value: 'FR', label: 'Frankreich (FR)' },
    { value: 'IT', label: 'Italien (IT)' },
    { value: 'LI', label: 'Liechtenstein (LI)' },
    { value: 'OTHER', label: 'Anderes…' },
  ] as const;

  // Demo mode removed: contracts are always evaluated live via the agent pipeline after upload.

  const handleUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || !e.target.files[0]) return;
    const file = e.target.files[0];
    processFile(file);
  };

  const processFile = async (file: File) => {
    const dedupeKey = extractionDedupeKey(file);
    const inFlight = EXTRACTION_IN_FLIGHT.get(dedupeKey);
    if (inFlight) {
      await inFlight;
      return;
    }

    const run = (async () => {
      const runId = ++extractionRunIdRef.current;
      setStep('extracting');
      setPipelineDone(false);
      setExtractionError(null);
      setContractPreviewFromFile(file);

      toast.info('Dokument wird analysiert', {
        id: TOAST_EXTRACTION_LOADING,
        description: 'Bitte warten Sie, unser KI-Agent liest die Daten aus.',
      });

      try {
        const pipelineResult = await withTimeout(
          runDocumentPipeline(file),
          PIPELINE_TIMEOUT_MS,
          'KI-Analyse dauert ungewöhnlich lange',
        );

        // Falls der User abgebrochen oder neu gestartet hat: späte Resultate ignorieren.
        if (runId !== extractionRunIdRef.current) return;

        if (pipelineResult.classification !== 'contract') {
          toast.dismiss(TOAST_EXTRACTION_LOADING);
          setContractPreviewFromFile(null);
          setRejectedFileName(file.name);
          setStep('rejected');
          return;
        }

        if (!pipelineResult.extraction?.contracts) {
          throw new Error('Konnte keine Vertragsdaten extrahieren.');
        }

        const result = pipelineResult.extraction;

        setExtraction(result);
        populateFromExtraction(result);

        if (pipelineResult.assistant_id) {
          setSavedAssistantId(pipelineResult.assistant_id);
        }

        const rFields = pipelineResult.reviewFields || [];
        setReviewFields(rFields);
        const contractIndefAtImport =
          result.contracts.contract_terms?.is_indefinite?.value === true;
        const attention = buildPopupAttentionFields(
          result,
          rFields,
          !!contractIndefAtImport,
        );

        if (pipelineResult.trace) {
          setPipelineTrace(pipelineResult.trace);
        }

        setPipelineDone(true);

        // Default-Modus festlegen: wenn es Prüf-Felder gibt → prüfen, sonst ergänzen.
        const hasReviewRows = attention.some((f) => !f.missing && f.needsReview);
        setAttentionMode(hasReviewRows ? 'pruefen' : 'ergaenzen');

        const meta = result.extraction_metadata;
        const warnLines = (meta.warnings ?? []).map(formatAIWarning);
        const hasWarnings = warnLines.length > 0;
        const overallOk = (meta as any).overall_status === 'ok' && !hasWarnings;
        const statusText = overallOk
          ? 'Alle Felder OK'
          : hasWarnings
            ? 'Hinweise beachten (siehe unten)'
            : `${(meta as any).fields_requiring_review || 0} Felder prüfen`;

        toast.dismiss(TOAST_EXTRACTION_LOADING);

        const baseLine = `${meta.fields_extracted} Felder erkannt – ${statusText}`;
        const description = hasWarnings
          ? `${baseLine} — Hinweise: ${warnLines.join(' · ')}`
          : baseLine;

        // Toast erst nach UI-Wechsel auf "review" anzeigen, damit er nicht "zu früh" wirkt.
        setPendingExtractionToast({ description, hasWarnings });
      } catch (err) {
        // Run invalidieren, damit späte Promises nie mehr den State überschreiben.
        extractionRunIdRef.current++;
        toast.dismiss(TOAST_EXTRACTION_LOADING);
        setContractPreviewFromFile(null);
        const msg = err instanceof Error ? err.message : 'Unbekannter Fehler';
        setExtractionError(msg);
        toast.error('Extraktion fehlgeschlagen', {
          description: msg,
        });
        setStep('upload');
      }
    })();

    EXTRACTION_IN_FLIGHT.set(dedupeKey, run);
    try {
      await run;
    } finally {
      EXTRACTION_IN_FLIGHT.delete(dedupeKey);
    }
  };



  const doSave = async () => {
    if (!employerAccess?.employer_id) return;

    // NBU-Validierung
    //
    // Regeln (Fehler 4):
    //   - < 8h/Woche → NBU-Felder vollständig optional, keine Blockierung
    //   - ≥ 8h/Woche ohne NBU-Daten → nicht-blockierende Warnung
    //   - Wenn irgendein NBU-Feld befüllt ist, muss der Datensatz konsistent
    //     sein (Gesamtprämiensatz > 0, Aufteilung AG+AN = 100%).
    //
    // Der Freiwillig-Flag verändert die Aufteilung nicht mehr (Fehler 5).
    const nbuTotalTrim = nbuTotal.trim();
    const nbuEmployerOut = nbuEmployer.trim();
    const nbuEmployeeOut = nbuEmployee.trim();
    const anyNbuFieldEntered = !!(nbuTotalTrim || nbuEmployerOut || nbuEmployeeOut);
    const hwNum = parseFloat(hoursPerWeek);
    const nbuMandatory = Number.isFinite(hwNum) && hwNum >= 8;

    if (anyNbuFieldEntered) {
      const nbuTotalN = parseLooseNumber(nbuTotalTrim);
      if (nbuTotalN === null || nbuTotalN <= 0) {
        toast.error('NBU unvollständig', {
          description: 'Bitte den Nichtberufsunfall-Gesamtprämiensatz (%) eingeben oder alle NBU-Felder leer lassen.',
        });
        return;
      }
      if (!nbuEmployerOut || !nbuEmployeeOut) {
        toast.error('NBU unvollständig', {
          description: 'Bitte AG- und AN-Prämienanteil (%) eingeben.',
        });
        return;
      }
      const ag = parseFloat(nbuEmployerOut);
      const an = parseFloat(nbuEmployeeOut);
      if (!Number.isFinite(ag) || !Number.isFinite(an)) {
        toast.error('NBU ungültig', {
          description: 'AG- und AN-Prämienanteil müssen Zahlen sein.',
        });
        return;
      }
      if (Math.abs(ag + an - 100) > 0.1) {
        toast.error('NBU ungültig', {
          description: 'AG-Anteil + AN-Anteil muss 100% ergeben.',
        });
        return;
      }
    } else if (nbuMandatory) {
      // Nicht blockierend: Warnung anzeigen, aber Speichern nicht verhindern.
      toast.warning('Nichtberufsunfallversicherung fehlt', {
        description:
          `Bei einem Pensum von ${hoursPerWeek}h/Woche ist eine Nichtberufsunfallversicherung gesetzlich obligatorisch. ` +
          `Das Onboarding kann trotzdem abgeschlossen werden, die NBU-Angaben sollten jedoch nachgetragen werden.`,
        duration: 8000,
      });
    }

    setSaving(true);
    const fullName = `${firstName} ${lastName}`.trim();
    
    const payload = {
      employer_id: employerAccess.employer_id,
      name: fullName || 'Unbenannt',
      // DB-Constraint: assistant.email darf nicht NULL sein
      email: email.trim() || '',
      date_of_birth: birthDate.trim() || null,
      hourly_rate: parseFloat(hourlyRate) || null,
      // Bug D1: vacation_weeks muss 4–7 sein (OR); alles ausserhalb wird auf
      // null gesetzt, sodass der Lohnlauf nachfragt statt still zu defaulten.
      vacation_weeks: (() => {
        const n = parseInt(vacationWeeks, 10);
        return Number.isFinite(n) && n >= 4 && n <= 7 ? n : null;
      })(),
      has_bvg: false,
      time_entry_mode: 'manual' as const,
      is_active: true,
      contract_data: {
        first_name: firstName, last_name: lastName,
        street,
        plz, city,
        country: country.trim() || null,
        phone: phone.trim() || null,
        gender: gender || null,
        ahv_number: ahvNumber,
        civil_status: civilStatus, residence_permit: residencePermit,
        contract_start: contractStart,
        contract_end: contractUnbefristet ? '' : contractEnd,
        contract_unbefristet: contractUnbefristet,
        notice_period_days: noticePeriodDays.trim() || null,
        hours_per_week: hoursPerWeek, hours_per_month: hoursPerMonth,
        wage_type: wageType,
        vacation_surcharge: uiPercentStringToHolidayFractionString(vacationSurcharge),
        iban,
        billing_method:
          billingMethod === 'ordinary' ? billingMethod : null,
        canton,
        nbu_total: nbuTotalTrim,
        nbu_employer: nbuEmployerOut,
        nbu_employee: nbuEmployeeOut,
        nbu_employer_voluntary: nbuEmployerVoluntary,
        ktv_ag: ktvAg.trim() || null,
        ktv_employee: ktvEmployee.trim() || null,
        extraction_metadata: extraction?.extraction_metadata ?? null,
      }
    };
    
    let error;
    if (savedAssistantId) {
      // Watsonx IDP has already inserted a draft in Supabase, update it
      const { error: updateError } = await supabase
        .from('assistant')
        .update(payload)
        .eq('id', savedAssistantId);
      error = updateError;
    } else {
      // Fallback for manual or legacy creation
      const { data, error: insertError } = await supabase
        .from('assistant')
        .insert(payload)
        .select('id')
        .single();
      error = insertError;
      if (data) {
        setSavedAssistantId(data.id);
      }
    }

    setSaving(false);
    if (error) {
      toast.error('Speichern fehlgeschlagen', {
        description: error.message || 'Es ist ein unbekannter Fehler aufgetreten.'
      });
    } else {
      // Show confetti + success screen
      setShowConfetti(true);
      setStep('success');
      setTimeout(() => setShowConfetti(false), 3000);
    }
  };

  // Helper to check if field was AI-extracted
  const isFieldAi = (key: string): boolean => {
    return !!confidenceMap[key];
  };

  const isRequired = (key: string): boolean => {
    if (REQUIRED_FIELDS.includes(key)) return true;

    // Wenn Wohnsitzkanton Prüfbedarf hat, braucht es zwingend eine PLZ.
    if (key === 'plz' && getFieldStatus('canton') === 'review_required') return true;

    // NBU-Felder sind nur bei Pensum ≥ 8h/Woche gesetzlich obligatorisch.
    if (key === 'nbuTotal' || key === 'nbuEmployer' || key === 'nbuEmployee') {
      const hw = parseFloat(hoursPerWeek);
      return Number.isFinite(hw) && hw >= 8;
    }

    return false;
  };

  // Inputs immer weiss (keine transparenten Felder), auch im dunklen Flow-Container.
  const inputStyle = "w-full px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors";
  const selectStyle = "w-full px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-900 text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors";

  /** Build common MiniField props for a given field key */
  const fieldProps = (key: string) => ({
    aiDetected: isFieldAi(key),
    fieldStatus: getFieldStatus(key),
    attentionHighlight: attentionFormKeys.has(key),
    required: isRequired(key),
  });


  return (
    <div className="h-full flex flex-col gap-6 p-4 md:p-6 lg:p-8 overflow-y-auto lg:overflow-hidden">
      {/* Header: nur Zurück-Link (Titel/Intro entfallen – Inhalt folgt im Workflow-Card bzw. Upload-Bereich) */}
      <div className="shrink-0 rounded-2xl border bg-card px-5 py-3 sm:px-6 sm:py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Zurück zur Übersicht
          </button>
          {step === 'upload' ? (
            <div className="hidden sm:block">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.doc,.docx,.txt,image/*,application/pdf"
                onChange={handleUpload}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-foreground text-background font-bold text-sm shadow-sm hover:bg-foreground/90 transition-colors cursor-pointer"
              >
                <UploadCloud className="w-4 h-4" />
                Vertrag hochladen & scannen
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Upload */}
      {step === 'upload' && (
        <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto bg-card rounded-2xl border p-10">
          <div className="text-center max-w-lg mx-auto">
            <div className="w-14 h-14 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-5">
              <UploadCloud className="w-7 h-7 text-primary" />
            </div>
            <h3 className="text-lg font-bold mb-1.5">Arbeitsvertrag hochladen</h3>
            <p className="text-muted-foreground text-sm mb-6">
              Laden Sie ein JPG, PNG, PDF oder Word-Dokument hoch.
            </p>

            {extractionError && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 text-left flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-bold text-red-800 mb-1">Upload fehlgeschlagen</h4>
                  <p className="text-sm text-red-700">{extractionError}</p>
                </div>
              </div>
            )}

            <div className="flex flex-col items-center gap-3">
              <label className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-foreground text-background font-bold text-sm hover:bg-foreground/90 transition-colors cursor-pointer">
                <input 
                  type="file" 
                  accept=".pdf,.doc,.docx,.txt,image/*,application/pdf"
                  onChange={handleUpload}
                  className="hidden"
                />
                Datei auswählen
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Extracting */}
      {step === 'extracting' && (
        <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
          <ExtractingScreen
            pipelineDone={pipelineDone}
            onReadyForReview={() => setStep('review')}
            onCancel={() => {
              extractionRunIdRef.current++;
              toast.dismiss(TOAST_EXTRACTION_LOADING);
              setExtractionError(null);
              setContractPreviewFromFile(null);
              setPipelineDone(false);
              setStep('upload');
            }}
          />
        </div>
      )}

      {/* Rejected – kein Arbeitsvertrag */}
      {step === 'rejected' && (
        <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto bg-card rounded-2xl border overflow-x-hidden">
          <div className="bg-gradient-to-r from-red-50 to-orange-50 px-8 py-6 border-b">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-red-100 flex items-center justify-center">
                <AlertCircle className="w-6 h-6 text-red-500" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-red-900">Kein Arbeitsvertrag erkannt</h3>
                <p className="text-sm text-red-700/70">Das Dokument konnte nicht als Arbeitsvertrag klassifiziert werden</p>
              </div>
            </div>
          </div>

          <div className="p-8 space-y-6">
            <div className="bg-white rounded-xl border p-5 space-y-3">
              <div className="flex items-center gap-3">
                <FileText className="w-5 h-5 text-slate-400" />
                <div>
                  <p className="text-sm font-medium">Hochgeladene Datei</p>
                  <p className="text-xs text-muted-foreground">{rejectedFileName}</p>
                </div>
              </div>
              <div className="border-t pt-3">
                <p className="text-sm text-slate-600">
                  Unser KI-Agent hat das Dokument analysiert und <strong>keinen gültigen Schweizer Arbeitsvertrag</strong> erkannt. 
                  Das Document Classification Tool hat keine ausreichenden Vertragsindikatoren gefunden.
                </p>
              </div>
            </div>

            <div className="bg-blue-50 rounded-xl border border-blue-100 p-5">
              <p className="text-sm font-semibold text-blue-800 mb-2">Was wird akzeptiert?</p>
              <ul className="text-sm text-blue-700 space-y-1.5">
                <li>• Schweizer Arbeitsverträge (Assistenzbeitrag IV)</li>
                <li>• Anstellungsverträge mit Angaben zu Lohn, Pensum, Ferien</li>
                <li>• PDF, Word, Bild oder Textdatei</li>
              </ul>
            </div>

            <div className="flex gap-3 justify-center">
              <button
                type="button"
                onClick={() => { setStep('upload'); setRejectedFileName(''); }}
                className="px-6 py-2.5 rounded-full bg-foreground text-background font-bold text-sm hover:bg-foreground/90 transition-colors flex items-center gap-2"
              >
                <ArrowLeft className="w-4 h-4" /> Anderes Dokument hochladen
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Review */}
      {step === 'review' && (
        <form
          onSubmit={(e) => {
            // Enter/implicit submit soll niemals speichern.
            e.preventDefault();
          }}
          className="flex flex-col gap-3 lg:flex-1 lg:min-h-0"
        >
          {/* Binary Status Banner */}
          {Object.keys(confidenceMap).length > 0 && (
            <div className={`shrink-0 border rounded-xl px-4 py-2.5 flex items-center gap-3 ${
              popupAttentionFields.length > 0
                ? 'bg-amber-50 border-amber-200'
                : 'bg-emerald-50 border-emerald-200'
            }`}>
              {/* Pipeline-Timing nur im Dev-Modus */}
              {import.meta.env.DEV && pipelineTimingSummary ? (
                <p className="text-[11px] text-muted-foreground whitespace-nowrap mr-2">
                  {pipelineTimingSummary}
                </p>
              ) : null}
              {popupAttentionFields.length > 0 ? (
                <>
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <p className="text-xs text-amber-700">
                    <span className="font-bold">{popupAttentionFields.length} Felder prüfen oder ergänzen</span> – bitte die Liste unten durchgehen; im Formular sind dieselben Felder orange markiert.
                  </p>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                  <p className="text-xs text-emerald-700 flex-1">
                    <span className="font-bold">Alle Felder mit hoher Sicherheit erkannt</span> – trotzdem empfehlen wir eine kurze Überprüfung anhand des Vertrags rechts.
                  </p>
                </>
              )}
            </div>
          )}

          <div className="lg:flex-1 lg:min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,600px)] gap-4">

            {/* ── LINKE SPALTE: Ausfüllbare Felder ──────────────────── */}
            <div className="min-w-0 lg:min-h-0 lg:overflow-y-auto lg:pr-2 space-y-3">

              {/* Asklepios-Header-Kachel */}
              <div className="rounded-2xl p-[1px] bg-[linear-gradient(90deg,rgba(59,130,246,0.55),rgba(168,85,247,0.50),rgba(16,185,129,0.38))] shadow-[0_22px_80px_rgba(2,6,23,0.18)]">
                <div className="relative rounded-2xl overflow-hidden bg-white">
                  <div className="relative px-5 py-4 text-white overflow-hidden">
                    <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_15%_0%,rgba(59,130,246,0.22),transparent_55%),radial-gradient(900px_520px_at_85%_15%,rgba(168,85,247,0.22),transparent_50%),linear-gradient(to_bottom,rgba(2,6,23,0.92),rgba(2,6,23,0.82))]" />
                    <div className="relative flex items-start gap-4">
                      <div className="w-10 h-10 rounded-2xl border border-white/15 bg-white/10 shrink-0 flex items-center justify-center">
                        <AsklepiosExtractLogo className="w-5 h-5 text-white" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-bold leading-tight">
                          {popupAttentionFields.length > 0 ? 'Asklepios braucht deine Hilfe' : 'Daten bestätigen'}
                        </h3>
                        <p className="text-xs text-white/80 mt-0.5 leading-relaxed">
                          Prüfe die markierten Felder anhand des Arbeitsvertrags rechts und ergänze fehlende Werte.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

            {(() => {
              const ageForLogic = (() => {
                if (!birthDate) return null;
                const bd = new Date(birthDate);
                if (isNaN(bd.getTime())) return null;
                const today = new Date();
                let age = today.getFullYear() - bd.getFullYear();
                if (today.getMonth() < bd.getMonth() || (today.getMonth() === bd.getMonth() && today.getDate() < bd.getDate())) age--;
                return age;
              })();
              const showPermitWarning = !!residencePermit && residencePermit !== 'CH' && residencePermit !== 'C';
              const showAgeWarning = ageForLogic !== null && (ageForLogic < 18 || ageForLogic > 65);
              const hwForLogic = parseFloat(hoursPerWeek);
              const hrForLogic = parseFloat(hourlyRate);
              const monthlyForLogic = (Number.isFinite(hwForLogic) && Number.isFinite(hrForLogic) && hwForLogic > 0 && hrForLogic > 0)
                ? hwForLogic * 4 * hrForLogic
                : null;
              const showBvgWarning = monthlyForLogic !== null && monthlyForLogic > 1890;
              const showNbu8h = Number.isFinite(hwForLogic) && hwForLogic > 0;
              const nbu8hUnder = showNbu8h && hwForLogic < 8;
              return (
              <>
              {/* ── Kachel: Stammdaten ─────────────────────────────── */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2 animate-in fade-in duration-200">
                <div className="flex items-center gap-2 mb-1">
                  <User className="w-4 h-4 text-slate-500" />
                  <h4 className="text-sm font-bold text-slate-900">Stammdaten</h4>
                </div>
                <MiniField id="field-firstName" title="Vorname" {...fieldProps('firstName')} hasValue={!!firstName}>
                  <input type="text" placeholder="Bitte ergänzen..." value={firstName} onChange={e => setFirstName(e.target.value)} className={inputStyle} />
                </MiniField>
                <MiniField id="field-lastName" title="Nachname" {...fieldProps('lastName')} hasValue={!!lastName}>
                  <input type="text" placeholder="Bitte ergänzen..." value={lastName} onChange={e => setLastName(e.target.value)} className={inputStyle} />
                </MiniField>
                <MiniField id="field-street" title="Strasse" {...fieldProps('street')} hasValue={!!street}>
                  <input type="text" placeholder="z.B. Musterstrasse 12" value={street} onChange={e => setStreet(e.target.value)} className={inputStyle} />
                </MiniField>
                <MiniField id="field-plz" title="PLZ" {...fieldProps('plz')} hasValue={!!plz} error={validatePlz(plz)} hint="Gültige PLZ">
                  <input type="text" placeholder="z.B. 8000" maxLength={4} value={plz} onChange={e => { const v = e.target.value.replace(/\D/g, '').slice(0, 4); setPlz(v); }} className={inputStyle} />
                </MiniField>
                <MiniField id="field-city" title="Ort" {...fieldProps('city')} hasValue={!!city}>
                  <input type="text" placeholder="Bitte ergänzen..." value={city} onChange={e => setCity(e.target.value)} className={inputStyle} />
                </MiniField>
                <MiniField id="field-birthDate" title="Geburtsdatum" {...fieldProps('birthDate')} hasValue={!!birthDate}>
                  <input type="date" value={birthDate} onChange={e => setBirthDate(e.target.value)} className={inputStyle} />
                </MiniField>
                <MiniField id="field-ahvNumber" title="AHV-Nummer" {...fieldProps('ahvNumber')} hasValue={!!ahvNumber} error={validateAhvNumber(ahvNumber)} hint="Format korrekt">
                  <input type="text" placeholder="756.xxxx.xxxx.xx" value={ahvNumber} onChange={e => setAhvNumber(formatAhvNumber(e.target.value))} className={inputStyle} />
                </MiniField>
                <MiniField id="field-gender" title="Geschlecht" {...fieldProps('gender')} hasValue={!!gender}>
                  <select value={gender} onChange={e => setGender(e.target.value)} className={selectStyle}>
                    <option value="">Bitte wählen...</option>
                    <option value="male">Männlich</option>
                    <option value="female">Weiblich</option>
                    <option value="diverse">Divers</option>
                  </select>
                </MiniField>
                <MiniField id="field-phone" title="Telefon (optional)" {...fieldProps('phone')} hasValue={!!phone}>
                  <input type="text" placeholder="+41 ..." value={phone} onChange={e => setPhone(e.target.value)} className={inputStyle} />
                </MiniField>
                <MiniField id="field-email" title="E-Mail" {...fieldProps('email')} hasValue={!!email}>
                  <input type="email" placeholder="name@domain.ch" value={email} onChange={e => setEmail(e.target.value)} className={inputStyle} />
                </MiniField>
                <MiniField id="field-country" title="Nationalität" {...fieldProps('country')} hasValue={!!country}>
                  <select
                    value={country && COUNTRY_OPTIONS.some(o => o.value === country) ? country : 'OTHER'}
                    onChange={(e) => {
                      const v = e.target.value;
                      setCountry(v === 'OTHER' ? '' : v);
                    }}
                    className={selectStyle}
                  >
                    {COUNTRY_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </MiniField>
                <MiniField id="field-civilStatus" title="Zivilstand" {...fieldProps('civilStatus')} hasValue={!!civilStatus}>
                  <select value={civilStatus} onChange={e => setCivilStatus(e.target.value)} className={selectStyle}>
                    <option value="">Bitte wählen...</option>
                    <option value="ledig">Ledig</option>
                    <option value="verheiratet">Verheiratet</option>
                    <option value="geschieden">Geschieden</option>
                    <option value="verwitwet">Verwitwet</option>
                    <option value="eingetragene Partnerschaft">Eingetragene Partnerschaft</option>
                  </select>
                </MiniField>
                <MiniField id="field-residencePermit" title="Aufenthaltsstatus" {...fieldProps('residencePermit')} hasValue={!!residencePermit}>
                  <select value={residencePermit} onChange={e => setResidencePermit(e.target.value)} className={selectStyle}>
                    <option value="">Bitte wählen...</option>
                    <option value="CH">Schweizer/in</option>
                    <option value="C">Ausweis C (Niederlassung)</option>
                    <option value="B">Ausweis B (Aufenthalt)</option>
                    <option value="G">Ausweis G (Grenzgänger)</option>
                    <option value="L">Ausweis L (Kurzaufenthalt)</option>
                    <option value="N">Ausweis N (Asylsuchende)</option>
                    <option value="F">Ausweis F (vorläufig Aufgenommene)</option>
                  </select>
                </MiniField>

                {showAgeWarning && (
                  <div className="bg-red-50 rounded-xl border border-red-200 p-3 text-sm text-red-800 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>Alter {ageForLogic} Jahre – Lohnabrechnung nur für Personen im Alter von 18–65 Jahren möglich.</span>
                  </div>
                )}
                {showPermitWarning && (
                  <div className="bg-amber-50 rounded-xl border border-amber-200 p-3 text-sm text-amber-800 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>Aufenthaltsstatus «{residencePermit}» – Quellensteuer wäre nötig, ist aber aktuell <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-gray-200 text-gray-500 mx-0.5">Out of Scope</span>. Lohnabrechnung nur für Schweizer/innen und C-Bewilligung möglich.</span>
                  </div>
                )}

              </div>

              {/* ── Kachel: Vertragsdetails & Pensum ──────────────────── */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2">
                <div className="flex items-center gap-2 mb-1">
                  <FileText className="w-4 h-4 text-slate-500" />
                  <h4 className="text-sm font-bold text-slate-900">Vertragsdetails & Pensum</h4>
                </div>
                <MiniField id="field-contractStart" title="Vertragsbeginn" {...fieldProps('contractStart')} hasValue={!!contractStart}>
                  <input type="date" value={contractStart} onChange={e => setContractStart(e.target.value)} className={inputStyle} />
                </MiniField>
                <MiniField id="field-contractUnbefristet" title="Unbefristet" {...fieldProps('contractUnbefristet')} hasValue={contractUnbefristet}>
                  <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="w-5 h-5 rounded border-slate-300"
                      checked={contractUnbefristet}
                      onChange={(e) => {
                        const v = e.target.checked;
                        setContractUnbefristet(v);
                        if (v) setContractEnd('');
                      }}
                    />
                    <span>Kein fixes Vertragsende</span>
                  </label>
                </MiniField>
                <MiniField id="field-contractEnd" title="Vertragsende" {...fieldProps('contractEnd')} hasValue={contractUnbefristet || !!contractEnd}>
                  {contractUnbefristet ? (
                    <p className="text-xs text-slate-500 py-1.5">— nicht zutreffend —</p>
                  ) : (
                    <input type="date" value={contractEnd} onChange={e => setContractEnd(e.target.value)} className={inputStyle} />
                  )}
                </MiniField>
                <MiniField id="field-noticePeriodDays" title="Kündigungsfrist (Tage)" {...fieldProps('noticePeriodDays')} hasValue={!!noticePeriodDays}>
                  <input
                    type="number"
                    min={0}
                    placeholder="z. B. 30"
                    value={noticePeriodDays}
                    onChange={e => setNoticePeriodDays(e.target.value)}
                    className={inputStyle}
                  />
                </MiniField>
                <MiniField id="field-hoursPerWeek" title="Stunden/Woche" {...fieldProps('hoursPerWeek')} hasValue={!!hoursPerWeek} error={validatePositiveNumber(hoursPerWeek, 'Stunden')}>
                  <input type="number" min="0" max="168" step="0.5" placeholder="z.B. 20" value={hoursPerWeek} onChange={e => setHoursPerWeek(e.target.value)} className={inputStyle} />
                </MiniField>
              </div>

              {/* ── Kachel: Lohn ──────────────────────────────────────── */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2">
                <h4 className="text-sm font-bold text-slate-900 mb-1">Lohn</h4>
                <MiniField id="field-wageType" title="Lohnart" {...fieldProps('wageType')} hasValue={!!wageType}>
                  <select value={wageType} onChange={e => setWageType(e.target.value)} className={selectStyle}>
                    <option value="hourly">Stundenlohn</option>
                  </select>
                </MiniField>
                <MiniField id="field-hourlyRate" title="Stundenlohn (CHF)" {...fieldProps('hourlyRate')} hasValue={!!hourlyRate} error={validatePositiveNumber(hourlyRate, 'Stundenlohn')}>
                  <input type="number" step="0.05" min="0" placeholder="z.B. 30.00" value={hourlyRate} onChange={e => setHourlyRate(e.target.value)} className={inputStyle} />
                </MiniField>
                <MiniField id="field-vacationWeeks" title="Ferien (Wochen)" {...fieldProps('vacationWeeks')} hasValue={!!vacationWeeks}>
                  <select value={vacationWeeks} onChange={e => setVacationWeeks(e.target.value)} className={selectStyle}>
                    <option value="4">4</option>
                    <option value="5">5</option>
                    <option value="6">6</option>
                    <option value="7">7</option>
                  </select>
                </MiniField>
                {showBvgWarning && (
                  <div className="bg-amber-50 rounded-xl border border-amber-200 p-3 text-sm text-amber-800">
                    Monatliches Einkommen ca. CHF {monthlyForLogic!.toFixed(0)} – liegt über CHF 1’890 (BVG-Schwelle von CHF 22’680/Jahr).
                    <span className="inline-flex items-center ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-gray-200 text-gray-500">BVG Out of Scope</span>
                  </div>
                )}
              </div>

              {/* ── Kachel: Versicherung & Konto ─────────────────────── */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2">
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <h4 className="text-sm font-bold text-slate-900">Versicherung & Konto</h4>
                  <div className="flex gap-1.5">
                    {['BVG', 'Quellensteuer', 'Nachtdienst'].map(label => (
                      <span key={label} className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-gray-100 text-gray-400 border border-gray-200/60">
                        {label} – n/a
                      </span>
                    ))}
                  </div>
                </div>
                <MiniField id="field-vacationSurcharge" title="Ferienzuschlag %" {...fieldProps('vacationSurcharge')} hasValue={!!vacationSurcharge}>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="z.B. 8.33"
                    value={vacationSurcharge}
                    onChange={e => setVacationSurcharge(e.target.value)}
                    className={inputStyle}
                  />
                </MiniField>
                <MiniField id="field-iban" title="Lohnkonto (IBAN)" {...fieldProps('iban')} hasValue={!!iban} error={validateIban(iban)} hint="Gültige IBAN">
                  <input type="text" placeholder="CH93 0076 2011 6238 5295 7" value={iban} onChange={e => setIban(formatIban(e.target.value))} className={inputStyle} />
                </MiniField>
                <MiniField id="field-billingMethod" title="Abrechnungsverfahren" {...fieldProps('billingMethod')} hasValue={!!billingMethod}>
                  <select value={billingMethod} onChange={e => setBillingMethod(e.target.value)} className={selectStyle}>
                    <option value="">Bitte wählen…</option>
                    <option value="ordinary">Ordentlich</option>
                  </select>
                </MiniField>
                <MiniField
                  id="field-canton"
                  title="Wohnsitzkanton"
                  {...fieldProps('canton')}
                  hasValue={!!canton}
                  hint="Wohnsitzkanton der Assistenzperson (aus PLZ/Adresse abgeleitet) – bitte prüfen"
                >
                  <select value={canton} onChange={e => setCanton(e.target.value)} className={selectStyle}>
                    <option value="">Bitte wählen...</option>
                    {SWISS_CANTON_OPTIONS.map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                </MiniField>

                <div className="mt-4 pt-3 border-t border-slate-200 space-y-3">
                  <h5 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                    Nichtberufsunfallversicherung (NBU)
                  </h5>
                  <div className="flex items-start gap-2.5 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                    <HelpCircle className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" />
                    <span>Der <strong>Nichtberufsunfallversicherungs-Gesamtprämiensatz (NBU)</strong> muss zwingend manuell eingegeben werden – entnehmen Sie ihn Ihrer Versicherungspolice (typischerweise 0.5–3&nbsp;%). Die Aufteilung in AG-/AN-Anteil kann aus dem Arbeitsvertrag übernommen werden.</span>
                  </div>
                  {showNbu8h && nbu8hUnder && (
                    <div className="bg-blue-50 rounded-xl border border-blue-100 p-3 text-sm text-blue-700">
                      Pensum unter 8h/Woche – Nichtberufsunfallversicherung ist nicht obligatorisch. Die NBU-Felder sind optional und können leer bleiben.
                    </div>
                  )}
                  {showNbu8h && !nbu8hUnder && (
                    <div className="bg-emerald-50 rounded-xl border border-emerald-200 p-3 text-sm text-emerald-700">
                      Pensum ≥ 8h/Woche – Nichtberufsunfallversicherung pflichtig. Der Abzug wird auf der Lohnabrechnung ausgewiesen.
                    </div>
                  )}
                  <MiniField id="field-nbuTotal" title="Nichtberufsunfallvers. (NBU) Gesamtprämiensatz (%) – manuell" {...fieldProps('nbuTotal')} hasValue={!!nbuTotal}
                    hint="Gesamtprämiensatz gemäss Ihrer Versicherungspolice (typ. 0.5–3%)"
                    error={nbuTotal && parseFloat(nbuTotal) > 5 ? 'Unrealistisch hoch – Prämiensätze liegen typischerweise bei 0.5–3%' : undefined}>
                    <input type="number" min={0} max={10} step="0.01" placeholder="z.B. 1.50"
                      value={nbuTotal} onChange={e => setNbuTotal(e.target.value)} className={inputStyle} />
                  </MiniField>
                  <MiniField id="field-nbuEmployer" title="Nichtberufsunfallvers. (NBU) AG-Prämienanteil (%)" {...fieldProps('nbuEmployer')} hasValue={!!nbuEmployer}
                    error={nbuEmployer && nbuEmployee && Math.abs(parseFloat(nbuEmployer || '0') + parseFloat(nbuEmployee || '0') - 100) > 0.1 ? 'AG-Anteil + AN-Anteil muss 100% ergeben' : undefined}>
                    <input type="number" min={0} max={100} step="1" placeholder="z.B. 0"
                      value={nbuEmployer} onChange={e => setNbuEmployer(e.target.value)}
                      className={inputStyle} />
                  </MiniField>
                  <MiniField id="field-nbuEmployee" title="Nichtberufsunfallvers. (NBU) AN-Prämienanteil (%)" {...fieldProps('nbuEmployee')} hasValue={!!nbuEmployee}
                    error={nbuEmployer && nbuEmployee && Math.abs(parseFloat(nbuEmployer || '0') + parseFloat(nbuEmployee || '0') - 100) > 0.1 ? 'AG-Anteil + AN-Anteil muss 100% ergeben' : undefined}>
                    <input type="number" min={0} max={100} step="1" placeholder="z.B. 100"
                      value={nbuEmployee} onChange={e => setNbuEmployee(e.target.value)}
                      className={inputStyle} />
                  </MiniField>
                  <MiniField id="field-nbuEmployerVoluntary" title="AG übernimmt Nichtberufsunfallvers. (NBU) freiwillig" {...fieldProps('nbuEmployerVoluntary')} hasValue>
                    <label className="flex items-center gap-2 cursor-pointer mt-1">
                      <input type="checkbox" checked={nbuEmployerVoluntary}
                        onChange={e => setNbuEmployerVoluntary(e.target.checked)}
                        className="rounded border-gray-300 h-4 w-4" />
                      <span className="text-sm text-muted-foreground">Auch bei Pensum unter 8h/Woche</span>
                    </label>
                  </MiniField>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-200 space-y-3">
                  <h5 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                    Krankentaggeldversicherung (KTV)
                  </h5>
                  <p className="text-xs text-slate-500">Optional – nur ausfüllen wenn eine KTV besteht. Die Sätze finden sich in der Versicherungspolice oder im Arbeitsvertrag (in %).</p>
                  <MiniField id="field-ktvAg" title="KTV AG-Prämienanteil (%)" hasValue={!!ktvAg}
                    hint="Arbeitgeber-Anteil an der KTV-Prämie in Prozent (z.B. 0.50 für 0.5%)">
                    <input type="number" min={0} max={10} step="0.01" placeholder="z.B. 0.50"
                      value={ktvAg} onChange={e => setKtvAg(e.target.value)} className={inputStyle} />
                  </MiniField>
                  <MiniField id="field-ktvEmployee" title="KTV AN-Prämienanteil (%)" hasValue={!!ktvEmployee}
                    hint="Arbeitnehmer-Anteil an der KTV-Prämie in Prozent (z.B. 0.50 für 0.5%)">
                    <input type="number" min={0} max={10} step="0.01" placeholder="z.B. 0.50"
                      value={ktvEmployee} onChange={e => setKtvEmployee(e.target.value)} className={inputStyle} />
                  </MiniField>
                </div>
              </div>
              </>
              );
            })()}

            {/* Speichern */}
            <div className="flex items-center justify-end pb-2">
              <button type="button" onClick={doSave} disabled={saving || !firstName || !lastName}
                className="px-6 py-2.5 rounded-full bg-emerald-600 text-white font-bold text-sm hover:bg-emerald-700 disabled:opacity-50 transition-colors flex items-center gap-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <><CheckCircle2 className="w-4 h-4" /> Speichern & Beenden</>}
              </button>
            </div>
            </div>  {/* closes left column div */}

            <aside className="min-w-0 lg:min-h-0 lg:h-full flex flex-col gap-3 lg:overflow-hidden">
              {/* Top: Zu prüfende Felder */}
              <div className="min-h-[220px] lg:min-h-0 lg:flex-[2]">
                <ReviewFieldsList
                  attentionFields={popupAttentionFields}
                  extraction={extraction}
                />
              </div>
              {/* Bottom: Vertragsvorschau */}
              <div className="min-h-[360px] lg:min-h-0 lg:flex-[3]">
                <ContractPreview
                  contractPreviewUrl={contractPreviewUrl}
                  contractFileName={contractFileName}
                  contractMimeType={contractMimeType}
                  docxHtml={docxHtml}
                />
              </div>
            </aside>
          </div>
        </form>
      )}
      {/* Success */}
      {step === 'success' && (
        <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto relative">
          {/* Confetti */}
          {showConfetti && (
            <div className="fixed inset-0 z-50 pointer-events-none overflow-hidden">
              {confettiPieces.map((p, i) => (
                  <div key={i} style={{
                    position: 'absolute', left: `${p.left}%`, top: '-10px',
                    width: `${p.size}px`, height: `${p.size * 1.5}px`,
                    backgroundColor: p.color, borderRadius: '2px',
                    transform: `rotate(${p.rotate}deg)`,
                    animation: `confetti-fall ${p.duration}s ease-in ${p.delay}s forwards`,
                  }} />
              ))}
              <style>{`
                @keyframes confetti-fall {
                  0% { transform: translateY(0) rotate(0deg); opacity: 1; }
                  100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
                }
              `}</style>
            </div>
          )}

          <div className="bg-card rounded-2xl border p-10 text-center">
            <div className="w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-5">
              <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            </div>
            <h2 className="text-2xl font-bold mb-2">
              {firstName} {lastName} wurde {editAssistant ? 'aktualisiert' : 'angelegt'}! 🎉
            </h2>
            <p className="text-muted-foreground mb-8 max-w-md mx-auto">
              Teilen Sie {editAssistant ? 'bei Bedarf erneut' : 'jetzt'} den persönlichen Zugangslink, damit {firstName} ihre Arbeitszeiten selbst erfassen kann.
            </p>

            {savedAssistantId && (
              <div className="max-w-md mx-auto space-y-4 mb-8">
                {/* Link preview */}
                <div className="bg-muted/40 rounded-xl border p-4">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold mb-2">Persönlicher Zugangslink</p>
                  <code className="text-sm text-foreground break-all">{window.location.origin}/t/{savedAssistantId}</code>
                </div>

                {/* Share buttons */}
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      const link = `${window.location.origin}/t/${savedAssistantId}`;
                      const text = `Hallo ${firstName}!\n\nHier ist dein persönlicher Link zur Arbeitszeiterfassung:\n${link}\n\nSpeichere diesen Link als Favorit oder auf deinem Homescreen.`;
                      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
                    }}
                    className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-sm transition-colors"
                  >
                    <Share2 className="w-4 h-4" /> Per WhatsApp senden
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(`${window.location.origin}/t/${savedAssistantId}`);
                        setCopiedLink(true);
                        toast.success('Link kopiert!');
                        setTimeout(() => setCopiedLink(false), 2000);
                      } catch {
                        toast.error('Link konnte nicht kopiert werden');
                      }
                    }}
                    className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl border-2 border-primary/20 hover:border-primary/40 font-bold text-sm transition-colors"
                  >
                    {copiedLink ? <><Check className="w-4 h-4 text-emerald-500" /> Kopiert!</> : <><Copy className="w-4 h-4" /> Link kopieren</>}
                  </button>
                </div>

                {/* Info box */}
                <div className="bg-blue-50 rounded-xl border border-blue-100 p-4 text-left">
                  <p className="text-sm font-semibold text-blue-800 mb-2">💡 So funktioniert's:</p>
                  <ul className="text-sm text-blue-700 space-y-1.5">
                    <li>1. Senden Sie den Link per WhatsApp an {firstName}</li>
                    <li>2. {firstName} öffnet den Link auf dem Handy</li>
                    <li>3. Arbeitszeiten werden direkt in der App erfasst</li>
                    <li>4. Sie sehen alle Einträge hier in der Übersicht</li>
                  </ul>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={onComplete}
              className="px-8 py-3 rounded-full bg-foreground text-background font-bold text-sm hover:bg-foreground/90 transition-colors"
            >
              Zur Übersicht →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
