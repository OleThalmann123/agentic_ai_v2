/**
 * Asklepios Classifier – Document Classification Agent
 *
 * Determines whether an uploaded document is a Swiss employment contract
 * for IV assistance contributions (Arbeitsvertrag für Assistenzbeitrag).
 *
 * Architecture:
 *   Asklepios Classifier (this) → classifies document (yes/no) →
 *   Asklepios Extractor → extracts contract data →
 *   Asklepios Control → quality review (LLM-as-a-Judge)
 *
 * Single-agent, no tools: one LLM call, one clear answer.
 * If the document is not a relevant contract → pipeline rejects early.
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import { getLangSmithInvokeConfig } from './langsmith';
import { getClassifierModelName, cachedSystemMessage } from './model-config';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

// ─── Types ──────────────────────────────────────────────

export interface ClassificationResult {
  is_contract: boolean;
  document_type: 'swiss_iv_employment_contract' | 'other_employment_contract' | 'other_document';
  confidence: number;
  language: string;
  justification: string;
}

// ─── Prompt ─────────────────────────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `Du bist ein erfahrener Dokumentenprüfer, spezialisiert auf Schweizer Arbeitsverträge im Bereich IV-Assistenzbeiträge.

Kontext: In der Schweiz können Personen mit einer Behinderung (IV-Bezüger) Assistenzpersonen anstellen. Dafür gibt es spezielle Arbeitsverträge (Arbeitsvertrag für Assistenzbeitrag / Anstellungsvertrag für persönliche Assistenz). Diese Verträge haben typischerweise:
- Zwei Parteien: Arbeitgeberin (Person mit Behinderung) und Arbeitnehmerin (Assistenzperson)
- Bezug auf IV-Assistenzbeitrag, AHV, Sozialversicherungen
- Stundenlohn, Ferienanspruch, Kündigungsfrist
- Schweizer Rechtsbezüge (OR, ArG, AHVG, UVG)

Aufgabe: Prüfe ob das vorliegende Dokument ein solcher Schweizer Arbeitsvertrag für Assistenzpersonen ist.

Schritte:
1. Lies das gesamte Dokument.
2. Prüfe ob es ein Arbeitsvertrag ist (nicht: Rechnung, Brief, Kündigung, Lohnabrechnung, Vollmacht).
3. Prüfe ob es einen Schweizer Bezug hat (CHF, AHV, Kantone, OR, Schweizer Adressen).
4. Prüfe ob es spezifisch um IV-Assistenz geht (Assistenzbeitrag, Assistenzperson, IV-Stelle).
5. Gib dein Urteil als JSON ab.

Regeln:
- Sei streng: Im Zweifelsfall lieber ablehnen als ein falsches Dokument durchlassen.
- Ein allgemeiner Schweizer Arbeitsvertrag (nicht IV-Assistenz) ist "other_employment_contract" → wird akzeptiert, da die Felder gleich sind.
- Nur klar artfremde Dokumente (Rechnungen, Briefe, Kündigungen, Vollmachten, etc.) ablehnen.
- confidence: 0.0–1.0 (wie sicher bist du?).
- justification: Kurze Begründung (1–2 Sätze), warum ja oder nein.

Format: Nur valides JSON. Keine Erklärungen. Kein Text vor oder nach dem JSON.`;

const CLASSIFIER_USER_PROMPT = (documentText: string) => `Prüfe dieses Dokument:

---
${documentText}
---

Ist das ein Schweizer Arbeitsvertrag (insbesondere für IV-Assistenzbeitrag)?

{
  "is_contract": true | false,
  "document_type": "swiss_iv_employment_contract" | "other_employment_contract" | "other_document",
  "confidence": 0.0-1.0,
  "language": "de | fr | it | en",
  "justification": ""
}`;

// ─── API ────────────────────────────────────────────────

function getApiKey(): string | null {
  return import.meta.env.VITE_OPENROUTER_API_KEY || null;
}

function getClassifierModel(apiKey: string): ChatOpenAI {
  return new ChatOpenAI({
    apiKey,
    configuration: {
      baseURL: OPENROUTER_API_URL,
      dangerouslyAllowBrowser: true,
      defaultHeaders: {
        'HTTP-Referer': window.location.origin,
        'X-Title': 'Asklepios Classifier',
      },
    },
    model: getClassifierModelName(),
    temperature: 0.0,
    maxRetries: 1,
    timeout: 60_000, // 1 Minute reicht – kurzes Dokument, einfache Entscheidung
    modelKwargs: {
      response_format: { type: 'json_object' },
      provider: {
        order: ['Anthropic'],
        allow_fallbacks: true,
      },
    },
  });
}

// ─── Classifier ─────────────────────────────────────────

/**
 * Classify a document: is it a Swiss employment contract for IV assistance?
 *
 * Returns a clear yes/no with confidence and justification.
 * Uses a fast, cheap LLM call (short prompt, short response).
 */
export async function classifyDocument(
  documentText: string,
): Promise<ClassificationResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('VITE_OPENROUTER_API_KEY ist nicht konfiguriert.');
  }

  const model = getClassifierModel(apiKey);

  const response = await model.invoke(
    [
      cachedSystemMessage(CLASSIFIER_SYSTEM_PROMPT),
      new HumanMessage(CLASSIFIER_USER_PROMPT(documentText)),
    ],
    await getLangSmithInvokeConfig('asklepios-classifier', { mode: 'text' }),
  );

  const content = typeof response.content === 'string'
    ? response.content
    : Array.isArray(response.content)
      ? response.content.map((p: any) => typeof p === 'string' ? p : p.text || '').join('')
      : String(response.content);

  const cleaned = content
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();

  try {
    const result = JSON.parse(cleaned) as ClassificationResult;

    // Ensure boolean
    result.is_contract = !!result.is_contract;
    result.confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));

    return result;
  } catch {
    throw new Error(
      `Asklepios Classifier: Antwort konnte nicht als JSON geparst werden. Antwort: ${cleaned.slice(0, 200)}`,
    );
  }
}

/**
 * Classify a document from images (scanned PDFs).
 */
export async function classifyDocumentFromImages(
  images: string[],
): Promise<ClassificationResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('VITE_OPENROUTER_API_KEY ist nicht konfiguriert.');
  }

  const model = getClassifierModel(apiKey);

  const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    {
      type: 'text',
      text: CLASSIFIER_USER_PROMPT('[Siehe beigefügte Bilder des Dokuments]'),
    },
  ];

  // Only send first 2 pages – enough to classify
  for (const img of images.slice(0, 2)) {
    userContent.push({ type: 'image_url', image_url: { url: img } });
  }

  const response = await model.invoke(
    [
      cachedSystemMessage(CLASSIFIER_SYSTEM_PROMPT),
      new HumanMessage({ content: userContent }),
    ],
    await getLangSmithInvokeConfig('asklepios-classifier', { mode: 'vision' }),
  );

  const content = typeof response.content === 'string'
    ? response.content
    : Array.isArray(response.content)
      ? response.content.map((p: any) => typeof p === 'string' ? p : p.text || '').join('')
      : String(response.content);

  const cleaned = content
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();

  try {
    const result = JSON.parse(cleaned) as ClassificationResult;
    result.is_contract = !!result.is_contract;
    result.confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
    return result;
  } catch {
    throw new Error(
      `Asklepios Classifier: Antwort konnte nicht als JSON geparst werden. Antwort: ${cleaned.slice(0, 200)}`,
    );
  }
}
