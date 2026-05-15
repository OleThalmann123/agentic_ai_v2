/**
 * IDP Pipeline – Agentic Workflow
 *
 * Step 1: PDF/Document Extraction
 * Step 2: Asklepios Classifier – Ist es ein Arbeitsvertrag? (ja/nein, LLM-basiert)
 * Step 3: Asklepios Extractor – Datenextraktion + Validierung (Tools)
 * Step 4: Safety-Check – Hat Agent Vertragsdaten zurückgegeben?
 * Step 5: Asklepios Control – Konfidenz-Bewertung (LLM-as-a-Judge)
 * Step 6: Binary Mapping – confidence → ok / review_required
 * Step 7: Return result with full trace (observability)
 *
 * 3 Agents: Classifier (Haiku) → Extractor (Sonnet) → Control (Sonnet)
 * Everything runs in the browser – no separate backend needed.
 */

import { ContractExtractionResult, DocumentClassification } from './types';
import {
  extractContractData,
  extractContractFromImages,
  mergeWithJudgeResult,
} from './asklepios-extractor';
import { readFileContent } from './pdf-extractor';
import { runJudge } from './asklepios-control';
import {
  classifyDocument,
  classifyDocumentFromImages,
} from './asklepios-classifier';
import {
  startTrace,
  addTraceStep,
  completeTraceStep,
  completeTrace,
  failTrace,
  type PipelineTrace,
} from './trace';
import { RunTree } from 'langsmith/run_trees';
import {
  getLangSmithClient,
  getLangSmithProjectName,
  isLangSmithEnabled,
  setPipelineLangSmithRoot,
  setPipelineLangSmithSessionId,
  flushLangSmithClient,
} from './langsmith';
import { getExtractorModelName, getJudgeModelName, getClassifierModelName } from './model-config';

export interface PipelineResult {
  classification: DocumentClassification;
  extraction?: ContractExtractionResult;
  requiresReview: boolean;
  reviewFields: string[];
  trace: PipelineTrace;
  assistant_id?: string;
}

