# AgentOps 3 - Optimization

*Status: 17.05.2026*

## Purpose

This document maps the Optimization pillar of the watsonx Orchestrate
AgentOps framework (*LU09 - Managing Risk of AI Agents*, Slide 41, with
the Optimization Loop of Slides 66 and 67) onto the implemented state
of the Asklepios document pipeline. The pillar comprises two framework
cells: Insights and Optimization.

A scoping statement is required to avoid overstatement. The
framework's Optimization pillar is a closed continuous-improvement
loop: a signal observed in production is evaluated, an intervention is
applied, and the result is fed back as a new baseline. That loop is
not operated here, because closing it requires a stable baseline
dataset and a run volume that the prototype does not have. What does
exist, and what this document records, is the set of static
optimization levers fixed at design time on the basis of the
Observability metrics (Pillar 1). These are deliberate optimization
decisions, not a running optimization process; they are reported as
such.

## Coverage of the Optimization Cells

| Cell | Sub-item | Status | Section |
|---|---|---|---|
| Insights | Find top-K issues for a specific agent | via prompt | 1.1 |
| Insights | Find top-K issues across all agents | out-of-scope | 4 |
| Insights | Find Root Cause for an identified issue | via prompt | 1.1 |
| Insights | UI and API | out-of-scope | 4 |
| Optimization | Applied levers (cost / latency) | implemented | 2 |
| Optimization | Prompt and Context Tuning | out-of-scope | 4 |
| Optimization | Retrieval and Tooling Optimization | out-of-scope | 4 |
| Optimization | Continuous Improvement Loop | out-of-scope | 4 |

## 1. Insights

### 1.1 Issue insight and root cause (via prompt)

Issue ranking and root-cause identification are not run through a
dedicated insights service. They are operated via prompt through
Claude Code, connected to LangSmith by the locally installed
`langsmith` CLI and the `langsmith-trace` skill (Pillar 1, section
1.3.3). Claude Code was prompted to pull the last five traces from the
`AgenticAI V2` project, parse the span hierarchy, and compare tokens,
cost and latency per step. The agent returned **cost** and **latency**
as the dominant issues.

This is evidenced by the worked trace of 2026-05-13: a representative
session cost 0.266 USD over 112.65 s across 4 LLM calls; the redundant
second Extractor span (the "Double Call") alone accounted for about
0.083 USD and about 24 s — roughly one third of the pipeline cost —
with no information gain (Pillar 1, section 1.3.3). Cost and latency
are thereby verified as the dominant, addressable issues directly
against the trace material.

Cross-agent ranking (top-K across all agents) and a dedicated insights
UI or API are out of scope; see section 4.

## 2. Applied Optimization Levers

Section 1 covers insight access. This section documents the
optimization levers the pipeline applies, each traced to the
Observability signal that motivated it and to its measured effect.
Effects are stated as deltas against the pipeline's own
necessary-work floor, the productive calls, rather than against an
external benchmark, consistent with the scope boundary of section 4.

The motivating analysis:

- **Runtime cost and duration per document.** A representative session
  cost 0.266 USD over 112.65 s with 4 LLM calls; the redundant second
  Extractor span alone accounted for about 0.083 USD and about 24 s.
  The Extractor loop did not treat a successful
  `contract_data_submission` as terminal and forced a further model
  turn that only re-serialised the validated tool output (Pillar 1,
  section 1.3.3).
- **Metric integrity.** A fraction of sessions did not finalise, so
  the Cost and Latency Cap aggregates (Pillar 2, section 1.5) were
  computed over incomplete data. The LangChain callback tracer batches
  were not awaited on teardown.

### Per-agent map

- **Classifier** — Lever 3 (prompt caching).
- **Extractor** — Lever 1 (terminal tool submission), Lever 3 (prompt
  caching).
- **Control (Judge)** — Lever 3 (prompt caching), Lever 4 (model
  selection), Lever 5 (compact prompt), Lever 6 (minimal response).
