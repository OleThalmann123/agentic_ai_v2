/**
 * LangSmith Integration – Browser-compatible tracing via server-side proxy
 *
 * Wie in der [LangSmith-Doku](https://docs.langchain.com/langsmith) üblich, kannst du setzen:
 *   LANGSMITH_TRACING=true
 *   LANGSMITH_ENDPOINT=https://api.smith.langchain.com
 *   LANGSMITH_API_KEY=…        (nur .env / Vercel – nie mit VITE_-Prefix)
 *   LANGSMITH_PROJECT="AgenticAI V2"
 *
 * Vite injiziert LANGSMITH_TRACING / LANGSMITH_PROJECT / LANGSMITH_ENDPOINT sicher ins Bundle
 * (siehe apps/prototyp-1-v2/vite.config.ts `define`). API-Keys gehen nicht ins Frontend.
 *
 * Zusätzlich (empfohlen für Proxy-Modus ohne Key im Browser):
 *   VITE_LANGSMITH_PROXY=true
 *
 * Hinweis: `import { traceable } from "langsmith/traceable"` aus der Doku ist **Node-only**
 * (async_hooks) und wird in dieser Browser-App nicht verwendet. Stattdessen: LangChainTracer +
 * RunTree + getLangSmithInvokeConfig (gleiche Runs in LangSmith, anderes Instrumentierungs-API).
 *
 * Server-side (Vercel): /api/langsmith/… injiziert LANGSMITH_API_KEY.
 */

import { CallbackManager } from '@langchain/core/callbacks/manager';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { Client } from 'langsmith';
import type { RunTree } from 'langsmith/run_trees';

let _tracer: LangChainTracer | null = null;
let _client: Client | null = null;

/** Parent-Run der Pipeline — gesetzt in pipeline.ts, damit LLM-Calls darunter hängen. */
let _pipelineLangSmithRoot: RunTree | null = null;

/** Eine Session pro Pipeline-Lauf — gleiche ID auf Root + Kind-Runs (Filter/Threads in LangSmith). */
let _pipelineLangSmithSessionId: string | null = null;

export function setPipelineLangSmithRoot(run: RunTree | null): void {
  _pipelineLangSmithRoot = run;
}

export function setPipelineLangSmithSessionId(id: string | null): void {
  _pipelineLangSmithSessionId = id;
}

function getPipelineLangSmithRoot(): RunTree | null {
  return _pipelineLangSmithRoot;
}

function getPipelineLangSmithSessionId(): string | null {
  return _pipelineLangSmithSessionId;
}

