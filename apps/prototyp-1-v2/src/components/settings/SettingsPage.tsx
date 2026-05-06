import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import {
  supabase,
  getIvStelleRecordForCanton,
  getIvStelleInvoiceRecipientSuggestion,
} from '@asklepios/core';
import { toast } from 'sonner';
import {
  Settings as SettingsIcon, User, Save, MapPin, CreditCard,
  RotateCcw, HeartHandshake, Mail, Home
} from 'lucide-react';
import { getCantonFromPLZ } from '@/utils/chPlz';
import { cn } from '@/lib/utils';

function EditableField({ label, value, onChange, placeholder, type = 'text', tooltip }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; tooltip?: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {label}
        </label>
        {tooltip && (
          <div className="relative group">
            <div className="w-3.5 h-3.5 rounded-full bg-muted-foreground/20 text-muted-foreground flex items-center justify-center cursor-help text-[9px] font-bold leading-none select-none">
              i
            </div>
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 bg-popover border text-popover-foreground text-xs rounded-lg px-3 py-2 shadow-lg
              opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150 z-50 leading-relaxed">
              {tooltip}
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-popover" />
            </div>
          </div>
        )}
      </div>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3.5 py-2.5 rounded-xl border bg-background text-sm font-medium
          shadow-sm shadow-black/5 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
      />
    </div>
  );
}

