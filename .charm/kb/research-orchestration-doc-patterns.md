---
id: research-orchestration-doc-patterns
root: research
type: research
status: current
summary: "Survey of how leading orchestration tools (Temporal, Airflow, Prefect, CrewAI, LangGraph, AutoGen, Ray) document orchestration concepts, mental models, and audience splits -- with a gap analysis against charm's current docs."
created: 2026-06-16
updated: 2026-06-16
---

# Research: Multi-Agent and Orchestration Tool Documentation Patterns

Sourced from published docs and community guides for Temporal, Airflow, Prefect, Ray,
CrewAI, LangGraph, and AutoGen. Observations are descriptive, not evaluative -- they feed
into charm's doc update work (T-006).

---

## 1. How leading tools explain orchestration concepts to new users

### Temporal

Temporal's entry point is a single durable mental model: "your code, but it can't fail."
The docs introduce Workflow -> Activity -> Worker as three clearly named layers, each
defined in one sentence before the tutorial starts. The key differentiator -- durability --
is explained via analogy (like a database transaction, but for long-running code), not
a diagram. The "How It Works" landing page is a 200-word conceptual anchor distinct from
the SDK reference.

Temporal explicitly avoids jargon imports from older tools (no DAG, no pipeline, no job).
New concepts get new terms, defined on first use.

### Airflow

Airflow builds on a visual metaphor: a Directed Acyclic Graph (DAG) is the whole workflow,
Tasks are nodes, Operators are templates for task behavior, and dependencies are edges.
The visual model is central -- the web UI's DAG view is shown in the first tutorial
screenshot. New users are meant to reason about Airflow spatially.

Structure follows Diataxis cleanly: Core Concepts -> Tutorial -> How-to Guides ->
References. The concepts page is short and definitional; the tutorial is hands-on from
line one.

The operator ecosystem (BashOperator, PythonOperator, S3Operator, etc.) is the main
extension point for users, and the docs treat "writing an Operator" as a level above
"writing a DAG." This implicit skill ladder is rarely named but consistently present.

### Prefect

Prefect's entry point is minimal friction: "add @flow and @task to your existing Python."
The mental model is additive (wrap what you have) rather than structural (redesign around
a new abstraction). Getting Started is a <5-minute "change two lines" path.

Flows and Tasks are explained as nested Python callables. Deployments (the production
concept) are introduced only after local execution is working. This staged complexity
disclosure means new users can be productive without understanding the full system.

Prefect's conceptual layer is light -- it leans on "it's just Python" as a shorthand for
the mental model rather than explaining the model explicitly.

### Ray

Ray documents two distinct user archetypes: ML practitioners using Ray libraries directly,
and platform engineers deploying Ray at scale. These audiences have different entry points,
different how-to paths, and different reference sections. The audience routing is explicit
in the deployment docs ("This is applicable if you are an ML engineer who...").

Ray's core concepts (Tasks, Actors, Objects) are lower-level than most orchestrators --
closer to distributed computing primitives than workflow abstractions. The docs reflect
this: they explain execution semantics in detail rather than business-logic analogies.

### CrewAI

CrewAI uses a workplace crew metaphor throughout: an Agent is a person with a role, goal,
and backstory; a Task is a to-do item; a Crew is a team. This analogy is load-bearing --
it is used to explain every primitive. New users who understand "hire specialists for a
job" understand CrewAI's model immediately.

The documentation favors short definitions and worked examples over deep conceptual
explanation. Role-playing frame keeps the cognitive load low.

### LangGraph

LangGraph teaches graph theory before workflow concepts: Nodes (functions or agents),
Edges (routing logic), and State (shared data). The mental model is computational rather
than analogical -- more suitable for developers comfortable with graph algorithms than
for operators configuring pipelines.

The framework's power features (fan-out, fan-in, conditional edges, interrupt/resume)
are explained with code samples rather than diagrams. There is no single "how LangGraph
works" anchor page for non-developers.

