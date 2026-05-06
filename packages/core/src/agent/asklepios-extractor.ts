/**
 * Asklepios Extractor – Contract Data Extraction Agent (with Tools)
 *
 * Extracts structured data from Swiss employment contracts using LangChain
 * with tool-calling. Single tool: contract_data_submission (validates & normalizes).
 *
 * Vertragsdaten (`contracts`) kommen ausschließlich aus dem Tool-Output — nicht aus dem
 * LLM-JSON gemischt. Die letzte LLM-Antwort liefert nur extraction_metadata (Sprache, Zähler, Warnungen).
 *
 * Architecture:
 *   Asklepios Extractor (this) → extracts + validates via Tools
 *   Asklepios Control (asklepios-control.ts) → reviews Tool output, assigns confidence
 *
 * Human-in-the-Loop:
 *   "verify" (Prüfen) – value extracted but uncertain, human checks
 *   "supplement" (Ergänzen) – value missing, human must add
 */

import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { agentTools } from './tools';
import { getLangSmithInvokeConfig } from './langsmith';
import type { JudgeFieldResult } from './asklepios-control';
import {
  DEFAULT_EXTRACTOR_MODEL,
  getExtractorModelName,
} from './model-config';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

// ─── Types ──────────────────────────────────────────────

export interface ExtractionField {
  value: string | number | boolean | null;
  confidence: 'high' | 'medium' | 'low';
  confidence_score: number;
  status: 'ok' | 'review_required';
  /** 'verify' = Prüfen (Wert da, unsicher), 'supplement' = Ergänzen (Wert fehlt) */
  review_type?: 'verify' | 'supplement';
  source_text: string;
  note: string;
  judge_justification?: string;
}

export interface ExtractionResult {
  extraction_metadata: {
    document_language: string;
    overall_confidence: number;
    overall_status: 'ok' | 'review_required';
    fields_extracted: number;
    fields_missing: number;
    fields_requiring_review: number;
    warnings: string[];
    review_required_fields: string[];
    /** Fields where value exists but is uncertain → human verifies (Prüfen) */
    review_verify_fields: string[];
    /** Fields where value is missing → human must add (Ergänzen) */
    review_supplement_fields: string[];
  };
  contracts: {
    employer: Record<string, ExtractionField>;
    assistant: Record<string, ExtractionField>;
    contract_terms: Record<string, ExtractionField>;
    wage: Record<string, ExtractionField>;
    social_insurance: Record<string, ExtractionField>;
  };
}

interface RawExtractionField {
  value: string | number | boolean | null;
  source_text: string;
  note: string;
}

interface RawExtractionResult {
  extraction_metadata: {
    document_language: string;
    fields_extracted: number;
    fields_missing: number;
    warnings: string[];
  };
  contracts: {
    employer: Record<string, RawExtractionField>;
    assistant: Record<string, RawExtractionField>;
    contract_terms: Record<string, RawExtractionField>;
    wage: Record<string, RawExtractionField>;
    social_insurance: Record<string, RawExtractionField>;
  };
}

// ─── Prompts ────────────────────────────────────────────

