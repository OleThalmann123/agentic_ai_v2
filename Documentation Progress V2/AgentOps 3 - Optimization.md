# AgentOps 3 - Optimization

*Status: 15.05.2026*

## Purpose

This document maps the Optimization pillar of the watsonx Orchestrate
AgentOps framework (*LU09 - Managing Risk of AI Agents*, Slide 41, with
the Optimization Loop of Slides 66 and 67) onto the implemented state
of the Asklepios document pipeline. The pillar comprises two framework
cells: Insights and Optimization.

A precise scoping statement is required to avoid overstatement. The
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
| Insights | Find top-K issues for a specific agent | manual | 1.1 |
| Insights | Find top-K issues across all agents | out-of-scope | 4 |
| Insights | Find Root Cause for an identified issue | manual | 1.1 |
| Insights | UI and API | out-of-scope | 4 |
| Optimization | Performance Tuning | implemented (design-time) | 2.1 |
| Optimization | Agent flow / accuracy optimization | implemented (design-time) | 2.2 |
| Optimization | Prompt and Context Tuning | out-of-scope | 4 |
| Optimization | Retrieval and Tooling Optimization | out-of-scope | 4 |
| Optimization | Continuous Improvement Loop | out-of-scope | 4 |

## 1. Insights

### 1.1 Issue insight and root cause (manual)

Issue ranking and root-cause identification are operated manually
through the LangSmith UI and the Claude Code / `langsmith` CLI
connection documented in Pillar 1, section 1.3.3. Concretely: the
issue tags `tool_schema_fail` and `tool_loop_capped` (Pillar 1,
section 1.3) partition failing runs into known classes, and the
per-step cost, latency and token breakdown (Pillar 1, section 1.2)
identifies the dominant contributor within a run. This yields the same
result as a "top-K issues for this agent" view and a "find root cause"
action, performed on demand rather than through a dedicated insights
service. A worked example is the 2026-05-13 "Double Call" finding
recorded in Pillar 1, section 1.3.3.

Cross-agent ranking and a dedicated insights UI or API are out of
scope; see section 4.

## 2. Optimization

The levers below are fixed at design time and are justified directly
by the Observability metrics. Each lever names the signal that
motivates it and the corresponding framework optimization category.

### 2.1 Performance Tuning

- **Per-agent model routing.** The pipeline assigns the cheapest
  adequate model per role: Haiku 4.5 for the Classifier, Sonnet 4.6
  for the Extractor and the Control judge. The motivating signal is
  the per-model cost and latency breakdown of Pillar 1, section 1.2
  (model identity captured as `ls_model_name`). Routing the
  low-complexity classification step to Haiku removes Sonnet-level
  cost and latency from every run without measurable quality loss on
  that step. This realises the framework's "model routing" and
  "targeted model downgrade" levers as a fixed architectural decision.
- **Bounded reasoning budget.** The cycle cap `MAX_TOOL_ROUNDS = 3`
  (Pillar 1, section 1.3.2) caps worst-case cost and latency per run
  and prevents unbounded tool-correction loops. This is the
  "inference-time budget cap" lever applied statically.

### 2.2 Agent flow and accuracy optimization

The LLM-as-a-Judge confidence gate `overall_confidence >= 0.8`
(Pillar 2, section 2.1) routes the agent flow: runs at or above the
threshold complete autonomously (Human-Out-of-the-Loop), runs below it
are escalated to human review (Human-on-the-Loop). This is an
accuracy-versus-autonomy optimization decision, fixed at design time
rather than tuned through a feedback loop. The Cost Cap and Latency
Cap (Pillar 2, section 1.5) provide the production signal that would
trigger a future retuning of these levers; they are configured and
verified, but the retuning loop itself is out of scope (section 4).

## 3. Applied Optimization Levers

Sections 1 and 2 describe insight access and design-time levers. This
section records the levers that were executed as a closed
Observe -> Evaluate -> Optimize cycle: a signal observed in the
Observability pillar, a root cause identified, a fix applied in code,
and a projected before/after stated for verification by re-run. This
is the first loop closure; it remains bounded by section 4 (no curated
baseline, single-digit volume), so effects are stated as measured
deltas against the pipeline's own necessary-work floor, not against an
external benchmark.

Issue and root cause (whole-agent level, 5 of 5 clean sessions,
project `AgenticAI V2`, sweep 2026-05-15):