async function runDocumentPipelineImpl(
  file?: File,
  text?: string | null,
): Promise<PipelineResult> {
  const trace = startTrace();

  try {
    if (!file && !text) {
      throw new Error('No file or text to analyze.');
    }

    // ── Step 1: Document Extraction ──
    const step1 = addTraceStep('pdf_extraction', 'Dokument lesen', {
      fileName: file?.name,
      fileType: file?.type,
      hasText: !!text,
    });

    let documentText = text || '';
    let images: string[] | undefined;

    if (file && !documentText) {
      const fileContent = await readFileContent(file);
      documentText = fileContent.text;
      images = fileContent.images;
    }

    if (!documentText && !images?.length) {
      throw new Error(
        'Konnte keinen Text oder Bilder aus dem Dokument extrahieren.',
      );
    }

    completeTraceStep(step1, {
      textLength: documentText.length,
      imageCount: images?.length ?? 0,
      isScanned: !!images?.length,
    });

    // ── Step 2: Asklepios Classifier – Ist es ein Arbeitsvertrag? ──
    // LLM-basierte Klassifizierung: Schweizer IV-Assistenz-Arbeitsvertrag ja/nein.
    // Bei "nein" → Pipeline bricht ab, Dokument wird abgelehnt.
    const step2 = addTraceStep('classification', 'Asklepios Classifier: Dokumentklassifizierung', {
      mode: images?.length ? 'vision' : 'text',
      model: getClassifierModelName(),
    });

    const classificationResult = images?.length
      ? await classifyDocumentFromImages(images)
      : await classifyDocument(documentText);

    completeTraceStep(step2, {
      is_contract: classificationResult.is_contract,
      document_type: classificationResult.document_type,
      confidence: classificationResult.confidence,
      justification: classificationResult.justification,
    });

    if (!classificationResult.is_contract) {
      const finalTrace = completeTrace({
        fieldsExtracted: 0,
        fieldsMissing: 0,
        fieldsRequiringReview: 0,
        overallConfidence: 0,
        modelUsed: getClassifierModelName(),
        judgeModelUsed: 'n/a',
        toolsCalled: [],
      });

      return {
        classification: 'other',
        requiresReview: false,
        reviewFields: [],
        trace: finalTrace,
      };
    }

    // ── Step 3: Asklepios Extractor – Extraktion mit Tools ──
    // Nutzt document_classification + contract_data_submission selbständig.
    // Tool-Output ist das autoritative Ergebnis (kein LLM-Fallback).
    const step3 = addTraceStep('agent_extraction', 'Asklepios Extractor: Datenextraktion', {
      mode: images?.length ? 'vision' : 'text',
    });

    let rawResult;
    let toolCalls: string[] = [];

    if (images && images.length > 0) {
      const extracted = await extractContractFromImages(
        images,
        classificationResult.language,
      );
      rawResult = extracted.raw;
      toolCalls = extracted.toolCalls;
    } else {
      const extracted = await extractContractData(
        documentText,
        classificationResult.language,
      );
      rawResult = extracted.raw;
      toolCalls = extracted.toolCalls;
    }

    completeTraceStep(step3, {
      fieldsExtracted: rawResult.extraction_metadata.fields_extracted,
      fieldsMissing: rawResult.extraction_metadata.fields_missing,
      warnings: rawResult.extraction_metadata.warnings,
      toolsUsed: toolCalls,
    });

    // Enforce tool usage: contract_data_submission MUST have been called.
    // It ensures Swiss-specific validation (IBAN, AHV, canton, enums,
    // hallucination guards) actually ran.
    // Note: document_classification is no longer needed here –
    // Asklepios Classifier (Agent 1) handles classification before extraction.
    const hadContracts =
      rawResult.contracts &&
      (rawResult.contracts.employer ||
        rawResult.contracts.assistant ||
        rawResult.contracts.contract_terms);
    const submissionCalled = toolCalls.includes('contract_data_submission');
    if (hadContracts && !submissionCalled) {
      throw new Error(
        'Asklepios Extractor hat contract_data_submission nicht aufgerufen – Validierung fehlt, Ergebnis nicht akzeptiert.',
      );
    }

    // ── Step 4: Safety-Check – Hat Agent Vertragsdaten zurückgegeben? ──
    const step4 = addTraceStep('classification', 'Vertragserkennung (Safety-Check)');

    const hasContracts =
      rawResult.contracts &&
      (rawResult.contracts.employer ||
        rawResult.contracts.assistant ||
        rawResult.contracts.contract_terms);

    if (!hasContracts) {
      completeTraceStep(step4, { classification: 'other' });
      const finalTrace = completeTrace({
        fieldsExtracted: 0,
        fieldsMissing: 0,
        fieldsRequiringReview: 0,
        overallConfidence: 0,
        modelUsed: getExtractorModelName(),
        judgeModelUsed: 'n/a',
        toolsCalled: toolCalls,
      });

      return {
        classification: 'other',
        requiresReview: false,
        reviewFields: [],
        trace: finalTrace,
      };
    }

    completeTraceStep(step4, { classification: 'contract' });

    // Stunden/Monat: weder extrahieren noch bewerten (nur Stunden/Woche).
    const ct = rawResult.contracts?.contract_terms as Record<string, unknown> | undefined;
    if (ct && 'hours_per_month' in ct) {
      delete ct.hours_per_month;
    }

    // ── Step 5: Asklepios Control – Qualitätsprüfung ──
    const step5 = addTraceStep('agent_judge', 'Asklepios Control: Qualitätsprüfung', {
      inputFields: Object.keys(rawResult.contracts),
      mode: images?.length ? 'vision' : 'text',
    });

    // Pass images to the Judge when available so it can visually verify
    // the extraction against the original document.
    const judgeResult = await runJudge(documentText, rawResult.contracts, images);

    completeTraceStep(step5, {
      overallConfidence: judgeResult.overall_confidence,
      overallStatus: judgeResult.overall_status,
      reviewRequiredFields: judgeResult.review_required_fields,
      summary: judgeResult.summary,
    });

    // ── Step 6: Merge & Binary Mapping ──
    const step6 = addTraceStep('binary_mapping', 'Binäre Statuszuordnung');

    const finalExtraction = mergeWithJudgeResult(rawResult, judgeResult) as unknown as ContractExtractionResult;

    completeTraceStep(step6, {
      overallStatus: finalExtraction.extraction_metadata.overall_status,
      fieldsRequiringReview: finalExtraction.extraction_metadata.fields_requiring_review,
      reviewFields: finalExtraction.extraction_metadata.review_required_fields,
    });

    // ── Step 7: Complete ──
    const requiresReview =
      finalExtraction.extraction_metadata.overall_status === 'review_required';

    const finalTrace = completeTrace({
      fieldsExtracted: finalExtraction.extraction_metadata.fields_extracted,
      fieldsMissing: finalExtraction.extraction_metadata.fields_missing,
      fieldsRequiringReview: finalExtraction.extraction_metadata.fields_requiring_review ?? 0,
      overallConfidence: finalExtraction.extraction_metadata.overall_confidence,
      modelUsed: getExtractorModelName(),
      judgeModelUsed: getJudgeModelName(),
      toolsCalled: toolCalls,
    });

    return {
      classification: 'contract',
      extraction: finalExtraction,
      requiresReview,
      reviewFields: finalExtraction.extraction_metadata.review_required_fields ?? [],
      trace: finalTrace,
    };
  } catch (error: any) {
    const errorTrace = failTrace(error?.message || 'Unknown error');
    throw Object.assign(error, { trace: errorTrace });
  }
}