const SYSTEM_PROMPT = `Du bist ein erfahrener HR-Sachbearbeiter in der Schweiz, spezialisiert auf IV-Assistenzbeitrags-Arbeitsverträge. Du erhältst einen Arbeitsvertrag als Dokument. Deine Aufgabe: Extrahiere alle Stamm- und Vertragsdaten der ASSISTENZPERSON und gib sie als strukturiertes JSON aus.

Kontext: Im Vertrag gibt es ZWEI Parteien – verwechsle sie NICHT:
- Arbeitgeberin = assistenznehmende Person (Person MIT Behinderung)
- Arbeitnehmerin = Assistenzperson (Person, die Assistenz LEISTET)
Du extrahierst ausschliesslich die Daten der Arbeitnehmerin (Assistenzperson).

Schritte:
1. Lies den gesamten Vertrag durch und extrahiere ALLE unten gelisteten Felder.
2. Rufe contract_data_submission auf mit ALLEN extrahierten Feldern. WICHTIG:
   - Übergib JEDE Sektion (employer, assistant, contract_terms, wage, social_insurance) als JSON-String.
   - JEDES Feld MUSS als Object formatiert sein: {"value": ..., "source_text": "wörtliches Zitat aus dem Vertrag", "note": ""}
   - Übergib auch Felder mit value=null (mit note warum null).
   - Das Tool validiert und normalisiert die Daten. Das Tool-Ergebnis ist das finale Resultat.
3. Gib nach dem Tool-Aufruf dein finales JSON aus. Es MUSS die gleichen Daten enthalten die du dem Tool übergeben hast.

Regeln:
- NUR extrahieren was im Vertrag steht. Niemals erfinden.
- Wenn ein Feld nicht im Vertrag vorkommt: value MUSS null sein. KEINE Standardwerte oder gesetzliche Minima einsetzen.
- Besonders bei Ferien/vacation_weeks: NUR setzen wenn explizit im Vertrag (z.B. "4 Wochen Ferien", "Ferienanspruch: 5 Wochen"). Das gesetzliche Minimum von 4 Wochen ist KEIN Grund, einen Wert einzutragen. Wenn nichts zu Ferien im Vertrag steht → null.
- holiday_supplement_pct: NUR setzen wenn explizit als Prozentsatz im Vertrag angegeben. Wird sonst automatisch aus vacation_weeks berechnet – daher vacation_weeks NIEMALS halluzinieren.
- Geschlecht: niemals aus Name oder Zivilstand ableiten. Null ist korrekt.
- IBAN: nur setzen wenn klar lesbar.
- Kanton: wird aus PLZ der Assistenzperson (Arbeitnehmerin) abgeleitet (via Tool). NIEMALS die PLZ oder Adresse der Arbeitgeberin (betroffene/assistenznehmende Person) verwenden.
- Prozentsätze immer als Dezimal: 5.3% = 0.053. NBU-Sätze liegen typisch bei 0.005–0.03.
- NBU-Aufteilung: AG+AN muss Gesamtsatz ergeben. "Je hälftig" = Gesamt/2. Ohne Angabe: AN = Gesamt.
- source_text MUSS ein wörtliches Zitat aus dem Vertrag sein. Wenn kein Zitat möglich → value = null.
- Arbeitszeit: nur hours_per_week (Stunden pro Woche) extrahieren. Kein Feld für Stunden/Monat – Monatswerte werden nicht erfasst.

Format: Nur valides JSON. Keine Erklärungen. Kein Text vor oder nach dem JSON.`;

