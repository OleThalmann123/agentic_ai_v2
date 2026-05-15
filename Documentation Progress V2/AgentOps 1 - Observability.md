# AgentOps 1 - Observability

*Status: 15.05.2026*

## Purpose

This document maps the Observability pillar of the watsonx Orchestrate
AgentOps framework (*LU09 - Managing Risk of AI Agents*, Slide 41) onto
the implemented state of the Asklepios document pipeline. The pillar
comprises three framework cells: Trace Capture and Visualization, Trace
Level Metrics, and Issue Detection. The instrumentation backend is
LangSmith, chosen because the pipeline is built on `@langchain/core`
and `@langchain/openai`; LangChain emits trace events through its
callback system, and LangSmith (maintained by LangChain Inc.) consumes
that protocol directly, which removes the need for a second,
parallel instrumentation layer.

## Coverage of the Observability Cells

| Cell | Sub-item | Status | Section |
|---|---|---|---|
| Trace Capture and Visualization | Tracing SDK | implemented | 1.1 |
| Trace Capture and Visualization | Tracing and Logs | implemented | 1.1 |
| Trace Capture and Visualization | Visualize traces | implemented | 1.1 |
| Trace Capture and Visualization | Search traces and spans | implemented | 1.1, 1.2 |
| Trace Level Metrics | Cost (USD) | implemented | 1.2 |
| Trace Level Metrics | Latency | implemented | 1.2 |
| Trace Level Metrics | Token count (input/output) | implemented | 1.2 |
| Trace Level Metrics | LLM / Tools called | implemented | 1.2 |
| Issue Detection | Tool issue detection | implemented | 1.3.1 |
| Issue Detection | Cycle detection | implemented | 1.3.2 |
| Issue Detection | Root Cause Analysis | manual | 1.3.3 |

Automated Root Cause Analysis is the only Observability sub-item not
realised as code; its rationale and deferral are stated in section 4.

## 1.1 Trace Capture and Visualization

Each pipeline run produces one hierarchical trace. The hierarchy is
constructed through `RunTree` objects in
`packages/core/src/agent/pipeline.ts`; child spans attach to the root
run through the LangChain callback context, so the structure is built
from the SDK callback protocol rather than declared manually. Traces
are persisted to, visualised in, and searchable from the LangSmith
project `AgenticAI V2`. The browser path routes through a server-side
proxy (`api/langsmith/*`) so the API key is never exposed client-side.

Representative trace structure:

    Asklepios_extract: Dokument-Pipeline     (root run, type: chain)
    +- Classifier: Dokumentklassifizierung   (type: llm, model: Haiku 4.5)
    +- Extractor: Datenextraktion            (type: llm, model: Sonnet 4.6)
    |  +- Tool: contract_data_submission     (type: tool)
    |  +- Extractor: Datenextraktion         (type: llm, tool-response round)
    +- Control: Qualitaetspruefung           (type: llm, model: Sonnet 4.6)

Span names are literal identifiers stored in LangSmith and are not
translated; the parenthesised annotations are descriptions, not part
of the identifier. Search across traces and spans is provided by the
LangSmith UI and by the `langsmith` CLI over the structured tags and
metadata documented in section 1.2.

Three skills from the LangSmith skills repository (`agent-skills/`)
are activated in the Claude Code setup and define the integration
patterns used here:

| Skill | Scope |
|---|---|
| `langsmith-trace` | Instrumenting applications and querying or exporting traces via the `langsmith` CLI |
| `langsmith-dataset` | Evaluation dataset management (types `final_response`, `single_step`, `trajectory`, `RAG`) |
| `langsmith-evaluator` | Evaluator definition and execution (LLM-as-Judge and code-based) |

`langsmith-dataset` and `langsmith-evaluator` operationally belong to
Pillar 2 and are referenced in the Evaluation document.

## 1.2 Trace Level Metrics

For every model and tool call LangSmith records the quantities the
framework defines as mandatory, inspectable at the corresponding span:

- **Inputs and outputs**: full prompts, responses, tool arguments and
  tool results are persisted and inspectable.
- **Token count**: input and output tokens, plus cache token detail
  fields (`cache_read`, `ephemeral_5m_input_tokens`,
  `ephemeral_1h_input_tokens`) when prompt caching is enabled.
- **Latency**: duration per step and for the full pipeline run.
- **Cost in USD**: model prices are configured in LangSmith (Settings,
  Model Pricing Map) from the OpenRouter rates for Sonnet 4.6 (prompt
  `$3` / completion `$15` per 1M tokens) and Haiku 4.5 (prompt `$1` /
  completion `$5` per 1M tokens), including cache token prices.
  LangSmith computes `prompt_cost`, `completion_cost` and `total_cost`
  deterministically per run and aggregates at trace level.
