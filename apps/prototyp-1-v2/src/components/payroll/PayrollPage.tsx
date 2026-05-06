import { useState, useEffect, useRef, useMemo } from 'react';
import { supabase } from '@asklepios/core';
import { useAuth } from '@/contexts/AuthContext';
import {
  calculatePayroll, FAK_RATES, fmt, fmtPct, type PayrollResult,
  getFerienzuschlagRate, getFerienzuschlagLabel,
} from '@asklepios/core';
import { calculatePayslip, generatePayslipPdf, type PayslipAccountingMethod } from '@asklepios/core';
import { generateTimesheetPdf } from '@asklepios/core';
import {
  generateIvInvoicePdf,
  type IvInvoiceLine,
  activityLabelFromStoredCode,
  formatIvCategoryForInlineDisplay,
  IV_INVOICE_DEFAULT_RATE_CHF,
  getIvStelleInvoiceRecipientSuggestion,
} from '@asklepios/core';
import { PDFDocument } from 'pdf-lib';
import { Link } from 'react-router-dom';
import {
  Calculator, FileText, ChevronLeft, ChevronRight, Users,
  ShieldCheck, Clock, Eye, Download, Pencil, Save, X,
  ChevronDown, TrendingUp, Banknote, ArrowRight, ArrowLeft, Sparkles, Package, ClipboardList,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Assistant } from '@asklepios/core';
import { Badge, badgeVariants } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { sanitizeFilenamePart } from '@/utils/filename';
import asklepiosLogoUrl from '@/assets/asklepios-logo.png';

// ─── Types ───
interface MonthlyHours {
  totalHours: number;
  nightHours: number;
  entryCount: number;
  entries: {
    id: string;
    date: string;
    start_time: string;
    end_time: string;
    is_night: boolean;
    category?: string;
    hours: number;
  }[];
}

// ─── Helpers ───
const MONTH_NAMES = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

function parseHours(start: string, end: string): number {
  const toMin = (t: string) => {
    const [hhRaw, mmRaw] = (t || '').split(':');
    const hh = Number(hhRaw);
    const mm = Number(mmRaw);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    if (hh === 24 && mm === 0) return 24 * 60;
    if (hh < 0 || hh > 23) return null;
    if (mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  };
  const s = toMin(start);
  const e = toMin(end);
  if (s == null || e == null) return 0;
  const raw = e - s;
  const minutes = raw >= 0 ? raw : raw + 24 * 60;
  return Math.max(0, minutes / 60);
}

/** Anzeige/Bearbeitung: nur HH:mm (ohne Sekunden). */
function formatTimeHHmm(t: string | undefined | null): string {
  const raw = (t ?? '').trim();
  if (!raw) return '';
  const [hPart, mPart] = raw.split(':');
  if (mPart === undefined) return raw.slice(0, 5);
  const hh = Math.trunc(Number(hPart));
  const mm = Math.trunc(Number(String(mPart).replace(/\D/g, '').slice(0, 2)));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return raw.slice(0, 5);
  if (hh === 24 && mm === 0) return '24:00';
  return `${String(Math.min(23, Math.max(0, hh))).padStart(2, '0')}:${String(Math.min(59, Math.max(0, mm))).padStart(2, '0')}`;
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key: string): string {
  const parts = key.split('-');
  const y = parts[0] ?? '';
  const m = parts[1] ?? '01';
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}

function buildPersonPdfName(monthKeyStr: string, docType: string, personName: string): string {
  const datePart = sanitizeFilenamePart(monthKeyStr);
  const typePart = sanitizeFilenamePart(docType);
  const namePart = sanitizeFilenamePart(personName);
  return `${datePart}_${typePart}_${namePart}.pdf`;
}

function buildPdfName(monthKeyStr: string, docType: string): string {
  const datePart = sanitizeFilenamePart(monthKeyStr);
  const typePart = sanitizeFilenamePart(docType);
  return `${datePart}_${typePart}.pdf`;
}

async function loadImageAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('image_read_failed'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(blob);
  });
}

// ─── Flow Steps (3-step linear flow) ───
type FlowStep = 'stunden' | 'abrechnung' | 'dokumente';

/** Spiegelt bestätigte Monate in assistant.contract_data, damit der Zugangslink sie lesen kann. */
async function mirrorPayrollFreigabeToAssistant(assistantId: string, monthFirst: string) {
  const { data, error } = await supabase.from('assistant').select('contract_data').eq('id', assistantId).single();
  if (error || !data) return;
  const cd = { ...((data.contract_data as Record<string, unknown>) || {}) } as Record<string, unknown>;
  const prev = Array.isArray(cd.payroll_freigaben) ? (cd.payroll_freigaben as string[]) : [];
  const normalized = monthFirst.slice(0, 10);
  if (prev.some((p) => String(p).slice(0, 10) === normalized)) return;
  const freigaben = new Set([...prev, normalized]);
  cd.payroll_freigaben = [...freigaben].sort();
  await supabase.from('assistant').update({ contract_data: cd }).eq('id', assistantId);
}

