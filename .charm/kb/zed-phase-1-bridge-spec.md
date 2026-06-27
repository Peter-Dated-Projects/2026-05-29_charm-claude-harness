# Phase 1 bridge spec: daemon <-> Zed CharmState + wire protocol

Authoritative interface contract for the Phase 1 charm-daemon-to-Zed-fork bridge.
Every claim here is grounded in the charm daemon at HEAD (`src/daemon/**`,
`src/schema.ts`). This is what the Phase 1 worker and Phases 2-7 build against, so
it documents **what the daemon returns today** first, then **exactly what daemon
work each proposal-assumed field requires** -- because several fields the proposal
treats as "extend the JSON" do not exist as data anywhere in the daemon.

Read this alongside `proposals/PROP-zed-fork-build-plan/phase-1-charm-bridge.md`
(the design) and `orchestration-model.md` (the hierarchy spine). Where they
disagree with this file on the wire shape, this file is correct -- it is read off
the code.

---

## 0. Headline finding: the proposal's CharmState is mostly aspirational

The `status` RPC handler is `src/daemon/index.ts:683-688`. It returns **exactly
three fields**:

```ts
case "status":
  return {
    tickets: store.list().map((t) => t.frontmatter), // TicketFrontmatter[]  (NO body)
    agents: registry.list(),                          // Agent[]
    pending_approvals: approvals.pending(),           // ApprovalGate[]
  };
```

The proposal's `CharmState` (phase-1-charm-bridge.md:170-178) assumes six fields:
`tickets`, `agents` (with `parent_id` + `worktree`), `sub_orchestrators`,
`pending_gates`, `coordination`, `session`. Mapping proposal -> reality:

| Proposal field | Status today | Gap / required daemon work |
|---|---|---|
| `tickets: Vec<Ticket>` | `tickets` = `TicketFrontmatter[]` (frontmatter only, no `body`) | Minor. Body is not in status; read the `.md` file when a body is actually needed. |
| `agents[].parent_id` | **Does not exist.** `Agent` (schema.ts:77-91) has no parent field. | Real backend work -- see section 1.1. Registry never records who spawned whom. |
| `agents[].worktree` | Field is `worktree_name` (schema.ts:85), and it is **always `null`** in practice (section 1.2). | Rename in serde + actually populate it (no MCP spawn path sets a cwd today). |
| `sub_orchestrators: Vec<...>` | **Not in status at all.** | Derive it daemon-side from the registry; needs parent tracking first. |
| `pending_gates` | Field is named `pending_approvals` = `ApprovalGate[]` (schema.ts:93-110). | Rename only. Shape is fully defined; carry it as-is. |
| `coordination: String` | **Not in status.** Separate `read_coordination` RPC returns `{ text }` (index.ts:934). | Either a second poll call or fold into status. |
| `session: SessionMeta` | **Not in status.** Only written (`set_session_description`, index.ts:1203) to `meta.json`; no RPC reads it back. | Read `meta.json` directly, or add to status. |

**Bottom line for the orchestrator:** Phase 1 as written has a hidden
prerequisite. The hierarchy fields (`parent_id`, `worktree`, `sub_orchestrators`)
are not a serialization tweak -- the daemon does not track this data at all. The
bridge itself (poll + apply + idle-gated inject) is fully buildable on today's
status shape; the *hierarchy* is the part that needs daemon backend work, and it
is a Phase 3 (canvas) need, not a Phase 1 inject need. See section 4.

---

## 1. The CharmState Rust struct (typed, grounded)

### 1.0 What deserializes cleanly from today's `status`

charm's wire convention is **snake_case** (`ticket_id`, `worktree_name`,
`pane_id`, `started_at`, `pending_approvals`, `payload_path`, `created_at`). The
proposal's note that JSON field names are `parentId` / `worktree` (camelCase)
(phase-1-charm-bridge.md:257-258) is **wrong** -- match snake_case in serde.