- **Pipeline-wide / infrastructure** — Lever 2 (deterministic trace
  flush).

### Lever 1: Terminal tool submission in the Extractor

- **Source:** Pillar 1, section 1.3.3 (Root Cause Analysis; span
  reading via Claude Code and the `langsmith` CLI).
- **Fix:** `packages/core/src/agent/asklepios-extractor.ts`,
  `runAgentWithTools`: a successful `contract_data_submission` breaks
  the loop before the second model invoke; `extraction_metadata` is
  derived deterministically (`countExtractionFields`, classifier
  language, tool envelope warnings) instead of from a second LLM pass.
- **Effect per document:** about -0.07 USD, about -24 s, about -50 %
  Extractor tokens, 4 -> 3 LLM calls. No quality effect: `contracts`
  always derived solely from the tool.

### Lever 2: Deterministic trace flush

- **Source:** Pillar 1, sections 1.1 and 1.2 (pending and truncated
  traces distorting the metric layer).
- **Fix:** `flushLangSmithClient()` (`agent/langsmith.ts`) is awaited
  unconditionally in the `pipeline.ts` `finally` block, draining the
  shared client used by both the RunTree and the callback tracer.
- **Effect:** trace completeness about 71 percent to about 100 percent;
  the Cap aggregates of Pillar 2, section 1.5 become trustworthy.

### Lever 3: Prompt caching of the static system prompts

- **Source:** Pillar 1, section 1.2 (token detail fields show
  `cache_read = 0`; the static per-agent system prompt is re-sent
  verbatim every run).
- **Fix:** `cachedSystemMessage` (`model-config.ts`) marks the static
  system prompt of all three agents (Classifier, Extractor, Control)
  as an ephemeral cache breakpoint; the per-document user prompt stays
  uncached. Inert if a provider ignores `cache_control` (no
  behavioural or quality change).
- **Effect:** removes the static system-prompt input-token cost on
  cache hits across all three agents.

### Lever 4: Judge model selection

The Control judge is the slowest single span and the largest per-call
cost (Pillar 1, section 1.2; about 0.05 USD per document). A cheaper
judge model (`anthropic/claude-haiku-4.5`, the mechanism the
Classifier already uses, configurable via `DEFAULT_JUDGE_MODEL` or
`VITE_OPENROUTER_JUDGE_MODEL` in `model-config.ts`) would reduce that
cost, but it moves the LLM-as-Judge gate
(`overall_confidence >= 0.8`, Pillar 2, section 2.1) and therefore the
Human-on-the-Loop boundary. A change of judge model would require a
judge-quality evaluation against a curated dataset, which is out of
scope (section 4); the judge consequently stays on the frontier model
as a deliberate accuracy decision.

### Lever 5: Compact judge prompt

- **Source:** Pillar 1, section 1.2 (token breakdown; the Control
  token volume sits in the user prompt, not the about 400-token
  system prompt; the per-field skeleton echo was about 63 percent of
  the judge text prompt, about 2300 of 3645 tokens).
- **Fix:** `asklepios-control.ts`: (a) the per-field
  `buildJudgeSkeleton` echo was removed and replaced by a constant,
  field-count-independent `JUDGE_OUTPUT_SCHEMA` (one generic field
  example plus an explicit instruction to mirror the EXTRAKTION keys);
  (b) the extraction is serialised without pretty-print whitespace;
  (c) the system-prompt rule list (IBAN and vacation hallucination
  guards) was left unchanged.
- **Effect:** the judge text prompt drops from about 3645 to about
  1350 tokens per document, independent of field count, with the
  scoring rules and full field coverage preserved.

### Lever 6: Minimal judge response

- **Source:** Pillar 1, section 1.2 (judge output token breakdown).
  The Control completion was about 4180 tokens; the per-field free
  text (justification plus source_quote plus summary) was about 35
  percent of the output, and the justification on the 33 ok-status
  fields alone was about 554 tokens, plus about 178 tokens
  source_quote on ok-fields.
