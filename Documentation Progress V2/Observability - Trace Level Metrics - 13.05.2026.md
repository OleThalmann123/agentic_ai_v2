# Observability / Trace Level Metrics

*13.05.2026*

## Purpose

Trace Level Metrics is the quantitative layer on top of every
recorded trace. Where Trace Capture and Visualization makes the
structural flow of the pipeline visible, Trace Level Metrics deliver
the five core quantities defined as mandatory in the lecture *LU09 -
Managing Risk of AI Agents* on Slide 41 (Mechanisms of Agent Ops,
watsonx Orchestrate Framework): Cost, Latency, Token count
(input/output), LLM, and Tools Called. On this basis we can take
optimization decisions in a data-driven manner.

## Captured Metrics

For each model and tool call, LangSmith records the following
quantities, which we can inspect at the spans of the trace:

- **Inputs and outputs** of every model and tool call: the full
  prompts, responses, tool arguments, and tool results are persisted
  and inspectable.
- **Token usage**: input and output tokens, plus cache token detail
  fields (`cache_read`, `ephemeral_5m_input_tokens`,
  `ephemeral_1h_input_tokens`) once prompt caching is enabled.
- **Latency**: duration per step and for the entire pipeline run.
- **Cost in USD**: the model prices are configured manually in
  LangSmith (Settings, Model Pricing Map), based on the OpenRouter
  rates for Sonnet 4.6 (Prompt `$3` / Completion `$15` per 1M
  tokens) and Haiku 4.5 (Prompt `$1` / Completion `$5` per 1M
  tokens), each including cache token prices. LangSmith computes
  `prompt_cost`, `completion_cost`, and `total_cost` per run
  deterministically and aggregates at the trace level.
- **Model identity**: the LLM used per call is captured in run
  metadata as `ls_model_name` (e.g.,
  `anthropic/claude-sonnet-4.6`, `anthropic/claude-haiku-4.5`).
  This lets us break down cost and latency per model, which is the
  prerequisite for the optimization levers proposed in *LU09 -
  Managing Risk of AI Agents* (Slide 67, Optimization Loop): model
  routing, targeted model downgrades, prompt compression, and tool
  deduplication.
- **Tool calls**: tool name, arguments, return value, and
  validation outcome (status `success` / `warning` / `error` from
  our Zod-based validator).
- **Tags and metadata**: every span carries structured supplementary
  information that lets us filter and analyze traces precisely.
  Specifically:
  - `pipeline_step` (`1` = Classifier, `2` = Extractor, `3` =
    Control): allows filters such as "show all Extractor calls from
    the last 24 hours".
  - `agent_role` (`classifier` / `extractor` / `judge`): the
    semantic role of the agent, independent of the pipeline step.
  - `session_id` (a UUID newly assigned per pipeline run): links
    all spans of the same document upload, even when the
    hierarchical trace nesting does not apply. This keeps a run
    reproducibly findable as a unit.
  - Semantic tags such as `asklepios`, `agent-1`, `agent-2`,
    `agent-3`, or mode markers like `vision-with-tools`: enable
    building dashboards per domain (e.g., Asklepios-relevant runs
    only) or per pipeline mode.

  Taken together, this lets us build queries in the LangSmith UI
  such as "all judge runs with confidence score below 0.7" or "all
  spans with session ID X", which is the basis for targeted error
  analysis and Issue Detection (Pillar 1, cell 1.3).

Validation example from a real trace on 2026-05-13: a document run
produces total costs of $0.205, broken down across four LLM spans
(Classifier $0.005, Extractor Round 0 $0.046, Extractor Round 1
$0.064, Control $0.090). Total latency: 91.5 seconds. Total tokens:
37,018.

## Reference to the Framework Table

This file covers the Pillar 1 cell **"Trace Level Metrics (Cost /
Latency / Token / LLM / Tools)"** from the lecture *LU09 - Managing
Risk of AI Agents* (Slide 41, Mechanisms of Agent Ops). 