- **Issue 1, runtime cost and duration per document.** Per session
  about 0.20 to 0.27 USD, about 110 s, about 47 k tokens, 4 LLM calls;
  the necessary-work floor is about 0.13 to 0.18 USD, about 86 s,
  about 31 k tokens, 3 LLM calls. Root cause: the Extractor loop did
  not treat a successful `contract_data_submission` as terminal and
  forced a further model turn that only re-serialised the validated
  tool output (Pillar 1, section 1.3.3).
- **Issue 2, metric integrity.** Only 5 of 7 traces finalised
  (about 71 percent); the Cost and Latency Cap aggregates (Pillar 2,
  section 1.5) were computed over incomplete sessions. Root cause: the
  LangChain callback tracer batches were not awaited on teardown.

### Lever 1: Eliminate the redundant Extractor round (implemented)

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

### Lever 2: Flush the callback tracer on teardown (implemented)

- **Source:** Pillar 1, sections 1.1 and 1.2 (pending and truncated
  traces distorting the metric layer).
- **Fix:** `flushLangSmithClient()` (`agent/langsmith.ts`) is awaited
  unconditionally in the `pipeline.ts` `finally` block, draining the
  shared client used by both the RunTree and the callback tracer.
- **Effect:** trace completeness about 71 percent to about 100 percent;
  the Cap aggregates of Pillar 2, section 1.5 become trustworthy.

### Lever 3: Prompt caching on the static system prompts (implemented)

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

### Lever 4: Cheaper Control judge model (proposed, gated)

- **Source:** Pillar 1, section 1.2 (cost breakdown; Control is the
  slowest single span, about 0.05 USD per document).
- **What:** set `DEFAULT_JUDGE_MODEL` or `VITE_OPENROUTER_JUDGE_MODEL`
  (`model-config.ts`) to `anthropic/claude-haiku-4.5`, the mechanism
  already used by the Classifier.
- **Status:** not implemented. It moves the LLM-as-Judge gate
  (`overall_confidence >= 0.8`, Pillar 2, section 2.1) and the
  Human-on-the-Loop boundary, so it requires a judge-quality
  evaluation against a curated dataset, which is out of scope
  (Pillar 2, section 4).

### Lever 5: Shorten the judge user prompt (proposed, gated)

- **Source:** Pillar 1, section 1.2 (token breakdown; the Control
  token volume sits in the user prompt, not the about 400-token
  system prompt).
- **What:** (a) remove the `buildJudgeSkeleton` echo, which duplicates
  every field name already present in the extraction payload;
  (b) serialise the extraction without pretty-print whitespace;
  (c) do not trim the system-prompt rule list (the IBAN and vacation
  hallucination guards are correctness guarantees).
- **Status:** not implemented; (a) changes the output-schema
  instruction and can affect judge JSON conformance, so it is gated on
  the same judge-quality evaluation as Lever 4.

Before/after example (real session, trace
`019e2571-5010-7000-8000-008484ba15ec`; after-values projected from
the directly measured redundant span, to be replaced by a re-run
measurement):

| Metric | Before | After (projected, Lever 1) |
|---|--:|--:|
| Cost per document | 0.266 USD | about 0.183 USD (-31 %) |
| Latency per document | 112.65 s | about 89 s (-21 %) |
| LLM calls | 4 | 3 |

Verification of the applied levers 1 to 3: re-run the same document
and pull a fresh trace; expect exactly three LLM spans, no second
Extractor span, `contracts` identical to the prior trace (no quality
regression), trace status finalised with no `pending` child runs, and
`cache_read` greater than zero on repeat runs.

## 4. Out of Scope

The continuous, closed Optimization Loop and its remaining sub-items
are deliberately not operated in the current prototype phase. The
shared reason is the same as in Pillar 2, section 4: there is no
curated baseline dataset, and at single-digit run volume a
feedback-driven loop would produce statistically insignificant
deltas while incurring fixed build and maintenance cost.

- **Continuous Improvement Loop.** The levers of section 2 are set
  once at design time and are not yet re-derived from production
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
  and issue insight is operated through the existing LangSmith UI and
  CLI rather than a separate insights service.

## Reference to the Framework Table

This document covers the Optimization row of the watsonx Orchestrate
AgentOps framework (*LU09 - Managing Risk of AI Agents*, Slide 41;
Optimization Loop, Slides 66 and 67): the cells Insights and
Optimization, to the extent realised as design-time levers in the
current project state.
