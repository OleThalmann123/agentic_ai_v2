/**
 * Agent Tools – LangChain Tool definitions
 * 
 * These are the two core tools from the Agent Canvas:
 * 
 * 1. Document Classification Tool
 *    Validates whether the uploaded document is a relevant employment
 *    contract and provides a classification.
 * 
 * 2. Contract Data Submission Tool
 *    Transfers all extracted contract data in a structured and standardized
 *    format to the backend for storage and further processing.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

// ─── Swiss Reference Data ────────────────────────────────

const SWISS_CANTONS: Record<string, string> = {
  ZH: 'Zürich', BE: 'Bern', LU: 'Luzern', UR: 'Uri', SZ: 'Schwyz',
  OW: 'Obwalden', NW: 'Nidwalden', GL: 'Glarus', ZG: 'Zug', FR: 'Freiburg',
  SO: 'Solothurn', BS: 'Basel-Stadt', BL: 'Basel-Landschaft', SH: 'Schaffhausen',
  AR: 'Appenzell Ausserrhoden', AI: 'Appenzell Innerrhoden', SG: 'St. Gallen',
  GR: 'Graubünden', AG: 'Aargau', TG: 'Thurgau', TI: 'Tessin', VD: 'Waadt',
  VS: 'Wallis', NE: 'Neuenburg', GE: 'Genf', JU: 'Jura',
};

const ZIP_TO_CANTON: Record<string, string> = {
  '1': 'VD', '10': 'VD', '11': 'VD', '12': 'GE', '13': 'VD', '14': 'VD',
  '15': 'FR', '16': 'FR', '17': 'FR', '18': 'VS', '19': 'VS',
  '20': 'VS', '21': 'VS', '22': 'FR', '23': 'FR', '24': 'NE', '25': 'NE',
  '26': 'JU', '27': 'JU', '28': 'BE', '29': 'BE',
  '30': 'BE', '31': 'BE', '32': 'SO', '33': 'BE', '34': 'BE', '35': 'BE',
  '36': 'BE', '37': 'BE', '38': 'BE', '39': 'BE',
  '40': 'SO', '41': 'AG', '42': 'AG', '43': 'SO', '44': 'BL', '45': 'BL',
  '46': 'BS', '47': 'BL', '48': 'SO', '49': 'AG',
  '50': 'AG', '51': 'AG', '52': 'AG', '53': 'AG', '54': 'LU', '55': 'LU',
  '56': 'ZG', '57': 'NW', '58': 'OW', '59': 'NW',
  '60': 'LU', '61': 'LU', '62': 'UR', '63': 'SZ', '64': 'GL', '65': 'SZ',
  '66': 'SZ', '67': 'SZ', '68': 'SZ', '69': 'SZ',
  '70': 'SG', '71': 'SG', '72': 'SG', '73': 'SG', '74': 'TG', '75': 'GR',
  '76': 'GR', '77': 'GR', '78': 'GR',
  '80': 'ZH', '81': 'ZH', '82': 'ZH', '83': 'ZH', '84': 'ZH', '85': 'ZH',
  '86': 'TG', '87': 'TG', '88': 'TG', '89': 'SH',
  '90': 'SG', '91': 'AR', '92': 'AI', '93': 'SG', '94': 'SG', '95': 'SG',
  '96': 'SG', '97': 'AI',
};

// ─── Tool 1: Document Classification ─────────────────────

/**
 * Document Classification Tool
 * 
 * Validates whether the uploaded document is a relevant Swiss employment
 * contract (Arbeitsvertrag für Assistenzbeitrag) and provides a classification.
 * 
 * Checks for key indicators:
 * - Contract-related keywords (Arbeitsvertrag, Anstellungsvertrag, etc.)
 * - Swiss-specific terms (AHV, Assistenzbeitrag, IV, Kantone)
 * - Employment data fields (Lohn, Ferien, Kündigungsfrist)
 * - Parties (Arbeitgeber, Arbeitnehmer/Assistenzperson)
 */
