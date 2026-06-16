---
id: research-cli-doc-practices
root: domain
type: domain
status: current
summary: "Research findings on CLI/developer-tool documentation best practices, synthesized from tmux/docker/kubectl/gh with specific recommendations for charm's docs."
created: 2026-06-16
updated: 2026-06-16
---

# Research: CLI Tool Documentation Best Practices

Research synthesized from clig.dev guidelines, draft.dev developer-tool docs best practices,
docker/kubectl/gh/tmux as reference tools, and patterns specific to daemon/client architectures.
Findings feed into the docs/ improvement work.

---

## Key Principles

- **Structure by user goal, not by code shape.** Organize around what the user is trying to do
  (operate, develop, understand), not around source modules or implementation layers.
- **State prerequisites up front.** Every install/getting-started guide must list all required
  tools before the first command. Discovering a dependency halfway through a setup is a trust
  breaker.
- **Make the help screen useful.** The CLI's `--help` output is the first documentation most
  users read. Group subcommands logically, give each a one-line description, and mention common
  flags. A useful `--help` reduces docs load significantly.
- **Examples are the most-read section.** Every concept doc and reference entry should include
  at least one runnable example. Concrete beats abstract every time.
- **Separate concepts from tasks from reference.** Users with different goals need different
  entry points. A first-time user needs concepts; a returning user needs the reference. Mixing
  them forces everyone to skim.
- **Acknowledge the canonical source.** For tools where docs lag code, explicitly state where
  the truth lives ("where docs and code disagree, the code wins"). This preserves trust.
- **Design docs are not operational docs.** Rationale and design notes must be clearly labeled
  and segregated. Users confuse "what we considered" with "how it works."

---

## Section Structure Patterns

Reference tools and how they solve the "what goes where" problem:

### tmux

- **Man page** — authoritative, comprehensive reference; covers every option and key binding
- **Getting started (wiki)** — install + core hierarchy (session → window → pane), first commands
- **FAQ** — quick-answer format for common stuck-points
- Pattern: man page is the single source of truth; everything else is an on-ramp to it.

### Docker

- **Overview / "What is Docker"** — one-page conceptual intro before any hands-on content
- **Quick start** — get a container running in 5 minutes; no concepts, just steps
- **How-to guides** — task-oriented ("How to use volumes", "How to write a Dockerfile")
- **Reference** — CLI flags, Dockerfile instructions, Compose schema; auto-generated or kept
  very close to the source
- Pattern: strict Divio/Diataxis split — tutorial, how-to, reference, and explanation are
  separate sections that don't bleed into each other.

### kubectl / Kubernetes

- **Concepts section** — "What is a Pod?", "What is a Deployment?" — glossary-level entries
  that stand alone before any task is attempted
- **Tasks section** — organized by what you want to accomplish, not by object type
- **Reference** — auto-generated from source, versioned per release
- **Troubleshooting** — dedicated section with symptom-first organization (not cause-first)
- Pattern: concepts are first-class pages, not asides in a getting-started guide.

### GitHub CLI (`gh`)

- **About page** — one-paragraph answer to "what is this and why use it over the web UI"
- **Getting started** — auth, first command, linking to the manual
- **Manual** — flat alphabetical command reference, auto-generated; linked from every command's
  `--help` output
- **Scripting guide** — separate doc for automation/CI use cases, not mixed into the getting
  started
- Pattern: manual is its own artifact, not an appendix in the guide; scripting is explicitly
  called out as a first-class use case.

---

## Anti-Patterns to Avoid

1. **Command lists without context.** Docs that enumerate flags but never explain why you would
   use them or what the result looks like. Developers need the "why" as much as the "what."

