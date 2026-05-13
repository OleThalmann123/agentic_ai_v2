# Observability / Trace Capture & Visualization via LangSmith

*13.05.2026*

## Motivation and Tool Selection

We chose LangSmith because it integrates natively with the LangChain
ecosystem our document pipeline is built on (`@langchain/core`,
`@langchain/openai`). LangChain already emits trace events through
its callback system, and LangSmith (developed by the same maintainer,
LangChain Inc.) consumes this protocol directly. This eliminates the
need for a second, parallel instrumentation layer.

## Coverage

LangSmith provides Trace Capture and Visualization in our setup: each
pipeline run produces a complete, hierarchical trace that lets us
follow the flow and localize error sources. The hierarchy is built
through `RunTree` objects in `pipeline.ts`; child spans attach
automatically to the root run through the LangChain callback context.

Example trace structure in the `AgenticAI V2` project:

    Asklepios_extract: Dokument-Pipeline       (Root run, type: chain)
    ├─ Classifier: Dokumentklassifizierung     (type: llm, model: Haiku 4.5)
    ├─ Extractor: Datenextraktion              (type: llm, model: Sonnet 4.6)
    │  ├─ Tool: contract_data_submission       (type: tool)
    │  └─ Extractor: Datenextraktion           (type: llm, tool-response round)
    └─ Control: Qualitätsprüfung               (type: llm, model: Sonnet 4.6)

The span names are literal identifiers stored in LangSmith and not
translated. The annotations in parentheses are descriptions, not
part of the identifier.

## LangSmith-specific Agent Skills

In the Claude Code setup we activated three skills from the
LangSmith skills repository (`agent-skills/`):

| Skill | Covered tasks |
|---|---|
| `langsmith-trace` | Instrumenting new applications (Python and JavaScript) and querying or exporting existing traces via the `langsmith` CLI |
| `langsmith-dataset` | Creating and managing evaluation datasets (types `final_response`, `single_step`, `trajectory`, `RAG`); upload via CLI and Python SDK |
| `langsmith-evaluator` | Defining evaluators (LLM-as-Judge and code-based custom evaluators), run functions for output capture, and executing evaluations |

The skills ensure a clean integration via Vibecoding. Note:
`langsmith-dataset` and `langsmith-evaluator` address Pillar 2
(Evaluation) and will be migrated to their corresponding files once
that pillar's documentation is built out.

## Reference to the Framework Table

This file covers the Pillar 1 cell **"Trace Capture & Visualization"**
from the lecture *LU09 - Managing Risk of AI Agents* (Slide 41,
Mechanisms of Agent Ops, watsonx Orchestrate Framework).