export const documentClassificationTool = tool(
  async ({ documentText, documentType }: { documentText: string; documentType: string }) => {
    const text = documentText.toLowerCase();

    const contractKeywords = [
      'arbeitsvertrag', 'anstellungsvertrag', 'anstellung', 'arbeitsverhältnis',
      'arbeitgeber', 'arbeitnehmer', 'assistenzperson', 'assistenzbeitrag',
    ];
    const swissKeywords = [
      'ahv', 'iv', 'schweiz', 'chf', 'kanton', 'bvg', 'nbu', 'uvg',
      'sozialversicherung', 'quellensteuer', 'fak',
    ];
    const employmentKeywords = [
      'lohn', 'stundenlohn', 'ferien', 'ferienanspruch',
      'kündigungsfrist', 'pensum', 'arbeitszeit', 'iban',
    ];

    const contractScore = contractKeywords.filter((k) => text.includes(k)).length;
    const swissScore = swissKeywords.filter((k) => text.includes(k)).length;
    const employmentScore = employmentKeywords.filter((k) => text.includes(k)).length;

    const totalScore = contractScore + swissScore + employmentScore;
    const maxScore = contractKeywords.length + swissKeywords.length + employmentKeywords.length;
    const confidence = Math.min(totalScore / 8, 1.0);

    let classification: 'swiss_employment_contract' | 'generic_contract' | 'other_document';
    let isRelevant: boolean;

    if (contractScore >= 2 && swissScore >= 1) {
      classification = 'swiss_employment_contract';
      isRelevant = true;
    } else if (contractScore >= 1 || employmentScore >= 3) {
      classification = 'generic_contract';
      isRelevant = true;
    } else {
      classification = 'other_document';
      isRelevant = false;
    }

    const detectedKeywords = [
      ...contractKeywords.filter((k) => text.includes(k)),
      ...swissKeywords.filter((k) => text.includes(k)),
      ...employmentKeywords.filter((k) => text.includes(k)),
    ];

    return JSON.stringify({
      classification,
      is_relevant: isRelevant,
      confidence: Math.round(confidence * 100) / 100,
      document_type: documentType,
      analysis: {
        contract_indicators: contractScore,
        swiss_indicators: swissScore,
        employment_indicators: employmentScore,
        total_score: totalScore,
        max_possible_score: maxScore,
      },
      detected_keywords: detectedKeywords,
      recommendation: isRelevant
        ? 'Document is a relevant employment contract. Proceed with data extraction.'
        : 'Document does not appear to be a Swiss employment contract. Extraction may yield incomplete results.',
    });
  },
  {
    name: 'document_classification',
    description:
      'Validates whether the uploaded document is a relevant Swiss employment contract (Arbeitsvertrag für Assistenzbeitrag) and provides a classification. Analyzes the document text for contract keywords, Swiss-specific terms, and employment data indicators. Returns classification (swiss_employment_contract, generic_contract, other_document), confidence score, and detected keywords.',
    schema: z.object({
      documentText: z.string().describe('The full text content of the uploaded document'),
      documentType: z
        .enum(['pdf_text', 'pdf_scanned', 'image', 'text_file'])
        .describe('The type/format of the source document'),
    }),
  },
);

// ─── Tool 2: Contract Data Submission ────────────────────

/**
 * Contract Data Submission Tool
 * 
 * Transfers all extracted contract data in a structured and standardized
 * format to the backend for storage and further processing.
 * 
 * Performs:
 * - Data validation (AHV format, IBAN format, canton codes, PLZ)
 * - Canton derivation from ZIP code when not explicitly provided
 * - Holiday supplement calculation from vacation weeks
 * - Standardized formatting of all fields
 */
