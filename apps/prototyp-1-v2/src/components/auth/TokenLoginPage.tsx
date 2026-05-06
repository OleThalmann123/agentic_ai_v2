import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@asklepios/core';
import type { Assistant } from '@asklepios/core';
import {
  Clock, XCircle, ChevronLeft, ChevronRight, ChevronUp, ChevronDown,
  CheckCircle2, List, Pencil, Trash2, Moon, FileText, ShieldCheck, AlertCircle, Download, Save, X,
} from 'lucide-react';
import {
  calculatePayslip,
  generatePayslipPdf,
  FAK_RATES,
  fmt,
  fmtPct,
  getIvAssistanceActivityOptions,
  getFerienzuschlagRate,
  type PayslipAccountingMethod,
} from '@asklepios/core';
import { toast } from 'sonner';
import { sanitizeFilenamePart } from '@/utils/filename';
import { AsklepiosLogo } from '@/components/brand/AsklepiosLogo';

/** Acht IV-Kategorien (Art. 39c IVG); gespeicherte Codes 2–9, Anzeige 1–8. */
const ACTIVITY_OPTIONS = getIvAssistanceActivityOptions();

const MONTH_NAMES_DE = [
  'Januar','Februar','März','April','Mai','Juni',
  'Juli','August','September','Oktober','November','Dezember',
];

/** Formatiert ein ISO-Datum (yyyy-mm-dd) als deutschen Monatslabel ("April 2026"). */
const formatMonthLabel = (isoDate: string): string => {
  const d = new Date(isoDate + 'T12:00:00');
  return `${MONTH_NAMES_DE[d.getMonth()]} ${d.getFullYear()}`;
};

interface TimeEntry {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  is_night: boolean;
  category?: string;
  category_note?: string;
  confirmed: boolean;
}

function parseTimeToMinutes(t: string): number | null {
  const s = (t || '').trim();
  if (!s) return null;
  const [hhRaw, mmRaw] = s.split(':');
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh === 24 && mm === 0) return 24 * 60;
  if (hh < 0 || hh > 23) return null;
  if (mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function diffHours(start: string, end: string): number {
  const s = parseTimeToMinutes(start);
  const e = parseTimeToMinutes(end);
  if (s == null || e == null) return 0;
  const raw = e - s;
  const minutes = raw >= 0 ? raw : raw + 24 * 60;
  return Math.max(0, minutes / 60);
}

function nextIsoDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function roundToStep(n: number, step: number, max: number): number {
  if (step <= 1) return clampInt(n, 0, max);
  const rounded = Math.round(n / step) * step;
  const clamped = clampInt(rounded, 0, max);
  // Ensure we never land on a value > max due to rounding.
  return Math.min(clamped, Math.floor(max / step) * step);
}

/** Arbeitgeber-Daten für Lohn-PDF (wie im AG-Dashboard / PayrollPage). */
interface EmployerForPayslip {
  name: string;
  canton?: string | null;
  contact_data?: Record<string, unknown> | null;
}

function monthFirstIsoFromDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** Erster Tag des Monats (Mittag, um TZ-Probleme zu vermeiden). */
function startOfMonthDate(d: Date = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 12, 0, 0, 0);
}

function addMonths(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1, 12, 0, 0, 0);
}

