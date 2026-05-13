# Observability via LangSmith

## Motivation und Toolwahl

Wir haben uns für LangSmith entschieden, weil es nativ in das
LangChain-Ökosystem integriert ist, auf dem unsere Dokument-Pipeline
basiert (`@langchain/core`, `@langchain/openai`). LangChain emittiert
Trace-Events bereits über sein Callback-System, und LangSmith (vom
selben Maintainer, LangChain Inc., entwickelt) konsumiert dieses
Protokoll direkt. Dadurch entfällt eine zweite, parallele
Instrumentierungs-Schicht.

## Abdeckung: Säule 1, Trace Capture und Visualization

LangSmith stellt bei uns Trace Capture und Visualization sicher: Pro
Pipeline-Lauf wird ein vollständiger, hierarchischer Trace erfasst, mit
dem wir den Ablauf nachvollziehen und Fehlerquellen lokalisieren können.

Beispielhafte Trace-Struktur im Projekt `AgenticAI V2`:

    Asklepios_extract: Dokument-Pipeline       (Root-Run, Typ: chain)
    ├─ Classifier: Dokumentklassifizierung     (Typ: llm, Modell: Haiku 4.5)
    ├─ Extractor: Datenextraktion              (Typ: llm, Modell: Sonnet 4.6)
    │  ├─ Tool: contract_data_submission       (Typ: tool)
    │  └─ Extractor: Datenextraktion           (Typ: llm, Tool-Response-Round)
    └─ Control: Qualitätsprüfung               (Typ: llm, Modell: Sonnet 4.6)

## Erfasste Größen pro Trace

- **Inputs und Outputs** jedes Modell- und Tool-Aufrufs: die kompletten
  Prompts, Responses, Tool-Argumente und Tool-Ergebnisse sind
  einsehbar.
- **Token-Verbrauch**: Input- und Output-Tokens, sowie Cache-Tokens
  sobald Prompt-Caching aktiv wird.
- **Latenz**: Dauer pro Schritt und für den gesamten Trace.
- **Kosten in USD**: die Modell-Preise haben wir manuell in LangSmith
  hinterlegt (Settings, Model Pricing Map), entsprechend der
  OpenRouter-Tarife für Sonnet 4.6 und Haiku 4.5. LangSmith berechnet
  daraus automatisch Cost pro Call und aggregiert auf Trace-Ebene.
- **Tool-Calls**: Tool-Name, Argumente, Rückgabewert und
  Validierungs-Outcome.
- **Tags und Metadata**: Pipeline-Schritt, Agent-Rolle und eine
  Session-ID pro Lauf, mit denen wir in der LangSmith-UI gezielt filtern
  und aggregieren können.

## LangSmith-spezifische Agent-Skills

Im Claude-Code-Setup haben wir drei Skills aus dem
LangSmith-Skills-Repository aktiviert (`agent-skills/`):

| Skill | Abgedeckte Aufgaben |
|---|---|
| `langsmith-trace` | Instrumentierung neuer Anwendungen (Python und JavaScript) sowie Abfragen und Exportieren existierender Traces via `langsmith` CLI |
| `langsmith-dataset` | Erstellung und Verwaltung von Evaluations-Datasets (Typen `final_response`, `single_step`, `trajectory`, `RAG`); Upload via CLI und Python-SDK |
| `langsmith-evaluator` | Definition von Evaluators (LLM-as-Judge und code-basierte Custom-Evaluators), Run-Functions zur Output-Erfassung und Ausführung von Evaluations |

Die Skills stellen eine saubere Integration via Vibecoding sicher.
