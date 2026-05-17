import { useState } from 'react';
import { supabase } from '@asklepios/core';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import {
  ArrowRight, ArrowLeft, HeartHandshake, User, CheckCircle2,
  ClipboardList, ShieldCheck, UserX, MapPin, AlertCircle, FileText
} from 'lucide-react';
import { getCantonFromPLZ, getCityFromChPlz, normalizeChPlz } from '@/utils/chPlz';

function getCityFromPLZ(plz: string): string | null {
  return getCityFromChPlz(plz);
}

const ALLOWED_CANTONS = ['BE', 'LU', 'ZH'] as const;
const ALLOWED_CANTON_LABELS: Record<string, string> = { BE: 'Bern', LU: 'Luzern', ZH: 'Zürich' };

function isPlzInAllowedCanton(plz: string): boolean {
  const canton = getCantonFromPLZ(plz);
  return !!canton && (ALLOWED_CANTONS as readonly string[]).includes(canton.code);
}

function isValidAhvNumber(v: string): boolean {
  if (!v.trim()) return true;
  return /^756\.\d{4}\.\d{4}\.\d{2}$/.test(v.trim());
}

function isValidIban(v: string): boolean {
  if (!v.trim()) return true;
  const clean = v.replace(/\s/g, '');
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/i.test(clean);
}

function isValidPhone(v: string): boolean {
  if (!v.trim()) return true;
  const digits = v.replace(/[\s\-().]/g, '');
  return /^\+?\d{10,15}$/.test(digits);
}

// ─── Stable sub-components ───

const inputCls = "w-full px-4 py-3 rounded-lg border bg-background text-base focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary";

function Field({ label, value, onChange, disabled, placeholder, type = 'text' }: {
  label: string; value: string; onChange?: (v: string) => void; disabled?: boolean; placeholder?: string; type?: string;
}) {
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium text-muted-foreground">{label}</label>
      <input id={id} type={type} value={value} onChange={e => onChange?.(e.target.value)}
        disabled={disabled} placeholder={placeholder}
        className={`${inputCls} ${disabled ? 'bg-muted/40 text-muted-foreground' : ''}`} />
    </div>
  );
}