export const contractDataSubmissionTool = tool(
  async ({
    employer,
    assistant,
    contract_terms,
    wage,
    social_insurance,
  }: {
    employer: string;
    assistant: string;
    contract_terms: string;
    wage: string;
    social_insurance: string;
  }) => {
    const validationErrors: string[] = [];
    const corrections: string[] = [];

    // ── Normalize fields: ensure every field is {value, source_text, note} ──
    // The LLM may pass flat values ("first_name": "Sara") instead of objects
    // ("first_name": {"value": "Sara", "source_text": "...", "note": ""}).
    // Without normalization, flat values are invisible to mergeWithJudgeResult.
    const normalizeField = (field: unknown): { value: any; source_text: string; note: string } => {
      if (field && typeof field === 'object' && 'value' in (field as any)) {
        const f = field as any;
        return {
          value: f.value ?? null,
          source_text: String(f.source_text ?? ''),
          note: String(f.note ?? ''),
        };
      }
      return { value: field ?? null, source_text: '', note: '' };
    };

    const normalizeSection = (data: Record<string, any>): Record<string, any> => {
      const result: Record<string, any> = {};
      for (const [key, val] of Object.entries(data)) {
        result[key] = normalizeField(val);
      }
      return result;
    };

    const ibanMod97 = (iban: string): number => {
      // ISO 13616: move first 4 chars to end, letters -> numbers (A=10..Z=35), mod 97 iteratively
      const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
      let remainder = 0;
      for (const ch of rearranged) {
        const code = ch.charCodeAt(0);
        if (code >= 48 && code <= 57) {
          remainder = (remainder * 10 + (code - 48)) % 97;
          continue;
        }
        if (code >= 65 && code <= 90) {
          const value = code - 55; // 'A' -> 10
          remainder = (remainder * 10 + Math.floor(value / 10)) % 97;
          remainder = (remainder * 10 + (value % 10)) % 97;
          continue;
        }
        // invalid char
        return -1;
      }
      return remainder;
    };

    const isValidIban = (iban: string): boolean => {
      if (!/^[A-Z0-9]+$/.test(iban)) return false;
      if (iban.length < 5) return false;
      return ibanMod97(iban) === 1;
    };

    const normalizeAhv = (raw: unknown): { digits: string; formatted: string | null } => {
      // Tolerate Swiss separators (., spaces, -) and OCR artifacts (commas, etc.)
      const digits = String(raw ?? '').replace(/[^\d]/g, '');
      if (!/^756\d{10}$/.test(digits)) return { digits, formatted: null };
      const formatted = `${digits.slice(0, 3)}.${digits.slice(3, 7)}.${digits.slice(7, 11)}.${digits.slice(11)}`;
      return { digits, formatted };
    };

    const normalizeIban = (raw: unknown): { cleaned: string; formatted: string | null } => {
      const cleaned = String(raw ?? '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, ''); // tolerate spaces, punctuation

      // We currently only support CH/LI.
      if (!/^(CH|LI)/.test(cleaned)) return { cleaned, formatted: null };

      // Per SWIFT IBAN Registry, CH/LI IBAN format is: 2 check digits + 5 numeric
      // bank code + 12 ALPHANUMERIC account characters. Letters in the account
      // portion are legal and MUST NOT be "OCR-corrected" to digits — doing so
      // either destroys correct IBANs or turns wrong ones into fake-valid ones.
      if (!/^(CH|LI)\d{7}[0-9A-Z]{12}$/.test(cleaned)) return { cleaned, formatted: null };
      if (!isValidIban(cleaned)) return { cleaned, formatted: null };

      const formatted = cleaned.match(/.{1,4}/g)?.join(' ') ?? cleaned;
      return { cleaned, formatted };
    };

    let employerData: Record<string, any>;
    let assistantData: Record<string, any>;
    let contractData: Record<string, any>;
    let wageData: Record<string, any>;
    let insuranceData: Record<string, any>;

    try {
      employerData = normalizeSection(JSON.parse(employer));
      assistantData = normalizeSection(JSON.parse(assistant));
      contractData = normalizeSection(JSON.parse(contract_terms));
      delete contractData.hours_per_month;
      wageData = normalizeSection(JSON.parse(wage));
      insuranceData = normalizeSection(JSON.parse(social_insurance));
    } catch {
      return JSON.stringify({
        status: 'error',
        message: 'Invalid JSON in one or more data sections. All sections must be valid JSON strings.',
      });
    }

    // ═══════════════════════════════════════════════════════════
    // Ebene 1: Basis-Normalisierung für ALLE Text-Felder
    //   - Trim (Leerzeichen vorne/hinten)
    //   - Doppelte Leerzeichen entfernen
    //   - ß → ss (Schweiz verwendet kein Eszett)
    // ═══════════════════════════════════════════════════════════
    const cleanText = (val: unknown): string | null => {
      if (val == null) return null;
      const s = String(val);
      if (!s.trim()) return null;
      return s
        .trim()
        .replace(/\s{2,}/g, ' ')   // Doppelte Leerzeichen
        .replace(/ß/g, 'ss');       // Eszett → ss (Schweiz)
    };

    for (const section of [employerData, assistantData, contractData, wageData, insuranceData]) {
      for (const [key, field] of Object.entries(section)) {
        if (field?.value != null && typeof field.value === 'string') {
          const cleaned = cleanText(field.value);
          if (cleaned !== null && cleaned !== field.value) {
            field.value = cleaned;
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════
    // Ebene 2: Namen & Orte – Erster Buchstabe gross
    //   Respektiert: Bindestriche (Meier-Müller), Partikel (von, de)
    // ═══════════════════════════════════════════════════════════
    const LOWERCASE_PARTICLES = new Set(['von', 'van', 'de', 'del', 'di', 'da', 'le', 'la', 'el', 'al']);

    const capitalizeWord = (word: string): string => {
      if (word.length === 0) return word;
      // Bindestriche: "meier-müller" → "Meier-Müller"
      if (word.includes('-')) {
        return word.split('-').map(capitalizeWord).join('-');
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    };

    const capitalizeName = (val: unknown): string | null => {
      if (val == null) return null;
      const s = String(val).trim();
      if (!s) return null;
      const words = s.split(' ');
      return words.map((w, i) => {
        // Partikel (von, de, etc.) bleiben klein, ausser am Anfang
        if (i > 0 && LOWERCASE_PARTICLES.has(w.toLowerCase())) {
          return w.toLowerCase();
        }
        return capitalizeWord(w);
      }).join(' ');
    };

    const nameFields: Array<[Record<string, any>, string]> = [
      [employerData, 'first_name'],
      [employerData, 'last_name'],
      [employerData, 'city'],
      [assistantData, 'first_name'],
      [assistantData, 'last_name'],
      [assistantData, 'city'],
    ];

    for (const [section, field] of nameFields) {
      if (section[field]?.value) {
        const capitalized = capitalizeName(section[field].value);
        if (capitalized && capitalized !== section[field].value) {
          corrections.push(`${field} Gross-/Kleinschreibung: ${section[field].value} → ${capitalized}`);
          section[field].value = capitalized;
        }
      }
    }

    // ═══════════════════════════════════════════════════════════
    // Ebene 3: Feld-spezifische Normalisierungen
    // ═══════════════════════════════════════════════════════════

    // ── Street: "Str." → "Strasse", Leerzeichen vor Hausnummer ──
    for (const section of [employerData, assistantData]) {
      if (section.street?.value) {
        let street = String(section.street.value);
        const original = street;

        // "Str." / "str." → "Strasse" / "strasse"
        street = street.replace(/\bStr\.\s*/gi, 'Strasse ');
        street = street.replace(/\bstrasse\b/gi, 'strasse');
        // Capitalize: "strasse" → "Strasse" (nur wenn es am Wortende steht)
        street = street.replace(/strasse\b/g, 'strasse');
        street = street.replace(/(?:^|\s)([a-zäöü])/g, (_m, c) => _m.replace(c, c.toUpperCase()));

        // Leerzeichen vor Hausnummer sicherstellen: "Lindenweg5" → "Lindenweg 5"
        street = street.replace(/([a-zäöüA-ZÄÖÜ])(\d)/, '$1 $2');

        // Doppelte Leerzeichen aufräumen
        street = street.replace(/\s{2,}/g, ' ').trim();

        if (street !== original) {
          corrections.push(`Strasse normalisiert: ${original} → ${street}`);
          section.street.value = street;
        }
      }
    }

    // ── Email: lowercase ──
    if (assistantData.email?.value) {
      const lower = String(assistantData.email.value).trim().toLowerCase();
      if (lower !== assistantData.email.value) {
        corrections.push(`E-Mail lowercase: ${assistantData.email.value} → ${lower}`);
        assistantData.email.value = lower;
      }
    }

    // ── Phone: Internationale Normalisierung (E.164-kompatibel) ──
    // Akzeptiert CH (+41), DE (+49), AT (+43), IT (+39), FR (+33), etc.
    if (assistantData.phone?.value) {
      let phone = String(assistantData.phone.value).trim();
      const original = phone;

      // Doppelte Null am Anfang (00xx) → +xx (internationale Vorwahl)
      phone = phone.replace(/^00(\d)/, '+$1');

      // Schweizer Lokalnummern ohne Vorwahl: "079 123 45 67" → "+41 79 123 45 67"
      phone = phone.replace(/^0(\d{2})\s?/, '+41 $1 ');

      // Trennzeichen vereinheitlichen: Punkte, Bindestriche, Klammern → Leerzeichen
      phone = phone.replace(/[()]/g, '');
      phone = phone.replace(/[\s.\-/]+/g, ' ').trim();

      if (phone !== original) {
        corrections.push(`Telefon normalisiert: ${original} → ${phone}`);
        assistantData.phone.value = phone;
      }
    }

    // ── NBU insurer name & policy number: Trim (Ebene 1 hat es schon gemacht, hier Sicherheit) ──
    // (already handled by Ebene 1 cleanText)

    // Map country names / ISO-3 codes to ISO-2. Must stay in sync with the
    // COUNTRY_OPTIONS list in AssistantOnboarding.tsx, otherwise the frontend
    // dropdown falls back to "OTHER" and the user loses the value.
    const COUNTRY_TO_ISO2: Record<string, string> = {
      CH: 'CH', CHE: 'CH', SCHWEIZ: 'CH', SWITZERLAND: 'CH', SUISSE: 'CH', SVIZZERA: 'CH',
      DE: 'DE', DEU: 'DE', DEUTSCHLAND: 'DE', GERMANY: 'DE', ALLEMAGNE: 'DE',
      AT: 'AT', AUT: 'AT', ÖSTERREICH: 'AT', OESTERREICH: 'AT', AUSTRIA: 'AT',
      IT: 'IT', ITA: 'IT', ITALIEN: 'IT', ITALY: 'IT', ITALIA: 'IT',
      FR: 'FR', FRA: 'FR', FRANKREICH: 'FR', FRANCE: 'FR',
      LI: 'LI', LIE: 'LI', LIECHTENSTEIN: 'LI',
    };
    const normalizeCountry = (v: unknown): string => {
      if (v === null || v === undefined) return '';
      return String(v).trim().toUpperCase();
    };
    const toIso2Country = (v: unknown): string | null => {
      const key = normalizeCountry(v);
      if (!key) return null;
      return COUNTRY_TO_ISO2[key] ?? null;
    };
    const isSwissCountry = (countryValue: unknown): boolean => {
      const c = normalizeCountry(countryValue);
      if (!c) return true; // default: assume CH if unknown
      return toIso2Country(countryValue) === 'CH';
    };

    // Validate assistant phone (soft) – accepts international formats
    // Valid: +41 79 123 45 67, +49 170 1234567, +33 6 12 34 56 78, etc.
    if (assistantData.phone?.value) {
      const phone = String(assistantData.phone.value).trim();
      if (!/^\+\d{1,3}\s?\d[\d\s]{5,}$/.test(phone)) {
        validationErrors.push('Telefonnummer-Format auffällig (erwartet: +Ländervorwahl gefolgt von Nummer, z.B. +41 79 123 45 67 oder +49 170 1234567)');
      }
    }

    // Validate assistant email (soft)
    if (assistantData.email?.value) {
      const email = String(assistantData.email.value).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        validationErrors.push('E-Mail-Format ungültig');
      }
    }

    // Normalise assistant country to ISO-2 (matches the frontend dropdown).
    if (assistantData.country?.value) {
      const iso2 = toIso2Country(assistantData.country.value);
      if (!iso2) {
        validationErrors.push(`Land nicht erkannt: ${assistantData.country.value}`);
      } else if (assistantData.country.value !== iso2) {
        corrections.push(`Land normalisiert: ${assistantData.country.value} → ${iso2}`);
        assistantData.country.value = iso2;
      }
    }

    // Normalise assistant gender to English enum (male|female|diverse).
    if (assistantData.gender?.value) {
      const raw = String(assistantData.gender.value).trim().toLowerCase();
      const genderMap: Record<string, 'male' | 'female' | 'diverse'> = {
        male: 'male', female: 'female', diverse: 'diverse',
        männlich: 'male', maennlich: 'male', mann: 'male', m: 'male',
        weiblich: 'female', frau: 'female', w: 'female', f: 'female',
        divers: 'diverse', d: 'diverse',
      };
      const norm = genderMap[raw];
      if (!norm) {
        validationErrors.push('Geschlecht nicht erkannt (erwartet: male|female|diverse)');
      } else if (assistantData.gender.value !== norm) {
        corrections.push(`Geschlecht normalisiert: ${assistantData.gender.value} → ${norm}`);
        assistantData.gender.value = norm;
      }
    }

    // Normalise civil_status to the exact casing used by the frontend
    // dropdown in AssistantOnboarding.tsx (otherwise the <select> would not
    // match the extracted value and render as empty).
    if (assistantData.civil_status?.value) {
      const raw = String(assistantData.civil_status.value).trim().toLowerCase();
      const civilMap: Record<string, string> = {
        ledig: 'ledig', single: 'ledig', unmarried: 'ledig',
        verheiratet: 'verheiratet', married: 'verheiratet',
        geschieden: 'geschieden', divorced: 'geschieden',
        verwitwet: 'verwitwet', widowed: 'verwitwet',
        'eingetragene partnerschaft': 'eingetragene Partnerschaft',
        'registered partnership': 'eingetragene Partnerschaft',
      };
      const norm = civilMap[raw];
      if (!norm) {
        validationErrors.push(`Zivilstand nicht erkannt: ${assistantData.civil_status.value}`);
      } else if (assistantData.civil_status.value !== norm) {
        corrections.push(`Zivilstand normalisiert: ${assistantData.civil_status.value} → ${norm}`);
        assistantData.civil_status.value = norm;
      }
    }

    // Normalise residence_permit to ISO enum shared with the frontend dropdown.
    if (assistantData.residence_permit?.value) {
      const raw = String(assistantData.residence_permit.value).trim().toUpperCase();
      const allowed = new Set(['CH', 'C', 'B', 'G', 'L', 'N', 'F']);
      if (!allowed.has(raw)) {
        validationErrors.push(`Aufenthaltsstatus nicht erkannt: ${assistantData.residence_permit.value}`);
      } else if (assistantData.residence_permit.value !== raw) {
        corrections.push(`Aufenthaltsstatus normalisiert: ${assistantData.residence_permit.value} → ${raw}`);
        assistantData.residence_permit.value = raw;
      }
    }

    // Validate accounting method (only ordinary supported)
    if (insuranceData.accounting_method?.value) {
      const m = String(insuranceData.accounting_method.value).trim().toLowerCase();
      const allowed = new Set(['ordinary']);
      if (!allowed.has(m)) {
        validationErrors.push(`Unknown accounting_method: ${insuranceData.accounting_method.value}`);
      }
      if (insuranceData.accounting_method.value !== m) {
        corrections.push(`Accounting method standardized: ${insuranceData.accounting_method.value} → ${m}`);
        insuranceData.accounting_method.value = m;
      }
    }

    // Validate AHV number (format + EAN-13 check digit per AHVG Art. 50c)
    if (assistantData.ahv_number?.value) {
      const { digits, formatted } = normalizeAhv(assistantData.ahv_number.value);
      if (!formatted) {
        validationErrors.push('AHV-Nummer ungültig (erwartet 13 Ziffern, beginnt mit 756; z.B. 756.XXXX.XXXX.XX)');
      } else {
        if (assistantData.ahv_number.value !== formatted) {
          corrections.push(`AHV-Nummer normalisiert: ${assistantData.ahv_number.value} → ${formatted}`);
          assistantData.ahv_number.value = formatted;
        }
        // EAN-13 / GS1 check digit validation (weighting 1-3-1-3-…, mod 10)
        let ean13sum = 0;
        for (let i = 0; i < 12; i++) {
          ean13sum += parseInt(digits.charAt(i)) * (i % 2 === 0 ? 1 : 3);
        }
        const expectedCheck = (10 - (ean13sum % 10)) % 10;
        const actualCheck = parseInt(digits.charAt(12));
        if (expectedCheck !== actualCheck) {
          validationErrors.push(
            `AHV-Prüfziffer ungültig (EAN-13): erwartet ${expectedCheck}, gefunden ${actualCheck} – möglicherweise Tipp-/OCR-Fehler`,
          );
        }
      }
    }

    // Guard against hallucinated payment_iban: require non-empty source_text.
    // Same pattern as vacation_weeks below — if the LLM produced a value but
    // couldn't quote the contract, we treat it as a hallucination.
    if (wageData.payment_iban?.value) {
      const src = String(wageData.payment_iban.source_text ?? '').trim();
      if (!src) {
        corrections.push(
          `payment_iban (${wageData.payment_iban.value}) hat keinen source_text – wahrscheinlich nicht im Vertrag vorhanden. Wert auf null gesetzt.`,
        );
        wageData.payment_iban.value = null;
        wageData.payment_iban.note = 'Nicht im Vertrag gefunden (kein source_text vorhanden)';
      }
    }

    // Validate IBAN
    if (wageData.payment_iban?.value) {
      const { formatted } = normalizeIban(wageData.payment_iban.value);
      if (!formatted) {
        validationErrors.push(
          'IBAN ungültig (erwartet CH/LI: 2 Prüfziffern + 5 Ziffern Bank + 12 alphanumerische Zeichen; Trennzeichen wie Leerzeichen/Punkte sind ok)',
        );
      } else if (wageData.payment_iban.value !== formatted) {
        corrections.push(`IBAN normalisiert: ${wageData.payment_iban.value} → ${formatted}`);
        wageData.payment_iban.value = formatted;
      }
    }

    // Semantic sanity: the source_text must literally contain the IBAN.
    // Otherwise the LLM quoted something else and is probably hallucinating.
    if (wageData.payment_iban?.value) {
      const srcAlnum = String(wageData.payment_iban.source_text ?? '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
      const valAlnum = String(wageData.payment_iban.value)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
      if (valAlnum && !srcAlnum.includes(valAlnum)) {
        validationErrors.push(
          'IBAN source_text enthält den extrahierten Wert nicht – möglicher Halluzinationshinweis.',
        );
      }
    }

    // Validate and standardize canton
    if (insuranceData.canton?.value) {
      const upper = String(insuranceData.canton.value).toUpperCase().trim();
      if (!(upper in SWISS_CANTONS)) {
        validationErrors.push(`Unknown canton code: ${insuranceData.canton.value}`);
      } else if (insuranceData.canton.value !== upper) {
        corrections.push(`Canton standardized: ${insuranceData.canton.value} → ${upper}`);
        insuranceData.canton.value = upper;
      }
    }

    // Derive canton from assistant's ZIP only — never from employer ZIP to avoid
    // assigning the disabled person's canton to the assistant's residence record.
    if (!insuranceData.canton?.value && assistantData.zip?.value) {
      const zip = String(assistantData.zip.value);
      const prefix2 = zip.substring(0, 2);
      const prefix1 = zip.substring(0, 1);
      const derivedCanton = ZIP_TO_CANTON[prefix2] || ZIP_TO_CANTON[prefix1];
      if (derivedCanton) {
        corrections.push(
          `Wohnsitzkanton der Assistenzperson abgeleitet aus PLZ ${zip} → ${derivedCanton} (${SWISS_CANTONS[derivedCanton]}). ` +
          `Hinweis: Ableitung basiert auf PLZ-Prefix – bitte prüfen, ob Kanton korrekt ist.`,
        );
        if (!insuranceData.canton) insuranceData.canton = {};
        insuranceData.canton.value = derivedCanton;
        insuranceData.canton.note = `Abgeleitet aus PLZ ${zip} der Assistenzperson (Prefix-basiert, bitte prüfen)`;
      } else {
        validationErrors.push(
          `Wohnsitzkanton konnte nicht aus PLZ ${zip} der Assistenzperson abgeleitet werden – bitte manuell eingeben.`,
        );
      }
    } else if (!insuranceData.canton?.value && !assistantData.zip?.value) {
      validationErrors.push(
        `Wohnsitzkanton nicht ableitbar: PLZ der Assistenzperson fehlt im Vertrag – bitte manuell eingeben.`,
      );
    }

    // Guard against hallucinated vacation_weeks: require non-empty source_text
    if (wageData.vacation_weeks?.value != null) {
      const src = String(wageData.vacation_weeks.source_text ?? '').trim();
      if (!src) {
        corrections.push(
          `vacation_weeks (${wageData.vacation_weeks.value}) hat keinen source_text – wahrscheinlich nicht im Vertrag vorhanden. Wert auf null gesetzt.`,
        );
        wageData.vacation_weeks.value = null;
        wageData.vacation_weeks.note = 'Nicht im Vertrag gefunden (kein source_text vorhanden)';
      }
    }

    // Calculate holiday supplement from vacation weeks if missing
    if (!wageData.holiday_supplement_pct?.value && wageData.vacation_weeks?.value) {
      const weeks = Number(wageData.vacation_weeks.value);
      const supplementMap: Record<number, number> = { 4: 0.0833, 5: 0.1064, 6: 0.1304, 7: 0.1556 };
      const supplement = supplementMap[weeks];
      if (supplement) {
        corrections.push(`Holiday supplement derived from ${weeks} weeks: ${(supplement * 100).toFixed(2)}%`);
        if (!wageData.holiday_supplement_pct) wageData.holiday_supplement_pct = {};
        wageData.holiday_supplement_pct.value = supplement;
        wageData.holiday_supplement_pct.note = `Berechnet aus ${weeks} Ferienwochen`;
      }
    }

    // Validate Nichtberufsunfallversicherung split: employer_pct + employee_pct must equal 100%.
    // Kein Auto-Default mehr: Wenn die Aufteilung im Vertrag fehlt, trägt der
    // Arbeitgeber sie manuell im Onboarding-Formular ein. Der Freiwillig-Flag
    // ("AG übernimmt NBU freiwillig auch unter 8h/Woche") verändert die
    // Aufteilung nicht mehr automatisch.
    if (insuranceData.nbu_total_rate_pct?.value != null) {
      const total = Number(insuranceData.nbu_total_rate_pct.value);
      const empPct = Number(insuranceData.nbu_employee_pct?.value ?? 0);
      const agPct = Number(insuranceData.nbu_employer_pct?.value ?? 0);

      if (total > 0 && empPct + agPct > 0 && Math.abs(empPct + agPct - 100) > 0.1) {
        validationErrors.push(
          `Nichtberufsunfallversicherungs-Aufteilung stimmt nicht: AN (${empPct}%) + AG (${agPct}%) = ${empPct + agPct}% ≠ 100%`,
        );
      }
    }

    // Validate PLZ
    for (const [label, data] of [['Employer', employerData], ['Assistant', assistantData]] as const) {
      if (data.zip?.value) {
        if (label === 'Assistant' && !isSwissCountry(assistantData.country?.value)) {
          continue;
        }
        const plz = String(data.zip.value).trim();
        const num = parseInt(plz, 10);
        if (plz.length !== 4 || isNaN(num) || num < 1000 || num > 9699) {
          validationErrors.push(`${label} PLZ invalid: ${plz} (expected: 4 digits, 1000-9699)`);
        }
      }
    }

    // ── Date normalization: CH (DD.MM.YYYY) → ISO 8601 (YYYY-MM-DD) ──
    const normalizeDateToISO = (val: unknown): string | null => {
      if (val == null) return null;
      const s = String(val).trim();
      // Already ISO 8601?
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      // Swiss format DD.MM.YYYY
      const match = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (match && match[1] && match[2] && match[3]) {
        return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
      }
      return null;
    };

    for (const [label, section, field] of [
      ['Geburtsdatum', assistantData, 'birth_date'],
      ['Vertragsbeginn', contractData, 'start_date'],
      ['Vertragsende', contractData, 'end_date'],
    ] as const) {
      if (section[field]?.value) {
        const iso = normalizeDateToISO(section[field].value);
        if (iso && section[field].value !== iso) {
          corrections.push(`${label} normalisiert (ISO 8601): ${section[field].value} → ${iso}`);
          section[field].value = iso;
        } else if (!iso) {
          validationErrors.push(`${label}: Datumsformat nicht erkannt: ${section[field].value} (erwartet: DD.MM.YYYY oder YYYY-MM-DD)`);
        }
      }
    }

    // ── Birth date plausibility ──
    if (assistantData.birth_date?.value) {
      const bd = new Date(assistantData.birth_date.value);
      const now = new Date();
      if (!isNaN(bd.getTime())) {
        if (bd > now) {
          validationErrors.push(`Geburtsdatum liegt in der Zukunft: ${assistantData.birth_date.value}`);
        } else if (bd.getFullYear() < 1900) {
          validationErrors.push(`Geburtsdatum vor 1900 – wahrscheinlich fehlerhaft: ${assistantData.birth_date.value}`);
        }
      }
    }

    // ── Cross-check: end_date > start_date ──
    if (contractData.start_date?.value && contractData.end_date?.value) {
      const start = new Date(contractData.start_date.value);
      const end = new Date(contractData.end_date.value);
      if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && end <= start) {
        validationErrors.push(
          `Vertragsende (${contractData.end_date.value}) liegt vor oder auf dem Vertragsbeginn (${contractData.start_date.value})`,
        );
      }
    }

    // ── Value range checks ──
    if (contractData.hours_per_week?.value != null) {
      const hours = Number(contractData.hours_per_week.value);
      if (isNaN(hours) || hours <= 0) {
        validationErrors.push(`hours_per_week ungültig: ${contractData.hours_per_week.value} (muss > 0 sein)`);
      } else if (hours > 50) {
        validationErrors.push(`hours_per_week = ${hours} übersteigt gesetzliches Maximum (50h/Woche)`);
      }
    }

    if (wageData.hourly_rate?.value != null) {
      const rate = Number(wageData.hourly_rate.value);
      if (isNaN(rate) || rate <= 0) {
        validationErrors.push(`hourly_rate ungültig: ${wageData.hourly_rate.value} (muss > 0 sein)`);
      } else if (rate < 15) {
        validationErrors.push(`hourly_rate = ${rate} CHF liegt unter üblichem Minimum (15 CHF)`);
      } else if (rate > 150) {
        validationErrors.push(`hourly_rate = ${rate} CHF ungewöhnlich hoch (> 150 CHF)`);
      }
    }

    if (contractData.notice_period_days?.value != null) {
      const days = Number(contractData.notice_period_days.value);
      if (isNaN(days) || days <= 0) {
        validationErrors.push(`notice_period_days ungültig: ${contractData.notice_period_days.value}`);
      } else if (days > 180) {
        validationErrors.push(`notice_period_days = ${days} ungewöhnlich lang (> 180 Tage)`);
      }
    }

    // ── Required field checks ──
    const requiredFields: Array<[string, Record<string, any>, string]> = [
      ['Arbeitgeber Vorname', employerData, 'first_name'],
      ['Arbeitgeber Nachname', employerData, 'last_name'],
      ['Assistenzperson Vorname', assistantData, 'first_name'],
      ['Assistenzperson Nachname', assistantData, 'last_name'],
      ['Vertragsbeginn', contractData, 'start_date'],
      ['Stundenlohn', wageData, 'hourly_rate'],
    ];
    for (const [label, section, field] of requiredFields) {
      if (!section[field]?.value) {
        validationErrors.push(`Pflichtfeld fehlt: ${label}`);
      }
    }

    // ── Enum validation: wage_type ──
    if (wageData.wage_type?.value) {
      const wt = String(wageData.wage_type.value).trim().toLowerCase();
      if (wt !== 'hourly') {
        validationErrors.push(`wage_type '${wageData.wage_type.value}' nicht unterstützt (erwartet: hourly)`);
      } else if (wageData.wage_type.value !== wt) {
        corrections.push(`wage_type normalisiert: ${wageData.wage_type.value} → ${wt}`);
        wageData.wage_type.value = wt;
      }
    }

    const submissionPayload = {
      employer: employerData,
      assistant: assistantData,
      contract_terms: contractData,
      wage: wageData,
      social_insurance: insuranceData,
    };

    return JSON.stringify({
      status: validationErrors.length === 0 ? 'success' : 'warning',
      message: validationErrors.length === 0
        ? 'All contract data validated and ready for submission to backend.'
        : `Data has ${validationErrors.length} validation issue(s). Review recommended.`,
      validation_errors: validationErrors,
      corrections_applied: corrections,
      data: submissionPayload,
      field_count: Object.values(submissionPayload).reduce(
        (sum, section) => sum + Object.keys(section).length, 0,
      ),
    });
  },
  {
    name: 'contract_data_submission',
    description:
      'Transfers all extracted contract data in a structured and standardized format to the backend for storage and further processing. Validates Swiss-specific formats (AHV numbers, IBANs, canton codes, PLZ), derives missing fields (canton from ZIP, holiday supplement from vacation weeks), and returns the validated payload. Pass each section as a JSON string.',
    schema: z.object({
      employer: z.string().describe('JSON string with employer fields: {first_name, last_name, street, zip, city}'),
      assistant: z.string().describe('JSON string with assistant fields: {first_name, last_name, street, zip, city, country, phone, email, birth_date, gender, ahv_number, civil_status, residence_permit}'),
      contract_terms: z.string().describe('JSON string with contract fields: {start_date, end_date, is_indefinite, hours_per_week, notice_period_days}'),
      wage: z.string().describe('JSON string with wage fields: {wage_type, hourly_rate, vacation_weeks, holiday_supplement_pct, payment_iban}'),
      social_insurance: z.string().describe('JSON string with insurance fields: {accounting_method, canton, nbu_total_rate_pct, nbu_employer_pct, nbu_employee_pct, nbu_employer_voluntary, nbu_insurer_name, nbu_policy_number}'),
    }),
  },
);

// ─── Export ──────────────────────────────────────────────

// Asklepios Classifier (Agent 1) handles document classification via LLM now.
// The Extractor (Agent 2) only needs the data submission tool for validation/normalization.
export const agentTools = [contractDataSubmissionTool];