### AutoGen

AutoGen centers its conceptual model on conversation patterns: two-agent chat, group chat
with a manager, and sequential chains of agent pairs. The framework uses the back-and-forth
exchange as the fundamental unit of work rather than a task graph or workflow DAG.

The "Getting Started" page shows a two-agent conversation in 10 lines of Python. Concepts
are introduced in the order a new user would reach them through use, not in a clean
taxonomy.

---

## 2. Mental model documentation patterns

### Analogies

Every tool uses at least one central analogy:

| Tool | Core analogy |
|---|---|
| Temporal | A transaction that can't be lost, even across crashes |
| Airflow | A dependency graph you can visualize and schedule |
| Prefect | Existing Python, just decorated |
| CrewAI | A crew of specialist workers given a job |
| LangGraph | A stateful graph of functions |
| AutoGen | Agents having a managed conversation |

The most accessible analogies translate to a non-developer audience (CrewAI, Temporal).
The least accessible ones assume graph theory or distributed systems background (LangGraph,
Ray). None of the AI-native frameworks (CrewAI, AutoGen, LangGraph) rely on legacy
pipeline metaphors (ETL, batch job, cron).

### Diagrams

- Airflow uses DAG visualizations prominently (both in docs and in-product).
- LangGraph uses state-machine diagrams (nodes/edges with labeled transitions).
- Temporal uses event-timeline diagrams for Workflow Execution semantics.
- Prefect uses flow/task dependency graphs in the UI, rarely in docs prose.
- CrewAI relies on prose and role cards, minimal diagrams.
- AutoGen docs are mostly code-forward, few architectural diagrams.

ASCII architecture diagrams (as charm uses in the README) are common in developer-
oriented tools but rare in operator-facing docs. Operators are more likely to see
swimlane or stage-gate diagrams.

### Progressive disclosure

Effective tools consistently stage information:

1. Entry point: one sentence that gives the mental model.
2. Quick start: working in <10 minutes without understanding everything.
3. Core concepts: names and definitions for the 4-6 most important abstractions.
4. How-to guides: goal-oriented recipes that reference those abstractions.
5. Reference: exhaustive, no narrative.

Prefect and Temporal execute this most cleanly. Airflow's quick-start is burdened by
infrastructure setup, which interrupts the conceptual introduction.

---

## 3. Audience-split strategies

### Named audiences