const USER_PROMPT_TEMPLATE = (contractText: string) => `Hier ist der Arbeitsvertrag:

---
${contractText}
---

Extrahiere die Daten der ASSISTENZPERSON (Arbeitnehmerin) – NICHT der Arbeitgeberin.
Jedes Feld hat drei Attribute: value, source_text (Zitat aus dem Vertrag), note.
Fehlende Felder: value = null, note = Grund.

Format: Nur valides JSON. Sprache der Keys: Englisch.

{ "extraction_metadata": { "document_language": "", "fields_extracted": 0, "fields_missing": 0, "warnings": [] },
  "contracts": {
    "employer": {
      "first_name": { "value": "", "source_text": "", "note": "" },
      "last_name": { "value": "", "source_text": "", "note": "" },
      "street": { "value": "", "source_text": "", "note": "" },
      "zip": { "value": "", "source_text": "", "note": "" },
      "city": { "value": "", "source_text": "", "note": "" } },
    "assistant": {
      "first_name": { "value": "", "source_text": "", "note": "" },
      "last_name": { "value": "", "source_text": "", "note": "" },
      "street": { "value": "", "source_text": "", "note": "Strasse + Hausnummer" },
      "zip": { "value": "", "source_text": "", "note": "4-stellig CH" },
      "city": { "value": "", "source_text": "", "note": "" },
      "country": { "value": "", "source_text": "", "note": "Nationalität/Staatsangehörigkeit als ISO-2, z.B. CH, DE, IT" },
      "phone": { "value": "", "source_text": "", "note": "+41..." },
      "email": { "value": "", "source_text": "", "note": "" },
      "birth_date": { "value": "", "source_text": "", "note": "YYYY-MM-DD" },
      "gender": { "value": "", "source_text": "", "note": "male|female|diverse, nur wenn explizit" },
      "civil_status": { "value": "", "source_text": "", "note": "ledig|verheiratet|geschieden|verwitwet|eingetragene Partnerschaft" },
      "residence_permit": { "value": "", "source_text": "", "note": "CH|C|B|G|L|N|F (Schweizer Bürger = CH)" },
      "ahv_number": { "value": "", "source_text": "", "note": "756.XXXX.XXXX.XX" } },
    "contract_terms": {
      "start_date": { "value": "", "source_text": "", "note": "YYYY-MM-DD" },
      "end_date": { "value": null, "source_text": "", "note": "null wenn unbefristet" },
      "is_indefinite": { "value": null, "source_text": "", "note": "true|false" },
      "hours_per_week": { "value": null, "source_text": "", "note": "" },
      "notice_period_days": { "value": null, "source_text": "", "note": "in Tagen" } },
    "wage": {
      "wage_type": { "value": "hourly", "source_text": "", "note": "" },
      "hourly_rate": { "value": null, "source_text": "", "note": "CHF brutto, nur Zahl" },
      "vacation_weeks": { "value": null, "source_text": "", "note": "null wenn nicht explizit im Vertrag. NUR setzen wenn Ferienanspruch wörtlich angegeben." },
      "holiday_supplement_pct": { "value": null, "source_text": "", "note": "null wenn nicht explizit im Vertrag. Wird automatisch berechnet falls vacation_weeks gesetzt." },
      "payment_iban": { "value": "", "source_text": "", "note": "CH/LI IBAN. NUR setzen wenn wörtlich im Vertrag. source_text MUSS die IBAN enthalten. Sonst null." } },
    "social_insurance": {
      "accounting_method": { "value": "ordinary", "source_text": "", "note": "" },
      "canton": { "value": "", "source_text": "", "note": "2-stellig, aus PLZ der Assistenzperson ableiten – NICHT aus Arbeitgeber-PLZ" },
      "nbu_total_rate_pct": { "value": null, "source_text": "", "note": "Dezimal, 0.015=1.5%, typ. 0.005-0.03" },
      "nbu_employer_pct": { "value": null, "source_text": "", "note": "Dezimal, AG-Anteil" },
      "nbu_employee_pct": { "value": null, "source_text": "", "note": "Dezimal, AN-Anteil an der Gesamtprämie" },
      "nbu_employer_voluntary": { "value": null, "source_text": "", "note": "true wenn AG die NBU auch bei Pensum unter 8h/Woche freiwillig einschliesst" },
      "nbu_insurer_name": { "value": "", "source_text": "", "note": "SUVA, Helvetia, etc." },
      "nbu_policy_number": { "value": "", "source_text": "", "note": "" } }
  } }`;

// ─── API ────────────────────────────────────────────────

function getApiKey(): string | null {
  return import.meta.env.VITE_OPENROUTER_API_KEY || null;
}

function getModel(apiKey: string, modelId: string = DEFAULT_EXTRACTOR_MODEL): ChatOpenAI {
  return new ChatOpenAI({
    apiKey,
    configuration: {
      baseURL: OPENROUTER_API_URL,
      dangerouslyAllowBrowser: true,
      defaultHeaders: {
        'HTTP-Referer': window.location.origin,
        'X-Title': 'Asklepios Extractor',
      },
    },
    model: modelId,
    temperature: 0.1,
    maxRetries: 1,
    timeout: 300_000,
    modelKwargs: {
      response_format: { type: 'json_object' },
      provider: {
        order: ['Anthropic'],
        allow_fallbacks: true,
      },
    },
  });
}