export function PayrollPage() {
  const { employerAccess, employer } = useAuth();
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [loading, setLoading] = useState(true);

  // Current month navigation
  const [currentMonth, setCurrentMonth] = useState(() => monthKey(new Date()));

  // Expanded card & flow step
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [flowStep, setFlowStep] = useState<FlowStep>('stunden');
  const [confirmedMap, setConfirmedMap] = useState<Record<string, boolean>>({});
  const [noWorkMap, setNoWorkMap] = useState<Record<string, boolean>>({});

  // Time entries for the month
  const [timeEntries, setTimeEntries] = useState<Record<string, MonthlyHours>>({});

  // Editing state
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');

  // Ref for scroll-into-view
  const expandedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (employerAccess?.employer_id) {
      loadData();
    } else {
      setLoading(false);
    }
  }, [employerAccess, currentMonth]);

  // Persist "keine Arbeit" per month (client-side)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`payroll_no_work:${currentMonth}`);
      setNoWorkMap(raw ? JSON.parse(raw) : {});
    } catch {
      setNoWorkMap({});
    }
  }, [currentMonth]);

  const setNoWork = (assistantId: string, value: boolean) => {
    setNoWorkMap((prev) => {
      const next = { ...prev, [assistantId]: value };
      try {
        localStorage.setItem(`payroll_no_work:${currentMonth}`, JSON.stringify(next));
      } catch (_) { /* localStorage unavailable – safe to ignore */ }
      return next;
    });
  };

  // Scroll expanded card into view
  useEffect(() => {
    if (expandedId && expandedRef.current) {
      setTimeout(() => {
        expandedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [expandedId]);

  const loadData = async () => {
    setLoading(true);
    try {
      const eid = employerAccess!.employer_id;

      const { data: aData, error: aErr } = await supabase
        .from('assistant')
        .select('*')
        .eq('employer_id', eid)
        .eq('is_active', true);

      if (aErr) {
        toast.error('Fehler beim Laden der Assistenzpersonen', { description: aErr.message });
        return;
      }

      if (aData) setAssistants(aData);

      const parts = currentMonth.split('-').map(Number);
      // Bug B4: Fallback auf "jetzt" statt hartkodiertes Jahr 2026.
      const _now = new Date();
      const year = Number.isFinite(parts[0]) ? (parts[0] as number) : _now.getFullYear();
      const month = Number.isFinite(parts[1]) ? (parts[1] as number) : _now.getMonth() + 1;
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const endDate = month === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(month + 1).padStart(2, '0')}-01`;

      const assistantIds = (aData || []).map(a => a.id);
      const { data: entries } = assistantIds.length > 0
        ? await supabase
            .from('time_entry')
            .select('*')
            .gte('date', startDate)
            .lt('date', endDate)
            .in('assistant_id', assistantIds)
        : { data: [] as any[] };

      const grouped: Record<string, MonthlyHours> = {};
      for (const a of (aData || [])) {
        grouped[a.id] = { totalHours: 0, nightHours: 0, entryCount: 0, entries: [] };
      }

      for (const e of (entries || [])) {
        if (!grouped[e.assistant_id]) continue;
        const hours = parseHours(e.start_time || '00:00', e.end_time || '00:00');
        const g = grouped[e.assistant_id];
        if (!g) continue;
        g.totalHours += hours;
        if (e.is_night) g.nightHours += hours;
        g.entryCount++;
        g.entries.push({
          id: e.id, date: e.date, start_time: e.start_time,
          end_time: e.end_time, is_night: e.is_night,
          category: e.category, hours,
        });
      }

      setTimeEntries(grouped);

      if (assistantIds.length > 0) {
        const monthFirst = `${year}-${String(month).padStart(2, '0')}-01`;
        const { data: confRows } = await supabase
          .from('payroll_confirmation')
          .select('assistant_id, month, confirmed')
          .in('assistant_id', assistantIds)
          .eq('month', monthFirst);
        const nextConfirmed: Record<string, boolean> = {};
        for (const row of confRows || []) {
          if (!row.confirmed || !row.assistant_id) continue;
          // Bug B3: statt blindem slice(0,7) die gespeicherte Monats-Info
          // korrekt parsen. Supabase kann je nach Client Date oder String
          // liefern – beide Pfade robust behandeln.
          let mk: string | null = null;
          if (typeof row.month === 'string' && /^\d{4}-\d{2}/.test(row.month)) {
            mk = row.month.slice(0, 7);
          } else if (row.month != null) {
            const parsed = new Date(row.month as string | number | Date);
            if (!Number.isNaN(parsed.getTime())) {
              mk = `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`;
            }
          }
          if (!mk) continue;
          nextConfirmed[`${row.assistant_id}-${mk}`] = true;
          void mirrorPayrollFreigabeToAssistant(row.assistant_id, monthFirst);
        }
        setConfirmedMap(nextConfirmed);
      } else {
        setConfirmedMap({});
      }
    } catch (e) {
      console.error('[PayrollPage] loadData', e);
      toast.error('Unerwarteter Fehler beim Laden der Daten');
    } finally {
      setLoading(false);
    }
  };

  const shiftMonth = (dir: number) => {
    // Bug B4: Fallback nicht auf 2026 fest verdrahten – bei korruptem
    // currentMonth auf "jetzt" zurückfallen.
    const now = new Date();
    const parts = currentMonth.split('-').map(Number);
    const y = Number.isFinite(parts[0]) ? (parts[0] as number) : now.getFullYear();
    const m = Number.isFinite(parts[1]) ? (parts[1] as number) : now.getMonth() + 1;
    const d = new Date(y, m - 1 + dir, 1);
    setCurrentMonth(monthKey(d));
    setExpandedId(null);
    setFlowStep('stunden');
  };

  const toggleExpand = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setFlowStep('stunden');
    } else {
      setExpandedId(id);
      setFlowStep('stunden');
    }
  };

  // Generate payslip for an assistant
  const generatePayslip = (assistant: Assistant, hours: MonthlyHours): PayrollResult | null => {
    const cd = assistant.contract_data as any;
    const stundenlohn = assistant.hourly_rate || (cd?.hourly_rate ? parseFloat(cd.hourly_rate) : 0);
    if (!stundenlohn || hours.totalHours === 0) return null;

    // For FAK the canton of the employer (workplace = disabled person's home) takes
    // priority; the assistant's own residence canton from contract_data is the fallback.
    const kanton = employer?.canton || cd?.canton || 'ZH';
    // Bug A4: Ferienwochen dürfen nicht mehr still auf 4 fallen. Fehlt der
    // Wert oder ist er ungültig, warnen wir und benutzen 4 Wochen als
    // dokumentierten Fallback – sichtbar in der Konsole und im Toast.
    const rawVacWeeks = assistant.vacation_weeks;
    const resolvedRate = getFerienzuschlagRate(rawVacWeeks);
    const ferienzuschlag = resolvedRate ?? 0.0833;
    if (resolvedRate == null) {
      console.warn(
        `[payroll] Ferienwochen für ${assistant.name ?? assistant.id} fehlen oder sind ungültig (${rawVacWeeks}). Fallback 4 Wochen / 8.33% verwendet.`,
      );
    }

    // NBU wird zweistufig berechnet (Gesamtprämie × Anteil), siehe payroll.ts.
    // Die Aufteilung ist immer in nbu_employer/nbu_employee hinterlegt (Fehler 5);
    // der Freiwillig-Flag steuert nur noch, ob die NBU auch bei < 8h/Woche greift.
    const nbuTotalRate = cd?.nbu_total ? parseFloat(cd.nbu_total) / 100 : undefined;
    const nbuEmployerShare = cd?.nbu_employer != null && cd?.nbu_employer !== '' ? parseFloat(cd.nbu_employer) / 100 : undefined;
    const nbuEmployeeShare = cd?.nbu_employee != null && cd?.nbu_employee !== '' ? parseFloat(cd.nbu_employee) / 100 : undefined;
    const nbuEmployerVoluntary = cd?.nbu_employer_voluntary === true;
    // Bug A2: Nur explizit true durchlassen – payroll.ts verlangt jetzt ein
    // explizites Opt-in. Voluntary wird dort separat behandelt.
    const nbuEligible = cd?.nbu_eligible === true;

    const ktvAG = cd?.ktv_ag ? parseFloat(cd.ktv_ag) / 100 : undefined;
    const ktvAN = cd?.ktv_employee ? parseFloat(cd.ktv_employee) / 100 : undefined;

    return calculatePayroll({
      stundenlohn,
      anzahlStunden: hours.totalHours,
      kanton,
      abrechnungsverfahren: 'ordentlich',
      ferienzuschlag,
      nbuTotalRate,
      nbuEmployerShare,
      nbuEmployeeShare,
      nbuEligible,
      nbuEmployerVoluntary,
      ktvAG,
      ktvAN,
      agName: employer?.name,
      anName: assistant.name,
    });
  };

  const handleConfirm = async (assistantId: string, name: string) => {
    const parts = currentMonth.split('-').map(Number);
    // Bug B4: Fallback auf "jetzt" statt hartkodiertes Jahr 2026.
    const _now = new Date();
    const year = Number.isFinite(parts[0]) ? (parts[0] as number) : _now.getFullYear();
    const month = Number.isFinite(parts[1]) ? (parts[1] as number) : _now.getMonth() + 1;
    const monthFirst = `${year}-${String(month).padStart(2, '0')}-01`;

    const { error: confErr } = await supabase.from('payroll_confirmation').upsert({
      assistant_id: assistantId,
      month: monthFirst,
      confirmed: true,
      confirmed_at: new Date().toISOString(),
    }, { onConflict: 'assistant_id,month' });

    if (confErr) {
      toast.error('Freigabe konnte nicht gespeichert werden', { description: confErr.message });
      return;
    }

    // Zusätzlich in contract_data spiegeln, damit der Zugangslink (ohne payroll_confirmation-SELECT) die Freigabe sieht.
    const { data: asstRow, error: loadAsstErr } = await supabase
      .from('assistant')
      .select('contract_data')
      .eq('id', assistantId)
      .single();
    if (!loadAsstErr && asstRow) {
      const cd = { ...((asstRow.contract_data as Record<string, unknown>) || {}) } as Record<string, unknown>;
      const prev = Array.isArray(cd.payroll_freigaben) ? (cd.payroll_freigaben as string[]) : [];
      const freigaben = new Set([...prev, monthFirst]);
      cd.payroll_freigaben = [...freigaben].sort();
      const { error: patchErr } = await supabase.from('assistant').update({ contract_data: cd }).eq('id', assistantId);
      if (patchErr) {
        console.error('payroll_freigaben update', patchErr);
        // Bug D2: DB-Fehler muss als Fehler sichtbar werden, nicht als Hinweis.
        toast.error('Freigabe nur teilweise gespeichert', {
          description: `Die Spiegelung in contract_data ist fehlgeschlagen (${patchErr.message}). Der Assistenz-Link sieht die Freigabe ggf. erst nach erneutem Öffnen.`,
        });
      }
    }

    setConfirmedMap(prev => ({ ...prev, [`${assistantId}-${currentMonth}`]: true }));
    toast.success(`Lohnabrechnung für ${name} bestätigt!`);
    setFlowStep('dokumente');
  };

  const canGenerateMonthlyPackage = () => {
    // Paket ist nur sinnvoll, wenn alle Assistent:innen entweder bestätigt sind
    // ODER explizit als "keine Arbeit in diesem Monat" markiert sind.
    if (assistants.length === 0) return false;
    for (const a of assistants) {
      const hours = timeEntries[a.id];
      const hasHours = (hours?.totalHours || 0) > 0;
      if (!hasHours) {
        if (!noWorkMap[a.id]) return false;
        continue;
      }
      const confirmed = confirmedMap[`${a.id}-${currentMonth}`] || false;
      if (!confirmed) return false;
    }
    return true;
  };

  // Edit entry
  const startEditing = (entry: { id: string; start_time: string; end_time: string }) => {
    setEditingEntryId(entry.id);
    setEditStart(formatTimeHHmm(entry.start_time));
    setEditEnd(formatTimeHHmm(entry.end_time));
  };

  const cancelEditing = () => {
    setEditingEntryId(null);
    setEditStart('');
    setEditEnd('');
  };

  const resetPayrollConfirmationIfNeeded = async (assistantId: string, entryDate: string) => {
    const monthFirst = entryDate.slice(0, 7) + '-01';
    await supabase
      .from('payroll_confirmation')
      .update({ confirmed: false, confirmed_at: null })
      .eq('assistant_id', assistantId)
      .eq('month', monthFirst)
      .eq('confirmed', true);
    const { data: aRow } = await supabase
      .from('assistant')
      .select('contract_data')
      .eq('id', assistantId)
      .single();
    if (aRow?.contract_data) {
      const cd = { ...(aRow.contract_data as Record<string, unknown>) };
      const fr = Array.isArray(cd.payroll_freigaben) ? cd.payroll_freigaben as string[] : [];
      const updated = fr.filter(m => String(m).slice(0, 10) !== monthFirst);
      if (updated.length !== fr.length) {
        cd.payroll_freigaben = updated;
        await supabase.from('assistant').update({ contract_data: cd }).eq('id', assistantId);
      }
    }
  };

  const saveEdit = async (entryId: string, assistantId?: string, entryDate?: string) => {
    const { error } = await supabase
      .from('time_entry')
      .update({ start_time: editStart, end_time: editEnd })
      .eq('id', entryId);

    if (error) {
      toast.error('Fehler: ' + error.message);
    } else {
      toast.success('Eintrag aktualisiert');
      cancelEditing();
      if (assistantId && entryDate) {
        await resetPayrollConfirmationIfNeeded(assistantId, entryDate);
      }
      loadData();
    }
  };

  // Helper: get AG/AN address data
  const getEmployerAddress = () => {
    const cd = employer?.contact_data as any;
    return {
      name: employer?.name || '–',
      street: cd?.street || '',
      plzCity: cd?.plz && cd?.city ? `${cd.plz} ${cd.city}` : (cd?.city || ''),
    };
  };

  const getEmployeeAddress = (assistant: Assistant) => {
    const cd = assistant.contract_data as any;
    return {
      name: assistant.name || '–',
      street: cd?.street || '',
      plzCity: cd?.plz && cd?.city ? `${cd.plz} ${cd.city}` : (cd?.city || ''),
    };
  };

  const downloadMonthlyPackagePdf = async () => {
    if (!canGenerateMonthlyPackage()) {
      toast.error('Monatspaket noch nicht verfügbar', {
        description: 'Bitte bestätigen Sie zuerst alle Abrechnungen mit Stunden (oder lassen Sie Personen ohne Stunden unverändert).',
      });
      return;
    }

    try {
      // 1) IV Deckblatt (global)
      const cd = employer?.contact_data as any;
      const insuredName = employer?.name || `${cd?.first_name || ''} ${cd?.last_name || ''}`.trim() || '–';
      const issuerName =
        employer?.representation === 'guardian'
          ? `${cd?.first_name || ''} ${cd?.last_name || ''}`.trim() || insuredName
          : insuredName;

      const invoiceIssuerEmailPhone = [cd?.email || '', cd?.phone || ''].filter(Boolean).join(' · ');
      // Fixer IV-Ansatz gemäss Vorgabe: CHF 35.30 pro Stunde
      const rate = IV_INVOICE_DEFAULT_RATE_CHF;

      const ivLines: IvInvoiceLine[] = [];
      for (const a of assistants) {
        const hours = timeEntries[a.id];
        if (!hours || hours.totalHours <= 0) continue;
        const byCat = new Map<string, number>();
        for (const e of hours.entries) {
          const cat = (e.category || '').trim() || 'Ohne Kategorie';
          byCat.set(cat, (byCat.get(cat) || 0) + (e.hours || 0));
        }
        for (const [cat, h] of byCat.entries()) {
          const rounded = Number(h.toFixed(2));
          if (rounded <= 0) continue;
          const amount = Number((rounded * rate).toFixed(2));
          ivLines.push({
            assistantName: a.name || '—',
            activityLabel: cat === 'Ohne Kategorie' ? cat : activityLabelFromStoredCode(cat),
            hours: rounded,
            rateCHF: rate,
            amountCHF: amount,
          });
        }
      }
      ivLines.sort((x, y) => (x.assistantName + x.activityLabel).localeCompare(y.assistantName + y.activityLabel));
      const ivTotalHours = Number(ivLines.reduce((s, l) => s + (l.hours || 0), 0).toFixed(2));
      const ivTotalCHF = Number((ivTotalHours * rate).toFixed(2));

      let logoDataUrl = '';
      try { logoDataUrl = await loadImageAsDataUrl(asklepiosLogoUrl); } catch { /* Fallback: kein Logo */ }

      const recipientAuthorityManual = String(cd?.iv_invoice_authority_name ?? '').trim();
      const recipientPlzManual =
        cd?.iv_invoice_authority_plz && cd?.iv_invoice_authority_city
          ? `${cd.iv_invoice_authority_plz} ${cd.iv_invoice_authority_city}`.trim()
          : '';
      const ivStelleSuggestion = getIvStelleInvoiceRecipientSuggestion(employer?.canton);
      const invoiceRecipientResolved =
        recipientAuthorityManual || recipientPlzManual
          ? { authorityName: recipientAuthorityManual, plzCity: recipientPlzManual }
          : ivStelleSuggestion
            ? {
                authorityName: ivStelleSuggestion.authorityName,
                plzCity: ivStelleSuggestion.plzCity,
              }
            : { authorityName: '', plzCity: '' };

      const ivDoc = generateIvInvoicePdf({
        invoiceDateLabel: new Date().toLocaleDateString('de-CH'),
        monthLabel: `${String(new Date(currentMonth + '-01T12:00:00').getMonth() + 1).padStart(2, '0')}/${new Date(currentMonth + '-01T12:00:00').getFullYear()}`,
        logoDataUrl,
        insuredPerson: {
          name: insuredName,
          ahvNumber: cd?.insured_ahv_number || '',
          street: cd?.affected_street || cd?.insured_street || cd?.street || '',
          plzCity: (cd?.affected_plz && cd?.affected_city)
            ? `${cd.affected_plz} ${cd.affected_city}`
            : (cd?.insured_plz && cd?.insured_city)
              ? `${cd.insured_plz} ${cd.insured_city}`
              : (cd?.plz && cd?.city ? `${cd.plz} ${cd.city}` : ''),
        },
        invoiceIssuer: {
          name: issuerName,
          emailPhone: invoiceIssuerEmailPhone,
          street: cd?.street || '',
          plzCity: cd?.plz && cd?.city ? `${cd.plz} ${cd.city}` : '',
        },
        billing: {
          gln: cd?.billing_gln || '',
          referenceNumber: cd?.billing_reference_number || '',
          iban: cd?.billing_iban || '',
          accountHolderName: cd?.billing_account_holder_name || '',
          accountHolderStreet: cd?.billing_account_holder_street || '',
          accountHolderPlzCity: (cd?.billing_account_holder_plz && cd?.billing_account_holder_city)
            ? `${cd.billing_account_holder_plz} ${cd.billing_account_holder_city}`
            : '',
          paymentTermsDays: Number(cd?.payment_terms_days) || 30,
          bankName: cd?.bank_name || '',
        },
        invoiceRecipient: invoiceRecipientResolved,
        invoiceInquiriesFooter: {
          name: String(cd?.iv_invoice_inquiries_name ?? '').trim(),
          email: String(cd?.iv_invoice_inquiries_email ?? '').trim(),
          phone: String(cd?.iv_invoice_inquiries_phone ?? '').trim(),
        },
        lines: ivLines,
        totalCHF: ivTotalCHF,
      });

      const merged = await PDFDocument.create();

      const appendJsPdf = async (jsPdfDoc: any) => {
        const buf = jsPdfDoc.output('arraybuffer');
        const src = await PDFDocument.load(buf);
        const pages = await merged.copyPages(src, src.getPageIndices());
        for (const p of pages) merged.addPage(p);
      };

      await appendJsPdf(ivDoc);

      // 2) Per assistant – nur wenn Stunden > 0:
      //    zuerst Arbeits- und Einsatzrapport, dann Lohnabrechnung.
      for (const a of assistants) {
        const hours = timeEntries[a.id];
        if (!hours || hours.totalHours <= 0) continue;

        const reportDoc = generateTimesheetPdf({
          title: 'Arbeits- und Einsatzrapport',
          month: monthLabel(currentMonth),
          employer: getEmployerAddress(),
          employee: getEmployeeAddress(a),
          entries: hours.entries.map((e) => ({
            date: e.date,
            start_time: (e.start_time || '').slice(0, 5),
            end_time: (e.end_time || '').slice(0, 5),
            hours: Number((e.hours || 0).toFixed(2)),
            is_night: Boolean(e.is_night),
            category: e.category || '',
          })),
          totalHours: Number(hours.totalHours.toFixed(2)),
          nightHours: Number(hours.nightHours.toFixed(2)),
          includeActivities: true,
        });
        await appendJsPdf(reportDoc);

        const result = payrollResults[a.id];
        if (result) {
          // reuse existing generator to build the PDF
          const cd2 = a.contract_data as any;
          const kanton = employer?.canton || cd2?.canton || 'ZH';
          const kantonName = FAK_RATES[kanton]?.name || kanton;
          const stundenlohn = a.hourly_rate || 0;
          const ferienzuschlagRate = getFerienzuschlagRate(a.vacation_weeks) ?? 0.0833;
          const ferienzuschlagLabel = getFerienzuschlagLabel(a.vacation_weeks ?? 4);

          const bm = String(cd2?.billing_method || 'ordinary').toLowerCase();
          const accountingMethod: PayslipAccountingMethod =
            bm === 'simplified' || bm === 'vereinfacht' ? 'simplified'
              : (bm === 'ordinary_with_withholding' || bm === 'ordinary_quellensteuer') ? 'ordinary_with_withholding'
                : 'ordinary';
          const accountingMethodLabel =
            accountingMethod === 'simplified'
              ? 'Vereinfachtes'
              : accountingMethod === 'ordinary_with_withholding'
                ? 'Ordentliches mit Quellensteuer'
                : 'Ordentliches';

          const nbuTotalRate = cd2?.nbu_total ? parseFloat(cd2.nbu_total) / 100 : undefined;
          const nbuEmployerShare = cd2?.nbu_employer != null && cd2?.nbu_employer !== '' ? parseFloat(cd2.nbu_employer) / 100 : undefined;
          const nbuEmployeeShare = cd2?.nbu_employee != null && cd2?.nbu_employee !== '' ? parseFloat(cd2.nbu_employee) / 100 : undefined;
          const nbuEmployerVoluntary = cd2?.nbu_employer_voluntary === true;
          const nbuEligible = cd2?.nbu_eligible !== undefined ? (cd2.nbu_eligible || nbuEmployerVoluntary) : undefined;
          const payslip = calculatePayslip({
            canton: kanton,
            accountingMethod,
            hourlyRate: stundenlohn,
            hours: hours.totalHours,
            vacationSurchargeRate: ferienzuschlagRate,
            nbuTotalRate,
            nbuEmployerShare,
            nbuEmployeeShare,
            nbuEligible,
            nbuEmployerVoluntary,
          });

          const payslipDoc = generatePayslipPdf({
            monthYearLabel: monthLabel(currentMonth),
            placeDateLabel: formatPlaceDateLabel(),
            employer: getEmployerAddress(),
            employee: { ...getEmployeeAddress(a), ahvNumber: (a.contract_data as any)?.ahv_number || '' },
            grundlagen: {
              cantonLabel: `${kantonName}`,
              accountingMethodLabel,
              hourlyRate: stundenlohn,
              hours: hours.totalHours,
              vacationSurchargeLabel: ferienzuschlagLabel,
            },
            accountingMethod,
            result: payslip,
          });
          await appendJsPdf(payslipDoc);
        }
      }

      const bytes = await merged.save();
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const aEl = document.createElement('a');
      aEl.href = url;
      aEl.download = buildPdfName(currentMonth, `Rechnung_Assistenzbeitrag_${insuredName}`);
      document.body.appendChild(aEl);
      aEl.click();
      aEl.remove();
      URL.revokeObjectURL(url);
      toast.success('Monatspaket heruntergeladen');
    } catch (e) {
      console.error(e);
      toast.error('Monatspaket konnte nicht erstellt werden');
    }
  };

  const downloadLohnUndEinsatzrapportPdf = async (assistant: Assistant, hours: MonthlyHours) => {
    try {
      const merged = await PDFDocument.create();

      const appendJsPdf = async (jsPdfDoc: any) => {
        const buf = jsPdfDoc.output('arraybuffer');
        const src = await PDFDocument.load(buf);
        const pages = await merged.copyPages(src, src.getPageIndices());
        for (const p of pages) merged.addPage(p);
      };

      // Reihenfolge: zuerst Arbeits-/Einsatzrapport, dann Lohnabrechnung
      const reportDoc = generateTimesheetPdf({
        title: 'Arbeits- und Einsatzrapport',
        month: monthLabel(currentMonth),
        employer: getEmployerAddress(),
        employee: getEmployeeAddress(assistant),
        entries: hours.entries.map((e) => ({
          date: e.date,
          start_time: (e.start_time || '').slice(0, 5),
          end_time: (e.end_time || '').slice(0, 5),
          hours: Number((e.hours || 0).toFixed(2)),
          is_night: Boolean(e.is_night),
          category: e.category || '',
        })),
        totalHours: Number(hours.totalHours.toFixed(2)),
        nightHours: Number(hours.nightHours.toFixed(2)),
        includeActivities: true,
      });
      await appendJsPdf(reportDoc);

      const result = payrollResults[assistant.id];
      if (result) {
        const cd2 = assistant.contract_data as any;
        const kanton = employer?.canton || cd2?.canton || 'ZH';
        const kantonName = FAK_RATES[kanton]?.name || kanton;
        const stundenlohn = assistant.hourly_rate || 0;
        const ferienzuschlagRate = getFerienzuschlagRate(assistant.vacation_weeks) ?? 0.0833;
        const ferienzuschlagLabel = getFerienzuschlagLabel(assistant.vacation_weeks ?? 4);

        const bm = String(cd2?.billing_method || 'ordinary').toLowerCase();
        const accountingMethod: PayslipAccountingMethod =
          bm === 'simplified' || bm === 'vereinfacht' ? 'simplified'
            : (bm === 'ordinary_with_withholding' || bm === 'ordinary_quellensteuer') ? 'ordinary_with_withholding'
              : 'ordinary';
        const accountingMethodLabel =
          accountingMethod === 'simplified'
            ? 'Vereinfachtes'
            : accountingMethod === 'ordinary_with_withholding'
              ? 'Ordentliches mit Quellensteuer'
              : 'Ordentliches';

        const nbuTotalRate = cd2?.nbu_total ? parseFloat(cd2.nbu_total) / 100 : undefined;
        const nbuEmployerShare = cd2?.nbu_employer != null && cd2?.nbu_employer !== '' ? parseFloat(cd2.nbu_employer) / 100 : undefined;
        const nbuEmployeeShare = cd2?.nbu_employee != null && cd2?.nbu_employee !== '' ? parseFloat(cd2.nbu_employee) / 100 : undefined;
        const nbuEmployerVoluntary = cd2?.nbu_employer_voluntary === true;
        const nbuEligible = cd2?.nbu_eligible !== undefined ? (cd2.nbu_eligible || nbuEmployerVoluntary) : undefined;
        const payslip = calculatePayslip({
          canton: kanton,
          accountingMethod,
          hourlyRate: stundenlohn,
          hours: hours.totalHours,
          vacationSurchargeRate: ferienzuschlagRate,
          nbuTotalRate,
          nbuEmployerShare,
          nbuEmployeeShare,
          nbuEligible,
          nbuEmployerVoluntary,
        });

        const payslipDoc = generatePayslipPdf({
          monthYearLabel: monthLabel(currentMonth),
          placeDateLabel: formatPlaceDateLabel(),
          employer: getEmployerAddress(),
          employee: { ...getEmployeeAddress(assistant), ahvNumber: (assistant.contract_data as any)?.ahv_number || '' },
          grundlagen: {
            cantonLabel: `${kantonName}`,
            accountingMethodLabel,
            hourlyRate: stundenlohn,
            hours: hours.totalHours,
            vacationSurchargeLabel: ferienzuschlagLabel,
          },
          accountingMethod,
          result: payslip,
        });
        await appendJsPdf(payslipDoc);
      }

      const bytes = await merged.save();
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const aEl = document.createElement('a');
      aEl.href = url;
      aEl.download = buildPersonPdfName(currentMonth, 'Lohn-und_Einsatzrapport', assistant.name);
      document.body.appendChild(aEl);
      aEl.click();
      aEl.remove();
      URL.revokeObjectURL(url);
      toast.success('Lohn- und Einsatzrapport heruntergeladen');
    } catch (e) {
      console.error(e);
      toast.error('Lohn- und Einsatzrapport konnte nicht erstellt werden');
    }
  };

  const formatPlaceDateLabel = () => {
    const cd = employer?.contact_data as any;
    const place = (cd?.city || '').trim();
    const date = new Date().toLocaleDateString('de-CH');
    return place ? `${place}, ${date}` : date;
  };

  // PDF handlers
  const downloadPayslipPdf = (assistant: Assistant, _result: PayrollResult, hours: MonthlyHours) => {
    const cd = assistant.contract_data as any;
    const kanton = employer?.canton || cd?.canton || 'ZH';
    const kantonName = FAK_RATES[kanton]?.name || kanton;
    const stundenlohn = assistant.hourly_rate || 0;
    const ferienzuschlagRate = getFerienzuschlagRate(assistant.vacation_weeks) ?? 0.0833;
    const ferienzuschlagLabel = getFerienzuschlagLabel(assistant.vacation_weeks ?? 4);

    const bm = String(cd?.billing_method || 'ordinary').toLowerCase();
    const accountingMethod: PayslipAccountingMethod =
      bm === 'simplified' || bm === 'vereinfacht' ? 'simplified'
        : (bm === 'ordinary_with_withholding' || bm === 'ordinary_quellensteuer') ? 'ordinary_with_withholding'
          : 'ordinary';
    const accountingMethodLabel =
      accountingMethod === 'simplified'
        ? 'Vereinfachtes'
        : accountingMethod === 'ordinary_with_withholding'
          ? 'Ordentliches mit Quellensteuer'
          : 'Ordentliches';

    const nbuTotalRate = cd?.nbu_total ? parseFloat(cd.nbu_total) / 100 : undefined;
    const nbuEmployerShare = cd?.nbu_employer != null && cd?.nbu_employer !== '' ? parseFloat(cd.nbu_employer) / 100 : undefined;
    const nbuEmployeeShare = cd?.nbu_employee != null && cd?.nbu_employee !== '' ? parseFloat(cd.nbu_employee) / 100 : undefined;
    const nbuEmployerVoluntary = cd?.nbu_employer_voluntary === true;
    const nbuEligible = cd?.nbu_eligible !== undefined ? (cd.nbu_eligible || nbuEmployerVoluntary) : undefined;
    const payslip = calculatePayslip({
      canton: kanton,
      accountingMethod,
      hourlyRate: stundenlohn,
      hours: hours.totalHours,
      vacationSurchargeRate: ferienzuschlagRate,
      nbuTotalRate,
      nbuEmployerShare,
      nbuEmployeeShare,
      nbuEligible,
      nbuEmployerVoluntary,
    });

    const doc = generatePayslipPdf({
      monthYearLabel: monthLabel(currentMonth),
      placeDateLabel: formatPlaceDateLabel(),
      employer: getEmployerAddress(),
      employee: { ...getEmployeeAddress(assistant), ahvNumber: cd?.ahv_number || '' },
      grundlagen: {
        cantonLabel: `${kantonName}`,
        accountingMethodLabel,
        hourlyRate: stundenlohn,
        hours: hours.totalHours,
        vacationSurchargeLabel: ferienzuschlagLabel,
      },
      accountingMethod,
      result: payslip,
    });

    doc.save(buildPersonPdfName(currentMonth, 'Lohnabrechnung', assistant.name));
    toast.success('Lohnabrechnung PDF heruntergeladen');
  };

  // Stats
  const totalHoursAll = Object.values(timeEntries).reduce((s, h) => s + h.totalHours, 0);
  const confirmedCount = assistants.filter(a => confirmedMap[`${a.id}-${currentMonth}`]).length;

  const payrollResults = useMemo(() => {
    const results: Record<string, PayrollResult | null> = {};
    for (const a of assistants) {
      const hours = timeEntries[a.id];
      if (hours) {
        results[a.id] = generatePayslip(a, hours);
      } else {
        results[a.id] = null;
      }
    }
    return results;
  }, [assistants, timeEntries, currentMonth, employer]);

  const assistantsWithHoursList = assistants.filter(
    (a) => (timeEntries[a.id]?.totalHours || 0) > 0,
  );
  const assistantsWithoutHoursList = assistants.filter(
    (a) => (timeEntries[a.id]?.totalHours || 0) <= 0,
  );
  const confirmedAmongWithHours = assistantsWithHoursList.filter(
    (a) => confirmedMap[`${a.id}-${currentMonth}`],
  ).length;
  const noWorkAmongWithoutHours = assistantsWithoutHoursList.filter(
    (a) => noWorkMap[a.id],
  ).length;
  const monthlyPackageReady = canGenerateMonthlyPackage();

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 lg:p-8">
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
      {/* ── HERO HEADER ── */}
      <div style={{
        background: 'linear-gradient(135deg, #1e293b 0%, #334155 50%, #475569 100%)',
        borderRadius: 20,
        padding: '32px 36px 28px',
        marginBottom: 28,
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* Decorative circles */}
        <div style={{
          position: 'absolute', top: -40, right: -40,
          width: 160, height: 160, borderRadius: '50%',
          background: 'rgba(255,255,255,0.04)',
        }} />
        <div style={{
          position: 'absolute', bottom: -20, right: 80,
          width: 100, height: 100, borderRadius: '50%',
          background: 'rgba(255,255,255,0.03)',
        }} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', position: 'relative', zIndex: 1 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10,
                background: 'linear-gradient(135deg, #2563eb, #059669)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Calculator style={{ width: 20, height: 20, color: '#fff' }} />
              </div>
              <h1 style={{ fontSize: 22, fontWeight: 800, color: '#fff', margin: 0, letterSpacing: '-0.02em' }}>
                Lohnabrechnung
              </h1>
            </div>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', margin: 0 }}>
              Automatisch berechnet aus Vertragsdaten und erfassten Stunden
            </p>
          </div>

          {/* Month selector */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'rgba(255,255,255,0.08)',
            borderRadius: 12, padding: '6px 6px',
            backdropFilter: 'blur(10px)',
          }}>
            <button
              onClick={() => shiftMonth(-1)}
              aria-label="Vorheriger Monat"
              style={{
                width: 34, height: 34, borderRadius: 8, border: 'none',
                background: 'rgba(255,255,255,0.08)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'rgba(255,255,255,0.7)', transition: 'all 0.2s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
            >
              <ChevronLeft style={{ width: 18, height: 18 }} />
            </button>
            <span style={{
              fontSize: 14, fontWeight: 700, color: '#fff',
              minWidth: 140, textAlign: 'center',
              letterSpacing: '-0.01em',
            }}>
              {monthLabel(currentMonth)}
            </span>
            <button
              onClick={() => shiftMonth(1)}
              aria-label="Nächster Monat"
              style={{
                width: 34, height: 34, borderRadius: 8, border: 'none',
                background: 'rgba(255,255,255,0.08)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'rgba(255,255,255,0.7)', transition: 'all 0.2s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
            >
              <ChevronRight style={{ width: 18, height: 18 }} />
            </button>
          </div>
        </div>

        {/* Stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: 14, marginTop: 24, position: 'relative', zIndex: 1 }}>
          <StatCard icon={<Users style={{ width: 16, height: 16 }} />} label="Personen" value={String(assistants.length)} />
          <StatCard icon={<Clock style={{ width: 16, height: 16 }} />} label="Stunden" value={fmt(totalHoursAll)} />
          <StatCard icon={<ShieldCheck style={{ width: 16, height: 16 }} />} label="Bestätigt" value={`${confirmedCount}/${assistants.length}`} />
        </div>
      </div>

      {/* ── IV Monatsdokument (global) ── */}
      {!loading && (
        <div
          className={cn(
            'relative mb-5 overflow-hidden rounded-2xl border shadow-sm',
            monthlyPackageReady ? 'border-success/40 bg-card' : 'border-border bg-card',
          )}
        >
          <div
            className={cn(
              'relative space-y-4 p-5 pb-6 sm:p-6',
              monthlyPackageReady && 'bg-success/[0.04]',
            )}
          >
            <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
              <div className="min-w-0 flex-1 space-y-3">
                <div className="flex flex-wrap items-start gap-3 sm:items-center">
                  <div
                    className={cn(
                      'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border',
                      monthlyPackageReady
                        ? 'border-success/40 bg-success/10 text-success'
                        : 'border-primary/25 bg-primary/[0.07] text-primary',
                    )}
                  >
                    <Package className="h-5 w-5" strokeWidth={2} aria-hidden />
                  </div>
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-lg font-extrabold uppercase tracking-wide text-foreground sm:text-xl">
                        Monatspaket (IV)
                      </p>
                      {monthlyPackageReady && (
                        <Badge variant="success" className="gap-1 rounded-full border-0 bg-success/12 px-2.5 py-0.5 text-success shadow-none">
                          <Sparkles className="h-3.5 w-3.5 opacity-90" aria-hidden />
                          Freigeschaltet
                        </Badge>
                      )}
                    </div>
                    <p className="max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-[0.9375rem]">
                      Sobald alle Lohnabrechnungen bestätigt sind oder Personen ohne Stunden als «Keine Arbeit» markiert wurden,
                      können Sie hier das komplette Paket für die IV erzeugen: Deckblatt plus alle relevanten PDFs.{' '}
                      Stellen Sie sicher, dass alle Angaben unter{' '}
                      <Link to="/settings" className="font-medium text-primary underline underline-offset-2 hover:text-primary/80">
                        Einstellungen &amp; Profil
                      </Link>{' '}
                      vollständig ausgefüllt sind.
                    </p>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Status</span>
                      {assistantsWithHoursList.length > 0 && (
                        <Badge variant="secondary" className="rounded-full px-2.5 py-0.5 font-mono text-xs tabular-nums shadow-sm">
                          Bestätigt {confirmedAmongWithHours}/{assistantsWithHoursList.length}
                        </Badge>
                      )}
                      {assistantsWithoutHoursList.length > 0 && (
                        <Badge
                          variant="outline"
                          className={cn(
                            'rounded-full border-dashed px-2.5 py-0.5 font-mono text-xs tabular-nums shadow-sm',
                            noWorkAmongWithoutHours >= assistantsWithoutHoursList.length &&
                              'border-success/55 bg-success/12 text-success',
                          )}
                        >
                          Keine Arbeit {noWorkAmongWithoutHours}/{assistantsWithoutHoursList.length}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void downloadMonthlyPackagePdf()}
                disabled={!monthlyPackageReady}
                className={cn(
                  'inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-xl border-0 px-5 py-3 text-sm font-extrabold transition-colors',
                  'outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  'sm:w-auto',
                  monthlyPackageReady
                    ? 'cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 active:bg-primary/95'
                    : 'cursor-not-allowed bg-muted text-muted-foreground shadow-none',
                )}
                title={monthlyPackageReady ? 'Monatspaket als PDF herunterladen' : 'Noch nicht verfügbar'}
              >
                <Download className="h-5 w-5 shrink-0" />
                Alles in 1 PDF
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ASSISTANT CARDS (Flow) ── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: '#94a3b8' }}>
          <div style={{
            width: 32, height: 32, border: '3px solid #e2e8f0', borderTopColor: '#3b82f6',
            borderRadius: '50%', margin: '0 auto 12px',
            animation: 'spin 0.8s linear infinite',
          }} />
          Lade Daten...
        </div>
      ) : assistants.length === 0 ? (
        <div style={{
          background: '#fff', borderRadius: 16, border: '1px solid #e2e8f0',
          padding: '48px 32px', textAlign: 'center',
        }}>
          <Users style={{ width: 40, height: 40, color: '#cbd5e1', margin: '0 auto 12px', display: 'block' }} />
          <p style={{ color: '#94a3b8', fontSize: 15 }}>Noch keine Assistenzpersonen erfasst.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {assistants.map(a => {
            const hours = timeEntries[a.id] || { totalHours: 0, nightHours: 0, entryCount: 0, entries: [] };
            const result = payrollResults[a.id];
            const confirmed = confirmedMap[`${a.id}-${currentMonth}`] || false;
            const isExpanded = expandedId === a.id;

            return (
              <div
                key={a.id}
                ref={isExpanded ? expandedRef : undefined}
                style={{
                  background: '#fff',
                  borderRadius: 16,
                  border: isExpanded ? '2px solid #3b82f6' : '1px solid #e2e8f0',
                  overflow: 'hidden',
                  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                  boxShadow: isExpanded
                    ? '0 8px 30px rgba(59, 130, 246, 0.12), 0 2px 8px rgba(0,0,0,0.04)'
                    : '0 1px 3px rgba(0,0,0,0.04)',
                }}
              >
                {/* ── Card header (always visible) ── */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleExpand(a.id)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(a.id); } }}
                  style={{
                    width: '100%', border: 'none', background: 'transparent',
                    cursor: 'pointer', padding: '18px 22px',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = '#f8fafc'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div style={{
                      width: 44, height: 44, borderRadius: 12,
                      background: confirmed
                        ? 'linear-gradient(135deg, #d1fae5, #a7f3d0)'
                        : 'linear-gradient(135deg, #eff6ff, #dbeafe)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      {confirmed
                        ? <ShieldCheck style={{ width: 22, height: 22, color: '#059669' }} />
                        : <span style={{ fontSize: 18, fontWeight: 700, color: '#3b82f6' }}>{a.name.charAt(0)}</span>
                      }
                    </div>
                    <div style={{ textAlign: 'left' }}>
                      <p style={{ fontSize: 15, fontWeight: 600, color: '#0f172a', margin: 0 }}>{a.name}</p>
                      <p style={{ fontSize: 12, color: '#94a3b8', margin: '2px 0 0' }}>
                        {hours.entryCount} Einträge · {fmt(hours.totalHours)} Std
                        {hours.nightHours > 0 && <> · {fmt(hours.nightHours)} Nacht <span style={{ fontSize: 9, background: '#f1f5f9', padding: '1px 5px', borderRadius: 9999, color: '#94a3b8', fontWeight: 600, letterSpacing: '0.03em' }}>ohne Zuschlag</span></>}
                      </p>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    {hours.totalHours <= 0 && (
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          setNoWork(a.id, !noWorkMap[a.id]);
                        }}
                        className={cn(
                          badgeVariants({
                            variant: noWorkMap[a.id] ? 'success' : 'outline',
                          }),
                          'cursor-pointer rounded-full px-3 py-1 text-[11px] font-bold shadow-none hover:opacity-95',
                          !noWorkMap[a.id] && 'border-dashed text-muted-foreground hover:bg-muted/70',
                        )}
                        title="Markieren, dass diese Person in diesem Monat nicht gearbeitet hat"
                      >
                        {noWorkMap[a.id] ? '✓ Keine Arbeit' : 'Keine Arbeit?'}
                      </button>
                    )}
                    {result ? (
                      <div style={{ textAlign: 'right', minWidth: 0 }}>
                        <p style={{ fontSize: 12, fontWeight: 600, color: '#0f172a', margin: 0, letterSpacing: '-0.01em' }}>
                          Gesamtkosten Arbeitgeber
                        </p>
                        <p style={{
                          fontSize: 16,
                          fontWeight: 700,
                          color: '#0f172a',
                          margin: '2px 0 0',
                          fontVariantNumeric: 'tabular-nums',
                          letterSpacing: '-0.02em',
                        }}>
                          CHF {fmt(result.totalaufwandAG.perYear)}
                        </p>
                        <p style={{ fontSize: 11, color: '#64748b', margin: '4px 0 0', lineHeight: 1.35 }}>
                          Auszuzahlender Nettolohn: CHF {fmt(result.nettolohn.perYear)}
                        </p>
                      </div>
                    ) : (
                      <p style={{ fontSize: 12, color: '#cbd5e1', fontStyle: 'italic' }}>Keine Stunden</p>
                    )}
                    <div style={{
                      width: 30, height: 30, borderRadius: 8,
                      background: isExpanded ? '#3b82f6' : '#f1f5f9',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all 0.3s',
                    }}>
                      <ChevronDown style={{
                        width: 16, height: 16,
                        color: isExpanded ? '#fff' : '#94a3b8',
                        transition: 'transform 0.3s',
                        transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      }} />
                    </div>
                  </div>
                </div>

                {/* ── Expanded content ── */}
                {isExpanded && (
                  <div style={{
                    borderTop: '1px solid #e2e8f0',
                    animation: 'slideDown 0.3s ease-out',
                  }}>
                    {/* Step indicator */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 0, padding: '12px 22px',
                      background: '#f8fafc', borderBottom: '1px solid #f1f5f9',
                      flexWrap: 'wrap',
                    }}>
                      <button
                        onClick={() => setFlowStep('stunden')}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '7px 14px', borderRadius: 8 ,
                          border: 'none', cursor: 'pointer',
                          fontSize: 12, fontWeight: flowStep === 'stunden' ? 600 : 500,
                          background: flowStep === 'stunden' ? '#fff' : 'transparent',
                          color: flowStep === 'stunden' ? '#1e293b' : '#94a3b8',
                          boxShadow: flowStep === 'stunden' ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
                          transition: 'all 0.2s',
                        }}
                      >
                        <span style={{
                          width: 18, height: 18, borderRadius: '50%', fontSize: 10, fontWeight: 700,
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          background: flowStep === 'stunden' ? '#1e293b' : '#cbd5e1',
                          color: '#fff',
                        }}>1</span>
                        Stunden prüfen
                      </button>
                      <ArrowRight style={{ width: 14, height: 14, color: '#cbd5e1', margin: '0 4px', flexShrink: 0 }} />
                      <button
                        onClick={() => setFlowStep('abrechnung')}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '7px 14px', borderRadius: 8,
                          border: 'none', cursor: 'pointer',
                          fontSize: 12, fontWeight: flowStep === 'abrechnung' ? 600 : 500,
                          background: flowStep === 'abrechnung' ? '#fff' : 'transparent',
                          color: flowStep === 'abrechnung' ? '#1e293b' : '#94a3b8',
                          boxShadow: flowStep === 'abrechnung' ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
                          transition: 'all 0.2s',
                        }}
                      >
                        <span style={{
                          width: 18, height: 18, borderRadius: '50%', fontSize: 10, fontWeight: 700,
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          background: flowStep === 'abrechnung' ? '#1e293b' : '#cbd5e1',
                          color: '#fff',
                        }}>2</span>
                        Lohnabrechnung
                      </button>
                      <ArrowRight style={{ width: 14, height: 14, color: '#cbd5e1', margin: '0 4px', flexShrink: 0 }} />
                      <button
                        onClick={() => setFlowStep('dokumente')}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '7px 14px', borderRadius: 8,
                          border: 'none', cursor: 'pointer',
                          fontSize: 12, fontWeight: flowStep === 'dokumente' ? 600 : 500,
                          background: flowStep === 'dokumente' ? '#fff' : 'transparent',
                          color: flowStep === 'dokumente' ? '#1e293b' : '#94a3b8',
                          boxShadow: flowStep === 'dokumente' ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
                          transition: 'all 0.2s',
                        }}
                      >
                        <span style={{
                          width: 18, height: 18, borderRadius: '50%', fontSize: 10, fontWeight: 700,
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          background: flowStep === 'dokumente' ? '#1e293b' : '#cbd5e1',
                          color: '#fff',
                        }}>3</span>
                        Dokumente
                      </button>
                    </div>

                    <div style={{ padding: '20px 22px 22px' }}>

                      {/* ── STEP 1: Stunden prüfen ── */}
                      {flowStep === 'stunden' && (
                        <div>
                          <PayrollFlowStepChrome
                            title="Stunden prüfen"
                            lead={
                              hours.entries.length === 0
                                ? 'Dieser Bereich zeigt die Zeiterfassung dieser Assistenzperson für den gewählten Monat. Ohne erfasste oder plausibel gesetzte Stunden gibt es keine belastbare Lohnabrechnung.'
                                : 'Dieser Bereich fasst alle Schichten dieses Monats für diese Assistenzperson zusammen. Diese Summen sind die Grundlage für die Lohnabrechnung und die späteren Unterlagen (z. B. IV).'
                            }
                            hint={
                              hours.entries.length === 0 ? (
                                <>Für diesen Monat sind noch keine Zeiten erfasst. Personen ohne Einsatz können Sie in der Übersicht als «Keine Arbeit» markieren.</>
                              ) : (
                                <>Prüfen Sie die erfassten Zeiten der Assistenzperson und korrigieren Sie sie bei Bedarf. Erst danach wird die Lohnabrechnung berechnet.</>
                              )
                            }
                          />
                          {/* Quick summary row */}
                          {result && (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 16 }}>
                              <div style={{ background: '#f8fafc', borderRadius: 10, padding: '12px 14px', border: '1px solid #e2e8f0' }}>
                                <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#475569', margin: '0 0 4px' }}>Gesamtkosten Arbeitgeber</p>
                                <p style={{ fontSize: 17, fontWeight: 800, color: '#1e293b', margin: 0, fontVariantNumeric: 'tabular-nums' }}>CHF {fmt(result.totalaufwandAG.perYear)}</p>
                                <p style={{ fontSize: 11, color: '#64748b', margin: '2px 0 0', lineHeight: 1.35 }}>
                                  Sozialversicherungsbeiträge Arbeitgeber + Bruttolohn
                                </p>
                              </div>
                              <div style={{ background: '#f8fafc', borderRadius: 10, padding: '12px 14px', border: '1px solid #e2e8f0' }}>
                                <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748b', margin: '0 0 4px' }}>Bruttolohn</p>
                                <p style={{ fontSize: 17, fontWeight: 800, color: '#1e293b', margin: 0, fontVariantNumeric: 'tabular-nums' }}>CHF {fmt(result.bruttolohn.perYear)}</p>
                                <div style={{ marginTop: 2, minWidth: 0 }}>
                                  <p style={{ fontSize: 11, color: '#94a3b8', margin: 0, lineHeight: 1.4 }}>
                                    Arbeitslohn: {fmt(hours.totalHours)} Std × CHF {fmt(a.hourly_rate || 0)} = CHF {fmt(result.arbeitslohn.perYear)}
                                  </p>
                                  {result.ferienzuschlag.perYear > 0 ? (
                                    <p style={{ fontSize: 11, color: '#94a3b8', margin: '4px 0 0', lineHeight: 1.4 }}>
                                      Ferienzuschlag: CHF {fmt(result.ferienzuschlag.perYear)} (laut Ferienwochen im Vertrag)
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                              <div style={{ background: '#f8fafc', borderRadius: 10, padding: '12px 14px', border: '1px solid #e2e8f0' }}>
                                <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748b', margin: '0 0 4px' }}>Auszuzahlender Nettolohn</p>
                                <p style={{ fontSize: 17, fontWeight: 800, color: '#1e293b', margin: 0, fontVariantNumeric: 'tabular-nums' }}>CHF {fmt(result.nettolohn.perYear)}</p>
                                <p style={{ fontSize: 11, color: '#94a3b8', margin: '2px 0 0' }}>CHF {fmt(result.nettolohn.perHour)}/Std</p>
                              </div>
                            </div>
                          )}

                          {hours.entries.length === 0 ? (
                            <div style={{
                              padding: '32px 20px', textAlign: 'center',
                              background: '#f8fafc', borderRadius: 12,
                            }}>
                              <Clock style={{ width: 32, height: 32, color: '#cbd5e1', margin: '0 auto 8px', display: 'block' }} />
                              <p style={{ color: '#94a3b8', fontSize: 14 }}>Keine Einträge für {monthLabel(currentMonth)}.</p>
                            </div>
                          ) : (
                            <>
                              <div style={{
                                borderRadius: 12, border: '1px solid #e2e8f0',
                                overflow: 'hidden', marginBottom: 14,
                              }}>
                                {[...hours.entries]
                                  .sort((a, b) => a.date.localeCompare(b.date))
                                  .map((e, idx) => {
                                    const d = new Date(e.date + 'T00:00:00');
                                    const dayName = d.toLocaleDateString('de-CH', { weekday: 'short' });
                                    const dayNum = d.getDate();
                                    const isEditing = editingEntryId === e.id;

                                    return (
                                      <div key={e.id} style={{
                                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                        padding: '10px 16px',
                                        borderBottom: idx < hours.entries.length - 1 ? '1px solid #f1f5f9' : 'none',
                                        background: isEditing ? '#f8fafc' : 'transparent',
                                        transition: 'background 0.15s',
                                      }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                          <div style={{
                                            width: 38, height: 38, borderRadius: 8,
                                            background: '#f1f5f9',
                                            display: 'flex', flexDirection: 'column',
                                            alignItems: 'center', justifyContent: 'center',
                                          }}>
                                            <span style={{ fontSize: 9, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 700, lineHeight: 1 }}>{dayName}</span>
                                            <span style={{ fontSize: 14, fontWeight: 700, color: '#334155', lineHeight: 1 }}>{dayNum}</span>
                                          </div>
                                          <div>
                                            {isEditing ? (
                                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                <input
                                                  type="time"
                                                  value={editStart}
                                                  onChange={ev => setEditStart(ev.target.value)}
                                                  style={{
                                                    padding: '3px 8px', border: '1px solid #cbd5e1',
                                                    borderRadius: 6, fontSize: 13, width: 85,
                                                  }}
                                                />
                                                <span style={{ color: '#94a3b8', fontSize: 13 }}>–</span>
                                                <input
                                                  type="time"
                                                  value={editEnd}
                                                  onChange={ev => setEditEnd(ev.target.value)}
                                                  style={{
                                                    padding: '3px 8px', border: '1px solid #cbd5e1',
                                                    borderRadius: 6, fontSize: 13, width: 85,
                                                  }}
                                                />
                                              </div>
                                            ) : (
                                              <p style={{ fontSize: 13, fontWeight: 500, color: '#1e293b', margin: 0 }}>{formatTimeHHmm(e.start_time)} – {formatTimeHHmm(e.end_time)}</p>
                                            )}
                                            <p style={{ fontSize: 11, color: '#94a3b8', margin: '1px 0 0' }}>
                                              {formatIvCategoryForInlineDisplay(e.category)}{e.is_night && ' 🌙'}
                                            </p>
                                          </div>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                          <span style={{ fontSize: 13, fontWeight: 700, color: '#334155', fontVariantNumeric: 'tabular-nums' }}>
                                            {isEditing ? fmt(parseHours(editStart, editEnd)) : fmt(e.hours)} Std
                                          </span>
                                          {isEditing ? (
                                            <div style={{ display: 'flex', gap: 4 }}>
                                              <button
                                                onClick={() => saveEdit(e.id, a.id, e.date)}
                                                style={{
                                                  width: 28, height: 28, borderRadius: 6, border: 'none',
                                                  background: '#e2e8f0', color: '#334155', cursor: 'pointer',
                                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                }}
                                              >
                                                <Save style={{ width: 14, height: 14 }} />
                                              </button>
                                              <button
                                                onClick={cancelEditing}
                                                style={{
                                                  width: 28, height: 28, borderRadius: 6, border: 'none',
                                                  background: '#f1f5f9', color: '#64748b', cursor: 'pointer',
                                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                }}
                                              >
                                                <X style={{ width: 14, height: 14 }} />
                                              </button>
                                            </div>
                                          ) : (
                                            <button
                                              onClick={() => startEditing(e)}
                                              style={{
                                                width: 28, height: 28, borderRadius: 6, border: 'none',
                                                background: 'transparent', color: '#94a3b8', cursor: 'pointer',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                transition: 'all 0.15s',
                                              }}
                                              onMouseEnter={ev => { ev.currentTarget.style.background = '#f1f5f9'; ev.currentTarget.style.color = '#475569'; }}
                                              onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent'; ev.currentTarget.style.color = '#94a3b8'; }}
                                            >
                                              <Pencil style={{ width: 13, height: 13 }} />
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                              </div>

                              {/* Total */}
                              <div style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                padding: '12px 16px', background: '#f8fafc', borderRadius: 10,
                                marginBottom: 14,
                              }}>
                                <span style={{ fontSize: 13, fontWeight: 600, color: '#475569' }}>Total</span>
                                <span style={{ fontSize: 16, fontWeight: 800, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
                                  {fmt(hours.totalHours)} Std
                                </span>
                              </div>
                            </>
                          )}

                          {/* Weiter */}
                          {result && (
                            <div style={{ marginTop: 4 }}>
                              <ActionButton
                                onClick={() => setFlowStep('abrechnung')}
                                icon={<ArrowRight style={{ width: 15, height: 15 }} />}
                                label="Weiter zur Lohnabrechnung"
                                variant="primary"
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {/* ── STEP 2: Lohnabrechnung erstellen ── */}
                      {flowStep === 'abrechnung' && (
                        <div>
                          <PayrollFlowStepChrome
                            title="Lohnabrechnung"
                            hint={
                              result ? (
                                <>
                                  Hier sehen Sie die Berechnung. Mit Bestätigung wird die Lohnabrechnung als PDF erzeugt und dem Arbeitnehmer zugestellt. Zudem wird der Arbeits- und Einsatzrapport erstellt. Anschliessend gelangen Sie zum Schritt «Dokumente».
                                </>
                              ) : (
                                <>Ohne erfasste Stunden ist keine Lohnabrechnung möglich.</>
                              )
                            }
                            onBack={() => setFlowStep('stunden')}
                          />
                          {result ? (
                            <>
                              {(() => {
                                const cd = (a.contract_data as any) || {};
                                // Kanton kommt vom Arbeitgeber-Profil (betroffene Person), nicht aus den Assistenzperson-Daten.
                                const kanton = employer?.canton || cd?.canton || 'ZH';
                                const kantonName = FAK_RATES[kanton]?.name || kanton;
                                const stundenlohn = a.hourly_rate || 0;
                                const ferienzuschlagRate = getFerienzuschlagRate(a.vacation_weeks) ?? 0.0833;

                                const bm = String(cd?.billing_method || 'ordinary').toLowerCase();
                                const accountingMethod: PayslipAccountingMethod =
                                  bm === 'simplified' || bm === 'vereinfacht' ? 'simplified'
                                    : (bm === 'ordinary_with_withholding' || bm === 'ordinary_quellensteuer') ? 'ordinary_with_withholding'
                                      : 'ordinary';
                                const accountingMethodLabel =
                                  accountingMethod === 'simplified'
                                    ? 'Vereinfachtes'
                                    : accountingMethod === 'ordinary_with_withholding'
                                      ? 'Ordentliches mit Quellensteuer'
                                      : 'Ordentliches';

                                const ktvRateEmployee = cd?.ktv_employee ? (parseFloat(cd.ktv_employee) / 100) : undefined;
                                const nbuTotalRate = cd?.nbu_total ? parseFloat(cd.nbu_total) / 100 : undefined;
                                const nbuEmployerShare = cd?.nbu_employer != null && cd?.nbu_employer !== '' ? parseFloat(cd.nbu_employer) / 100 : undefined;
                                const nbuEmployeeShare = cd?.nbu_employee != null && cd?.nbu_employee !== '' ? parseFloat(cd.nbu_employee) / 100 : undefined;
                                const nbuEmployerVoluntary = cd?.nbu_employer_voluntary === true;
                                const nbuEligible = cd?.nbu_eligible !== undefined ? (cd.nbu_eligible || nbuEmployerVoluntary) : undefined;
                                const withholdingTaxRate = cd?.withholding_tax_rate ? (parseFloat(cd.withholding_tax_rate) / 100) : undefined;

                                const payslip = calculatePayslip({
                                  canton: kanton,
                                  accountingMethod,
                                  hourlyRate: stundenlohn,
                                  hours: hours.totalHours,
                                  vacationSurchargeRate: ferienzuschlagRate,
                                  ktvRateEmployee,
                                  nbuTotalRate,
                                  nbuEmployerShare,
                                  nbuEmployeeShare,
                                  nbuEligible,
                                  nbuEmployerVoluntary,
                                  withholdingTaxRate,
                                });

                                const findDeduction = (label: string) => payslip.deductionLines.find(l => l.label === label && l.enabled !== false) || null;
                                const dAhv = findDeduction('AHV/IV/EO');
                                const dAlv = findDeduction('ALV');
                                const dKtv = findDeduction('KTV');
                                const dNbu = findDeduction('NBU') || findDeduction('Nichtberufsunfallversicherung');
                                const dQst = findDeduction('Quellensteuer');
                                const dFak = findDeduction('FAK');

                                return (
                                  <>
                                    {/* Grundlagen (template-like) */}
                                    <div style={{
                                      borderRadius: 10, border: '1px solid #e2e8f0',
                                      overflow: 'hidden', marginBottom: 16,
                                    }}>
                                      <div style={{ background: '#f8fafc', padding: '8px 14px', borderBottom: '1px solid #e2e8f0' }}>
                                        <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', margin: 0 }}>
                                          Grundlagen
                                        </p>
                                      </div>
                                      <div style={{ fontSize: 13 }}>
                                        <InfoRow label="Kanton" value={`${kantonName} (${kanton})`} />
                                        <InfoRow label="Abrechnungsverfahren" value={accountingMethodLabel} alt />
                                        <InfoRow label="Stundenlohn" value={`Fr. ${fmt(stundenlohn)}`} />
                                        <InfoRow label="Anzahl Stunden" value={fmt(hours.totalHours)} alt />
                                      </div>
                                    </div>

                                    {/* Lohn (template rows, always same structure) */}
                                    <PaySection title="Lohn">
                                      <PayRow label="Arbeitslohn" perH={payslip.wageLines.workWage.perHour} perM={payslip.wageLines.workWage.perMonth} />
                                      <PayRow label="Ferienzuschlag" rate={payslip.wageLines.vacationSurcharge.rate} perH={payslip.wageLines.vacationSurcharge.perHour} perM={payslip.wageLines.vacationSurcharge.perMonth} />
                                      <PayRow label="Bruttolohn" perH={payslip.wageLines.grossWage.perHour} perM={payslip.wageLines.grossWage.perMonth} bold />
                                    </PaySection>

                                    {/* Abzüge (template rows, only employee-side) */}
                                    <PaySection title="Abzüge">
                                      <PayRow label="AHV/IV/EO" rate={dAhv?.rate ?? null} perH={dAhv?.perHour} perM={dAhv?.perMonth ?? 0} />
                                      <PayRow label="ALV" rate={dAlv?.rate ?? null} perH={dAlv?.perHour} perM={dAlv?.perMonth ?? 0} />
                                      {dKtv ? (
                                        <PayRow label="KTV" rate={dKtv.rate ?? null} perH={dKtv.perHour} perM={dKtv.perMonth ?? 0} />
                                      ) : (
                                        <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                                          <td style={{ padding: '6px 14px', color: '#94a3b8' }}>
                                            KTV <span style={{ fontSize: 9, background: '#f1f5f9', padding: '1px 6px', borderRadius: 9999, marginLeft: 4, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Nicht erfasst</span>
                                          </td>
                                          <td colSpan={3} style={{ padding: '6px 14px', textAlign: 'right', color: '#cbd5e1', fontSize: 11 }}>–</td>
                                        </tr>
                                      )}
                                      <PayRow label="Nichtberufsunfallvers. (NBU)" rate={dNbu?.rate ?? null} perH={dNbu?.perHour} perM={dNbu?.perMonth ?? 0} />
                                      {dQst && dQst.enabled !== false && (dQst.perMonth ?? 0) > 0 ? (
                                        <PayRow label="Quellensteuer" rate={dQst.rate ?? null} perH={dQst.perHour} perM={dQst.perMonth ?? 0} />
                                      ) : (
                                        <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                                          <td style={{ padding: '6px 14px', color: '#94a3b8' }}>
                                            Quellensteuer <span style={{ fontSize: 9, background: '#f1f5f9', padding: '1px 6px', borderRadius: 9999, marginLeft: 4, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Out of Scope</span>
                                          </td>
                                          <td colSpan={3} style={{ padding: '6px 14px', textAlign: 'right', color: '#cbd5e1', fontSize: 11 }}>–</td>
                                        </tr>
                                      )}
                                      {dFak && (
                                        <PayRow label="FAK (nur Wallis)" rate={dFak.rate ?? null} perH={dFak.perHour} perM={dFak.perMonth ?? 0} />
                                      )}
                                      <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                                        <td style={{ padding: '6px 14px', color: '#94a3b8' }}>
                                          BVG <span style={{ fontSize: 9, background: '#f1f5f9', padding: '1px 6px', borderRadius: 9999, marginLeft: 4, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Out of Scope</span>
                                        </td>
                                        <td colSpan={3} style={{ padding: '6px 14px', textAlign: 'right', color: '#cbd5e1', fontSize: 11 }}>–</td>
                                      </tr>
                                      <PayRow label="Total Abzüge" perH={payslip.totalDeductions.perHour} perM={payslip.totalDeductions.perMonth} bold />
                                      <PayRow label="Nettolohn" perH={payslip.netWage.perHour} perM={payslip.netWage.perMonth} bold highlight />
                                    </PaySection>
                                  </>
                                );
                              })()}

                              {/* Action buttons */}
                              <div style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                                gap: 10,
                                marginBottom: 12,
                                alignItems: 'stretch',
                              }}>
                              </div>

                              {/* Confirm */}
                              {!confirmed ? (
                                <div>
                                  <button
                                    onClick={() => handleConfirm(a.id, a.name)}
                                    style={{
                                      width: '100%', padding: '14px 20px', borderRadius: 12,
                                      border: 'none', cursor: 'pointer',
                                      background: 'linear-gradient(135deg, #059669, #047857)',
                                      color: '#fff', fontWeight: 700, fontSize: 14,
                                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                                      transition: 'all 0.2s',
                                      boxShadow: '0 2px 8px rgba(5, 150, 105, 0.3)',
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(5, 150, 105, 0.4)'; }}
                                    onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(5, 150, 105, 0.3)'; }}
                                  >
                                    <ShieldCheck style={{ width: 18, height: 18 }} />
                                    Abrechnung bestätigen & freigeben
                                  </button>
                                </div>
                              ) : (
                                <div style={{
                                  display: 'flex', alignItems: 'center', gap: 12,
                                  padding: '14px 16px', borderRadius: 12,
                                  background: 'linear-gradient(135deg, #ecfdf5, #d1fae5)',
                                  border: '1px solid #a7f3d0',
                                }}>
                                  <ShieldCheck style={{ width: 20, height: 20, color: '#059669' }} />
                                  <div>
                                    <p style={{ fontSize: 14, fontWeight: 700, color: '#065f46', margin: 0 }}>✅ Abrechnung bestätigt</p>
                                    <p style={{ fontSize: 12, color: '#059669', margin: '2px 0 0' }}>{a.name} sieht diese Abrechnung jetzt im Zugangslink.</p>
                                  </div>
                                </div>
                              )}
                            </>
                          ) : (
                            <div style={{
                              padding: '32px 20px', textAlign: 'center',
                              background: '#f8fafc', borderRadius: 12,
                            }}>
                              <Clock style={{ width: 32, height: 32, color: '#cbd5e1', margin: '0 auto 8px', display: 'block' }} />
                              <p style={{ color: '#94a3b8', fontSize: 14 }}>
                                Keine Stunden erfasst – kein Lohnbudget möglich.
                              </p>
                            </div>
                          )}
                        </div>
                      )}

                      {/* ── STEP 3: Dokumente ── */}
                      {flowStep === 'dokumente' && (
                        <div>
                          <PayrollFlowStepChrome
                            title="Dokumentenspeicher"
                            hint={
                              <>
                                PDFs für <strong style={{ color: '#334155' }}>{a.name}</strong>: Lohnabrechnung sowie Arbeits- und Einsatzrapport.
                                Das Monatspaket für die IV (Deckblatt und alle Assistenzpersonen) erstellen Sie im Kasten <strong style={{ color: '#334155' }}>über</strong> der Liste.
                              </>
                            }
                            onBack={() => setFlowStep('abrechnung')}
                          />
                          <div style={{
                            borderRadius: 14,
                            border: '1px solid #e2e8f0',
                            background: '#fff',
                            padding: 12,
                          }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                              {result && (
                                <DocCard
                                  title={`Lohnabrechnung · ${monthLabel(currentMonth)} · ${a.name}`}
                                  subtitle=""
                                  fileType="PDF"
                                  icon={<Download style={{ width: 18, height: 18 }} />}
                                  layout="row"
                                  docListKind="payslip"
                                  onClick={() => downloadPayslipPdf(a, result, hours)}
                                />
                              )}
                              <DocCard
                                title={`Arbeits- und Einsatzrapport · ${monthLabel(currentMonth)} · ${a.name}`}
                                subtitle=""
                                fileType="PDF"
                                icon={<Download style={{ width: 18, height: 18 }} />}
                                disabled={hours.totalHours === 0}
                                layout="row"
                                docListKind="report"
                                onClick={() => void downloadLohnUndEinsatzrapportPdf(a, hours)}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Animation keyframes */}
      <style>{`
        @keyframes slideDown {
          from { opacity: 0; max-height: 0; }
          to { opacity: 1; max-height: 2000px; }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      </div>
    </div>
  );
}

// ── Sub-components ──

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div style={{
      minWidth: 0,
      background: 'rgba(255,255,255,0.07)',
      borderRadius: 12, padding: '14px 16px',
      backdropFilter: 'blur(8px)',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, color: 'rgba(255,255,255,0.45)' }}>
        {icon}
        <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      </div>
      <p style={{
        fontSize: 22,
        fontWeight: 800,
        color: '#fff',
        margin: 0,
        fontVariantNumeric: 'tabular-nums',
        overflowWrap: 'anywhere',
        lineHeight: 1.2,
      }}>{value}</p>
    </div>
  );
}

/** Einheitlicher Kopfbereich für die drei Payroll-Schritte: Titel, optional Einordnung, Hinweistext, optional Zurück. */
function PayrollFlowStepChrome({
  title,
  lead,
  hint,
  onBack,
  backLabel = 'Zurück',
}: {
  title: string;
  /** Kurz erklären, worum es in diesem Schritt geht (steht über dem eigentlichen Hinweis). */
  lead?: React.ReactNode;
  hint: React.ReactNode;
  onBack?: () => void;
  backLabel?: string;
}) {
  return (
    <div style={{
      borderRadius: 14,
      border: '1px solid #e2e8f0',
      background: '#f1f5f9',
      marginBottom: 16,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{
            margin: 0,
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: '#64748b',
          }}>
            {title}
          </p>
          <div style={{ margin: '8px 0 0', fontSize: 14, color: '#475569', lineHeight: 1.55 }}>
            {lead ? (
              <p style={{ margin: '0 0 10px', fontWeight: 600, color: '#1e293b', lineHeight: 1.45 }}>
                {lead}
              </p>
            ) : null}
            {hint}
          </div>
        </div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            style={{
              flexShrink: 0,
              border: '1px solid #e2e8f0',
              background: '#fff',
              borderRadius: 12,
              padding: '8px 14px',
              fontSize: 13,
              fontWeight: 700,
              color: '#334155',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
            }}
          >
            <ChevronLeft style={{ width: 16, height: 16 }} />
            {backLabel}
          </button>
        )}
      </div>
    </div>
  );
}


function ActionButton({ onClick, icon, label, variant, disabled }: {
  onClick: () => void; icon: React.ReactNode; label: string;
  variant: 'primary' | 'outline'; disabled?: boolean;
}) {
  const isPrimary = variant === 'primary';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        padding: '12px 14px',
        borderRadius: 14,
        border: isPrimary ? 'none' : '1px solid #e2e8f0',
        background: isPrimary ? 'linear-gradient(135deg, #3b82f6, #2563eb)' : '#f8fafc',
        color: isPrimary ? '#fff' : '#475569',
        fontSize: 13, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'all 0.2s',
        boxShadow: isPrimary ? '0 6px 18px rgba(37, 99, 235, 0.22)' : '0 1px 2px rgba(15, 23, 42, 0.06)',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.transform = 'translateY(-1px)';
        e.currentTarget.style.boxShadow = isPrimary
          ? '0 10px 24px rgba(37, 99, 235, 0.28)'
          : '0 8px 22px rgba(15, 23, 42, 0.08)';
        if (!isPrimary) e.currentTarget.style.background = '#fff';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = isPrimary
          ? '0 6px 18px rgba(37, 99, 235, 0.22)'
          : '0 1px 2px rgba(15, 23, 42, 0.06)';
        if (!isPrimary) e.currentTarget.style.background = '#f8fafc';
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: isPrimary ? 'rgba(255,255,255,0.18)' : '#eef2ff',
          color: isPrimary ? '#fff' : '#1d4ed8',
          flexShrink: 0,
        }}>
          {icon}
        </span>
        <span style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {label}
        </span>
      </span>
      <span style={{
        width: 28,
        height: 28,
        borderRadius: 10,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: isPrimary ? 'rgba(255,255,255,0.14)' : '#eef2ff',
        color: isPrimary ? 'rgba(255,255,255,0.95)' : '#1d4ed8',
        flexShrink: 0,
      }}>
        <ArrowRight style={{ width: 14, height: 14 }} />
      </span>
    </button>
  );
}