```rust
// Mirrors src/schema.ts TicketFrontmatter (lines 45-54). status returns
// frontmatter only -- there is no `body` on the wire.
#[derive(Deserialize)]
pub struct TicketFrontmatter {
    pub id: String,                 // /^T-\d{3,}$/
    pub title: String,
    #[serde(rename = "type")]
    pub ticket_type: TicketType,    // "investigation" | "implementation"
    pub status: TicketStatus,       // pending|ready|running|blocked|complete|failed|cancelled
    pub stage: TicketStage,         // generated|investigating|approved|in_progress|testing|done|failed
    pub depends_on: Vec<String>,
    pub touches: Vec<String>,
}

// Mirrors src/schema.ts Agent (lines 77-91). This is registry.list() verbatim.
#[derive(Deserialize, Clone)]
pub struct AgentRecord {
    pub id: String,                       // e.g. "worker-003", "main-001"
    pub role: AgentRole,                  // main|investigator|worker|tester|suborchestrator
    pub ticket_id: Option<String>,
    pub worktree_name: Option<String>,    // NOT `worktree`; ~always None today (see 1.2)
    pub pane_id: Option<String>,
    pub pid: Option<u64>,
    pub state: AgentState,                // spawning|running|blocked|done|failed
    pub started_at: i64,                  // epoch ms
}

// Mirrors src/schema.ts ApprovalGate (lines 93-110). This is `pending_approvals`.
#[derive(Deserialize)]
pub struct ApprovalGate {
    pub id: String,
    pub stage: u8,                        // literal 2 | 4
    pub label: String,
    pub payload_path: Option<String>,
    pub ticket_id: Option<String>,
    pub agent_id: Option<String>,
    pub resolved: bool,
    pub decision: Option<GateDecision>,   // "approve" | "reject"
    pub created_at: i64,
}

/// Exactly what the `status` RPC returns today -- deserialize the poll into this.
#[derive(Deserialize)]
pub struct StatusSnapshot {
    pub tickets: Vec<TicketFrontmatter>,
    pub agents: Vec<AgentRecord>,
    pub pending_approvals: Vec<ApprovalGate>,
}

/// The UI-facing state. Built FROM StatusSnapshot plus two extra sources that are
/// not in `status` today (coordination text, session meta).
pub struct CharmState {
    pub tickets: Vec<TicketFrontmatter>,
    pub agents: Vec<AgentRecord>,
    pub pending_approvals: Vec<ApprovalGate>,
    pub coordination: String,             // from read_coordination, NOT status
    pub session: Option<SessionMeta>,     // from meta.json, NOT status

    // ---- hierarchy: requires daemon work (section 1.1); empty until then ----
    pub sub_orchestrators: Vec<SubOrchestratorRecord>,

    // bridge-internal, not deserialized:
    on_agent_spawned: Option<Box<dyn Fn(&AgentRecord)>>,
}
```

### 1.1 `parent_id` and `sub_orchestrators` do not exist as data

- `AgentRegistry.create()` (registry.ts:44-63) builds the `Agent` record with
  `{ id, role, ticket_id, worktree_name: null, pane_id, pid, state, started_at }`.
  **No parent field, no setter for one.**
- Every spawn path takes the spawning caller's `caller_id` only to *authorize*
  the call (`assertOrchestrator`, index.ts:515-522) -- it is never recorded on the
  spawned agent. `spawn_workers` (index.ts:836), `spawn_investigators`
  (index.ts:771), `request_review` (index.ts:1315), and `spawn_suborchestrator`
  (index.ts:1294) all create children with no link back to the parent.
- So a `sub_orchestrators` list with per-sub `agent_count` cannot be computed --
  there is no edge from a worker to the sub-orchestrator that spawned it.

To populate the hierarchy the daemon needs:
1. Add `parent_id: string | null` to the `Agent` schema (schema.ts:77) and to
   `registry.create()` (default `null`).
2. Thread the authorizing `caller_id` into `SpawnSpec` and set it as the child's
   `parent_id` in `spawnAgentLocked` (index.ts:385-448). `caller_id` is already in
   hand at all four spawn sites.
3. Add `sub_orchestrators` to the `status` return: filter `registry.list()` for
   `role === "suborchestrator"`, and for each count children where
   `parent_id === so.id`.