function parseResponse(content: unknown): RawExtractionResult {
  if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
    return content as RawExtractionResult;
  }

  const rawText =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => {
              if (typeof part === 'string') return part;
              if (part && typeof part === 'object' && 'text' in (part as any)) {
                const t = (part as any).text;
                return typeof t === 'string' ? t : JSON.stringify(t);
              }
              return JSON.stringify(part);
            })
            .join('\n')
        : String(content ?? '');

  const cleanedText = rawText
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .replace(/^\uFEFF/, '') // BOM
    .trim();

  if (!cleanedText) {
    throw new Error('Leere KI-Antwort erhalten. Bitte erneut versuchen.');
  }

  const looksLikeHtml = /^<!doctype html|^<html\b/i.test(cleanedText);
  if (looksLikeHtml) {
    throw new Error(
      'Unerwartete HTML-Antwort erhalten (wahrscheinlich API-Fehler/Rate-Limit/Auth). Bitte erneut versuchen.',
    );
  }

  const tryParse = (candidate: string): RawExtractionResult | null => {
    try {
      return JSON.parse(candidate) as RawExtractionResult;
    } catch {
      return null;
    }
  };

  const ensureShape = (parsed: any): RawExtractionResult => {
    // Surface OpenRouter-ish error payloads cleanly (they are valid JSON but not our schema)
    if (parsed && typeof parsed === 'object' && ('error' in parsed || 'message' in parsed) && !('contracts' in parsed)) {
      const msg = typeof parsed.message === 'string'
        ? parsed.message
        : typeof (parsed.error as any)?.message === 'string'
          ? (parsed.error as any).message
          : 'Unerwartete API-Antwort erhalten.';
      throw new Error(msg);
    }

    if (!parsed || typeof parsed !== 'object' || !('contracts' in parsed) || !('extraction_metadata' in parsed)) {
      throw new Error('Unerwartetes Antwortformat der KI. Bitte erneut versuchen.');
    }
    return parsed as RawExtractionResult;
  };

  // 1) Direct parse
  const direct = tryParse(cleanedText);
  if (direct) return ensureShape(direct as any);

  // 2) Extract the first balanced JSON object from the text
  const extracted = extractFirstJsonObject(cleanedText);
  if (extracted) {
    const parsed = tryParse(extracted);
    if (parsed) return ensureShape(parsed as any);
  }

  // 3) Legacy: from first "{" to last "}"
  const startIdx = cleanedText.indexOf('{');
  const endIdx = cleanedText.lastIndexOf('}');
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const sliced = cleanedText.substring(startIdx, endIdx + 1);
    const parsed = tryParse(sliced);
    if (parsed) return ensureShape(parsed as any);
  }

  const snippet = cleanedText.slice(0, 400);
  throw new Error(
    `KI-Antwort konnte nicht als JSON geparsed werden. Bitte erneut versuchen. (Antwortanfang: ${JSON.stringify(snippet)})`,
  );
}

/**
 * Extract the first JSON object from a string by finding the first balanced { ... }.
 * This tolerates extra text before/after and braces inside JSON strings.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    if (ch === '}') depth--;

    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * Run tool calls if the model requests them, then return the TOOL-VALIDATED result.
 *
 * CRITICAL: `contracts` kommen nur aus contract_data_submission (`data`). Das finale
 * LLM-JSON liefert ausschließlich extraction_metadata. Kein Merge mit LLM-Feldern.
 * Tool nicht aufgerufen oder kein `data` bei success/warning → Error.
 */