function Section({ title, subtitle, icon: Icon, children }: {
  title: string;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border bg-gradient-to-b from-background to-muted/10 p-4 space-y-3 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-2xl bg-primary/10 border border-primary/10 flex items-center justify-center">
            <Icon className="w-4.5 h-4.5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">{title}</p>
            {subtitle && <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{subtitle}</p>}
          </div>
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function InfoRow({ icon: Icon, label, value, iconColor = 'text-muted-foreground' }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  iconColor?: string;
}) {
  return (
    <div className="flex items-center justify-between py-3 px-4 border-b border-border/50 last:border-b-0 bg-background/50">
      <div className="flex items-center gap-3">
        <Icon className={`w-4 h-4 ${iconColor}`} />
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
      </div>
      <span className="text-sm font-bold text-foreground">{value}</span>
    </div>
  );
}

export function SettingsPage() {
  const { user, employer, employerAccess, refreshProfile, signOut } = useAuth();
  const [activeTab, setActiveTab] = useState<'profil' | 'einstellungen'>('profil');
  const [insuredName, setInsuredName] = useState(employer?.name ?? '');
  const splitName = (full: string) => {
    const parts = full.trim().split(' ');
    return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
  };
  const [insuredFirstName, setInsuredFirstName] = useState(() => splitName(employer?.name ?? '').first);
  const [insuredLastName, setInsuredLastName] = useState(() => splitName(employer?.name ?? '').last);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Stored in employer.contact_data
  const contact = (employer?.contact_data as Record<string, string>) || {};
  // Rechnungssteller / Kontaktperson (kann von betroffener Person abweichen)
  const [issuerFirstName, setIssuerFirstName] = useState(contact.first_name ?? '');
  const [issuerLastName, setIssuerLastName] = useState(contact.last_name ?? '');
  const [issuerStreet, setIssuerStreet] = useState(contact.street ?? '');
  const [issuerPlz, setIssuerPlz] = useState(contact.plz ?? '');
  const [issuerCity, setIssuerCity] = useState(contact.city ?? '');
  const [representation, setRepresentation] = useState(employer?.representation ?? 'self');
  const [issuerPhone, setIssuerPhone] = useState((contact as any).phone ?? '');
  const [insuredAhvNumber, setInsuredAhvNumber] = useState((contact as any).insured_ahv_number ?? '');

  // Betroffene Person (falls unterstützt) – in contact_data. Sonst: separate Versicherte-Person-Adresse.
  const [affectedFirstName, setAffectedFirstName] = useState((contact as any).affected_first_name ?? '');
  const [affectedLastName, setAffectedLastName] = useState((contact as any).affected_last_name ?? '');
  const [affectedStreet, setAffectedStreet] = useState((contact as any).affected_street ?? '');
  const [affectedPlz, setAffectedPlz] = useState((contact as any).affected_plz ?? '');
  const [affectedCity, setAffectedCity] = useState((contact as any).affected_city ?? '');

  const [insuredStreet, setInsuredStreet] = useState(String((contact as any).insured_street ?? ''));
  const [insuredPlz, setInsuredPlz] = useState(String((contact as any).insured_plz ?? ''));
  const [insuredCity, setInsuredCity] = useState(String((contact as any).insured_city ?? ''));

  // IV invoice settings (stored inside employer.contact_data)
  const [billingIban, setBillingIban] = useState(String((contact as any).billing_iban ?? ''));
  const [billingReferenceNumber, setBillingReferenceNumber] = useState(String((contact as any).billing_reference_number ?? ''));
  const [billingAccountHolderName, setBillingAccountHolderName] = useState(String((contact as any).billing_account_holder_name ?? ''));
  const [billingAccountHolderStreet, setBillingAccountHolderStreet] = useState(String((contact as any).billing_account_holder_street ?? ''));
  const [billingAccountHolderPlz, setBillingAccountHolderPlz] = useState(String((contact as any).billing_account_holder_plz ?? ''));
  const [billingAccountHolderCity, setBillingAccountHolderCity] = useState(String((contact as any).billing_account_holder_city ?? ''));
  const [accountHolderIsInsured, setAccountHolderIsInsured] = useState(false);

  // IV-Rechnung: Empfänger (Behörde) + optionale Rückfragen-Zeile (Fusszeile PDF)
  const [ivInvoiceAuthorityName, setIvInvoiceAuthorityName] = useState(
    String((contact as any).iv_invoice_authority_name ?? ''),
  );
  const [ivInvoiceAuthorityPlz, setIvInvoiceAuthorityPlz] = useState(
    String((contact as any).iv_invoice_authority_plz ?? ''),
  );
  const [ivInvoiceAuthorityCity, setIvInvoiceAuthorityCity] = useState(
    String((contact as any).iv_invoice_authority_city ?? ''),
  );
  const [ivInvoiceInquiriesName, setIvInvoiceInquiriesName] = useState(
    String((contact as any).iv_invoice_inquiries_name ?? ''),
  );
  const [ivInvoiceInquiriesEmail, setIvInvoiceInquiriesEmail] = useState(
    String((contact as any).iv_invoice_inquiries_email ?? ''),
  );
  const [ivInvoiceInquiriesPhone, setIvInvoiceInquiriesPhone] = useState(
    String((contact as any).iv_invoice_inquiries_phone ?? ''),
  );

  const resetOnboarding = async () => {
    if (!employer || !employerAccess) return;
    if (!confirm('Onboarding wirklich zurücksetzen? Alle Daten (Assistenzpersonen, Einstellungen) werden gelöscht.')) return;
    setResetting(true);

    try {
      // 1. Get all assistant IDs for this employer
      const { data: assistants, error: getAssErr } = await supabase
        .from('assistant')
        .select('id')
        .eq('employer_id', employer.id);
      if (getAssErr) console.error("get assistants err", getAssErr);
      const assistantIds = (assistants || []).map(a => a.id);

      // 2. Delete dependent tables first (FK constraints)
      if (assistantIds.length > 0) {
        const { error: e1 } = await supabase.from('time_entry').delete().in('assistant_id', assistantIds).select();
        if (e1) console.error("time_entry err", e1);
        const { error: e2 } = await supabase.from('payroll').delete().in('assistant_id', assistantIds).select();
        if (e2) console.error("payroll err", e2);
        const { error: e3 } = await supabase.from('weekly_schedule').delete().in('assistant_id', assistantIds).select();
        if (e3) console.error("schedule err", e3);
      }

      // 3. Delete assistants
      const { error: asstErr } = await supabase.from('assistant').delete().eq('employer_id', employer.id).select();
      if (asstErr) console.error("assistant del err", asstErr);

      // 4. Delete employer_access
      const { error: accessError } = await supabase.from('employer_access').delete().eq('id', employerAccess.id).select();
      if (accessError) console.error('Failed to delete employer_access:', accessError);

      // 5. Delete employer (might fail due to RLS, but orphan is fine for a reset)
      const { error: empErr } = await supabase.from('employer').delete().eq('id', employer.id).select();
      if (empErr) console.error("employer del err", empErr);

      // SIGN OUT via context (clears localStorage + session), then redirect
      toast.success('Onboarding zurückgesetzt – Sie werden abgemeldet...');
      await signOut();
      
      // Force reload the app so the auth state clears reliably
      setTimeout(() => { window.location.replace('/login'); }, 500);
    } catch (e) {
      console.error('Reset error:', e);
      toast.error('Unerwarteter Fehler beim Zurücksetzen');
      setResetting(false);
    }
  };

  useEffect(() => {
    if (employer) {
      setInsuredName(employer.name ?? '');
      const { first, last } = splitName(employer.name ?? '');
      setInsuredFirstName(first);
      setInsuredLastName(last);
      setRepresentation(employer.representation ?? 'self');
      const c = (employer.contact_data as Record<string, string>) || {};
      setIssuerFirstName(c.first_name ?? '');
      setIssuerLastName(c.last_name ?? '');
      setIssuerStreet(c.street ?? '');
      setIssuerPlz(c.plz ?? '');
      setIssuerCity(c.city ?? '');
      setIssuerPhone((c as any).phone ?? '');
      setInsuredAhvNumber((c as any).insured_ahv_number ?? '');
      setAffectedFirstName((c as any).affected_first_name ?? '');
      setAffectedLastName((c as any).affected_last_name ?? '');
      setAffectedStreet((c as any).affected_street ?? '');
      setAffectedPlz((c as any).affected_plz ?? '');
      setAffectedCity((c as any).affected_city ?? '');
      setInsuredStreet(String((c as any).insured_street ?? ''));
      setInsuredPlz(String((c as any).insured_plz ?? ''));
      setInsuredCity(String((c as any).insured_city ?? ''));
      setBillingIban(String((c as any).billing_iban ?? ''));
      setBillingReferenceNumber(String((c as any).billing_reference_number ?? ''));
      setBillingAccountHolderName(String((c as any).billing_account_holder_name ?? ''));
      setBillingAccountHolderStreet(String((c as any).billing_account_holder_street ?? ''));
      setBillingAccountHolderPlz(String((c as any).billing_account_holder_plz ?? ''));
      setBillingAccountHolderCity(String((c as any).billing_account_holder_city ?? ''));
      const hasExplicitAccountHolder =
        String((c as any).billing_account_holder_name ?? '').trim() !== '' ||
        String((c as any).billing_account_holder_street ?? '').trim() !== '' ||
        String((c as any).billing_account_holder_plz ?? '').trim() !== '' ||
        String((c as any).billing_account_holder_city ?? '').trim() !== '';
      setAccountHolderIsInsured(!hasExplicitAccountHolder);
      setIvInvoiceAuthorityName(String((c as any).iv_invoice_authority_name ?? ''));
      setIvInvoiceAuthorityPlz(String((c as any).iv_invoice_authority_plz ?? ''));
      setIvInvoiceAuthorityCity(String((c as any).iv_invoice_authority_city ?? ''));
      setIvInvoiceInquiriesName(String((c as any).iv_invoice_inquiries_name ?? ''));
      setIvInvoiceInquiriesEmail(String((c as any).iv_invoice_inquiries_email ?? ''));
      setIvInvoiceInquiriesPhone(String((c as any).iv_invoice_inquiries_phone ?? ''));
    }
  }, [employer]);

  const insuredPersonForInvoice = () => {
    if (representation === 'guardian') {
      return {
        name: `${affectedFirstName} ${affectedLastName}`.trim(),
        street: affectedStreet,
        plz: affectedPlz,
        city: affectedCity,
      };
    }
    return {
      name: `${insuredFirstName} ${insuredLastName}`.trim() || insuredName,
      street: insuredStreet,
      plz: insuredPlz,
      city: insuredCity,
    };
  };

  useEffect(() => {
    if (!accountHolderIsInsured) return;
    const p = insuredPersonForInvoice();
    setBillingAccountHolderName(p.name);
    setBillingAccountHolderStreet(p.street);
    setBillingAccountHolderPlz(p.plz);
    setBillingAccountHolderCity(p.city);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    accountHolderIsInsured,
    representation,
    insuredFirstName,
    insuredLastName,
    insuredStreet,
    insuredPlz,
    insuredCity,
    affectedFirstName,
    affectedLastName,
    affectedStreet,
    affectedPlz,
    affectedCity,
  ]);

  const saveEmployer = async () => {
    if (!employer) return;
    setSaving(true);

    // Auto-detect canton from insured PLZ (betroffene Person)
    const effectiveInsuredPlz = representation === 'guardian' ? affectedPlz : insuredPlz;
    const detected = getCantonFromPLZ(effectiveInsuredPlz);

    // In Unterstützer-Modus ist employer.name = Name der betroffenen Person.
    const nextInsuredName =
      representation === 'guardian'
        ? `${affectedFirstName} ${affectedLastName}`.trim() || insuredName
        : `${insuredFirstName} ${insuredLastName}`.trim() || insuredName;

    const { error } = await supabase
      .from('employer')
      .update({
        name: nextInsuredName,
        representation,
        canton: detected?.code || employer.canton,
        contact_data: {
          ...((employer.contact_data as object) || {}),
          // Rechnungssteller / Kontaktperson
          first_name: issuerFirstName,
          last_name: issuerLastName,
          street: issuerStreet,
          plz: issuerPlz,
          city: issuerCity,
          phone: issuerPhone,

          insured_ahv_number: insuredAhvNumber,

          // Betroffene Person (nur relevant, wenn unterstützt)
          affected_first_name: affectedFirstName,
          affected_last_name: affectedLastName,
          affected_street: affectedStreet,
          affected_plz: affectedPlz,
          affected_city: affectedCity,

          // Versicherte Person Adresse (wenn selber = betroffene Person, aber Rechnungssteller kann abweichen)
          insured_street: insuredStreet,
          insured_plz: insuredPlz,
          insured_city: insuredCity,

          billing_iban: billingIban,
          billing_reference_number: billingReferenceNumber,
          billing_account_holder_name: accountHolderIsInsured ? insuredPersonForInvoice().name : billingAccountHolderName,
          billing_account_holder_street: accountHolderIsInsured ? insuredPersonForInvoice().street : billingAccountHolderStreet,
          billing_account_holder_plz: accountHolderIsInsured ? insuredPersonForInvoice().plz : billingAccountHolderPlz,
          billing_account_holder_city: accountHolderIsInsured ? insuredPersonForInvoice().city : billingAccountHolderCity,
          payment_terms_days: 30,
          iv_invoice_authority_name: ivInvoiceAuthorityName,
          iv_invoice_authority_plz: ivInvoiceAuthorityPlz,
          iv_invoice_authority_city: ivInvoiceAuthorityCity,
          iv_invoice_inquiries_name: ivInvoiceInquiriesName,
          iv_invoice_inquiries_email: ivInvoiceInquiriesEmail,
          iv_invoice_inquiries_phone: ivInvoiceInquiriesPhone,
        }
      })
      .eq('id', employer.id);
    if (error) {
      toast.error('Fehler beim Speichern: ' + error.message);
    } else {
      toast.success('Einstellungen gespeichert');
      await refreshProfile();
    }
    setSaving(false);
  };

  const SettingsCard = ({
    icon: Icon,
    iconColor = 'text-primary',
    iconBg = 'bg-primary/10',
    title,
    description,
    badge,
    children,
  }: {
    icon: typeof User;
    iconColor?: string;
    iconBg?: string;
    title: string;
    description?: string;
    badge?: string;
    children: React.ReactNode;
  }) => (
    <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
      <div className="px-6 py-5 border-b bg-muted/20">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-xl ${iconBg} flex items-center justify-center`}>
            <Icon className={`w-4.5 h-4.5 ${iconColor}`} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-sm">{title}</h2>
              {badge && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border bg-background/60 text-muted-foreground">
                  {badge}
                </span>
              )}
            </div>
            {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
          </div>
        </div>
      </div>
      <div className="px-6 py-5 space-y-4">
        {children}
      </div>
    </div>
  );

  const ReadOnlyField = ({ label, value }: { label: string; value: string }) => (
    <div className="flex flex-col">
      <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
        {label}
      </label>
      <div className="flex-1 flex items-center px-3.5 py-2.5 rounded-xl border bg-muted/40 text-sm text-muted-foreground font-medium">
        {value || '–'}
      </div>
    </div>
  );


  const detectedCanton = getCantonFromPLZ(representation === 'guardian' ? affectedPlz : insuredPlz);

  const applyIvStelleFromCanton = () => {
    const code = (employer?.canton || detectedCanton?.code || '').trim().toUpperCase();
    const sug = getIvStelleInvoiceRecipientSuggestion(code);
    if (!sug) {
      toast.error('Keine Standard-IV-Stelle hinterlegt', {
        description: 'Aktuell nur für die Kantone ZH, BE und Luzern. Bitte Adresse manuell eintragen oder Kanton in den Stammdaten setzen.',
      });
      return;
    }
    setIvInvoiceAuthorityName(sug.authorityName);
    setIvInvoiceAuthorityPlz(sug.record.plz);
    setIvInvoiceAuthorityCity(sug.record.city);
    toast.success('IV-Stelle übernommen', { description: 'Bitte speichern, damit die Daten wirksam werden.' });
  };

  // Guard: don't render if employer was deleted (e.g. after reset)
  if (!employer || !employerAccess) {
    return (
      <div className="h-full overflow-y-auto p-4 md:p-6 lg:p-8">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: '#94a3b8' }}>
          <p>Lade...</p>
        </div>
      </div>
    );
  }

  const ivCantonCode = (employer.canton || detectedCanton?.code || '').trim().toUpperCase();
  const ivStelleRecord = getIvStelleRecordForCanton(ivCantonCode);

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 lg:p-8">
    <div className="space-y-6 w-full max-w-7xl mx-auto pb-24">

      {/* Header */}
      <div className="rounded-3xl border bg-[radial-gradient(900px_520px_at_15%_0%,rgba(59,130,246,0.10),transparent_60%),radial-gradient(780px_520px_at_85%_10%,rgba(168,85,247,0.10),transparent_55%),linear-gradient(to_bottom,rgba(255,255,255,0.92),rgba(255,255,255,0.86))] p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-primary/10 border border-primary/10 flex items-center justify-center">
              <SettingsIcon className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Einstellungen & Profil</h1>
              <p className="text-muted-foreground text-sm mt-0.5">Konto, Profil und App-Einstellungen</p>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-2">
            {detectedCanton && (
              <div className="inline-flex items-center gap-2 px-3 py-2 rounded-2xl bg-blue-500/5 border border-blue-500/10 text-blue-700">
                <MapPin className="w-4 h-4" />
                <span className="text-sm font-semibold">{detectedCanton.code}</span>
                <span className="text-sm text-blue-700/70">{detectedCanton.name}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl bg-muted/40 border w-fit">
        {(['profil', 'einstellungen'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-5 py-2 rounded-lg text-sm font-medium transition-all",
              activeTab === tab
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab === 'profil' ? 'Profil' : 'Einstellungen'}
          </button>
        ))}
      </div>

      {/* ── Tab: Profil ── */}
      {activeTab === 'profil' && (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

        {/* Left Column: Betroffene Person & Rechnungssteller */}
        <div className="lg:col-span-7 space-y-6">
          {employer && (
            <SettingsCard
              icon={Home}
              iconColor="text-violet-600"
              iconBg="bg-violet-500/10"
              title="Betroffene Person & Rechnungssteller"
              description="Versicherte/betroffene Person kann von Konto-/Kontaktperson abweichen"
            >
              <div>
                <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                  Nutzungsart
                </label>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { val: 'self' as const, label: 'Betroffene Person', icon: User },
                    { val: 'guardian' as const, label: 'Unterstützende Person', icon: HeartHandshake },
                  ].map(({ val, label, icon: Icon }) => (
                    <button key={val} type="button" onClick={() => setRepresentation(val)}
                      className={`px-4 py-3 rounded-xl border-2 text-sm font-medium transition-all flex items-center gap-2
                        ${representation === val ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'}`}>
                      <Icon className="w-4 h-4 text-muted-foreground" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Versicherte / betroffene Person */}
                <Section
                  title="Betroffene Person (versicherte Person)"
                  subtitle="Diese Daten werden auf dem IV-Deckblatt verwendet."
                  icon={User}
                >
                  {representation === 'guardian' ? (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <EditableField label="Vorname" value={affectedFirstName} onChange={setAffectedFirstName} placeholder="Vorname" tooltip="Erscheint auf dem IV-Deckblatt und der monatlichen Rechnung als Name der versicherten Person." />
                        <EditableField label="Nachname" value={affectedLastName} onChange={setAffectedLastName} placeholder="Nachname" tooltip="Erscheint auf dem IV-Deckblatt und der monatlichen Rechnung als Name der versicherten Person." />
                      </div>
                      <EditableField label="Strasse & Nr." value={affectedStreet} onChange={setAffectedStreet} placeholder="z.B. Bahnhofstrasse 12" tooltip="Wohnadresse der versicherten Person — Pflichtangabe auf dem IV-Deckblatt." />
                      <div className="grid grid-cols-[120px_1fr] gap-3">
                        <EditableField label="PLZ" value={affectedPlz} onChange={setAffectedPlz} placeholder="8000" tooltip="Bestimmt den Kanton und damit den kantonalen FAK-Satz für die Lohnberechnung." />
                        <EditableField label="Ort" value={affectedCity} onChange={setAffectedCity} placeholder="Zürich" />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <EditableField label="Vorname" value={insuredFirstName} onChange={setInsuredFirstName} placeholder="Vorname" tooltip="Erscheint auf dem IV-Deckblatt und der monatlichen Rechnung als Name der versicherten Person." />
                        <EditableField label="Nachname" value={insuredLastName} onChange={setInsuredLastName} placeholder="Nachname" tooltip="Erscheint auf dem IV-Deckblatt und der monatlichen Rechnung als Name der versicherten Person." />
                      </div>
                      <EditableField label="Strasse & Nr." value={insuredStreet} onChange={setInsuredStreet} placeholder="z.B. Bahnhofstrasse 12" tooltip="Wohnadresse der versicherten Person — Pflichtangabe auf dem IV-Deckblatt." />
                      <div className="grid grid-cols-[120px_1fr] gap-3">
                        <EditableField label="PLZ" value={insuredPlz} onChange={setInsuredPlz} placeholder="8000" tooltip="Bestimmt den Kanton und damit den kantonalen FAK-Satz für die Lohnberechnung." />
                        <EditableField label="Ort" value={insuredCity} onChange={setInsuredCity} placeholder="Zürich" />
                      </div>
                    </>
                  )}
                  <EditableField label="AHV-Nummer" value={insuredAhvNumber} onChange={setInsuredAhvNumber} placeholder="756.xxxx.xxxx.xx" tooltip="Pflichtangabe auf der IV-Rechnung zur eindeutigen Identifikation bei der Ausgleichskasse. Format: 756.xxxx.xxxx.xx" />
                </Section>

                {/* Rechnungssteller / Kontaktperson */}
                <Section
                  title="Rechnungssteller / Kontaktperson"
                  subtitle="Kontaktperson bei Rückfragen (kann abweichen)."
                  icon={Mail}
                >
                  <div className="grid grid-cols-2 gap-3">
                    <EditableField label="Vorname" value={issuerFirstName} onChange={setIssuerFirstName} tooltip="Person, die bei Rückfragen der IV-Stelle kontaktiert wird und als Rechnungssteller auftritt." />
                    <EditableField label="Nachname" value={issuerLastName} onChange={setIssuerLastName} tooltip="Person, die bei Rückfragen der IV-Stelle kontaktiert wird und als Rechnungssteller auftritt." />
                  </div>
                  <EditableField label="Strasse & Nr." value={issuerStreet} onChange={setIssuerStreet} placeholder="z.B. Bahnhofstrasse 12" tooltip="Adresse des Rechnungsstellers — erscheint im Absenderblock des IV-Deckblatts." />
                  <div className="grid grid-cols-[120px_1fr] gap-3">
                    <EditableField label="PLZ" value={issuerPlz} onChange={setIssuerPlz} placeholder="8000" tooltip="Adresse des Rechnungsstellers — erscheint im Absenderblock des IV-Deckblatts." />
                    <EditableField label="Ort" value={issuerCity} onChange={setIssuerCity} placeholder="Zürich" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <EditableField label="Telefon (für Rückfragen)" value={issuerPhone} onChange={setIssuerPhone} placeholder="+41 ..." tooltip="Kontaktnummer für Rückfragen der IV-Stelle zur Abrechnung." />
                    <ReadOnlyField label="E-Mail" value={user?.email ?? ''} />
                  </div>
                </Section>
              </div>

              <Section
                title="IV-Deckblatt / Rechnung"
                subtitle="Auszahlungsdaten für die monatliche Rechnung."
                icon={CreditCard}
              >
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                  <ReadOnlyField label="IV-Ansatz (CHF/Std)" value="35.30" />
                  <EditableField label="IBAN (Auszahlung)" value={billingIban} onChange={setBillingIban} placeholder="CH.." tooltip="Bankkonto, auf das die IV-Auszahlung überwiesen wird. Muss auf den Namen des Kontoinhabers lauten." />
                  <EditableField label="Verfügungsnummer (optional)" value={billingReferenceNumber} onChange={setBillingReferenceNumber} placeholder="…" tooltip="Referenznummer aus der IV-Verfügung — ermöglicht der IV-Stelle die korrekte Zuordnung der Zahlung." />
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div className="lg:col-span-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-xl border bg-muted/20 px-3.5 py-2.5">
                    <div className="text-sm font-semibold">Kontoinhaber:in</div>
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <input
                        type="checkbox"
                        checked={accountHolderIsInsured}
                        onChange={(e) => setAccountHolderIsInsured(e.target.checked)}
                        className="h-4 w-4"
                      />
                      = betroffene Person
                    </label>
                  </div>
                  <EditableField
                    label="Name Kontoinhaber:in"
                    value={accountHolderIsInsured ? insuredPersonForInvoice().name : billingAccountHolderName}
                    onChange={setBillingAccountHolderName}
                    placeholder="Vorname Name"
                    tooltip="Muss mit dem beim Bankinstitut hinterlegten Namen übereinstimmen. Kann von der versicherten Person abweichen."
                  />
                  <EditableField
                    label="Adresse Kontoinhaber:in"
                    value={accountHolderIsInsured ? insuredPersonForInvoice().street : billingAccountHolderStreet}
                    onChange={setBillingAccountHolderStreet}
                    placeholder="Strasse Nr."
                    tooltip="Wird auf der Banküberweisung und dem IV-Deckblatt als Zahlungsempfängeradresse verwendet."
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <EditableField
                    label="PLZ"
                    value={accountHolderIsInsured ? insuredPersonForInvoice().plz : billingAccountHolderPlz}
                    onChange={setBillingAccountHolderPlz}
                    placeholder="8000"
                  />
                  <EditableField
                    label="Ort"
                    value={accountHolderIsInsured ? insuredPersonForInvoice().city : billingAccountHolderCity}
                    onChange={setBillingAccountHolderCity}
                    placeholder="Zürich"
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Wird im Download „IV‑Rechnung (Deckblatt)" verwendet. Die acht Leistungskategorien entsprechen Art. 39c IVG
                  (Auswahl in der Zeiterfassung).
                </p>

                <div className="mt-6 pt-4 border-t border-border/60 space-y-3">
                  <p className="text-sm font-medium text-foreground">Empfänger der Rechnung (Behörde)</p>
                  <p className="text-xs text-muted-foreground">
                    Für das geplante Brief-Layout (oben rechts). Daten werden bereits mitgegeben, sobald das PDF angepasst ist.
                  </p>

                  {ivStelleRecord ? (
                    <div className="rounded-xl border border-primary/15 bg-primary/[0.04] p-3 space-y-2 text-xs">
                      <p className="font-semibold text-foreground">
                        Referenz IV-Stelle ({ivCantonCode})
                      </p>
                      <p className="text-muted-foreground leading-relaxed whitespace-pre-line">
                        {ivStelleRecord.institutionNameDe}
                        {'\n'}
                        {ivStelleRecord.streetLine}
                        {ivStelleRecord.postBoxLine ? `\n${ivStelleRecord.postBoxLine}` : ''}
                        {'\n'}
                        {ivStelleRecord.plz} {ivStelleRecord.city}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <a
                          href={ivStelleRecord.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary font-medium hover:underline"
                        >
                          Website
                        </a>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground">{ivStelleRecord.phone}</span>
                      </div>
                      <button
                        type="button"
                        onClick={applyIvStelleFromCanton}
                        className="mt-1 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
                      >
                        Standard-Adresse übernehmen
                      </button>
                    </div>
                  ) : (
                    <p className="text-xs text-amber-700/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                      Kein Kanton ZH/BE/LU erkannt (Stammdaten-Kanton oder PLZ der betroffenen Person). IV-Adresse bitte manuell eintragen oder Kanton prüfen.
                    </p>
                  )}

                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                      Dienststelle / Behörde
                    </label>
                    <textarea
                      rows={4}
                      value={ivInvoiceAuthorityName}
                      onChange={e => setIvInvoiceAuthorityName(e.target.value)}
                      placeholder="Name und Anschrift der IV-Stelle (mehrzeilig möglich)"
                      className="w-full px-3.5 py-2.5 rounded-xl border bg-background text-sm font-medium shadow-sm shadow-black/5 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all resize-y min-h-[5.5rem]"
                    />
                  </div>
                  <div className="grid grid-cols-[120px_1fr] gap-3">
                    <EditableField label="PLZ" value={ivInvoiceAuthorityPlz} onChange={setIvInvoiceAuthorityPlz} placeholder="8000" tooltip="Adresse der zuständigen IV-Stelle für den Versand des monatlichen Deckblatts." />
                    <EditableField label="Ort" value={ivInvoiceAuthorityCity} onChange={setIvInvoiceAuthorityCity} placeholder="Zürich" />
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t border-border/60 space-y-3">
                  <p className="text-sm font-medium text-foreground">Rückfragen (Fusszeile Rechnung)</p>
                  <p className="text-xs text-muted-foreground">Optional, falls abweichend vom Rechnungssteller.</p>
                  <EditableField label="Name" value={ivInvoiceInquiriesName} onChange={setIvInvoiceInquiriesName} placeholder="Kontaktperson" tooltip="Ansprechperson bei der IV-Stelle für Rückfragen — erscheint als Fussnote auf dem Deckblatt." />
                  <EditableField label="E-Mail" value={ivInvoiceInquiriesEmail} onChange={setIvInvoiceInquiriesEmail} placeholder="mail@…" tooltip="Ansprechperson bei der IV-Stelle für Rückfragen — erscheint als Fussnote auf dem Deckblatt." />
                  <EditableField label="Telefon" value={ivInvoiceInquiriesPhone} onChange={setIvInvoiceInquiriesPhone} placeholder="+41 …" tooltip="Ansprechperson bei der IV-Stelle für Rückfragen — erscheint als Fussnote auf dem Deckblatt." />
                </div>
              </Section>

              <div className="sticky bottom-4 z-10 pb-[env(safe-area-inset-bottom)]">
                <div className="rounded-2xl border bg-background/80 backdrop-blur px-4 py-3 shadow-lg flex items-center justify-between gap-3">
                  <div className="text-xs text-muted-foreground">
                    Änderungen werden erst nach dem Speichern übernommen.
                  </div>
                  <button
                    onClick={saveEmployer}
                    disabled={saving}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 disabled:opacity-50
                      bg-gradient-to-r from-primary to-[hsl(240_70%_55%)] text-white shadow-lg shadow-primary/25 hover:shadow-primary/40 hover:translate-y-[-1px]"
                  >
                    {saving ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" />
                    ) : (
                      <>
                        <Save className="w-4 h-4" />
                        Speichern
                      </>
                    )}
                  </button>
                </div>
              </div>
            </SettingsCard>
          )}
        </div>

      </div>
      )}

      {/* ── Tab: Einstellungen ── */}
      {activeTab === 'einstellungen' && (
      <div className="max-w-xl space-y-6">
        <SettingsCard
          icon={RotateCcw}
          iconColor="text-red-600"
          iconBg="bg-red-500/10"
          title="Entwickler-Optionen"
          description="Onboarding erneut durchlaufen (löscht aktuelle Daten)"
        >
          <p className="text-sm text-muted-foreground">
            Setzt das Onboarding zurück und löscht alle erfassten Daten dieser Instanz. Anschliessend werden Sie abgemeldet.
          </p>
          <button
            onClick={resetOnboarding}
            disabled={resetting}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 disabled:opacity-50
              bg-red-500/10 text-red-600 hover:bg-red-500/20 border border-red-200"
          >
            {resetting ? (
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-red-400/30 border-t-red-500" />
            ) : (
              <>
                <RotateCcw className="w-4 h-4" />
                Onboarding zurücksetzen
              </>
            )}
          </button>
        </SettingsCard>
      </div>
      )}

    </div>
    </div>
  );
}
