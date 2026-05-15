# Evaluation

*Status: 15.05.2026*

## Purpose

This document describes the implemented state of the Evaluation row
from *LU09 – Managing Risk of AI Agents*, Slide 41 (watsonx-Orchestrate
AgentOps framework). It complements the three Observability documents
(`Observability – Trace Capture & Visualization`, `Observability –
Trace Level Metrics`, `Observability – Issue Detection`) and references
their components where they also serve evaluation. The document is
organised by the framework cells; each cell that has substance is
covered in its own section.

## Coverage of the Eval Cells

| Cell | Sub-item | Status | Section |
|---|---|---|---|
| OOTB Pre-defined Evals | Eval harness – Quality | implemented | §1.1 |
| OOTB Pre-defined Evals | Eval harness – Trajectory | partial | §1.3 |
| OOTB Pre-defined Evals | Guardrails | implemented | §1.1–1.3 |
| OOTB Pre-defined Evals | Run-Time Evals / Metrics | implemented + configured | §1.4, §1.5 |
| Self-defined Custom Evals | LLM-as-a-Judge | implemented | §2.1 |
| Self-defined Custom Evals | Code-based Custom Metrics | implemented | §2.2 |
| Self-defined Custom Evals | Business Metrics | implemented (Cost / Run) | §2.3 |
| Runtime Monitoring | Policy Enforcement | configured (Latency verified; Cost pending) | §1.5, §3 |
| Runtime Monitoring | Agent metrics dashboard | implemented (LangSmith UI) | §3 |
| Build-time Tools, Agent Benchmarking, Data Set Curation | – | out-of-scope | §4 |

## 1. OOTB Pre-defined Evals

### 1.1 Code-based Schema Adherence

The Extractor returns its results exclusively through the tool
`contract_data_submission`, whose input and output shape is defined by
a Zod schema. Validation is deterministic and model-independent;
violations emit `status: "warning"` or `status: "error"` on the tool
span. This realises both *Eval harness – Quality* and *Code-based
Custom Metrics*.

### 1.2 Tool Whitelist

The Extractor operates against a closed tool registry; calls outside
this set are structurally impossible. The risk class *Tool Choice
Hallucination* from the Risk Taxonomy is therefore eliminated by
construction.

### 1.3 Cycle Cap

The detector `tool_loop_capped` from the Issue Detection layer also
acts as a trajectory guardrail: runs exceeding `MAX_TOOL_ROUNDS = 3`
tool-call rounds are force-terminated and marked in the trace. Detail:
see `Observability – Issue Detection – 13.05.2026.md`, §2.

### 1.4 Run-Time Metrics and Cost per Run

Cost, latency, and token consumption are captured per run through
LangSmith tracing (detail: `Observability – Trace Level Metrics –
13.05.2026.md`). Among these fields, *Cost per Run* is directly
readable from the LangSmith dashboard and serves as the business
metric without additional definition (see also §2.3).

### 1.5 Cost Cap and Latency Cap (Run-Time Policy Enforcement)

Threshold alerts are configured for the project `AgenticAI V2` as a
minimal policy-enforcement layer. They convert the run-time metrics of
§1.4 into an active, event-driven notification and thereby cover both
*Run-Time Evals / Metrics* (OOTB) and *Policy Enforcement* (Runtime
Monitoring).

**Configuration**

| Parameter | Latency Cap | Cost Cap |
|---|---|---|
| Metric | average trace latency | average cost |
| Operator | ≥ (greater than or equal to) | ≥ |
| Threshold | 170 seconds | 0.40 USD |
| Aggregation window | 60 minutes | 60 minutes |
| Scope filter | project `AgenticAI V2` | project `AgenticAI V2` |
| Notification | webhook → relay.app | webhook → relay.app |

The thresholds are defined as 1.5× the metrics of the most recent
production reference trace (baseline: 112.66 s / 0.2665 USD; trace of
14.05.2026, 09:44). The 1.5 factor tolerates normal variance and only
fires on pronounced outliers. As the reference trace was itself a
failure case (tags `tool_loop_capped`, `tool_schema_fail`), the
resulting threshold is deliberately conservative; re-calibration
against a clean reference run is foreseen.