export function TokenLoginPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [employer, setEmployer] = useState<EmployerForPayslip | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Tabs
  const [tab, setTab] = useState<'erfassen' | 'protokoll' | 'lohn'>('erfassen');

  // Form state
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [startH, setStartH] = useState(8);
  const [startM, setStartM] = useState(0);
  const [endH, setEndH] = useState(12);
  const [endM, setEndM] = useState(0);
  const [category, setCategory] = useState('');
  const [categoryNote, setCategoryNote] = useState('');
  const [isNight, setIsNight] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);

  // Protocol state
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');

  // Payroll confirmation (locks edits once employer confirmed month)
  const [payrollConfirmed, setPayrollConfirmed] = useState(false);
  const [confirmationLoading, setConfirmationLoading] = useState(true);

  useEffect(() => {
    if (!token) { setError('Kein Token angegeben.'); setLoading(false); return; }
    lookupAssistant(token);
  }, [token]);

  useEffect(() => {
    if (assistant) loadEntries();
  }, [assistant]);

  // Load payroll confirmation for the month of the currently selected date
  useEffect(() => {
    if (!assistant) return;
    const monthFirst = date.slice(0, 7) + '-01';
    let cancelled = false;
    (async () => {
      setConfirmationLoading(true);
      const { data: pcRow } = await supabase
        .from('payroll_confirmation')
        .select('confirmed')
        .eq('assistant_id', assistant.id)
        .eq('month', monthFirst)
        .maybeSingle();
      const fromTable = !!pcRow?.confirmed;

      let fromAssistantJson = false;
      if (token) {
        let ac = await supabase.from('assistant').select('contract_data').eq('access_token', token).maybeSingle();
        if (!ac.data) {
          ac = await supabase.from('assistant').select('contract_data').eq('id', token).maybeSingle();
        }
        const fr = (ac.data?.contract_data as Record<string, unknown> | undefined)?.payroll_freigaben;
        if (Array.isArray(fr)) {
          fromAssistantJson = fr.some((m) => String(m).slice(0, 10) === monthFirst);
        }
      }

      if (!cancelled) {
        setPayrollConfirmed(fromTable || fromAssistantJson);
        setConfirmationLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [assistant?.id, date, token]);

  // Deutscher Monatslabel für den aktuell gewählten Erfassungs-Tag, z. B. "April 2026".
  // Wird in Sperr-Hinweisen/Toasts verwendet, damit der Zeitraum sichtbar ist.
  const lockedMonthLabel = useMemo(() => formatMonthLabel(date), [date]);

  const lookupAssistant = async (tkn: string) => {
    try {
      let { data, error: err } = await supabase
        .from('assistant').select('*, employer:employer_id(name, canton, contact_data)')
        .eq('access_token', tkn).single();
      if (!data || err) {
        const fb = await supabase.from('assistant').select('*, employer:employer_id(name, canton, contact_data)').eq('id', tkn).single();
        data = fb.data; err = fb.error;
      }
      if (!data || err) { setError('Ungültiger Login-Link.'); setLoading(false); return; }
      setAssistant(data as Assistant);
      if ((data as any).employer) setEmployer((data as any).employer);
    } catch { setError('Verbindungsfehler.'); }
    finally { setLoading(false); }
  };

  const loadEntries = async () => {
    if (!assistant) return;
    const { data, error: err } = await supabase
      .from('time_entry').select('*')
      .eq('assistant_id', assistant.id)
      .order('date', { ascending: false })
      .order('start_time', { ascending: false })
      .limit(50);
    if (err) {
      setSaveError(err.message || 'Einträge konnten nicht geladen werden.');
      setEntries([]);
      return;
    }
    if (data) setEntries(data as TimeEntry[]);
  };

  const pad = (n: number) => n.toString().padStart(2, '0');
  const fmtTime = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

  const shiftDate = (dir: number) => {
    const d = new Date(date + 'T12:00:00');
    d.setDate(d.getDate() + dir);
    setDate(d.toISOString().slice(0, 10));
  };

  const formatDateLabel = (iso: string) => {
    const d = new Date(iso + 'T12:00:00');
    const days = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    return `${days[d.getDay()]}, ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
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
    setPayrollConfirmed(false);
  };

  const handleSave = async () => {
    if (payrollConfirmed) {
      toast.error(`Gesperrt: Die Lohnabrechnung für ${lockedMonthLabel} wurde bereits freigegeben. Stunden in diesem Zeitraum können nicht mehr geändert werden.`);
      return;
    }
    if (!assistant) return;
    setSaving(true);
    setSaveError(null);
    const startTime = fmtTime(startH, startM);
    const endTime = fmtTime(endH, endM);
    // Tätigkeitsbereiche: wenn explizit deaktiviert => ausblenden; sonst standardmässig aktiv (MVP).
    const cd = (assistant.contract_data as any) ?? {};
    const requiresActivities = cd.time_entry_requires_activity_breakdown !== false;
    const allowsFreetext = !!cd.time_entry_allows_freetext;
    const categoryToSave = requiresActivities && !isNight ? (category || null) : null;
    const categoryNoteToSave = requiresActivities && allowsFreetext && !isNight ? (categoryNote.trim() || null) : null;

    if (editingId) {
      const sMin = parseTimeToMinutes(startTime);
      const eMin = parseTimeToMinutes(endTime);
      const crossesMidnight = sMin != null && eMin != null && eMin < sMin;

      if (crossesMidnight) {
        setSaveError('Bitte Nachtdienst über Mitternacht als zwei Einträge erfassen (vor und nach 00:00).');
        setSaving(false);
        return;
      }

      const { error: err } = await supabase
        .from('time_entry')
        .update({
          date,
          start_time: startTime,
          end_time: endTime,
          is_night: isNight,
          category: categoryToSave,
          category_note: categoryNoteToSave,
        })
        .eq('id', editingId);
      if (err) {
        setSaveError(err.message || 'Speichern fehlgeschlagen.');
        setSaving(false);
        return;
      }
      setEditingId(null);
    } else {
      const sMin = parseTimeToMinutes(startTime);
      const eMin = parseTimeToMinutes(endTime);
      const crossesMidnight = sMin != null && eMin != null && eMin < sMin;

      if (!crossesMidnight) {
        const { error: err } = await supabase.from('time_entry').insert({
          assistant_id: assistant.id,
          date,
          start_time: startTime,
          end_time: endTime,
          is_night: isNight,
          entered_by: 'assistant',
          confirmed: false,
          category: categoryToSave,
          category_note: categoryNoteToSave,
        });
        if (err) {
          setSaveError(err.message || 'Speichern fehlgeschlagen.');
          setSaving(false);
          return;
        }
      } else {
        // Nachtdienst über Mitternacht: automatisch in zwei Tage splitten.
        const nextDate = nextIsoDate(date);
        const { error: err } = await supabase.from('time_entry').insert([
          {
            assistant_id: assistant.id,
            date,
            start_time: startTime,
            end_time: '24:00',
            is_night: true,
            entered_by: 'assistant',
            confirmed: false,
            category: null,
          },
          {
            assistant_id: assistant.id,
            date: nextDate,
            start_time: '00:00',
            end_time: endTime,
            is_night: true,
            entered_by: 'assistant',
            confirmed: false,
            category: null,
          },
        ]);
        if (err) {
          setSaveError(err.message || 'Speichern fehlgeschlagen.');
          setSaving(false);
          return;
        }
      }
    }

    setSaving(false);
    await loadEntries();
    await resetPayrollConfirmationIfNeeded(assistant.id, date);

    // Show confetti, then switch to Protokoll
    setShowConfetti(true);
    setTimeout(() => {
      setShowConfetti(false);
      setTab('protokoll');
    }, 1500);
  };

  const handleDelete = async (id: string) => {
    const entry = entries.find(e => e.id === id);
    if (payrollConfirmed) {
      // Sperr-Meldung auf den Monat des gelöschten Eintrags beziehen, da im
      // Protokoll-Tab Einträge aus mehreren Monaten gelistet werden.
      const label = entry ? formatMonthLabel(entry.date) : lockedMonthLabel;
      toast.error(`Gesperrt: Die Lohnabrechnung für ${label} wurde bereits freigegeben. Stunden in diesem Zeitraum können nicht mehr gelöscht werden.`);
      return;
    }
    if (!assistant) return;
    if (!confirm('Möchten Sie diesen Zeiteintrag wirklich löschen?')) return;
    await supabase.from('time_entry').delete().eq('id', id);
    await loadEntries();
    if (entry) {
      await resetPayrollConfirmationIfNeeded(assistant.id, entry.date);
    }
  };

  const startEdit = (e: TimeEntry) => {
    if (payrollConfirmed) {
      const label = formatMonthLabel(e.date);
      toast.error(`Gesperrt: Die Lohnabrechnung für ${label} wurde bereits freigegeben. Stunden in diesem Zeitraum können nicht mehr bearbeitet werden.`);
      return;
    }
    setEditingEntryId(e.id);
    setEditStart(e.start_time.slice(0, 5));
    setEditEnd(e.end_time.slice(0, 5));
  };

  const cancelInlineEdit = () => {
    setEditingEntryId(null);
    setEditStart('');
    setEditEnd('');
  };

  const saveInlineEdit = async (entryId: string, entryDate: string) => {
    if (!assistant) return;
    const { error } = await supabase
      .from('time_entry')
      .update({ start_time: editStart, end_time: editEnd })
      .eq('id', entryId);
    if (error) {
      toast.error('Fehler: ' + error.message);
    } else {
      toast.success('Eintrag aktualisiert');
      cancelInlineEdit();
      await loadEntries();
      await resetPayrollConfirmationIfNeeded(assistant.id, entryDate);
    }
  };

  // ─── Spinner for hours/minutes ───
  const Spinner = ({ value, onChange, max, step = 1 }: { value: number; onChange: (v: number) => void; max: number; step?: number }) => {
    const [text, setText] = useState<string>(() => pad(clampInt(value, 0, max)));

    useEffect(() => {
      // Keep display in sync with external updates (buttons, edit load, etc.)
      setText(pad(clampInt(value, 0, max)));
    }, [value, max]);

    const handleUp = () => {
      const next = value + step;
      onChange(next > max ? 0 : next);
    };
    const handleDown = () => {
      const next = value - step;
      if (next < 0) {
        // Wrap to the highest valid step value <= max
        onChange(Math.floor(max / step) * step);
      } else {
        onChange(next);
      }
    };
    const commitText = (raw: string) => {
      const digits = raw.replace(/\D/g, '');
      if (digits === '') {
        setText(pad(0));
        onChange(0);
        return;
      }
      const num = clampInt(parseInt(digits, 10), 0, max);
      const stepped = roundToStep(num, step, max);
      setText(pad(stepped));
      onChange(stepped);
    };

    return (
      <div className="flex flex-col items-center">
        <button type="button" onClick={handleUp}
          className="w-full flex justify-center py-2 rounded-lg bg-slate-100 hover:bg-slate-200 transition">
          <ChevronUp className="w-5 h-5 text-slate-500" />
        </button>
        <input
          type="tel"
          inputMode="numeric"
          pattern="[0-9]*"
          value={text}
          onChange={(e) => {
            // Allow free typing without cursor jumps; we sanitize/commit on blur/enter.
            const next = e.target.value;
            // Keep it short (max 2 digits) but don't fight the caret with padding mid-typing.
            const digits = next.replace(/\D/g, '').slice(0, 2);
            setText(digits);
          }}
          onFocus={(e) => {
            // Select all for quick overwrite.
            e.currentTarget.select();
          }}
          onBlur={() => commitText(text)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              handleUp();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              handleDown();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setText(pad(clampInt(value, 0, max)));
              e.currentTarget.blur();
            }
          }}
          className="text-4xl font-black tabular-nums py-2 w-full text-center bg-transparent outline-none focus:ring-2 focus:ring-emerald-300 rounded-lg"
          style={{ caretColor: '#10b981' }}
        />
        <button type="button" onClick={handleDown}
          className="w-full flex justify-center py-2 rounded-lg bg-slate-100 hover:bg-slate-200 transition">
          <ChevronDown className="w-5 h-5 text-slate-500" />
        </button>
      </div>
    );
  };

  // ─── Loading ───
  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
    </div>
  );

  // ─── Error ───
  if (error || !assistant) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="text-center space-y-4 max-w-sm">
        <XCircle className="w-12 h-12 text-red-400 mx-auto" />
        <h1 className="text-xl font-bold">Link ungültig</h1>
        <p className="text-slate-500">{error || 'Nicht gefunden.'}</p>
        <button onClick={() => navigate('/login')} className="px-6 py-2.5 rounded-xl bg-slate-900 text-white font-medium">
          Zur Anmeldung
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col relative overflow-hidden">
      {/* Confetti overlay */}
      {showConfetti && (
        <div className="fixed inset-0 z-50 pointer-events-none overflow-hidden">
          {Array.from({ length: 40 }).map((_, i) => {
            const left = Math.random() * 100;
            const delay = Math.random() * 0.5;
            const duration = 1 + Math.random() * 1;
            const size = 6 + Math.random() * 6;
            const colors = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
            const color = colors[Math.floor(Math.random() * colors.length)];
            const rotate = Math.random() * 360;
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: `${left}%`,
                  top: '-10px',
                  width: `${size}px`,
                  height: `${size * 1.5}px`,
                  backgroundColor: color,
                  borderRadius: '2px',
                  transform: `rotate(${rotate}deg)`,
                  animation: `confetti-fall ${duration}s ease-in ${delay}s forwards`,
                }}
              />
            );
          })}
          <style>{`
            @keyframes confetti-fall {
              0% { transform: translateY(0) rotate(0deg); opacity: 1; }
              100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
            }
          `}</style>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-white/90 backdrop-blur rounded-2xl shadow-2xl px-8 py-6 text-center animate-bounce">
              <p className="text-3xl mb-1">🎉</p>
              <p className="text-lg font-bold text-slate-900">Gespeichert!</p>
            </div>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="bg-white border-b">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-white border border-slate-200 flex items-center justify-center overflow-hidden shadow-sm">
              <AsklepiosLogo className="w-full h-full object-contain p-1" />
            </div>
            <span className="font-semibold text-sm">{assistant.name}</span>
          </div>
          {/* Tabs */}
          <div className="flex bg-slate-100 rounded-lg p-0.5">
            <button onClick={() => setTab('erfassen')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition
              ${tab === 'erfassen' ? 'bg-white shadow text-slate-900' : 'text-slate-500'}`}>
              <Clock className="w-4 h-4" /> Erfassen
            </button>
            <button onClick={() => setTab('protokoll')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition
              ${tab === 'protokoll' ? 'bg-white shadow text-slate-900' : 'text-slate-500'}`}>
              <List className="w-4 h-4" /> Protokoll
            </button>
            <button onClick={() => setTab('lohn')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition
              ${tab === 'lohn' ? 'bg-white shadow text-slate-900' : 'text-slate-500'}`}>
              <FileText className="w-4 h-4" /> Lohn
            </button>
          </div>
        </div>
        {saveError ? (
          <div className="max-w-lg mx-auto px-4 pb-3">
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <span className="font-semibold">Fehler:</span> {saveError}
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex-1 max-w-lg mx-auto w-full px-4 py-6 space-y-5">
        {tab === 'erfassen' ? (
          /* ... existing erfassen content stays ... */
          <>
            {/* Date picker */}
            <div className="bg-white rounded-2xl shadow-sm border p-4 flex items-center justify-between">
              <button onClick={() => shiftDate(-1)} className="p-2 rounded-lg hover:bg-slate-100"><ChevronLeft className="w-5 h-5" /></button>
              <div className="text-center">
                <p className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">Datum</p>
                <p className="text-lg font-bold">{formatDateLabel(date || new Date().toISOString().slice(0, 10))}</p>
              </div>
              <button onClick={() => shiftDate(1)} className="p-2 rounded-lg hover:bg-slate-100"><ChevronRight className="w-5 h-5" /></button>
            </div>

            {/* Time pickers */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white rounded-2xl shadow-sm border p-4">
                <p className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold text-center mb-2">Von</p>
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1">
                  <Spinner value={startH} onChange={setStartH} max={23} />
                  <span className="text-2xl font-bold text-slate-300">:</span>
                  <Spinner value={startM} onChange={setStartM} max={59} step={1} />
                </div>
              </div>
              <div className="bg-white rounded-2xl shadow-sm border p-4">
                <p className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold text-center mb-2">Bis</p>
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1">
                  <Spinner value={endH} onChange={setEndH} max={23} />
                  <span className="text-2xl font-bold text-slate-300">:</span>
                  <Spinner value={endM} onChange={setEndM} max={59} step={1} />
                </div>
              </div>
            </div>




            {/* Night shift toggle (MVP 1: intentionally disabled / out of scope) */}
            <div className="bg-white rounded-2xl shadow-sm border px-5 py-4 flex items-center justify-between opacity-60">
              <div className="flex items-center gap-3">
                <Moon className="w-5 h-5 text-slate-400" />
                <span className="font-semibold text-base">Nachtdienst</span>
              </div>
              <button
                type="button"
                disabled
                aria-disabled="true"
                title="MVP 1: Nachtzuschläge sind noch out of scope"
                className="relative inline-flex h-7 w-14 shrink-0 items-center rounded-full transition-colors bg-slate-200 cursor-not-allowed"
              >
                <span className="inline-block h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200 translate-x-1" />
              </button>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span className="font-semibold">Hinweis (MVP 1):</span> Nachtdienst / Nachtzuschläge sind aktuell out of scope. Bitte erfasse die Zeiten ohne Nachtdienst-Markierung.
            </div>

            {/* Activity dropdown (only for day shifts, if required) */}
            {(() => {
              const acd = (assistant?.contract_data as any) ?? {};
              const showActivity = assistant && acd.time_entry_requires_activity_breakdown !== false && !isNight;
              const showFreetext = showActivity && !!acd.time_entry_allows_freetext;
              if (!showActivity) return null;
              return (
                <div className="bg-white rounded-2xl shadow-sm border p-4 space-y-3">
                  <p className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold text-center">
                    Tätigkeitsbereich
                  </p>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full px-3 py-3 rounded-xl border bg-white text-base focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
                  >
                    <option value="">Bitte wählen…</option>
                    {ACTIVITY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {showFreetext && (
                    <textarea
                      value={categoryNote}
                      onChange={(e) => setCategoryNote(e.target.value)}
                      placeholder="Zusätzliche Beschreibung (optional)…"
                      rows={2}
                      className="w-full px-3 py-2.5 rounded-xl border bg-white text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
                    />
                  )}
                </div>
              );
            })()}

            {/* Save button */}
            <button onClick={handleSave} disabled={saving || payrollConfirmed}
              className="w-full py-4 rounded-2xl bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-lg transition-all shadow-lg shadow-emerald-200 active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50">
              <CheckCircle2 className="w-6 h-6" />
              {editingId ? 'AKTUALISIEREN' : 'SPEICHERN'}
            </button>
            {payrollConfirmed ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                <span className="font-semibold">Gesperrt:</span> Die Lohnabrechnung für <span className="font-semibold">{lockedMonthLabel}</span> wurde bereits freigegeben. Stunden in diesem Zeitraum können nicht mehr erfasst, bearbeitet oder gelöscht werden.
              </div>
            ) : null}
            {saveError ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                <span className="font-semibold">Speichern/Laden fehlgeschlagen:</span> {saveError}
              </div>
            ) : null}

            {editingId && (
              <button onClick={() => { setEditingId(null); setTab('protokoll'); }}
                className="w-full py-3 text-slate-500 font-medium text-sm">
                Bearbeitung abbrechen
              </button>
            )}
          </>
        ) : tab === 'protokoll' ? (
          /* ─── Protocol tab ─── */
          <>
            {entries.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <Clock className="w-10 h-10 mx-auto mb-3 opacity-40" />
                <p className="font-medium">Noch keine Einträge</p>
              </div>
            ) : (
              <div className="space-y-3">
                {entries.map(e => {
                  const d = new Date(e.date + 'T12:00:00');
                  const dayLabel = formatDateLabel(e.date);
                  const hours = diffHours(e.start_time, e.end_time).toFixed(1);

                  return (
                    <div key={e.id} className="bg-white rounded-xl border shadow-sm p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-semibold text-slate-700">{dayLabel}</span>
                        <div className="flex items-center gap-1">
                          {e.is_night && <Moon className="w-4 h-4 text-indigo-400" />}
                          {e.confirmed
                            ? <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-medium">Bestätigt</span>
                            : <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">Offen</span>}
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        {editingEntryId === e.id ? (
                          <>
                            <div className="flex items-center gap-2">
                              <input type="time" value={editStart} onChange={ev => setEditStart(ev.target.value)}
                                className="px-2 py-1 border border-slate-300 rounded-lg text-sm w-24" />
                              <span className="text-slate-400">–</span>
                              <input type="time" value={editEnd} onChange={ev => setEditEnd(ev.target.value)}
                                className="px-2 py-1 border border-slate-300 rounded-lg text-sm w-24" />
                            </div>
                            <div className="flex items-center gap-1">
                              <button onClick={() => saveInlineEdit(e.id, e.date)}
                                className="p-2 rounded-lg hover:bg-emerald-50 text-emerald-600 transition">
                                <Save className="w-4 h-4" />
                              </button>
                              <button onClick={cancelInlineEdit}
                                className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 transition">
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div>
                              <span className="text-lg font-bold tabular-nums">{e.start_time.slice(0,5)} – {e.end_time.slice(0,5)}</span>
                              <span className="text-sm text-slate-400 ml-2">({hours}h)</span>
                            </div>
                            {!e.confirmed && (
                              <div className="flex items-center gap-1">
                                <button onClick={() => startEdit(e)} disabled={payrollConfirmed}
                                  title={payrollConfirmed ? `Gesperrt: Lohnabrechnung für ${formatMonthLabel(e.date)} wurde bereits freigegeben.` : undefined}
                                  className="p-2 rounded-lg hover:bg-blue-50 text-blue-500 transition disabled:cursor-not-allowed">
                                  <Pencil className="w-4 h-4" />
                                </button>
                                <button onClick={() => handleDelete(e.id)} disabled={payrollConfirmed}
                                  title={payrollConfirmed ? `Gesperrt: Lohnabrechnung für ${formatMonthLabel(e.date)} wurde bereits freigegeben.` : undefined}
                                  className="p-2 rounded-lg hover:bg-red-50 text-red-400 transition disabled:cursor-not-allowed">
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Weekly transfer info */}
            <div className="bg-blue-50 rounded-xl border border-blue-100 p-4 text-center">
              <p className="text-sm text-blue-700 font-medium">
                📤 Deine Stunden werden wöchentlich automatisch an deinen Arbeitgeber übermittelt.
              </p>
            </div>
          </>
        ) : tab === 'lohn' ? (
          <LohnTab
            assistant={assistant}
            employer={employer}
            entries={entries}
            lohnTabActive
            loginToken={token ?? ''}
          />
        ) : null}
      </div>
    </div>
  );
}

// ─── Lohn Tab Component (Freigabe + gleiche PDF-Logik wie PayrollPage) ───
function LohnTab({
  assistant,
  employer,
  entries,
  lohnTabActive,
  loginToken,
}: {
  assistant: Assistant;
  employer: EmployerForPayslip | null;
  entries: TimeEntry[];
  lohnTabActive: boolean;
  /** URL-Token (access_token oder Assistant-ID) zum Nachladen von contract_data inkl. payroll_freigaben. */
  loginToken: string;
}) {
  const cd = assistant.contract_data as Record<string, unknown> | null | undefined;
  const contract = (cd || {}) as Record<string, any>;
  const employerName = employer?.name || '';

  const [payrollConfirmed, setPayrollConfirmed] = useState(false);
  const [confirmationLoading, setConfirmationLoading] = useState(true);

  const monthNames = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonthDate());
  const monthFirst = monthFirstIsoFromDate(viewMonth);
  const currentMonthLabel = `${monthNames[viewMonth.getMonth()]} ${viewMonth.getFullYear()}`;

  const thisMonthStart = startOfMonthDate(new Date());
  const earliestNavMonth = addMonths(thisMonthStart, -60);
  const canGoPrevMonth = viewMonth.getTime() > earliestNavMonth.getTime();
  const canGoNextMonth = viewMonth.getTime() < thisMonthStart.getTime();

  const shiftViewMonth = (dir: number) => {
    setViewMonth((m) => {
      const n = addMonths(m, dir);
      if (n.getTime() < earliestNavMonth.getTime()) return earliestNavMonth;
      if (n.getTime() > thisMonthStart.getTime()) return thisMonthStart;
      return n;
    });
  };

  const [monthEntries, setMonthEntries] = useState<TimeEntry[]>([]);
  const [monthEntriesLoading, setMonthEntriesLoading] = useState(false);

  useEffect(() => {
    if (!lohnTabActive || !assistant.id) return;
    let cancelled = false;
    (async () => {
      setMonthEntriesLoading(true);
      const y = viewMonth.getFullYear();
      const mo = viewMonth.getMonth();
      const startDate = `${y}-${String(mo + 1).padStart(2, '0')}-01`;
      const endDate = mo === 11 ? `${y + 1}-01-01` : `${y}-${String(mo + 2).padStart(2, '0')}-01`;
      const { data, error } = await supabase
        .from('time_entry')
        .select('*')
        .eq('assistant_id', assistant.id)
        .gte('date', startDate)
        .lt('date', endDate)
        .order('date', { ascending: true })
        .order('start_time', { ascending: true });
      if (!cancelled) {
        if (!error && data) {
          setMonthEntries(data as TimeEntry[]);
        } else {
          setMonthEntries([]);
        }
        setMonthEntriesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [assistant.id, viewMonth, lohnTabActive, entries.length]);

  useEffect(() => {
    if (!lohnTabActive) return;
    let cancelled = false;
    (async () => {
      setConfirmationLoading(true);
      const { data: pcRow } = await supabase
        .from('payroll_confirmation')
        .select('confirmed')
        .eq('assistant_id', assistant.id)
        .eq('month', monthFirst)
        .maybeSingle();
      const fromTable = !!pcRow?.confirmed;

      let fromAssistantJson = false;
      if (loginToken) {
        let ac = await supabase.from('assistant').select('contract_data').eq('access_token', loginToken).maybeSingle();
        if (!ac.data) {
          ac = await supabase.from('assistant').select('contract_data').eq('id', loginToken).maybeSingle();
        }
        const fr = (ac.data?.contract_data as Record<string, unknown> | undefined)?.payroll_freigaben;
        if (Array.isArray(fr)) {
          fromAssistantJson = fr.some((m) => String(m).slice(0, 10) === monthFirst);
        }
      }

      if (!cancelled) {
        setPayrollConfirmed(fromTable || fromAssistantJson);
        setConfirmationLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [assistant.id, monthFirst, lohnTabActive, loginToken, entries.length]);

  const trackedHours = monthEntries.reduce((sum, e) => {
    return sum + diffHours(e.start_time, e.end_time);
  }, 0);

  const stundenlohn = assistant.hourly_rate || (contract?.hourly_rate ? parseFloat(String(contract.hourly_rate)) : 0);
  const stunden = Number(trackedHours.toFixed(2));
  const kanton = (employer?.canton || contract?.canton || 'ZH') as string;
  // Bug A4: zentral berechnet, kein stilles 4-Wochen-Fallback mehr in der Tabelle.
  const ferienzuschlagRate = getFerienzuschlagRate(assistant.vacation_weeks) ?? 0.0833;

  const bm = String(contract?.billing_method || 'ordinary').toLowerCase();
  const accountingMethod: PayslipAccountingMethod =
    bm === 'simplified' || bm === 'vereinfacht' ? 'simplified'
      : (bm === 'ordinary_with_withholding' || bm === 'ordinary_quellensteuer') ? 'ordinary_with_withholding'
        : 'ordinary';

  const ktvRateEmployee = contract?.ktv_employee ? (parseFloat(String(contract.ktv_employee)) / 100) : undefined;
  // NBU: zweistufige Berechnung (Gesamtprämie × Anteil). Vorher wurde fälschlich
  // nur nbu_employee (%-Anteil an der Prämie) direkt als Abzugsprozentsatz
  // angewendet – das ergab bei 100% AN-Anteil einen Abzug von 100% des Lohns.
  const nbuTotalRate = contract?.nbu_total ? parseFloat(String(contract.nbu_total)) / 100 : undefined;
  const nbuEmployerShare = contract?.nbu_employer != null && contract?.nbu_employer !== '' ? parseFloat(String(contract.nbu_employer)) / 100 : undefined;
  const nbuEmployeeShare = contract?.nbu_employee != null && contract?.nbu_employee !== '' ? parseFloat(String(contract.nbu_employee)) / 100 : undefined;
  const nbuEmployerVoluntary = contract?.nbu_employer_voluntary === true;
  const nbuEligible = contract?.nbu_eligible !== undefined ? (contract.nbu_eligible || nbuEmployerVoluntary) : undefined;
  const withholdingTaxRate = contract?.withholding_tax_rate ? (parseFloat(String(contract.withholding_tax_rate)) / 100) : undefined;

  const payslip = calculatePayslip({
    canton: kanton,
    accountingMethod,
    hourlyRate: stundenlohn,
    hours: stunden,
    vacationSurchargeRate: ferienzuschlagRate,
    ktvRateEmployee,
    nbuTotalRate,
    nbuEmployerShare,
    nbuEmployeeShare,
    nbuEligible,
    nbuEmployerVoluntary,
    withholdingTaxRate,
  });

  const agCd = employer?.contact_data as Record<string, any> | undefined;
  const getEmployerAddress = () => ({
    name: employer?.name || '–',
    street: agCd?.street || '',
    plzCity: agCd?.plz && agCd?.city ? `${agCd.plz} ${agCd.city}` : (agCd?.city || ''),
  });

  const getEmployeeAddress = () => ({
    name: assistant.name || '–',
    street: contract?.street || '',
    plzCity: contract?.plz && contract?.city ? `${contract.plz} ${contract.city}` : (contract?.city || ''),
  });

  const formatPlaceDateLabel = () => {
    const place = String(agCd?.city || '').trim();
    const date = new Date().toLocaleDateString('de-CH');
    return place ? `${place}, ${date}` : date;
  };

  const kantonName = FAK_RATES[kanton]?.name || kanton;
  // Bug A4: zentraler Helper statt einer zweiten Cascade.
  const ferienzuschlagLabel = `${(ferienzuschlagRate * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
  const accountingMethodLabel =
    accountingMethod === 'simplified'
      ? 'Vereinfachtes'
      : accountingMethod === 'ordinary_with_withholding'
        ? 'Ordentliches mit Quellensteuer'
        : 'Ordentliches';

  const downloadOfficialPayslipPdf = () => {
    const payslipDoc = generatePayslipPdf({
      monthYearLabel: currentMonthLabel,
      placeDateLabel: formatPlaceDateLabel(),
      employer: getEmployerAddress(),
      employee: { ...getEmployeeAddress(), ahvNumber: String(contract?.ahv_number || '') },
      grundlagen: {
        cantonLabel: `${kantonName}`,
        accountingMethodLabel,
        hourlyRate: stundenlohn,
        hours: stunden,
        vacationSurchargeLabel: ferienzuschlagLabel,
      },
      accountingMethod,
      result: payslip,
    });
    const datePart = sanitizeFilenamePart(monthFirst.slice(0, 7));
    const namePart = sanitizeFilenamePart(assistant.name || 'Lohnabrechnung');
    payslipDoc.save(`${datePart}_Lohnabrechnung_${namePart}.pdf`);
    toast.success('Lohnabrechnung heruntergeladen');
  };

  const Row = ({ label, rate, perHour, perYear, bold, minus }: {
    label: string;
    rate?: number | null;
    perHour: number;
    perYear: number;
    bold?: boolean;
    minus?: boolean;
  }) => (
    <div className={`flex items-center justify-between py-1.5 ${bold ? 'font-bold' : ''}`}>
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-4">
        {rate != null && <span className="text-xs text-slate-400 tabular-nums w-14 text-right">{fmtPct(rate)}</span>}
        {rate == null && <span className="w-14" />}
        <span className="text-sm tabular-nums w-20 text-right">
          {minus ? `−${fmt(perYear)}` : fmt(perYear)}
        </span>
      </div>
    </div>
  );

  const activeDeductions = payslip.deductionLines.filter((l) => l.enabled !== false);

  return (
    <>
      {!monthEntriesLoading && entries.length === 0 && monthEntries.length === 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 flex items-start gap-2">
          <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-semibold">Keine Einträge sichtbar</p>
            <p className="text-xs text-amber-700 mt-0.5">
              Wenn du soeben Stunden erfasst hast, ist das meist ein Berechtigungs-/Speicherfehler. Bitte im Tab „Erfassen“ speichern – die konkrete Fehlermeldung wird oben angezeigt.
            </p>
          </div>
        </div>
      ) : null}

      <div className="bg-white rounded-2xl shadow-sm border p-4 text-center">
        <p className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">Lohnabrechnung</p>
        <div className="mt-1 flex items-center justify-center gap-0.5">
          <button
            type="button"
            aria-label="Vorheriger Monat"
            disabled={!canGoPrevMonth || monthEntriesLoading}
            onClick={() => shiftViewMonth(-1)}
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-25"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </button>
          <p className="min-w-0 flex-1 text-center text-lg font-bold leading-tight px-1">{currentMonthLabel}</p>
          <button
            type="button"
            aria-label="Nächster Monat"
            disabled={!canGoNextMonth || monthEntriesLoading}
            onClick={() => shiftViewMonth(1)}
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-25"
          >
            <ChevronRight className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <p className="text-xs text-slate-500 mt-0.5">
          {monthEntriesLoading ? 'Monat wird geladen…' : `${stunden} Stunden · CHF ${fmt(stundenlohn)}/Std`}
        </p>
      </div>

      {!monthEntriesLoading && monthEntries.length === 0 && entries.length > 0 ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-center text-xs text-slate-600">
          In diesem Monat sind keine Stunden erfasst.
        </div>
      ) : null}

      <div className={`rounded-xl border p-3 flex items-center gap-3 ${
        payrollConfirmed
          ? 'bg-emerald-50 border-emerald-200'
          : 'bg-amber-50 border-amber-200'
      }`}>
        {confirmationLoading ? (
          <p className="text-sm text-slate-600">Freigabe wird geladen…</p>
        ) : payrollConfirmed ? (
          <>
            <ShieldCheck className="w-5 h-5 text-emerald-600 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-emerald-800">Bestätigt durch {employerName || 'deinen Arbeitgeber'}</p>
              <p className="text-xs text-emerald-600">Diese Abrechnung wurde freigegeben. Du kannst dieselbe Lohnabrechnung wie im Arbeitgeber-Dashboard als PDF laden.</p>
            </div>
          </>
        ) : (
          <>
            <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-amber-800">Noch nicht bestätigt</p>
              <p className="text-xs text-amber-600">Warte auf Freigabe durch {employerName || 'deinen Arbeitgeber'}.</p>
            </div>
          </>
        )}
      </div>

      {payrollConfirmed && stunden > 0 && !confirmationLoading ? (
        <button
          type="button"
          onClick={downloadOfficialPayslipPdf}
          className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm shadow-md transition-colors"
        >
          <Download className="w-5 h-5" />
          Offizielle Lohnabrechnung (PDF)
        </button>
      ) : null}

      <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-slate-400 font-bold">
            <span>Position</span>
            <span>CHF / Monat</span>
          </div>
        </div>

        <div className="px-4 py-3 space-y-0.5">
          <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold pt-1 pb-1">Lohn</p>
          <Row label="Arbeitslohn" perHour={payslip.wageLines.workWage.perHour} perYear={payslip.wageLines.workWage.perMonth} />
          {payslip.wageLines.vacationSurcharge.perMonth > 0 && (
            <Row
              label="Ferienzuschlag"
              rate={payslip.wageLines.vacationSurcharge.rate}
              perHour={payslip.wageLines.vacationSurcharge.perHour}
              perYear={payslip.wageLines.vacationSurcharge.perMonth}
            />
          )}
          <div className="border-t my-1.5" />
          <Row label="Bruttolohn" perHour={payslip.wageLines.grossWage.perHour} perYear={payslip.wageLines.grossWage.perMonth} bold />

          <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold pt-3 pb-1">Abzüge</p>
          {activeDeductions.map((l, i) => (
            <Row key={i} label={l.label} rate={l.rate} perHour={l.perHour} perYear={l.perMonth} minus />
          ))}
          <div className="border-t my-1.5" />
          <Row
            label="Total Abzüge"
            rate={payslip.totalDeductions.rate}
            perHour={payslip.totalDeductions.perHour}
            perYear={payslip.totalDeductions.perMonth}
            bold
            minus
          />
        </div>

        <div className="px-4 py-4 bg-emerald-50 border-t border-emerald-200">
          <div className="flex items-center justify-between">
            <span className="font-bold text-emerald-800">Nettolohn</span>
            <span className="text-xl font-black tabular-nums text-emerald-700">CHF {fmt(payslip.netWage.perMonth)}</span>
          </div>
          <p className="text-xs text-emerald-600 mt-0.5">CHF {fmt(payslip.netWage.perHour)} pro Stunde</p>
        </div>
      </div>

      {!payrollConfirmed ? (
        <div className="bg-blue-50 rounded-xl border border-blue-100 p-4 text-center">
          <p className="text-sm text-blue-700 font-medium">
            📄 Die offizielle Lohnabrechnung zum Download steht bereit, sobald der Arbeitgeber die Abrechnung bestätigt hat.
          </p>
        </div>
      ) : null}
    </>
  );
}