This is the "backend that produces a real hierarchy is not built" gap that
orchestration-model.md:78-80 already calls out. Recommend splitting it into its
own daemon-side ticket that blocks Phase 3, not Phase 1.

### 1.2 `worktree_name` is always null through the MCP surface

The plumbing exists -- `spawnAgentLocked` calls `registry.setWorktree()` when
`spec.cwd && spec.cwd !== paths.root` (index.ts:423) -- but **no caller passes a
`cwd`**. `spawn_workers`/`spawn_investigators`/`request_review` call
`spawnAgentLocked` with no `cwd` (so `spec.cwd ?? paths.root` resolves to root,
index.ts:418), and `spawn_suborchestrator` uses `cwd: paths.root`
(index.ts:1305). So worktree-isolated execution is not wired into the spawn path:
`create_worktree` makes the checkout, but nothing directs an agent into it.
Populating `worktree_name` requires a `cwd`/worktree param on the spawn RPCs.

### 1.3 `SessionMeta`

Mirrors schema.ts:331-349. All identity fields optional (older `meta.json`
files were description-only). Lives at `paths.metaJson`; not returned by any RPC.
Bridge should read the file directly (it is in the well-known run dir) or the
daemon should add it to `status`.

```rust
#[derive(Deserialize)]
pub struct SessionMeta {
    pub uuid: Option<String>,
    pub session_name: Option<String>,
    pub root: Option<String>,
    pub socket: Option<String>,
    pub pid: Option<u64>,
    pub description: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub source: SessionSource, // "agent" | "fallback" | "start"
}
```

---

## 2. The socket wire protocol

### 2.1 Transport (both directions)

Newline-delimited JSON-RPC over a Unix domain socket (`src/daemon/rpc.ts`).
Request frame: `{ id, method, params }\n` (schema.ts:112-116). Response frame:
`{ id, ok, result }\n` or `{ id, ok: false, error }\n` (schema.ts:119-125). The
server (`startRpcServer`, rpc.ts:43) and a client (`rpcCall`, rpc.ts:209) are both
in `rpc.ts`. Two properties the bridge's Rust client MUST replicate:

- **Per-call connection, id-correlated.** `attemptCall` (rpc.ts:120) opens a fresh
  connection per call, writes one frame, reads until it sees a line whose `id`
  matches, then closes. There is **no persistent connection and no server-push**
  in the current model -- a frame the client didn't ask for has nowhere to land.
- **Backpressure-safe writes.** A frame over ~8KB does not fit one `write()`; the
  unwritten tail must be resent on `drain` (rpc.ts:7-40, 183-193). A status reply
  with many tickets/agents will exceed 8KB, so the Rust reader must loop on partial
  reads and the writer must drain partial writes.

### 2.2 Poll (data in): `status` every 1500ms

`rpc_call(socket, "status", json!({}))` -> `StatusSnapshot` (section 1.0). Socket
path is `.charm/run/<uuid>/sock` (`paths.socket`); detect it per
phase-1-charm-bridge.md "Socket detection". Two companion reads the bridge needs
because they are not in `status`:

- `read_coordination` -> `{ text: String }` (index.ts:934) for `CharmState.coordination`.
- `meta.json` file read for `CharmState.session` (no RPC).

Fold both into the same 1500ms tick. (A future `status` extension could return all
three to save round-trips; not required for Phase 1.)

### 2.3 Inject push (data out): RECOMMENDED transport = bridge second listen socket

The hard direction is daemon -> bridge: today the daemon injects text by calling
`tmux.sendText(paneId, text)` (tmux.ts:185). In the fork there is no tmux pane to
paste into; the daemon must instead tell the bridge "inject this text into the
terminal for agent X." There are **exactly three such call-sites** (every
`sendText` into an agent pane):

1. `pingOrchestrator` -> orchestrator (`main-001`) wake line (index.ts:548).
2. `continue_agent` -> a blocked sub-agent's unblock message (index.ts:1181).
3. `set_mode` -> `/model <id>` + a mode-switch note to the orchestrator (index.ts:1251-1252).