**Architecture and data flow**

The LangSmith alert engine evaluates the metric per aggregation
window. When the threshold is reached, LangSmith invokes a webhook.
Because LangSmith alert actions support only `webhook`, `pagerduty`,
and `dynatrace` — there is no native email delivery — the
notification is delivered through a relay.app workflow:

    LangSmith (alert)  ──webhook──▶  relay.app (workflow)  ──▶  email

The relay.app workflow consists of an inbound webhook trigger and an
email action to the operator. The delivery chain is therefore
testable end-to-end independently of an actual threshold breach.

**Implementation note**

The LangSmith platform alert API is in alpha and proved unreliable
for programmatic creation (HTTP 200 without persistence, undocumented
required fields). The alert rules were therefore created through the
LangSmith UI (Monitoring → Alerts). Figure 1 shows the "Latency Cap"
configuration. The delivery chain was verified end-to-end via a
manual webhook invocation; Figure 2 shows the resulting delivered
notification.

![Figure 1 (illustrative example): LangSmith alert configuration "Latency Cap"](img/latency-cap-config.png)

*Figure 1 — Illustrative example: LangSmith alert configuration "Latency Cap".*

![Figure 2 (illustrative example): Alert notification delivered via relay.app](img/latency-cap-mail.png)

*Figure 2 — Illustrative example: alert notification delivered via relay.app.*

**Status**

- **Latency Cap:** configured and verified end-to-end.
- **Cost Cap:** identical pattern, creation pending.

At the current run volume (single digits) the windowed average is of
limited significance; the mechanism is nonetheless fully established
and scales without further change as volume grows.

## 2. Self-defined Custom Evals

### 2.1 Built-in LLM-as-a-Judge

The Control agent in `packages/core/src/agent/asklepios-control.ts`
operates as a downstream judge on the tool-validated extraction. It
receives the original contract together with the extraction and
assigns a per-field `confidence_score` between 0.0 and 1.0, plus a
textual justification with a source quote. The field-level scores are
aggregated into an `overall_confidence`. Escalation is encoded in
binary form: `overall_confidence >= 0.8` sets `overall_status: "ok"`,
below that `review_required`. This threshold implements the separation
between *Human-Out-of-the-Loop* and *Human-on-the-Loop*. The
LLM-as-a-Judge is therefore already realised on the production path; a
separate offline evaluator pipeline is not required.

### 2.2 Code-based Custom Metrics

Covered by the deterministic Zod validation described in §1.1: schema
adherence and field-type correctness are evaluated without a model
call and are therefore stable and reproducible.

### 2.3 Business Metric — Cost per Run

Cost per Run is read directly from the LangSmith dashboard (§1.4). It
serves as the business metric without an additional definition or
pipeline.

## 3. Runtime Monitoring

Runtime monitoring is provided by the LangSmith UI (agent metrics
dashboard, run and trace views) together with the policy-enforcement
alerts described in §1.5. The alert chain — LangSmith threshold →
webhook → relay.app → email — is established and verified
independently of an actual breach.

## 4. Out of Scope

Build-time Tools (Experimentation Tracking, Prompt Comparison,
Champion/Challenger), Agent Benchmarking, and Data Set Curation are
not implemented in the current project phase. They depend on a stable
reference dataset; at present such a dataset would be either purely
synthetic — and therefore only partly representative of real Swiss
employment contracts — or would require significant curation effort on
production traces, without delivering a corresponding ROI at the
current prototype stage. Likewise deliberately excluded: Build-time
Red Teaming, AI-based Grader Prompt Generation, annotation workflows
with manual correction, Shadow AI Discovery, and Agent X-Ray. These
are recoverable in a later maturity step once a curated eval set
exists.

## Reference to the Framework Table

This document covers the cells *OOTB Pre-defined Evals*, *Self-defined
Custom Evals*, and parts of *Runtime Monitoring* in the Evaluation row
of *LU09 – Managing Risk of AI Agents* (Slide 41), to the extent
implemented or configured in the current project state.