/**
 * Öffentliche Pipeline: legt bei aktivem LangSmith einen Root-Run an, damit alle
 * Agent-/LLM-Spans in der UI unter einem Trace hängen (statt vieler Root-Zeilen).
 */
export async function runDocumentPipeline(
  file?: File,
  text?: string | null,
): Promise<PipelineResult> {
  const client = isLangSmithEnabled() ? getLangSmithClient() : null;
  console.info('[LangSmith][diag]', {
    enabled: isLangSmithEnabled(),
    hasClient: !!client,
    project: getLangSmithProjectName(),
    proxyUrl:
      typeof window !== 'undefined' ? `${window.location.origin}/api/langsmith` : null,
  });
  if (import.meta.env.DEV && !client) {
    console.warn(
      '[LangSmith] Aus — keine Runs. Wie Doku: LANGSMITH_TRACING=true, LANGSMITH_API_KEY, LANGSMITH_PROJECT in ibm-agentic-ai-/.env; optional VITE_LANGSMITH_PROXY=true für expliziten Proxy. Dev-Server neu starten. npm run preview ohne Proxy; Production: gleiche Variablen auf Vercel + /api/langsmith + Redeploy nach Env-Änderungen.',
    );
  }
  let rootRun: RunTree | undefined;
  const sessionId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  if (client) {
    const project = getLangSmithProjectName();
    rootRun = new RunTree({
      name: 'Asklepios_extract: Dokument-Pipeline',
      client,
      project_name: project,
      run_type: 'chain',
      tracingEnabled: true,
      tags: ['asklepios', 'asklepios_extract', 'pipeline', 'idp'],
      metadata: { session_id: sessionId },
      inputs: {
        fileName: file?.name ?? null,
        hasText: !!text,
      },
    });
    await rootRun.postRun();
    setPipelineLangSmithRoot(rootRun);
    setPipelineLangSmithSessionId(sessionId);
  }

  try {
    const result = await runDocumentPipelineImpl(file, text);
    if (rootRun) {
      await rootRun.end({
        classification: result.classification,
        requiresReview: result.requiresReview,
        reviewFieldCount: result.reviewFields.length,
      });
      await rootRun.patchRun();
    }
    return result;
  } catch (e: unknown) {
    if (rootRun) {
      const msg = e instanceof Error ? e.message : String(e);
      await rootRun.end(undefined, msg);
      await rootRun.patchRun().catch(() => {});
    }
    throw e;
  } finally {
    setPipelineLangSmithRoot(null);
    setPipelineLangSmithSessionId(null);
    // Drain the shared client (RunTree + callback tracer) unconditionally,
    // on success and error, so child spans are flushed before teardown
    // instead of being left as `pending` runs in LangSmith.
    await flushLangSmithClient();
  }
}