async function runAgentWithTools(
  model: ChatOpenAI,
  messages: Array<SystemMessage | HumanMessage>,
  documentMode: 'text' | 'vision' = 'text',
): Promise<{ raw: RawExtractionResult; toolCalls: string[] }> {
  const toolCalls: string[] = [];
  const MAX_TOOL_ROUNDS = 3;

  // Capture the tool-validated data from contract_data_submission
  let toolValidatedData: RawExtractionResult['contracts'] | null = null;

  const modelWithTools = model.bindTools(agentTools);

  let response = await modelWithTools.invoke(
    messages,
    await getLangSmithInvokeConfig('asklepios-extractor', {
      mode: `${documentMode}-with-tools`,
    }),
  );
  const allMessages = [...messages, response];
  let round = 0;

  while (response.tool_calls && response.tool_calls.length > 0 && round < MAX_TOOL_ROUNDS) {
    round++;
    for (const call of response.tool_calls) {
      toolCalls.push(call.name);
      const selectedTool = agentTools.find((t) => t.name === call.name);
      if (!selectedTool) {
        throw new Error(`Unknown tool: ${call.name}`);
      }
      const toolTraceConfig = await getLangSmithInvokeConfig('asklepios-extractor', {
        mode: `${documentMode}-tool-exec`,
        tool_name: call.name,
        tool_round: round,
      });
      const toolRunnableConfig = toolTraceConfig
        ? {
            ...toolTraceConfig,
            runName: `Tool: ${call.name}`,
            tags: [
              ...new Set([
                ...((toolTraceConfig.tags as string[] | undefined) ?? []),
                'tool',
                call.name,
              ]),
            ],
          }
        : undefined;
      const toolResult = await (selectedTool as { invoke: (a: unknown, c?: unknown) => Promise<unknown> }).invoke(
        call.args,
        toolRunnableConfig,
      );
      const toolResultString = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

      // Capture validated data from contract_data_submission tool
      if (call.name === 'contract_data_submission') {
        try {
          const parsed = JSON.parse(toolResultString);
          if (parsed.data && (parsed.status === 'success' || parsed.status === 'warning')) {
            toolValidatedData = parsed.data;
          }
        } catch {
          throw new Error(
            'Asklepios Extractor: contract_data_submission Tool-Ergebnis konnte nicht geparst werden.',
          );
        }
      }

      allMessages.push({
        role: 'tool',
        content: toolResultString,
        tool_call_id: call.id!,
      } as any);
    }

    response = await modelWithTools.invoke(
      allMessages,
      await getLangSmithInvokeConfig('asklepios-extractor', {
        mode: `${documentMode}-tool-round-${round}`,
      }),
    );
    allMessages.push(response);
  }

  if (round >= MAX_TOOL_ROUNDS && response.tool_calls && response.tool_calls.length > 0) {
    console.warn(`[Asklepios Extractor] Tool-calling limit reached (${MAX_TOOL_ROUNDS} rounds). Forcing final response.`);
    const forceModel = getModel(
      import.meta.env.VITE_OPENROUTER_API_KEY!,
      getExtractorModelName(),
    );
    response = await forceModel.invoke(
      allMessages,
      await getLangSmithInvokeConfig('asklepios-extractor', {
        mode: `${documentMode}-forced-final`,
      }),
    );
  }

  // LLM final response has extraction_metadata + contracts in correct format
  const llmParsed = parseResponse(response.content as string);

  // MANDATORY: Tool must have been called for validation to run.
  if (!toolCalls.includes('contract_data_submission')) {
    throw new Error(
      'Asklepios Extractor: contract_data_submission Tool wurde nicht aufgerufen – Validierung fehlt.',
    );
  }

  if (!toolValidatedData) {
    throw new Error(
      'Asklepios Extractor: contract_data_submission lieferte keine validierten Daten (data fehlt oder status weder success noch warning).',
    );
  }

  return {
    raw: {
      extraction_metadata: llmParsed.extraction_metadata,
      contracts: toolValidatedData as RawExtractionResult['contracts'],
    },
    toolCalls,
  };
}

/**
 * Extract contract data from TEXT content (Agent 1).
 */
export async function extractContractData(
  contractText: string,
): Promise<{ raw: RawExtractionResult; toolCalls: string[] }> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('VITE_OPENROUTER_API_KEY ist nicht konfiguriert.');
  }

  const model = getModel(apiKey, getExtractorModelName());

  return runAgentWithTools(
    model,
    [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(USER_PROMPT_TEMPLATE(contractText)),
    ],
    'text',
  );
}

/**
 * Extract contract data from IMAGES (Agent 1, vision path).
 * Uses the same tool-calling loop as the text path so that
 * document_classification + contract_data_submission (AHV/IBAN/Kanton
 * normalisierung) auch bei Vision-Extraktion durchlaufen werden.
 */
export async function extractContractFromImages(
  images: string[],
): Promise<{ raw: RawExtractionResult; toolCalls: string[] }> {
  const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    {
      type: 'text',
      text: USER_PROMPT_TEMPLATE('[Siehe beigefügte Bilder des Arbeitsvertrags]'),
    },
  ];

  for (const img of images) {
    userContent.push({ type: 'image_url', image_url: { url: img } });
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('VITE_OPENROUTER_API_KEY ist nicht konfiguriert.');
  }

  const model = getModel(apiKey, getExtractorModelName());

  return runAgentWithTools(
    model,
    [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage({ content: userContent }),
    ],
    'vision',
  );
}

// ─── Binary Status Helpers ──────────────────────────────

/** Map confidence_score → binary status */
export function confidenceToStatus(
  confidenceScore: number,
): 'ok' | 'review_required' {
  return confidenceScore >= 0.8 ? 'ok' : 'review_required';
}

/**
 * Get human-readable message for review fields.
 * Uses review_type to distinguish between:
 *   - 'verify' (Prüfen): value exists but uncertain → human verifies
 *   - 'supplement' (Ergänzen): value missing → human must add
 */