function Radio({ active, onClick, label, icon: Icon, disabled }: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon?: React.ComponentType<{className?: string}>;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`w-full text-left px-5 py-4 rounded-xl border-2 text-base font-medium transition-all
        ${disabled ? 'opacity-50 cursor-not-allowed bg-muted/30 border-border' : ''}
        ${!disabled && active ? 'border-primary bg-primary/5' : ''}
        ${!disabled && !active ? 'border-border hover:border-primary/30' : ''}`}
    >
      <span className="flex items-center gap-3">
        <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0
          ${active ? 'border-primary bg-primary' : 'border-muted-foreground/30'}`}>
          {active && <span className="w-2 h-2 rounded-full bg-white" />}
        </span>
        {Icon && <Icon className="w-5 h-5 text-muted-foreground" />}
        {label}
      </span>
    </button>
  );
}

interface Props { onComplete: () => void; }
type RoleType = 'affected' | 'supporter' | null;

/*  Steps:
 *  0 = Role (affected / supporter)
 *  1 = Your contact data
 *  2 = Affected person data (supporter only, else skip)
 *  3 = Who tracks hours (employer / assistant)
 *     → if assistant: sub-question "approval required?"
 */

export function EmployerOnboarding({ onComplete }: Props) {
  const { user, refreshProfile } = useAuth();
  const [role, setRole] = useState<RoleType>(null);
  const [step, setStep] = useState(0);

  // Contact
  const [cFirst, setCFirst] = useState('');
  const [cLast, setCLast] = useState('');
  const [cStreet, setCStreet] = useState('');
  const [cZip, setCZip] = useState('');
  const [cCity, setCCity] = useState('');
  const [cCityAutofill, setCCityAutofill] = useState(false);
  const [cPhone, setCPhone] = useState('');

  // Affected person
  const [aFirst, setAFirst] = useState('');
  const [aLast, setALast] = useState('');
  const [aStreet, setAStreet] = useState('');
  const [aZip, setAZip] = useState('');
  const [aCity, setACity] = useState('');
  const [aCityAutofill, setACityAutofill] = useState(false);
  const [aEmail, setAEmail] = useState('');
  const [insuredAhvNumber, setInsuredAhvNumber] = useState('');

  // IV invoice / billing (stored in employer.contact_data)
  const [billingIban, setBillingIban] = useState('');
  const [billingAccountHolderName, setBillingAccountHolderName] = useState('');
  const [billingAccountHolderStreet, setBillingAccountHolderStreet] = useState('');
  const [billingAccountHolderPlz, setBillingAccountHolderPlz] = useState('');
  const [billingAccountHolderCity, setBillingAccountHolderCity] = useState('');
  const [billingReferenceNumber, setBillingReferenceNumber] = useState('');
  const [accountHolderIsAffected, setAccountHolderIsAffected] = useState(true);

  // Setup
  const [tracker, setTracker] = useState('');
  const [approvalNeeded, setApprovalNeeded] = useState('');
  const [activitiesInDayShifts, setActivitiesInDayShifts] = useState<'yes' | 'no' | ''>('');
  const [loading, setLoading] = useState(false);
  const [detectedCanton, setDetectedCanton] = useState<{ code: string; name: string } | null>(null);

  // Auto-detect canton when PLZ changes
  const handleZipChange = (zip: string) => {
    const normalized = normalizeChPlz(zip);
    setCZip(normalized);
    if (normalized.length >= 4) {
      setDetectedCanton(getCantonFromPLZ(normalized));
      const city = getCityFromPLZ(normalized);
      if (city && (!cCity || cCityAutofill)) {
        setCCity(city);
        setCCityAutofill(true);
      }
    } else {
      setDetectedCanton(null);
    }
  };

  const handleAffectedZipChange = (zip: string) => {
    const normalized = normalizeChPlz(zip);
    setAZip(normalized);
    const city = getCityFromPLZ(normalized);
    if (city && (!aCity || aCityAutofill)) {
      setACity(city);
      setACityAutofill(true);
    }
  };

  const TOTAL_STEPS = 3;

  const next = () => {
    let n = step + 1;
    if (n === 2 && role === 'affected') n = 3;
    setStep(n);
  };
  const back = () => {
    let p = step - 1;
    if (p === 2 && role === 'affected') p = 1;
    setStep(p);
  };

  const canNext = () => {
    if (step === 1) return cFirst.trim().length >= 1 && cLast.trim().length >= 1 && cZip.length === 4 && isPlzInAllowedCanton(cZip) && isValidAhvNumber(insuredAhvNumber) && isValidIban(billingIban) && isValidPhone(cPhone);
    if (step === 2) return aFirst.trim().length >= 1 && aLast.trim().length >= 1;
    if (step === 3) return tracker !== '' && (tracker === 'employer' || (approvalNeeded !== '' && activitiesInDayShifts !== ''));
    return false;
  };

  const isFinal = step === 3;
  const progress = Math.round((step / TOTAL_STEPS) * 100);

  const submit = async () => {
    if (!user || !canNext()) return;
    setLoading(true);

    const isSupporter = role === 'supporter';
    const name = isSupporter ? `${aFirst} ${aLast}`.trim() : `${cFirst} ${cLast}`.trim();

    // Generate the employer ID client-side so we can reference it in employer_access
    // without needing .select().single() after the INSERT. The SELECT policy on employer
    // requires an employer_access row to exist, which creates a chicken-and-egg problem
    // if we rely on the chained select to get the ID back.
    const employerId = crypto.randomUUID();

    const { error: e1 } = await supabase
      .from('employer')
      .insert({
        id: employerId,
        name,
        canton: detectedCanton?.code || 'ZH',
        representation: isSupporter ? 'guardian' : 'self',
        iv_hours_day: 8, iv_hours_night: 0, iv_rate: 35.3,
        contact_data: {
          first_name: cFirst,
          last_name: cLast,
          street: cStreet,
          plz: cZip,
          city: cCity,
          phone: cPhone,
          insured_ahv_number: insuredAhvNumber.trim() || null,
          billing_iban: billingIban.trim() || null,
          billing_reference_number: billingReferenceNumber.trim() || null,
          billing_account_holder_name: (
            accountHolderIsAffected
              ? (isSupporter ? `${aFirst} ${aLast}`.trim() : `${cFirst} ${cLast}`.trim())
              : billingAccountHolderName
          ).trim() || null,
          billing_account_holder_street: (
            accountHolderIsAffected
              ? (isSupporter ? aStreet : cStreet)
              : billingAccountHolderStreet
          ).trim() || null,
          billing_account_holder_plz: (
            accountHolderIsAffected
              ? (isSupporter ? aZip : cZip)
              : billingAccountHolderPlz
          ).trim() || null,
          billing_account_holder_city: (
            accountHolderIsAffected
              ? (isSupporter ? aCity : cCity)
              : billingAccountHolderCity
          ).trim() || null,
          payment_terms_days: 30,
          ...(isSupporter ? {
            affected_first_name: aFirst,
            affected_last_name: aLast,
            affected_street: aStreet,
            affected_plz: aZip,
            affected_city: aCity,
          } : {})
        }
      });

    if (e1) { toast.error('Fehler: ' + e1.message); setLoading(false); return; }

    const { error: e2 } = await supabase
      .from('employer_access')
      .insert({ employer_id: employerId, user_id: user.id, role: 'admin_full', invited_email: user.email || '' });

    if (e2) {
      // Roll back the orphaned employer row so the user can retry cleanly.
      await supabase.from('employer').delete().eq('id', employerId);
      toast.error('Fehler: ' + e2.message);
      setLoading(false);
      return;
    }

    toast.success('Einrichtung abgeschlossen!');
    await refreshProfile();
    setLoading(false);
    onComplete();
  };

  // ─── Steps ───
  const renderStep = () => {
    // 0: Role
    if (step === 0) return (
      <div className="space-y-5">
        <h3 className="text-xl font-bold text-center">Wer nutzt die App?</h3>
        <div className="grid grid-cols-2 gap-4">
          {/* Betroffene Person – in scope */}
          <button type="button" onClick={() => { setRole('affected'); next(); }}
            className="p-6 rounded-xl border-2 border-transparent bg-muted/40 hover:border-primary/20 transition-all text-center">
            <User className="w-8 h-8 text-primary mx-auto mb-2" />
            <p className="text-base font-semibold">Betroffene Person</p>
            <p className="text-sm text-muted-foreground">Ich selbst</p>
          </button>
          {/* Unterstützende Person */}
          <button type="button" onClick={() => { setRole('supporter'); next(); }}
            className="p-6 rounded-xl border-2 border-transparent bg-muted/40 hover:border-primary/20 transition-all text-center">
            <HeartHandshake className="w-8 h-8 text-primary mx-auto mb-2" />
            <p className="text-base font-semibold">Unterstützende Person</p>
            <p className="text-sm text-muted-foreground">Für jemand anderen</p>
          </button>
        </div>
      </div>
    );

    // 1: Your data
    if (step === 1) return (
      <div className="space-y-6">
        <h3 className="text-xl font-bold flex items-center gap-2">
          <MapPin className="w-6 h-6 text-primary" />
          {role === 'affected' ? 'Ihre Angaben' : 'Ihre Kontaktdaten'}
        </h3>

        {/* ── Abschnitt 1: Persönliche Angaben ── */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <User className="w-4 h-4 text-muted-foreground" />
            <h4 className="text-sm font-semibold text-foreground">Persönliche Angaben</h4>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Vorname *" value={cFirst} onChange={setCFirst} />
            <Field label="Nachname *" value={cLast} onChange={setCLast} />
          </div>
          <Field label="Strasse & Nr." value={cStreet} onChange={setCStreet} />

          <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-900 flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
            <span>Asklepios ist derzeit nur in den Kantonen <strong>Bern</strong>, <strong>Luzern</strong> und <strong>Zürich</strong> verfügbar. Bitte geben Sie eine Postleitzahl aus einem dieser Kantone ein.</span>
          </div>

          <div className="grid grid-cols-[120px_1fr] gap-4">
            <div className="space-y-1">
              <label className="text-sm font-medium text-muted-foreground">PLZ *</label>
              <input type="text" value={cZip} onChange={e => handleZipChange(e.target.value)}
                placeholder="z.B. 8000" maxLength={4}
                className={`${inputCls} ${cZip.length === 4 && !isPlzInAllowedCanton(cZip) ? 'border-red-400 focus:ring-red-200 focus:border-red-400' : ''}`} />
              {cZip.length === 4 && !isPlzInAllowedCanton(cZip) && (
                <p className="text-xs text-red-600 mt-1">PLZ liegt nicht in BE, LU oder ZH.</p>
              )}
            </div>
            <Field
              label="Ort *"
              value={cCity}
              onChange={(v) => { setCCity(v); setCCityAutofill(false); }}
            />
          </div>

          {detectedCanton && isPlzInAllowedCanton(cZip) && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/10">
              <MapPin className="w-4 h-4 text-primary" />
              <span className="text-sm"><span className="font-semibold">{detectedCanton.code}</span> – {detectedCanton.name}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Field label="E-Mail" value={user?.email ?? ''} disabled />
            <div>
              <Field label="Telefon (optional)" value={cPhone} onChange={setCPhone} placeholder="+41 ..." />
              {!isValidPhone(cPhone) && (
                <p className="text-xs text-red-600 mt-1">Ungültiges Telefonformat.</p>
              )}
            </div>
          </div>
        </div>

        {/* ── Abschnitt 2: Fallbezogene Angaben (optional / später) ── */}
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-slate-500 shrink-0" />
              <h4 className="text-sm font-semibold text-slate-700">Fallbezogene Angaben</h4>
            </div>
            <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200 whitespace-nowrap">
              Kann später ergänzt werden
            </span>
          </div>
          <p className="text-xs text-slate-500 -mt-1">
            Diese Angaben werden für die IV-Abrechnung benötigt und können auch nach der Einrichtung noch hinzugefügt werden.
          </p>

          <div>
            <Field label="AHV-Nummer (versicherte Person)" value={insuredAhvNumber} onChange={setInsuredAhvNumber} placeholder="756.xxxx.xxxx.xx" />
            {!isValidAhvNumber(insuredAhvNumber) && (
              <p className="text-xs text-red-600 mt-1">Format: 756.xxxx.xxxx.xx</p>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 space-y-3">
            <p className="text-sm font-semibold text-slate-700">IV-Abrechnung (Ansatz & Auszahlung)</p>
            <Field label="IV-Ansatz (CHF/Std)" value="35.30" disabled />
            <div>
              <Field label="IBAN (Auszahlung IV Rechnung für Assistenzbeitrag)" value={billingIban} onChange={setBillingIban} placeholder="CH.." />
              {!isValidIban(billingIban) && (
                <p className="text-xs text-red-600 mt-1">Ungültiges IBAN-Format. Erwartet: Ländercode + 2 Prüfziffern + 11–30 Zeichen.</p>
              )}
            </div>
            <Field label="Mitteilungs-/Verfügungsnummer (optional)" value={billingReferenceNumber} onChange={setBillingReferenceNumber} placeholder="…" />
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border bg-background/70 px-3 py-2">
              <span className="text-sm font-medium">Kontoinhaber:in</span>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={accountHolderIsAffected}
                  onChange={(e) => setAccountHolderIsAffected(e.target.checked)}
                  className="h-4 w-4"
                />
                = betroffene Person
              </label>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field
                label="Name Kontoinhaber:in"
                value={accountHolderIsAffected ? `${cFirst} ${cLast}`.trim() : billingAccountHolderName}
                onChange={setBillingAccountHolderName}
                placeholder="Vorname Name"
                disabled={accountHolderIsAffected}
              />
              <Field
                label="Adresse Kontoinhaber:in"
                value={accountHolderIsAffected ? cStreet : billingAccountHolderStreet}
                onChange={setBillingAccountHolderStreet}
                placeholder="Strasse Nr."
                disabled={accountHolderIsAffected}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field
                label="PLZ"
                value={accountHolderIsAffected ? cZip : billingAccountHolderPlz}
                onChange={setBillingAccountHolderPlz}
                placeholder="8000"
                disabled={accountHolderIsAffected}
              />
              <Field
                label="Ort"
                value={accountHolderIsAffected ? cCity : billingAccountHolderCity}
                onChange={setBillingAccountHolderCity}
                placeholder="Zürich"
                disabled={accountHolderIsAffected}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Diese Angaben werden für das IV-Deckblatt / die monatliche Rechnung verwendet.
            </p>
          </div>
        </div>
      </div>
    );

    // 2: Affected person (supporter only)
    if (step === 2) return (
      <div className="space-y-4">
        <h3 className="text-xl font-bold flex items-center gap-2"><User className="w-6 h-6 text-primary" />Betroffene Person</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Field label="Vorname" value={aFirst} onChange={setAFirst} />
          </div>
          <div>
            <Field label="Nachname" value={aLast} onChange={setALast} />
          </div>
        </div>
        <Field label="Strasse & Nr." value={aStreet} onChange={setAStreet} />
        <div className="grid grid-cols-[120px_1fr] gap-4">
          <Field label="PLZ" value={aZip} onChange={handleAffectedZipChange} />
          <Field
            label="Ort"
            value={aCity}
            onChange={(v) => {
              setACity(v);
              setACityAutofill(false);
            }}
          />
        </div>
        <Field label="E-Mail (optional)" value={aEmail} onChange={setAEmail} type="email" placeholder="name@beispiel.ch" />
      </div>
    );

    // 3: Who tracks hours
    if (step === 3) return (
      <div className="space-y-3">
        <h3 className="text-xl font-bold flex items-center gap-2"><ClipboardList className="w-6 h-6 text-primary" />Wer erfasst die Stunden?</h3>
        <Radio
          active={tracker === 'employer'}
          onClick={() => { setTracker('employer'); setApprovalNeeded(''); setActivitiesInDayShifts(''); }}
          label={role === 'affected' ? 'Ich selbst (Betroffene Person)' : role === 'supporter' ? 'Ich selbst (Unterstützende Person)' : 'Ich selbst (Arbeitgeber)'}
          icon={User}
        />
        <Radio active={tracker === 'assistant'} onClick={() => setTracker('assistant')} label="Die Assistenzperson" icon={UserX} />

        {tracker === 'assistant' && (
          <div className="ml-6 space-y-3 pt-2 border-l-2 border-primary/20 pl-4">
            <p className="text-base font-medium flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-primary" />Müssen die Stunden genehmigt werden?</p>
            <div className="grid grid-cols-2 gap-3">
              <Radio active={approvalNeeded === 'yes'} onClick={() => setApprovalNeeded('yes')} label="Ja, ich genehmige" />
              <Radio active={approvalNeeded === 'no'} onClick={() => setApprovalNeeded('no')} label="Nein, direkt übernehmen – out of scope" disabled />
            </div>

            <div className="pt-3">
              <p className="text-base font-medium">Soll die Assistenzperson bei Tagdiensten zusätzlich Tätigkeiten erfassen?</p>
              <p className="text-sm text-muted-foreground mt-1">
                Wenn Sie <span className="font-medium">Ja</span> wählen, erscheint bei <span className="font-medium">Tagdiensten</span> beim Erfassen der Stunden
                ein zusätzliches Feld „Tätigkeitsbereich“. Bei Nachtdiensten wird dieses Feld nicht angezeigt.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Radio active={activitiesInDayShifts === 'yes'} onClick={() => setActivitiesInDayShifts('yes')} label="Ja, Tätigkeiten mit erfassen" />
                <Radio active={activitiesInDayShifts === 'no'} onClick={() => setActivitiesInDayShifts('no')} label="Nein, nur Zeiten erfassen" />
              </div>
            </div>
          </div>
        )}
      </div>
    );

    return null;
  };

  return (
    <div className="w-full max-w-3xl mx-auto rounded-2xl border bg-card shadow-sm overflow-hidden">
      <div className="h-1.5 bg-muted">
        <div className="h-full bg-primary transition-all duration-500" style={{ width: `${progress}%` }} />
      </div>
      <div className="p-6">
        {renderStep()}

        {step > 0 && (
          <div className="flex items-center justify-between mt-6 pt-5 border-t">
            <button type="button" onClick={back}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-base text-muted-foreground hover:text-foreground transition">
              <ArrowLeft className="w-5 h-5" /> Zurück
            </button>

            {isFinal ? (
              <button type="button" onClick={submit} disabled={!canNext() || loading}
                className="flex items-center gap-2 px-6 py-3 rounded-xl text-base font-semibold bg-primary text-white disabled:opacity-40 transition">
                {loading ? <span className="animate-spin rounded-full h-5 w-5 border-2 border-white/30 border-t-white" />
                  : <><CheckCircle2 className="w-5 h-5" /> Abschliessen</>}
              </button>
            ) : (
              <button type="button" onClick={next} disabled={!canNext()}
                className="flex items-center gap-2 px-6 py-3 rounded-xl text-base font-semibold bg-primary text-white disabled:opacity-40 transition">
                Weiter <ArrowRight className="w-5 h-5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