(The other tmux touch-points -- `splitPane`/`killPane`/`relayout`/`listPanes` in
`spawnAgentLocked`, `tearDownAgent`, `relayoutLocked`, `sweepDeadPanes` -- are
pane-grid lifecycle, not text injection. They are Phase 4's concern, not the
bridge protocol. Keep them out of Phase 1 scope.)

**Three options** (the proposal's open question #2, phase-1-charm-bridge.md:355-363):

- **(a) Bridge opens a second listen socket; daemon connects as a client.**
  RECOMMENDED.
- (b) Server-push frame on the existing socket. Rejected: the current protocol is
  one-shot, id-correlated request/response (2.1). A server-push frame forces a
  persistent subscribed connection on both ends and an unsolicited-frame path the
  id-correlation loop (rpc.ts:162-181) is built to discard. Largest protocol
  change, touches the hot poll path.
- (c) Daemon writes a marker, the bridge's poll picks it up. Rejected for the
  inject path: up-to-1500ms latency on waking a blocked agent / the orchestrator
  is the user-visible lag the whole design is trying to cut.

**Why (a):** it reuses `rpc.ts` wholesale on both ends and matches the existing
architecture exactly -- the bridge runs a `startRpcServer` on a second socket
(e.g. `.charm/run/<uuid>/inject.sock`), and at the three call-sites the daemon
replaces `tmux.sendText(paneId, text)` with
`rpcCall(injectSock, "inject_text", { agent_id, text })`. The daemon already is an
RPC client (`rpcCall`); the bridge already must be an RPC server's peer. One frame
type:

```jsonc
// daemon -> bridge, on the inject socket
{ "id": "...", "method": "inject_text", "params": { "agent_id": "worker-003", "text": "..." } }
// bridge -> daemon reply
{ "id": "...", "ok": true }
```

**Registration & graceful fallback.** The daemon must know the inject socket path
and must no-op cleanly when no bridge is attached (legacy/tmux mode). Recommend
extending `register_panes` (index.ts:702) -- or a small `register_bridge` RPC --
so the bridge hands the daemon its `inject.sock` path on startup. Until a bridge
registers, the daemon keeps the `tmux.sendText` path; once one does, the three
call-sites route to `inject_text` instead. The existing
`register_panes`/`orchestrator_pane` ceremony stays; the handle type changes from
a tmux pane id to the agent_id the bridge resolves to a terminal entity.

Note the daemon today addresses injection by **pane_id** (`orchestratorPaneId`,
`target.pane_id`). The bridge addresses by **agent_id**. The mapping already
exists in the registry (`Agent.id <-> Agent.pane_id`), so the daemon should send
`agent_id` (resolve `orchestratorPaneId` back to `main-001`, send `target.id` from
`continue_agent`). The bridge owns the `agent_id -> Entity<Terminal>` map.

---

## 3. `apply()` diff + `on_agent_spawned` + idle-gated injection

### 3.1 `apply()` and the spawn callback

```rust
impl CharmState {
    fn apply(&mut self, snap: StatusSnapshot, coordination: String, session: Option<SessionMeta>) {
        let prev: HashSet<String> = self.agents.iter().map(|a| a.id.clone()).collect();
        let next = snap.agents;
        // fire the spawn callback for ids new since the last poll, BEFORE the swap
        if let Some(cb) = &self.on_agent_spawned {
            for a in next.iter().filter(|a| !prev.contains(&a.id)) {
                cb(a);
            }
        }
        self.agents = next;
        self.tickets = snap.tickets;
        self.pending_approvals = snap.pending_approvals;
        self.coordination = coordination;
        self.session = session;
        // self.sub_orchestrators: derive here once the daemon returns it; empty until then.
    }
}
```

This is "Option A" from the consistency audit (phase-1-charm-bridge.md:222-232):
spawn detection rides the existing 1500ms status poll -- the daemon's
`spawnAgentLocked` arrow in the diagram means "the poll observed a new agent id."
No separate spawn push channel. Phase 4's terminal manager registers exactly one
`on_agent_spawned` handler at bridge construction and is its only consumer; it
opens a terminal pane for the new agent.

Caveat: pass the whole `&AgentRecord` to the callback (not just the id) so Phase 4
gets `role` and `pane_id`. The proposal's sketch passes `agent.worktree` -- that
is `worktree_name` and is `None` today (section 1.2), so Phase 4 must not depend on
it for pane placement yet.

### 3.2 Idle-gated injection -- buildable on TODAY's data

The three-tier inject gating (orchestrator: strict idle-gate; sub-orchestrator:
idle-gate, looser; leaf: direct) from phase-1-charm-bridge.md:297-347 needs to
classify an `agent_id` into a tier. **This does not need `parent_id`.** The tier
is fully determined by data `status` returns today:

- `agent_id == "main-001"` (MAIN_AGENT_ID, spawn.ts:13) -> Orchestrator tier.
- `role == "suborchestrator"` -> Sub-orchestrator tier.
- `role in {worker, investigator, tester}` -> Leaf tier (direct `terminal.input`).

So the Phase 1 inject contract is independent of the hierarchy backend. `parent_id`
matters for drawing the canvas tree edges (Phase 3), not for inject routing.

```rust
fn agent_tier(&self, agent_id: &str) -> AgentTier {
    if agent_id == "main-001" { return AgentTier::Orchestrator; }
    match self.agents.iter().find(|a| a.id == agent_id).map(|a| &a.role) {
        Some(AgentRole::Suborchestrator) => AgentTier::SubOrchestrator,
        _ => AgentTier::Leaf,
    }
}
```

The idle signal must come from the orchestrator's `TerminalView` (does the human
have pending input?). For Orchestrator/SubOrchestrator tiers, queue and flush on
the next idle boundary; for Leaf, call `terminal.input(text.into_bytes())`
immediately.

