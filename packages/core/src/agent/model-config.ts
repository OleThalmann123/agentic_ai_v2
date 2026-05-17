import { SystemMessage } from '@langchain/core/messages';

/**
 * Zentrale OpenRouter-Modellwahl für die IDP-Pipeline.
 *
 * Env (Vite):
 * - VITE_OPENROUTER_MODEL            — Override für Extraktion + Judge
 * - VITE_OPENROUTER_EXTRACTOR_MODEL  — nur Asklepios Extractor (Extraktion / Vision)
 * - VITE_OPENROUTER_JUDGE_MODEL      — nur Asklepios Control (Qualitätsprüfung)
 *
 * Asklepios Extractor (Sonnet 4.6): Frontier-Qualität für präzise Vertragsextraktion
 *   – Tool-calling + Vision
 *   – Trennt Arbeitgeber/Arbeitnehmer sauber
 *   – Tool-Output ist das autoritative Ergebnis
 *
 * Asklepios Control (Sonnet 4.6): Frontier-Qualität für den Qualitätscheck
 *   – Vision-basierte Verifikation gegen Originaldokument
 *   – Frontier-Reasoning für präzise Konfidenz-Bewertung
 */

/**
 * Asklepios Extractor — Extraktion mit Tool-Calls + Vision.
 * Sonnet 4.6: Frontier-Qualität für Schweizer Arbeitsverträge.
 */
export const DEFAULT_EXTRACTOR_MODEL = 'anthropic/claude-sonnet-4.6';

/**
 * Asklepios Control — LLM-as-a-Judge (strukturierter JSON-Score pro Feld).
 * Sonnet 4.6: Frontier-Qualität für die Konfidenz-Bewertung.
 */
export const DEFAULT_JUDGE_MODEL = 'anthropic/claude-sonnet-4.6';

export function getExtractorModelName(): string {
  return (
    import.meta.env.VITE_OPENROUTER_EXTRACTOR_MODEL ||
    import.meta.env.VITE_OPENROUTER_MODEL ||
    DEFAULT_EXTRACTOR_MODEL
  );
}

export function getJudgeModelName(): string {
  return (
    import.meta.env.VITE_OPENROUTER_JUDGE_MODEL ||
    import.meta.env.VITE_OPENROUTER_MODEL ||
    DEFAULT_JUDGE_MODEL
  );
}

/**
 * Asklepios Classifier — Dokumentklassifizierung (ja/nein).
 * Haiku 4.5: Schnell und günstig – einfache Ja/Nein-Entscheidung.
 */
export const DEFAULT_CLASSIFIER_MODEL = 'anthropic/claude-haiku-4.5';

export function getClassifierModelName(): string {
  return (
    import.meta.env.VITE_OPENROUTER_CLASSIFIER_MODEL ||
    import.meta.env.VITE_OPENROUTER_MODEL ||
    DEFAULT_CLASSIFIER_MODEL
  );
}

/**
 * System message whose static prompt is marked as a prompt-cache
 * breakpoint. Anthropic (via OpenRouter) caches the prefix up to the
 * `cache_control` block; the per-document user prompt stays uncached.
 * The static system prompt of each agent is re-sent verbatim on every
 * run, so caching it removes that input-token cost on cache hits.
 * Functionally identical to `new SystemMessage(text)` if a provider
 * ignores `cache_control` (no behavioural change, no quality impact).
 */
export function cachedSystemMessage(text: string): SystemMessage {
  return new SystemMessage({
    content: [
      {
        type: 'text',
        text,
        cache_control: { type: 'ephemeral' },
      } as unknown as { type: 'text'; text: string },
    ],
  });
}