function DocCard({
  title,
  subtitle,
  fileType,
  badge,
  icon,
  disabled,
  tone,
  layout = 'card',
  docListKind,
  onClick,
}: {
  title: string;
  subtitle?: string;
  fileType: 'PDF' | 'DOCX';
  badge?: string;
  icon: React.ReactNode;
  disabled?: boolean;
  tone?: 'default' | 'primary';
  layout?: 'card' | 'row';
  /** Nur für Listen-Layout: unterscheidbare Mini-Icons in der Vorschau */
  docListKind?: 'payslip' | 'report';
  onClick: () => void;
}) {
  const isPrimary = tone === 'primary';
  const typeColor = fileType === 'PDF' ? { fg: '#1d4ed8', bg: '#eef2ff', border: '#c7d2fe' } : { fg: '#0f766e', bg: '#ecfeff', border: '#a5f3fc' };
  const isRow = layout === 'row';
  const listAccent =
    docListKind === 'payslip'
      ? { previewBg: 'linear-gradient(180deg, #ecfdf5 0%, #f8fafc 100%)', chipBg: '#d1fae5', chipFg: '#047857' }
      : docListKind === 'report'
        ? { previewBg: 'linear-gradient(180deg, #eff6ff 0%, #f8fafc 100%)', chipBg: '#dbeafe', chipFg: '#1d4ed8' }
        : null;
  const ListKindIcon = docListKind === 'payslip' ? Banknote : docListKind === 'report' ? ClipboardList : null;
  const previewSheen =
    docListKind === 'payslip'
      ? 'radial-gradient(120px 80px at 25% 20%, rgba(16,185,129,0.14), transparent 62%), radial-gradient(140px 90px at 80% 60%, rgba(5,150,105,0.07), transparent 62%)'
      : docListKind === 'report'
        ? 'radial-gradient(120px 80px at 25% 20%, rgba(59,130,246,0.11), transparent 62%), radial-gradient(140px 90px at 80% 60%, rgba(14,165,233,0.08), transparent 62%)'
        : 'radial-gradient(120px 80px at 25% 20%, rgba(59,130,246,0.08), transparent 62%), radial-gradient(140px 90px at 80% 60%, rgba(14,165,233,0.06), transparent 62%)';

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        borderRadius: 16,
        border: isPrimary ? '1px solid rgba(59, 130, 246, 0.28)' : '1px solid #e2e8f0',
        background: '#fff',
        padding: isRow ? 12 : 14,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        textAlign: 'left',
        transition: 'box-shadow 0.18s, background 0.18s',
        boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
        display: 'flex',
        flexDirection: isRow ? 'row' : 'column',
        gap: isRow ? 12 : 12,
        minHeight: isRow ? 86 : 160,
        alignItems: isRow ? 'center' : 'stretch',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.boxShadow = '0 14px 30px rgba(15, 23, 42, 0.10)';
        e.currentTarget.style.background = '#f8fafc';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = '0 1px 2px rgba(15, 23, 42, 0.06)';
        e.currentTarget.style.background = '#fff';
      }}
    >
      {/* Left preview: bei Dokumenten-Liste klares Typ-Icon statt generischer Zeilen */}
      <div style={{
        width: isRow ? (listAccent ? 104 : 92) : '100%',
        height: isRow ? 62 : 'auto',
        borderRadius: 14,
        border: isPrimary ? '1px solid rgba(59,130,246,0.18)' : '1px solid #e2e8f0',
        background: isRow && listAccent ? listAccent.previewBg : 'linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)',
        position: 'relative',
        overflow: 'hidden',
        flexShrink: 0,
      }}>
        <div style={{
          position: 'absolute',
          inset: 0,
          background: previewSheen,
          pointerEvents: 'none',
        }} />
        {isRow && listAccent && ListKindIcon ? (
          <div
            style={{
              position: 'relative',
              zIndex: 1,
              height: '100%',
              minHeight: 62,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 8,
            }}
            aria-hidden
          >
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                background: listAccent.chipBg,
                border: `1px solid ${listAccent.chipFg}22`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: listAccent.chipFg,
                boxShadow: '0 2px 8px rgba(15,23,42,0.06)',
              }}
            >
              <ListKindIcon style={{ width: 28, height: 28 }} strokeWidth={2} />
            </div>
          </div>
        ) : (
          <div style={{ padding: 10, position: 'relative', zIndex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ height: 8, width: '62%', borderRadius: 999, background: '#e2e8f0' }} />
              <div style={{ height: 8, width: 28, borderRadius: 999, background: '#e2e8f0' }} />
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ height: 7, width: '92%', borderRadius: 999, background: '#e2e8f0' }} />
              <div style={{ height: 7, width: '84%', borderRadius: 999, background: '#e2e8f0' }} />
              <div style={{ height: 7, width: '74%', borderRadius: 999, background: '#e2e8f0' }} />
            </div>
          </div>
        )}
      </div>

      {/* Right meta */}
      <div style={{ minWidth: 0, flex: 1, display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{
            width: 36,
            height: 36,
            borderRadius: 12,
            background: isPrimary
              ? 'rgba(59,130,246,0.10)'
              : listAccent
                ? docListKind === 'payslip'
                  ? 'rgba(16,185,129,0.14)'
                  : 'rgba(59,130,246,0.12)'
                : '#f1f5f9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: isPrimary ? '#2563eb' : listAccent ? listAccent.chipFg : '#334155',
            flexShrink: 0,
          }}>
            {icon}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: 14,
                fontWeight: 800,
                color: '#0f172a',
                letterSpacing: '-0.01em',
                lineHeight: 1.35,
                overflowWrap: 'anywhere',
                minWidth: 0,
              }}>{title}</span>
              <span style={{
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: '0.08em',
                padding: '4px 8px',
                borderRadius: 999,
                border: `1px solid ${typeColor.border}`,
                background: typeColor.bg,
                color: typeColor.fg,
              }}>
                {fileType}
              </span>
              {badge && (
                <span style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  padding: '4px 8px',
                  borderRadius: 999,
                  border: '1px solid #e2e8f0',
                  background: '#fff',
                  color: '#475569',
                }}>
                  {badge}
                </span>
              )}
            </div>
            {!!subtitle && (
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {subtitle}
              </div>
            )}
          </div>
        </div>
        <div style={{ fontSize: 12, color: disabled ? '#cbd5e1' : '#94a3b8' }}>
          {disabled ? 'Keine Stunden erfasst – Download nicht verfügbar' : 'Klick zum Herunterladen'}
        </div>
      </div>
    </button>
  );
}

