# Observability / Issue Detection

*13.05.2026*

## Purpose

Issue Detection automatically identifies known failure classes in every
pipeline run. In the lecture *LU09 - Managing Risk of AI Agents*
(Slide 41), the cell is defined as three components: Tool issue
detection, Cycle detection, and Root Cause Analysis.

## Components

### 1. Tool issue detection (detector: `tool_schema_fail`)

The Extractor instructs the model to return the extracted contract
data via the tool `contract_data_submission`. The tool validates the
returned JSON against a Zod schema and emits a `status` field with
one of three values: `success`, `warning`, or `error`.

The detector scans every new trace for this tool span and assigns the
tag `tool_schema_fail` to the root run as soon as `status != "success"`.

**Example:** the model returns a birth date in the form `"32.13.2026"`.
The Zod validation fails. The tool sets `status: "warning"`. The
detector observes this on the next sweep and tags the trace.

Practical use: a filter `tag:tool_schema_fail` in the LangSmith UI
returns every run in which the proposed data structure was malformed,
without inspecting each trace individually.

### 2. Cycle detection (detector: `tool_loop_capped`)

The Extractor permits at most `MAX_TOOL_ROUNDS = 3` tool-call rounds
per run. A round consists of a model proposal, the tool validation,
and a model correction. When the loop reaches this cap, the code
forces a final model call without tool bindings so that the run does
not stall.

The current round number is attached to each span as the metadata
field `tool_round`. The detector scans every new trace for child
spans with `tool_round >= MAX_TOOL_ROUNDS` and assigns the tag
`tool_loop_capped` to the root run.

**Example:** for a contract with unusual PDF structure (multi-column
layout, poor OCR quality), the model returns data that narrowly
misses the schema in each round. After three rounds the cap engages,
and the detector tags the trace.

Practical use: a filter `tag:tool_loop_capped` shows the runs in
which the model could not extract the data within the intended number
of rounds. These traces are direct candidates for prompt optimization
or model upgrades.

### 3. Root Cause Analysis

RCA is not implemented as an automated layer in the code; it is
operated manually through Claude Code. LangSmith is connected to
Claude Code through three building blocks:

1. The `langsmith` CLI is installed locally and wraps the LangSmith
   REST API as a shell utility.
2. Authentication runs via `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`,
   and `LANGSMITH_PROJECT` from the repository `.env` file.
3. The `langsmith-trace` skill activated in the Claude Code setup
   provides the call patterns and the data model.

Through this connection, Claude Code can pull any trace from the
`AgenticAI V2` project, parse the span hierarchy, compare tokens,
cost, and latency per step, inspect the inputs and outputs of every
model and tool call, and derive root-cause hypotheses that can be
verified against the trace material itself.

**Example:** an analysis on 2026-05-13 surfaced the "Double Call" in
the Extractor, namely a second LLM invocation following a successful
tool call that contributes no new information yet accounts for
roughly one third of the pipeline cost. The hypothesis was verified
directly against the trace, without requiring an automated RCA
mechanism.

A fully automated RCA layer (rule-based triage over combined issue
tags, or LLM-as-Judge over failure traces) will be introduced once
the trace volume justifies it.

## Reference to the Framework Table

This file covers the Pillar 1 cell **"Issue Detection (Tool issue
detection, cycle detection, and Root Cause Analysis)"** from
*LU09 - Managing Risk of AI Agents* (Slide 41).