/** Vercel/UI liefern oft "true", "1", "True" statt exakt "true". */
function isTruthyEnv(v: string | undefined): boolean {
  if (v === undefined || v === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

function proxyBaseUrl(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/api/langsmith`;
  }
  return '/api/langsmith';
}

/** LangSmith-Doku: LANGSMITH_TRACING (per Vite define → process.env im Bundle). */
function langSmithTracingFromDocsEnv(): boolean {
  try {
    const p = typeof process !== 'undefined' ? process.env?.LANGSMITH_TRACING : undefined;
    return isTruthyEnv(p);
  } catch {
    return false;
  }
}

function langSmithProjectFromDocsEnv(): string | undefined {
  try {
    const p = typeof process !== 'undefined' ? process.env?.LANGSMITH_PROJECT : undefined;
    if (p != null && String(p).trim() !== '') return String(p).trim();
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Projektname wie in der LangSmith-Doku (LANGSMITH_PROJECT) bzw. VITE_LANGSMITH_PROJECT. */
export function getLangSmithProjectName(): string {
  return (
    langSmithProjectFromDocsEnv() ||
    (import.meta.env.VITE_LANGSMITH_PROJECT as string | undefined) ||
    'AgenticAI V2'
  );
}

/**
 * Entspricht langsmith/langchain getLangchainCallbacks(runTree), ohne Import von
 * langsmith/langchain (das zieht traceable/node:async_hooks ins Browser-Bundle).
 */
async function getLangchainCallbacksForParentRun(
  runTree: RunTree,
): Promise<CallbackManager | undefined> {
  let callbacks = await CallbackManager.configure();
  if (!callbacks && runTree.tracingEnabled !== false) {
    callbacks = new CallbackManager();
  }
  let langChainTracer = callbacks?.handlers.find(
    (h: { name?: string }) => h?.name === 'langchain_tracer',
  ) as LangChainTracer | undefined;
  if (!langChainTracer && runTree.tracingEnabled !== false) {
    // Immer denselben Client wie der Pipeline-Root — sonst nutzt LangChainTracer()
    // kurz den Default-Singleton (US-Endpoint, kein Browser-Key) → stille Fehler.
    langChainTracer = new LangChainTracer({
      client: runTree.client,
      projectName: runTree.project_name ?? undefined,
    });
    callbacks?.addHandler(langChainTracer);
  }

  const runMap = new Map<string, RunTree>();
  let rootRun: RunTree = runTree;
  const rootVisited = new Set<string>();
  while (rootRun.parent_run) {
    if (rootVisited.has(rootRun.id)) break;
    rootVisited.add(rootRun.id);
    rootRun = rootRun.parent_run;
  }
  const queue: RunTree[] = [rootRun];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);
    runMap.set(current.id, current);
    if (current.child_runs?.length) {
      queue.push(...current.child_runs);
    }
  }

  if (callbacks != null) {
    Object.assign(callbacks, { _parentRunId: runTree.id });
  }
  if (langChainTracer != null) {
    const tracerAny = langChainTracer as LangChainTracer & {
      updateFromRunTree?: (rt: RunTree) => void;
      runMap?: Map<string, RunTree>;
      client?: Client;
      projectName?: string;
      exampleId?: string;
    };
    if (typeof tracerAny.updateFromRunTree === 'function') {
      tracerAny.updateFromRunTree(runTree);
    } else {
      Object.assign(langChainTracer, {
        runMap,
        client: runTree.client,
        projectName: runTree.project_name || tracerAny.projectName,
        exampleId: runTree.reference_example_id || tracerAny.exampleId,
      });
    }
  }
  return callbacks;
}

function getLangSmithConfig() {
  const hasBrowserApiKey = !!import.meta.env.VITE_LANGSMITH_API_KEY;
  const proxyFlag = isTruthyEnv(import.meta.env.VITE_LANGSMITH_PROXY as string | undefined);
  const docsTracingOn = langSmithTracingFromDocsEnv();
  const proxyEnabled = !hasBrowserApiKey && (proxyFlag || docsTracingOn);

  const apiKey = proxyEnabled
    ? 'proxy' // placeholder – the serverless function injects the real key
    : import.meta.env.VITE_LANGSMITH_API_KEY;

  let endpoint: string;
  if (proxyEnabled) {
    endpoint = proxyBaseUrl();
  } else {
    endpoint =
      (import.meta.env.VITE_LANGSMITH_ENDPOINT as string | undefined) ||
      (typeof process !== 'undefined' ? process.env?.LANGSMITH_ENDPOINT : undefined) ||
      'https://api.smith.langchain.com';
  }

  const project = getLangSmithProjectName();

  return { apiKey, endpoint, project };
}

export function isLangSmithEnabled(): boolean {
  return (
    langSmithTracingFromDocsEnv() ||
    isTruthyEnv(import.meta.env.VITE_LANGSMITH_PROXY as string | undefined) ||
    !!import.meta.env.VITE_LANGSMITH_API_KEY
  );
}

export function getLangSmithClient(): Client | null {
  if (_client) return _client;

  const config = getLangSmithConfig();
  if (!config.apiKey) return null;

  const workspaceId =
    (import.meta.env.VITE_LANGSMITH_WORKSPACE_ID as string | undefined) ||
    undefined;

  _client = new Client({
    apiKey: config.apiKey,
    apiUrl: config.endpoint,
    ...(workspaceId ? { workspaceId } : {}),
  });

  // Browser → Vercel-Proxy: multipart/form-data wird von @vercel/node oft als Objekt geparst und
  // im Proxy fälschlich JSON-stringifiziert → LangSmith 422. JSON-basiertes runs/batch funktioniert.
  const hasBrowserApiKey = !!import.meta.env.VITE_LANGSMITH_API_KEY;
  const proxyFlag = isTruthyEnv(import.meta.env.VITE_LANGSMITH_PROXY as string | undefined);
  const useProxy = !hasBrowserApiKey && (proxyFlag || langSmithTracingFromDocsEnv());
  if (useProxy) {
    const c = _client as unknown as { _multipartDisabled?: boolean };
    c._multipartDisabled = true;
  }

  return _client;
}

export function getLangSmithTracer(): LangChainTracer | null {
  if (_tracer) return _tracer;

  const config = getLangSmithConfig();
  if (!config.apiKey) {
    console.log(
      '[LangSmith] Tracing disabled – set LANGSMITH_TRACING=true and LANGSMITH_API_KEY (wie Doku), oder VITE_LANGSMITH_PROXY=true; Dev-Server neu starten.',
    );
    return null;
  }

  const client = getLangSmithClient();
  if (!client) return null;

  _tracer = new LangChainTracer({
    projectName: config.project,
    client,
  });

  console.log(`[LangSmith] Tracing enabled → project "${config.project}" via ${config.endpoint}`);
  return _tracer;
}

/**
 * Get callbacks config for LLM invocations.
 * Includes tracer + run metadata so alle drei Pipeline-Agenten in LangSmith
 * filterbar sind (tags agent-1/2/3, metadata pipeline_step, agent_role).
 */
export type LangSmithAgentLabel = 'asklepios-classifier' | 'asklepios-extractor' | 'asklepios-control';

const AGENT_LABELS: Record<
  LangSmithAgentLabel,
  { name: string; tags: string[]; pipeline_step: 1 | 2 | 3; agent_role: string }
> = {
  'asklepios-classifier': {
    name: 'Asklepios Classifier: Dokumentklassifizierung',
    tags: ['asklepios', 'classifier', 'classification', 'agent-1'],
    pipeline_step: 1,
    agent_role: 'classifier',
  },
  'asklepios-extractor': {
    name: 'Asklepios Extractor: Datenextraktion',
    tags: ['asklepios', 'extractor', 'tools', 'agent-2'],
    pipeline_step: 2,
    agent_role: 'extractor',
  },
  'asklepios-control': {
    name: 'Asklepios Control: Qualitätsprüfung',
    tags: ['asklepios', 'control', 'judge', 'quality-check', 'agent-3'],
    pipeline_step: 3,
    agent_role: 'judge',
  },
};

export function getLangSmithCallbacks(
  agentName: LangSmithAgentLabel,
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const tracer = getLangSmithTracer();
  if (!tracer) return undefined;

  const label = AGENT_LABELS[agentName];
  const sessionId = getPipelineLangSmithSessionId();

  return {
    callbacks: [tracer],
    runName: label.name,
    tags: label.tags,
    metadata: {
      ...metadata,
      ...(sessionId ? { session_id: sessionId } : {}),
      agent: agentName,
      pipeline_step: label.pipeline_step,
      agent_role: label.agent_role,
    },
  };
}

/**
 * Callback-Konfiguration für model.invoke — bevorzugt verschachtelte Runs unter
 * dem Pipeline-Parent-Run (RunTree in runDocumentPipeline), sonst flacher Fallback.
 */
export async function getLangSmithInvokeConfig(
  agentName: LangSmithAgentLabel,
  metadata?: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const label = AGENT_LABELS[agentName];
  const sessionId = getPipelineLangSmithSessionId();
  const meta = {
    ...metadata,
    ...(sessionId ? { session_id: sessionId } : {}),
    agent: agentName,
    pipeline_step: label.pipeline_step,
    agent_role: label.agent_role,
  };

  if (!isLangSmithEnabled()) {
    return undefined;
  }

  const parentTree = getPipelineLangSmithRoot();
  if (parentTree) {
    try {
      const callbacks = await getLangchainCallbacksForParentRun(parentTree);
      if (callbacks) {
        return {
          callbacks,
          runName: label.name,
          tags: label.tags,
          metadata: meta,
        };
      }
    } catch (e) {
      console.warn('[LangSmith] Nested callbacks failed, using flat tracer', e);
    }
  }

  return getLangSmithCallbacks(agentName, metadata);
}
