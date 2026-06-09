# PROP-charm-harness-ui-revamp

**Status:** draft

---

## Problem

The charm harness currently uses a tmux-based TUI as its UI layer. This was
the right call for getting to a working system quickly, but it constrains
what the UI can express and limits the audience to people comfortable in a
terminal. As the harness matures, the question of whether to stay in the
terminal, adopt a richer TUI framework, or graduate to a full app becomes
consequential for both UX quality and distribution.

---

## Context / Findings

### charm.land

charm.land is the Charm team's suite of Go-based terminal UI libraries:

- **Bubble Tea** -- Elm-architecture TUI framework. Component model, event
  loop, composable views. The foundation most Charm apps are built on.
- **Bubbles** -- Pre-built Bubble Tea components (lists, text inputs, tables,
  spinners, viewports, etc.).
- **Lip Gloss** -- Style/layout DSL for terminal output: colors, borders,
  padding, flexbox-like alignment. Operates on strings, not a DOM.
- **Glamour** -- Markdown rendering for the terminal (code blocks, headers,
  tables).
- **Huh** -- Form library for interactive prompts and configuration UIs.
- **Harmonica** -- Animation/easing for smooth TUI transitions.
- **Wish** -- SSH app server: expose a Bubble Tea app over SSH so users
  connect without installing anything.
- **Soft Serve** -- Git server built on Wish; shows the pattern of a
  self-hosted service using the same stack.

**What this stack is good at:**
- Rich, composable terminal UIs with relatively clean Go code.
- Real-time streaming output (progress bars, live logs, agent status grids).
- SSH-accessible UI with no client install (Wish).
- Self-contained single binaries.

**What it does not solve:**
- The harness is Python-heavy (daemon, hooks, MCP server). A Go rewrite or a
  Go UI wrapper around a Python core adds a language boundary.
- No native graph/network visualization -- the force-directed graph is
  currently rendered in a browser window. Bubble Tea has no equivalent.
- Mobile, sharing, or remote-access-beyond-SSH scenarios are out of scope.
- No built-in OAuth, auth management, or multi-user concepts.

**Assessment:** Bubble Tea + Lip Gloss would materially improve the charm
Console over raw tmux panes. It would give a proper agent status grid, a
real settings form (via Huh), and clean markdown rendering for ticket/KB
views. The migration cost is non-trivial -- it means rewriting the Console
layer in Go or wrapping it -- but the outcome would be a visibly more polished
tool with no new distribution requirements.

---

### Full App: Conductor / Superset.sh Direction

Two reference points for what "graduating to a full app" looks like in this
space:

- **Conductor** -- web-based orchestration UI for agent workflows. Assumes a
  running backend, serves a React/Next.js frontend, gives non-terminal users
  access to pipeline state. Closest analogue to what charm could become if
  it wanted a browser UI.
- **Superset.sh** -- positions itself as a "terminal for teams": a hosted web
  app that wraps terminal sessions in a browser tab, adds sharing, commenting,
  and async collaboration. Not an orchestrator, but shows the pattern of
  taking a terminal-native workflow and making it accessible without giving up
  the terminal metaphor.

**Benefits of going full app:**
- Richer visualization (real force-directed graphs in-browser, not a
  spawned window).
- Accessible to collaborators who don't have the harness installed.
- Better multi-session / multi-project management from a single dashboard.
- Auth, RBAC, and team features become natural extensions.
- Mobile and async access to session state.

**Downsides:**
- Massive scope increase. What is currently a single-machine CLI tool becomes
  a client-server product with a deployment story.
- Infrastructure cost (hosting, auth, database for multi-user state).
- Distribution complexity -- a CLI tool ships as a pip install; a web app
  ships as a hosted service or a self-hosted container.
- Slower iteration cycle: changes to UI require a full frontend build step
  rather than editing a .md prompt file.
- Risk of premature productization: building the app before nailing the
  core workflow semantics wastes effort.

**Best direction if pursuing a full app:**
The least-regret path would be a local-first Electron or Tauri app that
embeds the current Python daemon and serves a React frontend. This gives
browser-quality UI (real graphs, markdown, forms) while keeping the
single-machine, no-auth, no-deployment model of the current tool. It
preserves the existing Python backend without a rewrite and uses a familiar
web stack for the UI. Once the local app is stable, adding an optional
server mode (multi-user, hosted) becomes a well-scoped extension.

**Tauri vs Electron:**
- Tauri: Rust core, ~10x smaller bundle, faster startup. Better long-term
  but adds a Rust build dependency.
- Electron: Node.js core, heavier, but the entire frontend toolchain is
  already Node -- no new language introduced. Faster to ship a prototype.
- Recommendation: Electron for a prototype, with the explicit intent to
  migrate to Tauri if the app proves worth keeping.

---

## Proposal

Two-track approach:

**Track A (near-term, low-risk):** Migrate the charm Console to Bubble Tea +
Lip Gloss. This is a contained improvement to the existing terminal UX
without changing the distribution model or introducing a new language
boundary in the hot path. Delivers: proper agent grid, settings form via
Huh, markdown KB viewer. Estimated scope: medium (weeks, not months).

**Track B (longer-term, higher value):** Build a local Electron app that
embeds the daemon and serves a React frontend. Unlocks real graph
visualization, richer ticket/proposal views, and eventual multi-user
extension. This is the right path if charm is intended to become a
distributable product rather than a personal harness. Estimated scope:
large. Should not be started until the core workflow semantics (tickets,
agents, KB, proposals) are stable -- building UI on shifting foundations
is waste.

**Sequencing recommendation:** Ship Track A first. If charm reaches the
point where it is being shared with teammates or run in a multi-project
context regularly, start Track B.

---

## Alternatives Considered

- **Stay on raw tmux:** Zero migration cost. But the ceiling on UX quality
  is low -- tmux panes cannot render tables, forms, or live-updating grids
  cleanly. Already hitting this ceiling with the coordination board.

- **Wish (SSH app server):** Interesting for team access without an install,
  but adds an always-on server requirement and complicates auth. Out of scope
  for a single-user harness.

- **Tauri instead of Electron for Track B:** Better long-term, but Rust as
  a new build dependency slows the prototype. Revisit after an Electron
  prototype validates the direction.

- **Pure web app (no Electron):** Requires a server deployment, which breaks
  the single-machine model. Only sensible if multi-user is a hard requirement
  from the start.

---

## Open Questions

- Is charm intended to stay a personal harness or become a shared team tool?
  The answer determines whether Track B is worth the investment.
- What is the right Go/Python boundary if we adopt Bubble Tea? A thin Go
  shell that shells out to Python, or a proper IPC layer (Unix socket, gRPC)?
- For Track B: what does the daemon's API surface need to look like to serve
  a browser frontend? (Current: Python subprocess + sqlite + file conventions.
  Would need at minimum a local HTTP API.)

---

## Status

draft
