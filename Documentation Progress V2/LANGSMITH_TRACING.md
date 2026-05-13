# Observability via LangSmith

## Motivation and Tool Selection

We chose LangSmith because it integrates natively with the LangChain
ecosystem our document pipeline is built on (`@langchain/core`,
`@langchain/openai`). LangChain already emits trace events through its
callback system, and LangSmith (developed by the same maintainer,
LangChain Inc.) consumes this protocol directly. This eliminates the
need for a second, parallel instrumentation layer.

## Coverage: Pillar 1, Trace Capture and Visualization

LangSmith provides Trace Capture and Visualization in our setup: each
pipeline run produces a complete, hierarchical trace that lets us
follow the flow and localize error sources.

Example trace structure in the `AgenticAI V2` project:

    Asklepios_extract: Dokument-Pipeline       (Root run, type: chain)
    ├─ Classifier: Dokumentklassifizierung     (type: llm, model: Haiku 4.5)
    ├─ Extractor: Datenextraktion              (type: llm, model: Sonnet 4.6)
    │  ├─ Tool: contract_data_submission       (type: tool)
    │  └─ Extractor: Datenextraktion           (type: llm, tool-response round)
    └─ Control: Qualitätsprüfung               (type: llm, model: Sonnet 4.6)

(Span names are literal identifiers stored in LangSmith and not
translated; the descriptors in parentheses are annotations.)

## Captured Metrics per Trace

- **Inputs and outputs** of each model and tool call: the full prompts,
  responses, tool arguments, and tool results are inspectable.
- **Token usage**: input and output tokens, plus cache tokens once
  prompt caching is enabled.
- **Latency**: duration per step and for the entire trace.
- **Cost in USD**: model prices are configured manually in LangSmith
  (Settings, Model Pricing Map), based on the OpenRouter rates for
  Sonnet 4.6 and Haiku 4.5. LangSmith automatically computes cost per
  call and aggregates at the trace level.
- **Tool calls**: tool name, arguments, return value, and validation
  outcome.
- **Tags and metadata**: pipeline step, agent role, and a session ID
  per run, which let us filter and aggregate precisely in the LangSmith
  UI.

## LangSmith-specific Agent Skills

In the Claude Code setup we activated three skills from the LangSmith
skills repository (`agent-skills/`):

| Skill | Covered tasks |
|---|---|
| `langsmith-trace` | Instrumenting new applications (Python and JavaScript) and querying or exporting existing traces via the `langsmith` CLI |
| `langsmith-dataset` | Creating and managing evaluation datasets (types `final_response`, `single_step`, `trajectory`, `RAG`); upload via CLI and Python SDK |
| `langsmith-evaluator` | Defining evaluators (LLM-as-Judge and code-based custom evaluators), run functions for output capture, and executing evaluations |

The skills ensure a clean integration via Vibecoding.