2. **Buried prerequisites.** Requirements discovered mid-walkthrough ("you'll need X installed
   before continuing...") are a common onboarding failure mode. List all requirements before the
   first step, or use a preflight check command.

3. **Design notes indexed alongside operational docs.** Users read "design/parallelization.md"
   and assume it describes current behavior. Label design docs as non-normative and keep them out
   of the primary navigation.

4. **No troubleshooting section, or troubleshooting organized by cause.** Users arrive at
   troubleshooting with symptoms, not root causes. Structure by "what the user sees," not "what
   went wrong internally."

5. **No glossary or concepts page.** Tools that introduce domain-specific terms (tickets, stages,
   gates, fleets, workers) without a single reference for definitions force users to reverse-
   engineer vocabulary from context.

6. **Getting started that tries to explain everything.** A getting-started guide that teaches
   concepts before it gets the user to a working state loses readers. The goal of getting started
   is one successful run, not complete understanding.

7. **No quick reference for power users.** After the first session, users want a command/keybind
   cheat sheet, not a narrative guide. Tools that lack this force repeated trips through the full
   docs.

8. **Docs that lag the code with no disclaimer.** Without a statement like "code at HEAD is
   authoritative," users file bugs on documented behavior that was changed months ago.

9. **Interactive-first docs for a tool used in automation.** If the tool is also used in scripts
   or CI, the docs must cover non-interactive use explicitly. Scripting behavior (flags, exit
   codes, machine-readable output) should not be scattered through narrative guides.

---

## Patterns Specific to Daemon/Client Architecture

Tools with a persistent background process (charmd) have additional documentation obligations:

- **Explain the daemon's lifecycle explicitly.** Users need to know: when does it start, when
  does it stop, how do they know if it's running, and what does "it crashed" look like. Docker
  and Tailscale both have explicit "daemon vs CLI" explainer pages.

- **Document the start/stop/status lifecycle.** At minimum: how to start, how to stop gracefully,
  how to force-kill, how to check status. These should appear in the operating docs, not just
  the developer architecture doc.

- **Make daemon errors legible from the CLI.** When the daemon is not running, client commands
  should emit a human-readable message that includes the recovery command ("daemon not running;
  start with `charm daemon start`" or equivalent).

- **Version mismatch deserves a dedicated subsection.** Client/daemon version skew is a common
  support issue for daemon-client tools. Document the behavior (auto-upgrade? hard failure? warn?)
  and include the recovery path in troubleshooting.

- **Separate the wire protocol from user-facing behavior.** The socket protocol and IPC details
  belong in developer/architecture docs. Operator docs should describe only observable behavior:
  "the daemon manages agent processes; you interact with it through the CLI."

- **Auto-start behavior must be documented.** If the daemon starts automatically on first use,
  say so. If it does not, say what the user must do first. Unexplained background processes erode
  trust.

---

## Specific Recommendations for charm's Docs

Based on the current `docs/` structure (as of this research pass):

**Strengths to keep:**
- Audience split (operating vs developing vs design) is correct; most CLI tools collapse these.
- Troubleshooting section exists at the top level — good.
- "Code at HEAD wins" disclaimer in docs/README.md is the right pattern.
- Getting started covers prerequisites (Claude Code CLI, tmux, Bun) before the first command.

**Gaps:**

1. **No glossary/concepts page.** Charm introduces: ticket, stage, gate, worker, reviewer,
   tester, pane, fleet, COORDINATION.md, PROJECT.md. A user's first encounter with these is
   typically buried in getting-started prose. A dedicated "Concepts" page under `operating/`
   with one-paragraph entries for each term would unblock first-time users faster.

2. **charmd lifecycle is undocumented for operators.** The architecture doc covers charmd, but
   there is no operator-level doc explaining: is it persistent, how does it start, how to check
   its status, what happens when it crashes. This is the most common daemon/client documentation
   gap.

3. **No quick-reference cheat sheet.** After a first session, users want the 10-most-used
   commands and keybindings on one page, not the full CLI reference. A `operating/cheatsheet.md`
   or a top-of-page summary in the CLI reference would serve this.

4. **Design notes bleed into the primary nav.** The docs/README lists design notes inline with
   operational docs. New users may read design notes as current behavior. Consider adding a clear
   "non-normative" callout at the top of every file under `design/`.

5. **No scripting / non-interactive usage guide.** If charm is used in CI or scripts (or
   intended to be), that use case deserves its own section. Exit codes, `--json` flags, and
   non-interactive approval flows should be explicitly documented.

6. **Troubleshooting is symptom-poor.** Check that the troubleshooting doc is organized by
   symptom ("workers are stuck", "console shows nothing", "session wedged after stage 2") rather
   than by internal cause. Users arrive with symptoms.

7. **Getting started could end with "what to read next."** After the first session, point users
   to concepts, the CLI reference, and troubleshooting explicitly. This bridges getting-started
   to depth without requiring the user to navigate the full docs tree.