function InfoRow({ label, value, alt }: { label: string; value: string; alt?: boolean }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      padding: '6px 14px',
      background: alt ? '#f8fafc' : 'transparent',
    }}>
      <span style={{ color: '#64748b' }}>{label}</span>
      <span style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: '#1e293b' }}>{value}</span>
    </div>
  );
}

function PaySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      borderRadius: 10, border: '1px solid #e2e8f0',
      overflow: 'hidden', marginBottom: 12,
    }}>
      <div style={{ background: '#f8fafc', padding: '8px 14px', borderBottom: '1px solid #e2e8f0' }}>
        <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', margin: 0 }}>
          {title}
        </p>
      </div>
      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
            <th style={{ textAlign: 'left', padding: '6px 14px', fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}></th>
            <th style={{ textAlign: 'right', padding: '6px 14px', fontSize: 10, fontWeight: 600, color: '#94a3b8', width: 70 }}>Satz</th>
            <th style={{ textAlign: 'right', padding: '6px 14px', fontSize: 10, fontWeight: 600, color: '#94a3b8', width: 95 }}>Pro Std</th>
            <th style={{ textAlign: 'right', padding: '6px 14px', fontSize: 10, fontWeight: 600, color: '#94a3b8', width: 95 }}>Total</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function PayRow({ label, rate, perH, perM, bold, highlight }: {
  label: string; rate?: number | null; perH?: number; perM: number;
  bold?: boolean; highlight?: boolean;
}) {
  return (
    <tr style={{
      borderBottom: '1px solid #f1f5f9',
      fontWeight: bold ? 600 : 400,
      background: highlight ? '#eff6ff' : 'transparent',
    }}>
      <td style={{ padding: '6px 14px', color: '#334155' }}>{label}</td>
      <td style={{ padding: '6px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#64748b' }}>
        {rate != null ? fmtPct(rate) : ''}
      </td>
      <td style={{ padding: '6px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#475569' }}>
        {perH != null ? `Fr. ${fmt(perH)}` : ''}
      </td>
      <td style={{ padding: '6px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: bold ? '#0f172a' : '#475569' }}>
        Fr. {fmt(perM)}
      </td>
    </tr>
  );
}
