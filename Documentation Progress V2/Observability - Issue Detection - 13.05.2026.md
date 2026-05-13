# Observability / Issue Detection

*13.05.2026*

## Purpose

Trace Capture and Trace Level Metrics provide the raw material per run.
Issue Detection is the layer that automatically filters this data for
known failure classes, so that not every individual trace has to be
inspected manually. In the lecture *LU09 - Managing Risk of AI Agents*
(Slide 41), the cell is defined as three components: Tool issue
detection, Cycle detection, and Root Cause Analysis.

## Current state per component

### Tool issue detection

The tool `contract_data_submission` used in the Extractor pipeline
(`tools.ts:807-832`) performs a Zod-based schema validation of the
contract object proposed by the model. The return object contains a
field `status` with the values `success`, `warning`, or `error`. The
pipeline accepts `success` and `warning` as valid and passes the
validated data on; only `error` aborts the pipeline.

The data is inspectable in the LangSmith trace inside the output field
of the tool span. An automated detection of warning cases was missing
until we registered the `tool_schema_fail` run rule described below.

### Cycle detection

The Extractor contains a hard cap on the tool loop at
`MAX_TOOL_ROUNDS = 3` (`asklepios-extractor.ts:353`). When the cap is
reached, the code emits a `console.warn` and forces a final model call
without tool bindings (lines 432 to 442).

For each tool round, two metadata fields are attached to the
corresponding LangSmith span: `mode` with values such as
`text-tool-round-1` (line 425), and `tool_round` with the numeric round
index (line 380). The `tool_round` field is the preferred input for
deterministic filter queries.

Here too the data was captured, but no automated tag flagged the cap
hit until we registered the `tool_loop_capped` run rule.

### Root Cause Analysis

Root Cause Analysis is not implemented as an automated layer in the
code; it is driven manually through Claude Code. LangSmith is
connected to Claude Code through three building blocks:

1. The `langsmith` CLI is installed locally and wraps the
   LangSmith REST API as a shell utility.
2. Authentication runs via `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`,
   and `LANGSMITH_PROJECT` from the repository `.env` file.
3. The `langsmith-trace` skill (see doc file 1.1, skills table)
   activated in the Claude Code setup provides the call patterns
   and the data model.

Through this connection, Claude Code can automatically pull any trace
from the `AgenticAI V2` project, parse the span hierarchy, compare
tokens, cost, and latency per step, inspect the inputs and outputs of
every model and tool call, and derive and verify root-cause hypotheses
on its own.

A concrete example: in our session on 2026-05-13 this workflow
surfaced the "Double Call" in the Extractor, a second LLM invocation
after a successful tool call that contributes no new information yet
accounts for roughly one third of the pipeline cost. The hypothesis
was verified directly against the trace material.

A fully automated RCA layer (rule-based triage over combined issue
tags, or LLM-as-Judge over failure traces) only becomes worthwhile
once the trace volume makes manual review the bottleneck.

## Registered detectors

Two deterministic online evaluators are registered as Run Rules on the
`AgenticAI V2` LangSmith project. Both fire on every new root run of
the pipeline (sampling rate 1.0, filter `and(eq(is_root, true),
has(tags, "pipeline"))`). They write feedback scores and tags back to
the root run without modifying the pipeline code.

### Detector 1: tool_schema_fail

Rule ID `3a6842fb-22b9-4d15-a08a-ab82969d7ea4`. Iterates over child
spans, finds the `Tool: contract_data_submission` span, parses its
output as JSON, and emits the tag `tool_schema_fail` with score 1 when
the parsed `status` field is anything other than `success`.

```python
def perform_eval(run):
    import json
    for child in run.child_runs or []:
        if child.run_type == "tool" and child.name == "Tool: contract_data_submission":
            raw = (child.outputs or {}).get("output")
            if not isinstance(raw, str):
                continue
            try:
                parsed = json.loads(raw)
                if parsed.get("status") and parsed["status"] != "success":
                    return {
                        "key": "tool_schema_fail",
                        "score": 1,
                        "comment": f"status={parsed['status']}",
                    }
            except json.JSONDecodeError:
                pass
    return {"key": "tool_schema_fail", "score": 0}
```

### Detector 2: tool_loop_capped

Rule ID `4b8f96f6-b04f-4b06-818d-0ce4c0a2f86e`. Iterates over child
spans, reads the `tool_round` metadata field, and emits the tag
`tool_loop_capped` with score 1 when any span recorded a round value
greater than or equal to `MAX_TOOL_ROUNDS` (currently 3).

```python
def perform_eval(run):
    MAX_TOOL_ROUNDS = 3  # mirror of asklepios-extractor.ts:353
    for child in run.child_runs or []:
        meta = ((child.extra or {}).get("metadata") or {})
        round_val = meta.get("tool_round")
        if isinstance(round_val, int) and round_val >= MAX_TOOL_ROUNDS:
            return {
                "key": "tool_loop_capped",
                "score": 1,
                "comment": f"tool_round={round_val}",
            }
    return {"key": "tool_loop_capped", "score": 0}
```

Both rules were created via `POST /api/v1/runs/rules` with the
LangSmith API. They run server-side on every new pipeline trace; no
local worker, no cron, no webhook is required on our side.

## Reference to the Framework Table

This file covers the Pillar 1 cell **"Issue Detection (Tool issue
detection, cycle detection, and Root Cause Analysis)"** from
*LU09 - Managing Risk of AI Agents* (Slide 41).

| Component | Data captured | Detection |
|---|---|---|
| Tool issue detection | ✅ | ✅ (`tool_schema_fail` rule active) |
| Cycle detection | ✅ | ✅ (`tool_loop_capped` rule active) |
| Root Cause Analysis | ✅ | ✅ (Claude Code via `langsmith` CLI and the `langsmith-trace` skill) |

Overall status of this cell: ✅ Available. All three components are
operational. A fully automated RCA layer is a future roadmap item once
trace volume justifies it.