- **Fix:** `asklepios-control.ts`: the per-field judge object is
  reduced to `{ "confidence_score": <0.0-1.0> }`; `confidence`,
  `status`, `justification`, `source_found`, `source_quote` are
  removed from the output schema, the prompt instruction and (as
  optional) the `JudgeFieldResult` interface. Top-level
  `overall_confidence`, `overall_status`, `review_required_fields`,
  `summary` are kept (consumed by `pipeline.ts`). The system-prompt
  scoring rules (IBAN and vacation guards) are unchanged.
  `asklepios-extractor.ts` `mergeWithJudgeResult` derives the
  `confidence` enum deterministically from `confidence_score` and
  takes `source_text` from the extractor's own per-field source; the
  judge `source_quote` fallback is dropped.
- **Effect:** the per-field free text is removed from the judge
  response; the Control completion shrinks by roughly three quarters
  (see section 3). The per-field judge audit text, internal-only
  per Pillar 2 section 2.1, is no longer produced; the country prefill
  in the UI falls back to its existing note and value-normalisation
  path without breaking.

## 3. Results

The Control completion figures are directly attributable: the Control
input (prompt) token count is essentially unchanged, so the completion
reduction is caused by the smaller response, not by a different input.
The pipeline-level figures are indicative, since the documents across
sessions are not a controlled A/B.

Control span (Levers 5 and 6):

| Control span | Before | After | Delta |
|---|--:|--:|--:|
| Completion tokens | 4180 | 1000 | -76 % |
| Total tokens | 9590 | 6286 | -34 % |
| Cost | 0.079 USD | 0.031 USD | -61 % |
| Latency | 42.3 s | 12.6 s | -70 % |
| Judge JSON size | about 12060 chars | about 2711 chars | -78 % |

Pipeline per document, cumulative over all levers (indicative):

| Per document | Before | After | Delta |
|---|--:|--:|--:|
| Cost | 0.266 USD | 0.085 USD | -68 % |
| Latency | 112.65 s | 43.72 s | -61 % |
| Tokens | 56667 | 18645 | -67 % |
| LLM calls | 4 | 3 | -1 |

The judge continues to score every field and to flag the
review-required fields; the scoring behaviour is preserved while both
the prompt and the response are substantially smaller.

## 4. Out of Scope

The continuous, closed Optimization Loop and its remaining sub-items
are deliberately not operated in the current prototype phase. The
shared reason is the same as in Pillar 2, section 4: there is no
curated baseline dataset, and at single-digit run volume a
feedback-driven loop would produce statistically insignificant
deltas while incurring fixed build and maintenance cost.

- **Continuous Improvement Loop.** The applied levers of section 2 are
  set once at design time and are not yet re-derived from production
  feedback against a committed baseline. Closing the loop is
  recoverable once a curated evaluation set and sufficient volume
  exist.
- **Prompt and Context Tuning.** Prompts are hand-authored and
  versioned with the code; there is no automated, evaluation-driven
  prompt or context tuning cycle.
- **Retrieval and Tooling Optimization.** The pipeline performs no
  retrieval or RAG step, and the tool surface is a single validated
  submission tool; there is no retrieval relevance or tool-selection
  search space to optimise.
- **Insights: cross-agent top-K and dedicated UI/API.** The system is
  a single owned pipeline, so cross-agent ranking is not meaningful,
  and issue insight is operated via prompt through the existing
  LangSmith CLI rather than a separate insights service.

## Reference to the Framework Table

This document covers the Optimization row of the watsonx Orchestrate
AgentOps framework (*LU09 - Managing Risk of AI Agents*, Slide 41;
Optimization Loop, Slides 66 and 67): the cells Insights and
Optimization, to the extent realised as design-time levers in the
current project state.