export function reviewMessage(field: ExtractionField): string | undefined {
  if (field.status === 'ok' && field.value !== null) return undefined;
  if (field.review_type === 'verify') {
    return 'Unsicherer Wert – bitte prüfen.';
  }
  if (field.review_type === 'supplement') {
    return 'Nicht im Vertrag gefunden – bitte ergänzen.';
  }
  if (field.value === null) return 'Nicht im Vertrag gefunden';
  return undefined;
}

/** Get a tooltip with the source text quote */
export function fieldSourceTooltip(field: ExtractionField): string | undefined {
  if (!field.source_text) return undefined;
  return `Quelle: «${field.source_text}» (${Math.round(field.confidence_score * 100)}%)`;
}

/**
 * Merge raw extraction with judge results into final ExtractionResult.
 */
/**
 * Merge Tool-validated extraction with Asklepios Control judge results.
 *
 * The raw extraction data comes from the contract_data_submission TOOL output
 * (not the LLM text). Asklepios Control assigns confidence scores per field.
 * This function merges both and determines review_type:
 *   - 'verify': value exists but confidence < 0.8 → human verifies (Prüfen)
 *   - 'supplement': value is null/empty → human must add (Ergänzen)
 */
export function mergeWithJudgeResult(
  raw: RawExtractionResult,
  judgeResult: import('./asklepios-control').JudgeResult,
): ExtractionResult {
  const contracts: ExtractionResult['contracts'] = {} as any;
  let fieldsRequiringReview = 0;
  const reviewRequiredFields: string[] = [];
  const reviewVerifyFields: string[] = [];
  const reviewSupplementFields: string[] = [];

  for (const [sectionName, sectionFields] of Object.entries(raw.contracts)) {
    const judgeSection = judgeResult.fields?.[sectionName] || {};
    const mergedSection: Record<string, ExtractionField> = {};

    for (const [fieldName, rawField] of Object.entries(
      sectionFields as Record<string, RawExtractionField>,
    )) {
      if (sectionName === 'contract_terms' && fieldName === 'hours_per_month') continue;
      const judgeField = judgeSection[fieldName] as JudgeFieldResult | undefined;

      const confidenceScore = judgeField?.confidence_score ?? 0.5;
      const status = confidenceScore >= 0.8 ? 'ok' : 'review_required';

      const safeRawField: RawExtractionField =
        rawField && typeof rawField === 'object'
          ? (rawField as RawExtractionField)
          : ({ value: null, source_text: '', note: '' } as RawExtractionField);

      // Determine review_type: verify (Prüfen) vs. supplement (Ergänzen)
      let reviewType: 'verify' | 'supplement' | undefined;
      if (status === 'review_required') {
        const fullPath = `${sectionName}.${fieldName}`;
        fieldsRequiringReview++;
        reviewRequiredFields.push(fullPath);

        if (safeRawField.value !== null && safeRawField.value !== undefined && safeRawField.value !== '') {
          reviewType = 'verify';  // Prüfen: Wert vorhanden aber unsicher
          reviewVerifyFields.push(fullPath);
        } else {
          reviewType = 'supplement';  // Ergänzen: Wert fehlt
          reviewSupplementFields.push(fullPath);
        }
      }

      mergedSection[fieldName] = {
        value: safeRawField.value,
        confidence: judgeField?.confidence ?? 'medium',
        confidence_score: confidenceScore,
        status,
        review_type: reviewType,
        source_text: judgeField?.source_quote || safeRawField.source_text || '',
        note: safeRawField.note,
        judge_justification: judgeField?.justification,
      };
    }

    (contracts as any)[sectionName] = mergedSection;
  }

  return {
    extraction_metadata: {
      document_language: raw.extraction_metadata.document_language,
      overall_confidence: judgeResult.overall_confidence,
      overall_status: judgeResult.overall_confidence >= 0.8 ? 'ok' : 'review_required',
      fields_extracted: raw.extraction_metadata.fields_extracted,
      fields_missing: raw.extraction_metadata.fields_missing,
      fields_requiring_review: fieldsRequiringReview,
      warnings: raw.extraction_metadata.warnings,
      review_required_fields: reviewRequiredFields,
      review_verify_fields: reviewVerifyFields,
      review_supplement_fields: reviewSupplementFields,
    },
    contracts,
  };
}
