/**
 * Asklepios Control – Quality Control Agent (LLM-as-a-Judge)
 *
 * Evaluates the TOOL-VALIDATED output of Asklepios Extractor.
 * Reviews each extracted field against the original contract text and
 * assigns confidence scores with justification.
 *
 * Architecture:
 *   Asklepios Extractor extracts + validates data via Tools →
 *   Asklepios Control reviews the Tool output against original contract →
 *   Assigns confidence scores + justification per field →
 *   Binary mapping: score >= 0.8 → "ok" (HOOTL), < 0.8 → "review_required" (HOTL/HITL)
 *
 * Human-in-the-Loop:
 *   "verify" (Prüfen) – value extracted but uncertain, human checks
 *   "supplement" (Ergänzen) – value missing, human must add
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import { getLangSmithInvokeConfig } from './langsmith';
import { getJudgeModelName, cachedSystemMessage } from './model-config';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

export interface JudgeFieldResult {
  confidence: 'high' | 'medium' | 'low';
  confidence_score: number;
  status: 'ok' | 'review_required';
  justification: string;
  source_found: boolean;
  source_quote: string;
}

export interface JudgeResult {
  fields: Record<string, Record<string, JudgeFieldResult>>;
  overall_confidence: number;
  overall_status: 'ok' | 'review_required';
  review_required_fields: string[];
  summary: string;
}

const JUDGE_SYSTEM_PROMPT = `Du bist ein erfahrener Qualitätsprüfer für Datenextraktionen aus Schweizer Arbeitsverträgen. Du erhältst den Originalvertrag und die daraus extrahierten Daten. Deine Aufgabe: Prüfe JEDES extrahierte Feld gegen den Originaltext und vergib einen confidence_score.

Schritte:
1. Lies den Originalvertrag vollständig.
2. Vergleiche JEDES Feld der Extraktion mit dem Originaltext.
3. Vergib pro Feld einen confidence_score (0.0–1.0) nach diesen Kriterien:
   - 0.85–1.0 (high): Wert steht explizit und eindeutig im Vertrag.
   - 0.50–0.84 (medium): Wert interpretiert, abgeleitet oder teilweise korrekt.
   - 0.00–0.49 (low): Wert fehlt, falsch extrahiert oder widersprüchlich.
4. Setze status: "ok" wenn score >= 0.8, sonst "review_required".
5. Zitiere die relevante Stelle aus dem Vertrag in source_quote.

Regeln:
- Sei streng: lieber einmal zu viel "review_required" als einen Fehler durchlassen.
- Wert null + Feld nicht im Vertrag = korrekt (0.95).
- Wert null + Feld steht im Vertrag = Fehler (0.2).
- Wert gesetzt + KEIN wörtliches Zitat im Vertrag auffindbar = Halluzination (0.1). Besonders kritisch bei: vacation_weeks, holiday_supplement_pct, notice_period_days, payment_iban. Wenn das Wort "Ferien" nirgends im Vertrag vorkommt, MUSS vacation_weeks null sein. Wenn die IBAN nicht als zusammenhängende Zeichenfolge im Vertragstext auffindbar ist, MUSS payment_iban als Halluzination (0.1) markiert werden.
- Geschlecht: niemals aus Name ableiten. Null ist korrekt (0.95).
- ISO-Übersetzungen erlaubt: "Schweiz" = CH = korrekt (high).
- justification ist rein intern (Audit/Trace), nicht für Endbenutzer.

Format: Nur valides JSON. Keine Erklärungen. Kein Text vor oder nach dem JSON.`;

function buildJudgeSkeleton(extractedData: Record<string, unknown>): string {
  const sections = extractedData as Record<string, Record<string, unknown>>;
  const skeleton: Record<string, Record<string, object>> = {};

  for (const [section, fields] of Object.entries(sections)) {
    if (!fields || typeof fields !== 'object') continue;
    skeleton[section] = {};
    for (const fieldName of Object.keys(fields as Record<string, unknown>)) {
      skeleton[section][fieldName] = {
        confidence: 'high|medium|low',
        confidence_score: '0.0-1.0',
        status: 'ok|review_required',
        justification: '',
        source_found: 'true|false',
        source_quote: '',
      };
    }
  }

  return JSON.stringify({
    fields: skeleton,
    overall_confidence: '0.0-1.0',
    overall_status: 'ok|review_required',
    review_required_fields: ['section.field_name'],
    summary: '',
  }, null, 2);
}

const JUDGE_USER_PROMPT = (
  originalText: string,
  extractedData: Record<string, unknown>,
) => `Hier ist der Originalvertrag und die Extraktion. Bewerte JEDES Feld.

=== VERTRAG ===
${originalText}
=== ENDE ===

=== EXTRAKTION ===
${JSON.stringify(extractedData, null, 2)}
=== ENDE ===

Format: Nur valides JSON. Bewerte jedes Feld der Extraktion einzeln.

${buildJudgeSkeleton(extractedData)}`;

function getApiKey(): string | null {
  return import.meta.env.VITE_OPENROUTER_API_KEY || null;
}

function getJudgeModel(apiKey: string): ChatOpenAI {
  return new ChatOpenAI({
    apiKey,
    configuration: {
      baseURL: OPENROUTER_API_URL,
      dangerouslyAllowBrowser: true,
      defaultHeaders: {
        'HTTP-Referer': window.location.origin,
        'X-Title': 'Asklepios Control',
      },
    },
    model: getJudgeModelName(),
    temperature: 0.0,
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

function parseJudgeResponse(content: unknown): JudgeResult {
  if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
    return content as JudgeResult;
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
    .replace(/^\uFEFF/, '')
    .trim();

  if (!cleanedText) {
    throw new Error('Leere Judge-Antwort erhalten. Bitte erneut versuchen.');
  }

  const looksLikeHtml = /^<!doctype html|^<html\b/i.test(cleanedText);
  if (looksLikeHtml) {
    throw new Error(
      'Unerwartete HTML-Antwort vom Judge erhalten (wahrscheinlich API-Fehler/Rate-Limit/Auth). Bitte erneut versuchen.',
    );
  }

  const tryParse = (candidate: string): JudgeResult | null => {
    try {
      return JSON.parse(candidate) as JudgeResult;
    } catch {
      return null;
    }
  };

  const ensureShape = (parsed: any): JudgeResult => {
    if (parsed && typeof parsed === 'object' && ('error' in parsed || 'message' in parsed) && !('fields' in parsed)) {
      const msg = typeof parsed.message === 'string'
        ? parsed.message
        : typeof (parsed.error as any)?.message === 'string'
          ? (parsed.error as any).message
          : 'Unerwartete API-Antwort erhalten.';
      throw new Error(msg);
    }

    if (!parsed || typeof parsed !== 'object' || !('fields' in parsed) || !('overall_confidence' in parsed)) {
      throw new Error('Unerwartetes Antwortformat des Judge. Bitte erneut versuchen.');
    }
    return parsed as JudgeResult;
  };

  const direct = tryParse(cleanedText);
  if (direct) return ensureShape(direct as any);

  const extracted = extractFirstJsonObject(cleanedText);
  if (extracted) {
    const parsed = tryParse(extracted);
    if (parsed) return ensureShape(parsed as any);
  }

  const startIdx = cleanedText.indexOf('{');
  const endIdx = cleanedText.lastIndexOf('}');
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const sliced = cleanedText.substring(startIdx, endIdx + 1);
    const parsed = tryParse(sliced);
    if (parsed) return ensureShape(parsed as any);
  }

  const snippet = cleanedText.slice(0, 400);
  throw new Error(
    `Judge-Antwort konnte nicht als JSON geparsed werden. (Antwortanfang: ${JSON.stringify(snippet)})`,
  );
}

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
 * Run the LLM-as-a-Judge evaluation.
 * Asklepios Control reviews the Tool-validated extraction against the
 * original contract. When images are provided (vision pipeline), the Judge
 * receives them directly so it can visually verify extracted values.
 */
