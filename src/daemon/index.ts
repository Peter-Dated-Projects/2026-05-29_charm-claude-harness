#!/usr/bin/env bun
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { charmPaths, defaultSessionName } from "../paths.ts";
import { TicketStore } from "../store/tickets.ts";
import { AgentRegistry } from "./registry.ts";
import { CoordinationWriter } from "./coord.ts";
import { Solver, type InFlight } from "./solver.ts";
import { createMultiplexer, multiplexerAvailable, type LaunchSpec } from "./multiplexer.ts";
import { ApprovalQueue } from "./approvals.ts";
import { startRpcServer, isPipe } from "./rpc.ts";
import { buildClaudeLaunch, defaultModelForRole, ensureDirectoryTrusted, MAIN_AGENT_ID, type SpawnSpec } from "./spawn.ts";
import { killGraphViewers } from "../graph-viewers.ts";
import {
  CreateTicketsInput,
  SpawnReviewersInput,
  SpawnWorkersInput,
  AwaitApprovalInput,
  UpdatePlanInput,
  ReportStatusInput,
  SetTicketStatusInput,
  RequestReviewInput,
  SetSessionDescriptionInput,
  KillAgentInput,
  CancelTicketInput,
  ContinueAgentInput,
  SessionMeta,
  COORDINATION_STATUSES,
  type AgentRole,
} from "../schema.ts";

type DaemonOpts = { root: string; session: string };

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** argv that runs the graph viewer. Resolution precedence:
 *    1. CHARM_GRAPH_BIN  -- explicit override (path to a charm-graph binary)
 *    2. compiled daemon  -- the `charm-graph` binary installed alongside charmd
 *    3. from TS source   -- `<bun> run src/console/graph.ts`
 *  A compiled binary's own module URL lives under Bun's embedded "$bunfs" root
 *  (not on disk) and process.execPath is the daemon binary rather than bun, so
 *  the source-style `<bun> run <file>` form only works when running from source. */
function graphBinArgs(): string[] {
  const override = process.env.CHARM_GRAPH_BIN;
  if (override) return [override];
  const url = typeof import.meta.url === "string" ? import.meta.url : "";
  const compiled = url.includes("/$bunfs/") || url.includes("/~BUN/");
  if (compiled) {
    // .exe suffix on Windows — see exeName() in cli.ts for the rationale.
    const binName = process.platform === "win32" ? "charm-graph.exe" : "charm-graph";
    const sibling = join(dirname(process.execPath), binName);
    return [existsSync(sibling) ? sibling : binName];
  }
  return [process.execPath, "run", join(import.meta.dir, "../console/graph.ts")];
}

/** How to open ONE graph viewer in a brand-new OS terminal window, fully outside
 *  tmux. Returns a spawnSync-style spec (the daemon runs it and returns).
 *
 *  The viewer runs as `CHARM_GRAPH_PIDFILE=<file> CHARM_KB_DIR=<dir> <graphbin>; exit`
 *  inside the new window: it self-registers its PID for `charm stop` to reap,
 *  renders + live-watches the knowledge base at CHARM_KB_DIR, and the trailing
 *  `exit` lets the window close once the viewer quits (subject to the terminal's
 *  "close on clean exit" setting).
 *
 *  Which terminal: an explicit CHARM_GRAPH_TERMINAL_CMD wins (a custom launcher;
 *  it receives CHARM_GRAPH_CMD + CHARM_GRAPH_PIDFILE + CHARM_KB_DIR in its env).
 *  Otherwise we open the same program charm itself is running in, read from
 *  TERM_PROGRAM (inherited by the daemon from `charm start`). iTerm and Apple
 *  Terminal each get their own AppleScript dialect; anything else (or a missing
 *  TERM_PROGRAM) falls back to Terminal.app, which exists on every Mac. */