Ray, Temporal, and Airflow (via Astronomer's commercial docs) explicitly name their
audiences and route them to separate doc trees:

- **Operators / platform engineers**: install, configure, scale, monitor, secure.
- **Developers / practitioners**: write workflows, define tasks, use the SDK.
- **Architects / evaluators**: understand why, compare alternatives, assess fit.

CrewAI, AutoGen, and LangGraph are effectively single-audience (developers), with minimal
operator or evaluator content.

### Structural approaches

- **Separate top-level sections**: Astronomer (Airflow) separates "Learn" (developer) from
  "Deploy" (operator). Temporal separates "Concepts + SDKs" from "Cloud / Self-hosted."
- **Audience labels on pages**: Some Temporal pages open with "For developers who..." or
  "For cluster operators who..." to set context without restructuring the nav.
- **Getting-started forks**: Two distinct getting-started paths ("I want to run it" vs
  "I want to write a workflow") serve different entry needs without requiring a full
  doc-tree split.

### The evaluator audience

No tool handles the evaluator (someone deciding whether to adopt) consistently well. Most
docs assume adoption is decided and jump to "how to get started." Temporal comes closest,
with a "Why Temporal" section that addresses the business case without requiring code
literacy.

---

## 4. Conceptual vs. how-to vs. reference structure (Diataxis alignment)

The Diataxis framework (tutorials, how-to guides, reference, explanation) is the current
best-practice model for technical docs. Its core principle: each content type serves a
different user mode (learning, doing, consulting, understanding) and should be kept
separate.

| Tool | Diataxis alignment |
|---|---|
| Airflow | Explicit: "Core Concepts" / "Tutorial" / "How-to Guides" / "References" section names match Diataxis directly. |
| Temporal | Strong: Concepts, How-to, Reference, and SDK docs are separate top-level sections. |
| Prefect | Moderate: Getting Started (tutorial) + Concepts + How-to + API Reference, but some blending. |
| Ray | Partial: strong reference, weak conceptual layer. |
| CrewAI | Minimal: mostly tutorial-style with inline reference. |
| LangGraph | Developer-first: tutorials and reference well-covered, conceptual and how-to layers thin. |
| AutoGen | Tutorial-forward: getting started pages dominate; reference and conceptual thin. |

---

## 5. Gap analysis: charm's current docs vs. these patterns

### What charm does well

- **Audience split is structural**: `docs/operating/` (operators), `docs/developing/`
  (contributors), `docs/design/` (architects) cleanly separates the three audiences.
  This matches or beats most tools in the comparison.
- **README explains the why**: The "Why this exists" section addresses the evaluator
  audience directly and is more explicit about design motivation than most tools surveyed.
- **ASCII architecture diagram in README**: Covers the system overview at a glance.
- **CLI reference and keybindings are complete**: Exhaustive, well-organized reference
  content for operators.

### Gaps

**No standalone "how charm thinks" page.**
The README mixes evaluation pitch, mental model explanation, architecture reference, and
quick start in one long document. Leading tools (Temporal especially) separate the
"here is the mental model" page from the "here is the architecture" page and the
"here is the quick start." Charm needs a short, pure-explanation page (100-200 words)
that gives a new user the mental model without requiring them to read the full README.

**The five-stage pipeline has no visual.**
The pipeline table in the README is accurate but abstract. Airflow, LangGraph, and
Temporal all use visuals (diagrams, screenshots, annotated flow) to show the stage
progression. A stage-gate diagram or ASCII swimlane would substantially reduce the time
to understanding for new operators.

**No routing for evaluators at the top level.**
The README routes operators to `docs/operating/` and developers to `docs/developing/`,
but someone deciding whether to adopt charm has no explicit path. A two-sentence
"evaluating charm" entry in the README with a pointer to the design notes would serve
this audience without restructuring anything.

**Terminology is not consolidated.**
Terms like ticket, worker, orchestrator, gate, stage, fleet, pane, and session are used
consistently in the code and prompts, but there is no glossary. The `domain/` KB root
exists but is empty (0 notes). Other tools (Temporal, Airflow) define their core terms
in a dedicated glossary or concepts page. This gap matters most when charm terms conflict
with similar-but-different terms from other tools (e.g. "worker" in Celery vs. in charm).

**Design notes are at the bottom of the nav, not surfaced for operators.**
The `design/` section (parallelization strategies, phasing/sequencing) contains conceptual
reasoning that would help operators make better decisions about scoping their projects.
Currently it appears after the developer docs in the nav, and is framed as "the thinking
behind the harness" rather than "understanding what charm is good at." Framing these as
operator-facing explanation content would align with the Diataxis pattern more clearly.

**No "30-second pitch" callout for new users.**
Temporal, Prefect, and CrewAI all have a short, visually separated callout (often a
highlighted box or leading paragraph) that gives the core mental model in 2-3 sentences.
Charm's equivalent is buried mid-README after the "Why this exists" prose. Surfacing a
short, memorable one-liner earlier would reduce abandonment from new evaluators.

**How-to content for common operator tasks is thin.**
The `operating/` docs cover getting started and running a session well. But common
operator tasks (how do I scope tickets to avoid conflicts? how do I handle a blocked
worker? when should I use research mode vs development mode?) are scattered across
troubleshooting and modes docs rather than organized as explicit how-to recipes. Prefect
and Temporal both have dedicated how-to libraries for common operational patterns.