export async function runJudge(
  originalText: string,
  extractedContracts: Record<string, unknown>,
  images?: string[],
): Promise<JudgeResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('VITE_OPENROUTER_API_KEY ist nicht konfiguriert.');
  }

  const model = getJudgeModel(apiKey);

  // Build the user message – with images when available (vision pipeline)
  let userMessage: HumanMessage;

  if (images && images.length > 0) {
    // Vision mode: send images + extraction data so the Judge can verify visually
    const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      {
        type: 'text',
        text: JUDGE_USER_PROMPT(
          '[Siehe beigefügte Bilder des Arbeitsvertrags – prüfe die Extraktion visuell gegen das Originaldokument]',
          extractedContracts,
        ),
      },
    ];
    for (const img of images) {
      userContent.push({ type: 'image_url', image_url: { url: img } });
    }
    userMessage = new HumanMessage({ content: userContent });
  } else {
    // Text mode: send original text
    userMessage = new HumanMessage(JUDGE_USER_PROMPT(originalText, extractedContracts));
  }

  const response = await model.invoke(
    [
      cachedSystemMessage(JUDGE_SYSTEM_PROMPT),
      userMessage,
    ],
    await getLangSmithInvokeConfig('asklepios-control', {
      fieldsToReview: Object.keys(extractedContracts),
      mode: images?.length ? 'vision' : 'text',
    }),
  );

  const result = parseJudgeResponse(response.content);

  if (!result.review_required_fields) {
    result.review_required_fields = [];
  }
  if (result.fields) {
    for (const section of Object.values(result.fields)) {
      for (const [fieldName, field] of Object.entries(section as Record<string, JudgeFieldResult>)) {
        field.status = field.confidence_score >= 0.8 ? 'ok' : 'review_required';
        if (field.status === 'review_required') {
          const sectionName = Object.entries(result.fields).find(
            ([, v]) => v === section,
          )?.[0];
          const fullName = `${sectionName}.${fieldName}`;
          if (!result.review_required_fields.includes(fullName)) {
            result.review_required_fields.push(fullName);
          }
        }
      }
    }
  }

  result.overall_status =
    result.overall_confidence >= 0.8 ? 'ok' : 'review_required';

  return result;
}

/**
 * Run the Judge on vision-based extractions (scanned PDFs).
 * Passes images directly to the Judge for visual verification.
 */
export async function runJudgeForImages(
  images: string[],
  extractedContracts: Record<string, unknown>,
): Promise<JudgeResult> {
  return runJudge('', extractedContracts, images);
}