/** True if a process with this pid currently exists. Signal 0 does the kernel's
 *  permission/existence check without delivering a signal. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function graphLaunchSpec(pidFile: string, kbDir: string): { cmd: string; args: string[]; env?: NodeJS.ProcessEnv } {
  const inner =
    `CHARM_GRAPH_PIDFILE=${shq(pidFile)} CHARM_KB_DIR=${shq(kbDir)} ` +
    `${graphBinArgs().map(shq).join(" ")}; exit`;

  const custom = process.env.CHARM_GRAPH_TERMINAL_CMD;
  if (custom) {
    return {
      cmd: "sh",
      args: ["-c", custom],
      env: { ...process.env, CHARM_GRAPH_CMD: inner, CHARM_GRAPH_PIDFILE: pidFile, CHARM_KB_DIR: kbDir },
    };
  }

  if (process.platform !== "darwin") {
    throw new Error(
      "opening a separate terminal window is only built in for macOS; " +
        "set CHARM_GRAPH_TERMINAL_CMD to a launcher (it gets $CHARM_GRAPH_CMD).",
    );
  }

  // Escape for embedding inside an AppleScript double-quoted string literal.
  const asStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const termProgram = process.env.TERM_PROGRAM ?? "";

  if (termProgram === "iTerm.app") {
    // iTerm: make a new window from the default profile, then run the command in it.
    const script =
      `tell application "iTerm"\n` +
      `  set w to (create window with default profile)\n` +
      `  tell current session of w to write text ${asStr(inner)}\n` +
      `  activate\n` +
      `end tell`;
    return { cmd: "osascript", args: ["-e", script] };
  }

  // Apple Terminal (TERM_PROGRAM=Apple_Terminal) and the safe default for anything
  // else: `do script` with no target opens a fresh window and runs the command.
  const script = `tell application "Terminal"\n  do script ${asStr(inner)}\n  activate\nend tell`;
  return { cmd: "osascript", args: ["-e", script] };
}

async function main() {
  const program = new Command();
  program
    .name("charmd")
    .option("--root <path>", "project root", process.cwd())
    .option("--session <name>", "tmux session name (default: derived from --root)")
    .parse(process.argv);
  const opts = program.opts<DaemonOpts>();
  // cli.ts always passes an explicit --session; derive a per-directory default
  // only for the rare case of running charmd directly, so it never falls back to
  // a hardcoded "charm" that would collide with another directory's session.
  const session = opts.session ?? defaultSessionName(opts.root);

  const paths = charmPaths(opts.root);
  mkdirSync(paths.charmDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });

  // Refuse to start only if a *live* daemon already owns this directory. A
  // lingering pidfile from a hard kill or crash (common on Windows, where
  // process.kill can't run the graceful handler) names a dead pid — treat that
  // as stale, clear it (and any stale ready marker), and continue. We read the
  // pidfile synchronously: Bun.file().text() returns a Promise, so the old
  // `Number(Bun.file(...).text())` was always NaN.
  if (existsSync(paths.pidFile)) {
    // NB: read synchronously. Bun.file().text() is async — `Number(Promise)`
    // is always NaN, which previously made this guard refuse *every* start
    // whenever any pidfile existed, even after a clean crash.
    const recorded = Number(readFileSync(paths.pidFile, "utf8").trim());
    if (Number.isInteger(recorded) && recorded > 0 && isProcessAlive(recorded)) {
      console.error(`[charmd] already running (pid=${recorded}); refusing to start a second daemon.`);
      process.exit(2);
    }
    // Stale pidfile (dead pid, or unparseable from a partial write). Reclaim it
    // (and any stale ready marker) instead of wedging — otherwise a crash
    // permanently blocks restart until someone hand-removes the file. On Windows
    // a hard kill can't run the graceful handler, so this is the common path.
    console.error(`[charmd] removing stale pidfile (pid=${recorded}) from a prior crash`);
    try { unlinkSync(paths.pidFile); } catch { /* ignore */ }
    try { unlinkSync(paths.ready); } catch { /* ignore */ }
  }
  writeFileSync(paths.pidFile, String(process.pid));

  ensureDirectoryTrusted(paths.root);

  const store = new TicketStore(paths);
  store.reindexAll();
  const registry = new AgentRegistry();
  const coord = new CoordinationWriter(paths);
  const mux = createMultiplexer(session);
  const approvals = new ApprovalQueue();

  const muxAvailable = multiplexerAvailable();
  if (!muxAvailable) {
    console.error("[charmd] WARNING: no terminal multiplexer (tmux/psmux) on PATH; spawning panes will fail.");
  }

  const inFlight = (): InFlight[] =>
    registry
      .list()
      .filter((a) => a.role === "worker" && (a.state === "running" || a.state === "blocked") && a.ticket_id)
      .map((a) => {
        const t = store.read(a.ticket_id!);
        return { ticket_id: a.ticket_id!, touches: t?.frontmatter.touches ?? [] };
      });

  // Recompute COORDINATION.md from current state: one row per live ticket (every
  // status except `complete`), driven off the sqlite index — NOT the agent
  // registry. This is the board's whole point: an open-but-unassigned ticket and
  // a failed-but-needs-attention ticket both belong on it, neither of which has a
  // live agent. We join the registry only to annotate which sub-agent (if any) is
  // currently on each ticket. Fully derived, rebuilt and rewritten on every
  // change, so it stays small no matter how long the run.
  const refreshCoordination = () => {
    const agentByTicket = new Map<string, { id: string; state: string }>();
    for (const a of registry.list()) {
      if (a.role !== "main" && a.ticket_id) agentByTicket.set(a.ticket_id, { id: a.id, state: a.state });
    }
    const rows = store.queryIndex({ statuses: COORDINATION_STATUSES }).map((t) => {
      const agent = agentByTicket.get(t.id) ?? null;
      return {
        ticket_id: t.id,
        about: t.title,
        stage: t.stage,
        status: t.status,
        agent_id: agent?.id ?? null,
        agent_state: agent?.state ?? null,
      };
    });
    coord.write(rows);
  };

  // Pane layout state. consolePaneId is the Ink TUI pane (pinned left column);
  // agentPaneIds is every Claude pane in spawn order, starting with the "main"
  // agent pane registered by `cli.ts start` before any sub-agents.
  let consolePaneId: string | null = null;
  const agentPaneIds: string[] = [];
  // Pane id of the orchestrator (main agent), set on register_panes. The daemon
  // wakes this pane when a sub-agent finishes so the orchestrator can reap it.
  let orchestratorPaneId: string | null = null;
  const WINDOW = "charm";

  function relayout() {
    if (!muxAvailable || !consolePaneId || agentPaneIds.length === 0) return;
    try {
      // The backend owns the layout strategy: tmux applies a precise custom
      // layout (console column + VS-Code agent grid); psmux approximates with a
      // preset. The daemon just names the console pane and the agent panes.
      mux.relayout({ window: WINDOW, consolePaneId, agentPaneIds });
    } catch (e) {
      console.error("[charmd] relayout failed:", e);
    }
  }

  function spawnAgent(spec: SpawnSpec): string {
    const agent = registry.create({ role: spec.role, ticket_id: spec.ticket_id });
    const resolved: SpawnSpec = { ...spec, model: spec.model ?? defaultModelForRole(spec.role) };
    const launch: LaunchSpec = { ...buildClaudeLaunch(paths, agent.id, resolved), cwd: paths.root };
    const pane = mux.splitPane({ launch, direction: "h" });
    registry.attach(agent.id, { pane_id: pane });
    refreshCoordination();
    agentPaneIds.push(pane);
    relayout();
    return agent.id;
  }

  /** Kill an agent's pane and drop it from the registry, coordination doc, and
   *  pane grid, then relayout. Shared by dismiss_agent (done/failed cleanup) and
   *  kill_agent (forced termination). No-op if the agent is already gone. */
  function tearDownAgent(agent_id: string) {
    const a = registry.get(agent_id);
    if (!a) return;
    if (a.pane_id) {
      try { mux.killPane(a.pane_id); } catch { /* ignore */ }
      const i = agentPaneIds.indexOf(a.pane_id);
      if (i >= 0) agentPaneIds.splice(i, 1);
    }
    registry.remove(agent_id);
    refreshCoordination();
    relayout();
  }

  /** Resolve the role of a kill_agent caller. The human operator (Console pane)
   *  sends no caller_id and is treated as a privileged operator. An agent caller
   *  is identified by CHARM_AGENT_ID: the orchestrator's fixed id resolves to
   *  "main"; any other id is looked up in the registry. */
  function resolveCaller(caller_id: string | undefined): "operator" | AgentRole {
    if (caller_id === undefined) return "operator";
    if (caller_id === MAIN_AGENT_ID) return "main";
    const a = registry.get(caller_id);
    if (!a) throw new Error(`unknown caller agent: ${caller_id}`);
    return a.role;
  }

  // Wake the orchestrator when sub-agents change state, so it can reap finished
  // panes and advance the workflow. Bursts are coalesced into a single wake: if
  // five workers finish at once the orchestrator (on Opus) takes one turn, not
  // five. Events accumulate for a short window, then flush as one injected line.
  let pingPending: string[] = [];
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  function pingOrchestrator(event: string) {
    if (!muxAvailable || !orchestratorPaneId) return;
    pingPending.push(event);
    if (pingTimer) return; // already armed — coalesce into the pending flush
    pingTimer = setTimeout(() => {
      const events = pingPending;
      pingPending = [];
      pingTimer = null;
      // The pane may have vanished (orchestrator exited) during the window.
      if (!orchestratorPaneId || !mux.paneAlive(orchestratorPaneId)) return;
      // One line only: literal newlines typed into the pane would submit early.
      const line =
        `[charm] ${events.join("; ")}. Check list_agents() (read the ticket file .charm/tickets/<id>.md for the ` +
        `blocked agent's note and activity log): reap done/failed sub-agents with kill_agent, and for each blocked ` +
        `one either resolve what it was waiting on and resume it with continue_agent or abandon it with kill_agent, ` +
        `then advance the workflow per your orchestrator instructions.`;
      try { mux.sendText(orchestratorPaneId, line); }
      catch (e) { console.error("[charmd] pingOrchestrator failed:", e); }
    }, 1200);
  }

  const server = startRpcServer(paths.socket, async (method, params) => {
    switch (method) {
      case "ping":
        return { ok: true, ts: Date.now() };
      case "status":
        return {
          tickets: store.list().map((t) => t.frontmatter),
          agents: registry.list(),
          pending_approvals: approvals.pending(),
        };
      case "list_tickets": {
        // Query the sqlite index, optionally filtered to a set of statuses. This
        // is the agent-facing backlog view (exposed as the list_tickets MCP tool)
        // and the queryable counterpart to COORDINATION.md's rendered board.
        const p = (params ?? {}) as { statuses?: string[] };
        return store.queryIndex({ statuses: p.statuses });
      }
      case "approve_gate": {
        const { id, decision } = params as { id: string; decision: "approve" | "reject" };
        return { resolved: approvals.resolve(id, decision) };
      }
      case "pending_approvals":
        return approvals.pending();
      case "register_panes": {
        // Called once by `cli.ts start` after creating the tmux session, so
        // the daemon knows which pane to pin as the console column and which
        // panes already belong to the agent grid (the main agent at minimum).
        const { console_pane_id, agent_pane_ids } = params as {
          console_pane_id: string;
          agent_pane_ids: string[];
        };
        consolePaneId = console_pane_id;
        agentPaneIds.length = 0;
        agentPaneIds.push(...agent_pane_ids);
        // The first agent pane is the orchestrator (main); cli.ts registers it
        // before any sub-agents. It's the pane the daemon wakes on sub-agent
        // state changes.
        orchestratorPaneId = agent_pane_ids[0] ?? null;
        refreshCoordination();
        relayout();
        return { ok: true };
      }
      // ---- MCP-facing tools ----
      case "create_tickets": {
        const input = CreateTicketsInput.parse(params);
        const created = input.tickets.map((t) => store.create(t).frontmatter);
        return created;
      }
      case "spawn_review_agents": {
        const input = SpawnReviewersInput.parse(params);
        const ids: string[] = [];
        for (const tid of input.ticket_ids) {
          ids.push(spawnAgent({
            role: "reviewer",
            ticket_id: tid,
            prompt: `Review and enrich .charm/tickets/${tid}.md in place.`,
            interactive: true,
          }));
        }
        return { agent_ids: ids };
      }
      case "spawn_workers": {
        const input = SpawnWorkersInput.parse(params);
        const completed = new Set(
          store.list().filter((t) => t.frontmatter.status === "complete").map((t) => t.frontmatter.id),
        );
        const solver = new Solver(store.list());
        const runnable = solver.nextRunnable({
          completed,
          inFlight: inFlight(),
          candidates: input.ticket_ids,
        });
        const ids: string[] = [];
        for (const tid of runnable) {
          ids.push(spawnAgent({
            role: "worker",
            ticket_id: tid,
            prompt: `Implement ticket T-${tid.slice(2)}. First read .charm/tickets/${tid}.md (your ticket, incl. its activity log) and .charm/COORDINATION.md (the index of what other agents are working on), then call update_plan() with your plan, then implement.`,
            interactive: true,
          }));
          store.update(tid, { status: "running", stage: "in_progress" });
        }
        const deferred = input.ticket_ids.filter((id) => !runnable.includes(id));
        return { agent_ids: ids, deferred };
      }
      case "await_approval": {
        const input = AwaitApprovalInput.parse(params);
        const decision = await approvals.enqueue({
          stage: input.stage,
          label: input.label,
          ticket_id: input.ticket_id,
          payload_path: input.payload_path,
        });
        return { decision };
      }
      case "update_plan": {
        const input = UpdatePlanInput.parse(params);
        const a = registry.get(input.agent_id);
        if (!a) throw new Error(`unknown agent: ${input.agent_id}`);
        // The plan lives only in the ticket's activity log, not on the in-memory
        // agent record or COORDINATION.md.
        if (a.ticket_id) store.appendLog(a.ticket_id, { agent: a.id, kind: "plan", text: input.plan });
        refreshCoordination();
        return { ok: true };
      }
      case "read_coordination":
        return { text: coord.read() };
      case "report_status": {
        const input = ReportStatusInput.parse(params);
        const a = registry.setState(input.agent_id, input.state, input.note);
        if (input.state === "done" && a.ticket_id) {
          store.update(a.ticket_id, { status: "complete", stage: "done" });
        } else if (input.state === "failed" && a.ticket_id) {
          store.update(a.ticket_id, { status: "failed", stage: "failed" });
        }
        // Record the status transition (and any note) in the ticket's activity
        // log. Done after the frontmatter update above so the log entry reflects
        // the new status. COORDINATION.md only shows the live state, not the note.
        if (a.ticket_id) store.appendLog(a.ticket_id, { agent: a.id, kind: input.state, text: input.note });
        refreshCoordination();
        // Wake the orchestrator on a sub-agent's done/failed/blocked so it can
        // reap the pane and advance. Never ping for the main agent itself.
        if (a.role !== "main" && (input.state === "done" || input.state === "failed" || input.state === "blocked")) {
          pingOrchestrator(`${a.id} (${a.role}) -> ${input.state}${a.ticket_id ? ` on ${a.ticket_id}` : ""}`);
        }
        return { ok: true };
      }
      case "set_ticket_status": {
        // Worker-driven ticket lifecycle: the calling agent sets its OWN ticket's
        // status and/or stage. Self-scoped via agent_id (folded in by the MCP shim),
        // so an agent can never move another's ticket. `cancelled` is not settable
        // here (enforced by the input schema) — that's an operator call-off, not a
        // worker decision. Like report_status, the transition is mirrored into the
        // ticket's activity log, and COORDINATION.md is rebuilt.
        const input = SetTicketStatusInput.parse(params);
        const a = registry.get(input.agent_id);
        if (!a) throw new Error(`unknown agent: ${input.agent_id}`);
        if (!a.ticket_id) throw new Error(`agent ${input.agent_id} holds no ticket`);
        const patch: { status?: string; stage?: string } = {};
        if (input.status) patch.status = input.status;
        if (input.stage) patch.stage = input.stage;
        store.update(a.ticket_id, patch);
        const kind = input.status ? `status=${input.status}` : `stage=${input.stage}`;
        store.appendLog(a.ticket_id, { agent: a.id, kind, text: input.note });
        refreshCoordination();
        return { ok: true };
      }
      case "dismiss_agent": {
        const { agent_id } = params as { agent_id: string };
        const a = registry.get(agent_id);
        if (!a) throw new Error(`unknown agent: ${agent_id}`);
        if (a.state !== "done" && a.state !== "failed") {
          throw new Error(`agent ${agent_id} is ${a.state}; only done/failed can be dismissed`);
        }
        tearDownAgent(agent_id);
        return { ok: true };
      }
      case "kill_agent": {
        const input = KillAgentInput.parse(params);
        const callerRole = resolveCaller(input.caller_id);
        // A null/absent agent_id means "kill myself". That only resolves to a
        // concrete target for an agent caller; the human operator must name one.
        const targetId = input.agent_id ?? input.caller_id;
        if (!targetId) throw new Error("agent_id is required");

        // The orchestrator is protected: it is never a valid kill target, for any
        // caller. Guard on the id directly (it is not in the registry) so this holds
        // even before the target lookup.
        if (targetId === MAIN_AGENT_ID) {
          throw new Error("refusing to kill the orchestrator (main agent)");
        }
        const target = registry.get(targetId);
        if (!target) throw new Error(`unknown agent: ${targetId}`);

        const isSelf = targetId === input.caller_id;
        // Authorization: the human operator and the orchestrator may kill any
        // sub-agent; a sub-agent may only kill itself.
        if (callerRole !== "operator" && callerRole !== "main" && !isSelf) {
          throw new Error(
            `agent ${input.caller_id} (${callerRole}) may only kill itself; ` +
            `killing ${targetId} requires the orchestrator`,
          );
        }

        // Aborting an in-flight ticket. The terminal status depends on WHO killed
        // it: a worker tearing down its own pane couldn't finish -> `failed`; an
        // operator/orchestrator killing someone else's pane is a deliberate call-off
        // -> `cancelled`. Both surface differently in the log and on the board
        // (failed stays for a retry, cancelled drops off).
        // Aborting an in-flight ticket marks it `failed` (not `cancelled`) so it
        // stays on the board and surfaces for retry — killing a stuck/looping agent
        // is a "kill and reassign" move, not a "call this off" one. Deliberate
        // cancellation (the ticket is no longer wanted) is a separate, explicit path
        // — see cancel_ticket — precisely so it can't be confused with a retry kill.
        if (target.ticket_id && (target.state === "spawning" || target.state === "running")) {
          try { store.update(target.ticket_id, { status: "failed", stage: "failed" }); } catch { /* ignore */ }
        }

        if (isSelf) {
          // The caller is tearing down its own pane, which also kills the claude
          // process that issued this RPC. Defer one tick so the reply flushes
          // before the pane (and its MCP shim) dies — mirrors `shutdown`.
          setTimeout(() => tearDownAgent(targetId), 50);
        } else {
          tearDownAgent(targetId);
        }
        return { ok: true, killed: targetId };
      }
      case "cancel_ticket": {
        // Deliberate call-off: this ticket is no longer wanted. Distinct from
        // kill_agent (which fails a ticket for retry) — cancelling marks it
        // `cancelled`, drops it off the board, and tears down any agent on it.
        // Operator/orchestrator only; a sub-agent can't cancel work.
        const input = CancelTicketInput.parse(params);
        const callerRole = resolveCaller(input.caller_id);
        if (callerRole !== "operator" && callerRole !== "main") {
          throw new Error(
            `agent ${input.caller_id} (${callerRole}) may not cancel tickets; that requires the orchestrator`,
          );
        }
        const t = store.read(input.ticket_id);
        if (!t) throw new Error(`unknown ticket: ${input.ticket_id}`);
        if (t.frontmatter.status === "complete") {
          throw new Error(`ticket ${input.ticket_id} is already complete; nothing to cancel`);
        }
        store.update(input.ticket_id, { status: "cancelled" });
        store.appendLog(input.ticket_id, {
          agent: input.caller_id ?? "operator",
          kind: "cancelled",
          text: input.note,
        });
        // Stop any agent currently on this ticket — its work is moot now.
        const onTicket = registry.list().find((a) => a.role !== "main" && a.ticket_id === input.ticket_id);
        if (onTicket) tearDownAgent(onTicket.id);
        refreshCoordination();
        // A human operator cancelling from the console is news to the orchestrator;
        // a cancel the orchestrator issued itself is not.
        if (callerRole === "operator") {
          pingOrchestrator(`${input.ticket_id} cancelled by operator${input.note ? `: ${input.note}` : ""}`);
        }
        return { ok: true, cancelled: input.ticket_id };
      }
      case "continue_agent": {
        const input = ContinueAgentInput.parse(params);
        const callerRole = resolveCaller(input.caller_id);
        // Only the human operator and the orchestrator may resume an agent. A
        // sub-agent cannot drive another sub-agent.
        if (callerRole !== "operator" && callerRole !== "main") {
          throw new Error(
            `agent ${input.caller_id} (${callerRole}) may not continue other agents; that requires the orchestrator`,
          );
        }
        // The orchestrator drives the workflow itself — it is never a target.
        if (input.agent_id === MAIN_AGENT_ID) {
          throw new Error("refusing to continue the orchestrator (main agent)");
        }
        const target = registry.get(input.agent_id);
        if (!target) throw new Error(`unknown agent: ${input.agent_id}`);
        // Only a blocked agent can be continued. `running` is the normal
        // actively-working state (set on attach), so typing into that pane would
        // inject mid-turn and corrupt the agent's work. done/failed are terminal
        // (spawn a fresh agent instead); spawning hasn't taken its first turn yet,
        // so there's nothing to resume.
        if (target.state !== "blocked") {
          throw new Error(
            `agent ${target.id} is ${target.state}; only a blocked agent can be continued`,
          );
        }
        if (!target.pane_id) throw new Error(`agent ${target.id} has no pane to message`);
        if (!muxAvailable || !mux.paneAlive(target.pane_id)) {
          throw new Error(`agent ${target.id}'s pane is gone — it may have exited; kill_agent and respawn instead`);
        }
        // Wake the blocked agent with the orchestrator's guidance (one line — a
        // literal newline would submit early), then optimistically flip it back
        // to running. The agent corrects this via its own report_status as it
        // proceeds, re-blocks, or finishes.
        mux.sendText(target.pane_id, `[charm] Orchestrator: ${input.message}`);
        const a = registry.setState(target.id, "running");
        // Record the orchestrator's unblock message in the ticket's activity log
        // so the resume (and its guidance) is part of the ticket's history.
        if (a.ticket_id) store.appendLog(a.ticket_id, { agent: "orchestrator", kind: `continue -> ${a.id}`, text: input.message });
        refreshCoordination();
        return { ok: true, continued: target.id };
      }
      case "list_agents":
        return registry.list().map((a) => ({
          id: a.id,
          role: a.role,
          state: a.state,
          ticket_id: a.ticket_id,
        }));
      case "set_session_description": {
        const input = SetSessionDescriptionInput.parse(params);
        const now = Date.now();
        // Preserve created_at if the agent updates an existing description.
        let createdAt = now;
        if (existsSync(paths.metaJson)) {
          try {
            const prev = SessionMeta.parse(JSON.parse(readFileSync(paths.metaJson, "utf8")));
            createdAt = prev.created_at;
          } catch { /* corrupted — start fresh */ }
        }
        const meta: SessionMeta = {
          description: input.description,
          created_at: createdAt,
          updated_at: now,
          source: "agent",
        };
        writeFileSync(paths.metaJson, JSON.stringify(meta, null, 2) + "\n");
        return { ok: true };
      }
      case "shutdown": {
        // Kill the tmux session first so panes (console, agents) tear down
        // before the daemon disappears. Schedule cleanup on next tick so the
        // RPC reply gets flushed.
        setTimeout(() => {
          try { mux.killSession(); } catch { /* ignore */ }
          cleanup();
        }, 50);
        return { ok: true };
      }
      case "open_graph": {
        // Open the standalone force-directed graph viewer in a brand-new OS
        // terminal window, fully outside tmux and the charm session. Each call
        // opens an independent window (any number can run at once); the viewer
        // self-registers its PID in paths.graphPids on startup and removes it on
        // exit, so `charm stop` / daemon teardown can reap every window.
        const spec = graphLaunchSpec(paths.graphPids, paths.kbDir);
        const r = spawnSync(spec.cmd, spec.args, { stdio: "ignore", env: spec.env });
        if (r.error) throw new Error(`failed to open graph viewer: ${r.error.message}`);
        if (r.status !== 0) throw new Error(`failed to open graph viewer (exit ${r.status})`);
        return { ok: true };
      }
      case "request_review": {
        const input = RequestReviewInput.parse(params);
        const id = spawnAgent({
          role: "tester",
          ticket_id: input.ticket_id,
          prompt: `Validate ticket ${input.ticket_id}: read .charm/tickets/${input.ticket_id}.md acceptance criteria, run tests, produce a checklist result. No code edits.`,
          interactive: true,
        });
        return { agent_id: id };
      }
      default:
        throw new Error(`unknown method: ${method}`);
    }
  });

  const cleanup = () => {
    try { server.stop(); } catch { /* ignore */ }
    // Reap any standalone graph viewers we spawned before we exit, so they don't
    // linger as orphans (covers SIGINT/SIGTERM and the shutdown RPC alike).
    try { killGraphViewers(paths.graphPids); } catch { /* ignore */ }
    // A Unix socket leaves a file to remove; a Windows named pipe does not (the
    // OS frees it when server.stop() closes the handle) — never unlink a pipe.
    if (!isPipe(paths.socket)) { try { unlinkSync(paths.socket); } catch { /* ignore */ } }
    try { unlinkSync(paths.ready); } catch { /* ignore */ }
    try { unlinkSync(paths.pidFile); } catch { /* ignore */ }
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Signal readiness now that the RPC server is listening. The CLI polls this
  // marker (not the endpoint itself, which is unstat-able when it's a named
  // pipe) before issuing its first RPC. Written last so its presence implies a
  // fully-initialized daemon.
  writeFileSync(paths.ready, String(process.pid));
  console.log(`[charmd] listening on ${paths.socket} (session=${session}, root=${paths.root})`);
}

main().catch((e) => {
  console.error("[charmd] fatal:", e);
  process.exit(1);
});