### 3.3 The bracketed-paste risk is real -- inherited from tmux

`tmux.sendText` deliberately uses **bracketed paste**, not `send-keys -l`, because
literal multi-line sends broke two ways: a newline reads as SUBMIT (so a
multi-line orchestrator message was truncated at the first line) and a long blob +
Enter raced the TUI's ingest (tmux.ts:163-194). A bare
`terminal.input(bytes_with_newlines)` into claude's REPL will hit the **same**
failure if the REPL has bracketed paste on -- the message submits early on the
first `\n`. Phase 1 MUST prototype multi-line injection against a real claude REPL;
if it breaks, wrap the payload in `ESC[200~ ... ESC[201~` and send a terminating
Enter, exactly as tmux's `paste-buffer -p` + `send-keys Enter` does
(tmux.ts:191-193). A bug here is silent: the orchestrator/agent simply never wakes.

---

## 4. Build-ticket guidance (what a Phase 1 worker touches)

Buildable in Phase 1 on today's daemon, no backend hierarchy work:
- New crate `crates/charm/` + `crates/charm/src/charm_bridge.rs` (Rust side only;
  no edits to `src/daemon/**` except the inject transport below).
- Poll loop -> `status` + `read_coordination` + `meta.json`; `StatusSnapshot` /
  `CharmState` per section 1.0; `apply()` + `on_agent_spawned` per 3.1.
- Idle-gated `inject_text` dispatch per 3.2 (tier from role + `main-001`).
- Bracketed-paste prototype per 3.3 BEFORE trusting `terminal.input`.

Daemon-side change Phase 1 does need (small, in `src/daemon/`):
- Bridge inject socket: `register_bridge`/`register_panes` extension + route the
  three `sendText` call-sites (index.ts:548, 1181, 1251-1252) to
  `rpcCall(injectSock, "inject_text", {agent_id, text})` when a bridge is
  attached, tmux fallback otherwise. Send `agent_id`, not `pane_id`.

Recommend a SEPARATE daemon ticket (blocks Phase 3, not Phase 1) for the
hierarchy backend: `Agent.parent_id` + thread `caller_id` into `spawnAgentLocked`
+ `sub_orchestrators` in `status` (section 1.1), and a `cwd`/worktree param on the
spawn RPCs so `worktree_name` is actually populated (section 1.2).