- **LLM identity**: the model per call is captured in run metadata as
  `ls_model_name` (for example `anthropic/claude-sonnet-4.6`,
  `anthropic/claude-haiku-4.5`), which permits a per-model breakdown
  of cost and latency. This breakdown is the precondition for the
  optimization levers documented in Pillar 3.
- **Tool calls**: tool name, arguments, return value and validation
  outcome (status `success` / `warning` / `error` from the Zod-based
  validator).
- **Tags and metadata** on every span, enabling precise filtering:
  - `pipeline_step` (`1` Classifier, `2` Extractor, `3` Control).
  - `agent_role` (`classifier` / `extractor` / `judge`), the semantic
    role independent of pipeline step.
  - `session_id` (a UUID assigned per pipeline run) links all spans
    of one document upload as a reproducibly findable unit even where
    hierarchical nesting does not apply.
  - Semantic tags (`asklepios`, `agent-1`, `agent-2`, `agent-3`) and
    mode markers (`vision-with-tools`) supporting per-domain and
    per-mode dashboards.

These fields support queries such as "all judge runs with confidence
score below 0.7" or "all spans with session ID X", which is the basis
for the Issue Detection of section 1.3.

Reference measurement from a production trace on 2026-05-13: total
cost `$0.205`, distributed across four LLM spans (Classifier `$0.005`,
Extractor round 0 `$0.046`, Extractor round 1 `$0.064`, Control
`$0.090`); total latency 91.5 s; total tokens 37,018.

## 1.3 Issue Detection

Issue Detection identifies known failure classes per run. The
framework defines three components.

### 1.3.1 Tool issue detection (detector `tool_schema_fail`)

The Extractor returns extracted contract data through the tool
`contract_data_submission`. The tool validates the returned JSON
against a Zod schema and emits a `status` field of `success`,
`warning` or `error`. The detector scans every new trace for this
tool span and assigns the tag `tool_schema_fail` to the root run as
soon as `status != "success"`. Example: the model returns a birth
date `"32.13.2026"`; Zod validation fails; the tool sets
`status: "warning"`; the next detector sweep tags the trace. The
LangSmith filter `tag:tool_schema_fail` then returns every run with a
malformed data structure without per-trace inspection.

### 1.3.2 Cycle detection (detector `tool_loop_capped`)

The Extractor permits at most `MAX_TOOL_ROUNDS = 3` tool-call rounds
per run (one round = model proposal, tool validation, model
correction). At the cap the code forces a final model call without
tool bindings so the run cannot stall. The current round number is
attached to each span as metadata `tool_round`; the detector tags the
root run `tool_loop_capped` when a child span carries
`tool_round >= MAX_TOOL_ROUNDS`. The filter `tag:tool_loop_capped`
isolates runs that exceeded the intended round budget; these are
direct candidates for prompt revision or model upgrade.

### 1.3.3 Root Cause Analysis

Automated RCA is not implemented in code; it is operated manually
through Claude Code, connected to LangSmith by three components: the
locally installed `langsmith` CLI wrapping the LangSmith REST API;
authentication via `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT` and
`LANGSMITH_PROJECT` from the repository `.env`; and the
`langsmith-trace` skill providing the call patterns and data model.
Through this connection Claude Code pulls any trace from
`AgenticAI V2`, parses the span hierarchy, compares tokens, cost and
latency per step, inspects inputs and outputs, and derives root-cause
hypotheses verifiable against the trace material. Example: an analysis
on 2026-05-13 surfaced the "Double Call" in the Extractor, a second
LLM invocation after a successful tool call that adds no information
yet accounts for roughly one third of pipeline cost; the hypothesis
was verified directly against the trace. The deferral of an automated
RCA layer is stated in section 4.

## 4. Out of Scope

A fully automated RCA layer (rule-based triage over combined issue
tags, or LLM-as-Judge over failure traces) is deferred. At the current
run volume the manual procedure of section 1.3.3 yields the same
diagnostic result without the fixed cost of building and maintaining
an automated triage layer; automation is introduced once trace volume
makes the per-incident manual cost dominant.

## Reference to the Framework Table

This document covers the Observability row of the watsonx Orchestrate
AgentOps framework (*LU09 - Managing Risk of AI Agents*, Slide 41):
the cells Trace Capture and Visualization, Trace Level Metrics, and
Issue Detection.
