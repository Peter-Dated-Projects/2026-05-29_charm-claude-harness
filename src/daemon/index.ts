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
import { Tmux } from "./tmux.ts";
import { buildLayoutString } from "./layout.ts";
import { ApprovalQueue } from "./approvals.ts";
import { startRpcServer } from "./rpc.ts";
import { buildClaudeCommand, defaultModelForRole, ensureDirectoryTrusted, isMode, MAIN_AGENT_ID, MODE_MODEL, resolveModel, type SpawnSpec } from "./spawn.ts";
import { killGraphViewers } from "../graph-viewers.ts";
import { createProposal, listProposals, finishProposal } from "../store/proposals.ts";
import {
  CreateTicketsInput,
  CreateProposalInput,
  PromoteInput,
  FinishProposalInput,
  SpawnReviewersInput,
  SpawnWorkersInput,
  AwaitApprovalInput,
  UpdatePlanInput,
  ReportStatusInput,
  SetTicketStatusInput,
  SetTicketStateInput,
  RequestReviewInput,
  SetSessionDescriptionInput,
  KillAgentInput,
  CancelTicketInput,
  ContinueAgentInput,
  SessionMeta,
  COORDINATION_STATUSES,
  type AgentRole,
} from "../schema.ts";

type DaemonOpts = { root: string; session: string; uuid?: string };

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
    const sibling = join(dirname(process.execPath), "charm-graph");
    return [existsSync(sibling) ? sibling : "charm-graph"];
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
    .option("--uuid <id>", "session UUID (control-plane key; default: derived single-session layout)")
    .parse(process.argv);
  const opts = program.opts<DaemonOpts>();
  // cli.ts always passes an explicit --session; derive a per-directory default
  // only for the rare case of running charmd directly, so it never falls back to
  // a hardcoded "charm" that would collide with another directory's session.
  const session = opts.session ?? defaultSessionName(opts.root);

  // The UUID must match the one `charm start` used: it keys this session's
  // socket/pidfile/run dir, and start blocks waiting for exactly that socket. A
  // bare `charmd` (no --uuid) uses the legacy single-session layout under .charm/.
  const paths = charmPaths(opts.root, opts.uuid);
  mkdirSync(paths.charmDir, { recursive: true });
  mkdirSync(paths.runDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });

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
    // instead of wedging — otherwise a crash permanently blocks restart until
    // someone hand-removes the file.
    console.error(`[charmd] removing stale pidfile (pid=${recorded}) from a prior crash`);
    try { unlinkSync(paths.pidFile); } catch { /* ignore */ }
  }
  writeFileSync(paths.pidFile, String(process.pid));

  // Write a per-session MCP config with CHARM_SOCKET in the env block.
  // This guarantees each session's charm-mcp is a distinct process: Claude Code
  // keys its MCP server registry on (command + env), so different sockets produce
  // different instances. Without this, all sessions share the one charm-mcp that
  // was started first — closing session A kills it and breaks every other session.
  {
    const mcpBin = process.env.CHARM_MCP_BIN ?? "charm-mcp";
    const cfg = {
      mcpServers: {
        charm: { command: mcpBin, args: [], env: { CHARM_SOCKET: paths.socket } },
      },
    };
    writeFileSync(paths.sessionMcpConfig, JSON.stringify(cfg, null, 2) + "\n");
  }

  ensureDirectoryTrusted(paths.root);

  const store = new TicketStore(paths);
  store.reindexAll();
  const registry = new AgentRegistry();
  const coord = new CoordinationWriter(paths);
  const tmux = new Tmux(session);
  const approvals = new ApprovalQueue();

  const tmuxAvailable = Tmux.available();
  if (!tmuxAvailable) {
    console.error("[charmd] WARNING: tmux not on PATH; spawning panes will fail.");
  }

  const inFlight = (): InFlight[] =>
    registry
      .list()
      .filter((a) => a.role === "worker" && (a.state === "running" || a.state === "blocked") && a.ticket_id)
      .map((a) => {
        const t = store.read(a.ticket_id!);
        return { ticket_id: a.ticket_id!, touches: t?.frontmatter.touches ?? [] };
      });

  // Hard ceiling on concurrent agent sessions (tmux panes / live Claude processes)
  // in this charm, INCLUDING the orchestrator. Set at `charm start` via
  // --max-agents (CHARM_MAX_AGENTS); defaults to 10. The CLI validates it, but a
  // bare `charmd` may have it unset/garbage, so re-floor here.
  const maxAgents = (() => {
    const raw = Number(process.env.CHARM_MAX_AGENTS);
    return Number.isInteger(raw) && raw >= 1 ? raw : 10;
  })();

  // Agents occupying a live slot: the orchestrator (always present once its pane
  // is registered — it isn't in the registry) plus every sub-agent that's
  // spawning/running/blocked. done/failed agents are reaped and free their slot.
  const liveAgentCount = (): number =>
    (orchestratorPaneId ? 1 : 0) +
    registry.list().filter((a) => a.state === "spawning" || a.state === "running" || a.state === "blocked").length;

  // Slots left before the cap. Batch spawners clamp to this so they never spawn
  // past the ceiling (and report the rest as deferred for a later retry).
  const remainingAgentSlots = (): number => Math.max(0, maxAgents - liveAgentCount());

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
    if (!tmuxAvailable || !consolePaneId || agentPaneIds.length === 0) return;
    try {
      const win = tmux.windowSize(WINDOW);
      const cIdx = tmux.paneIndex(consolePaneId);
      if (cIdx === null) return;
      const agentIdxs: number[] = [];
      const agentWidths: number[] = [];
      for (const pid of agentPaneIds) {
        const idx = tmux.paneIndex(pid);
        if (idx === null) continue;
        agentIdxs.push(idx);
        agentWidths.push(tmux.paneWidth(pid) ?? 0);
      }
      if (agentIdxs.length === 0) return;
      // Preserve whatever width the console column currently has -- the user
      // may have dragged the divider. Fall back to a 35% share only on the
      // first layout, when the pane hasn't been sized yet. Floored at 40 cols
      // so the Ink TUI stays readable, and capped so the agent grid keeps room.
      const cur = tmux.paneWidth(consolePaneId);
      const consoleWidth = Math.min(
        Math.max(20, win.w - 20),
        Math.max(40, cur ?? Math.floor(win.w * 0.35)),
      );
      const layout = buildLayoutString({
        windowWidth: win.w,
        windowHeight: win.h,
        consolePaneIndex: cIdx,
        agentPaneIndexes: agentIdxs,
        consoleWidth,
        agentPaneWidths: agentWidths,
      });
      tmux.applyLayout(WINDOW, layout);
    } catch (e) {
      console.error("[charmd] relayout failed:", e);
    }
  }

  function spawnAgent(spec: SpawnSpec): string {
    // Hard cap guard — the single chokepoint every spawn path flows through, so
    // no caller can exceed the ceiling even if a batch clamp is wrong. Batch
    // spawners pre-clamp to remainingAgentSlots() and never reach this throw;
    // it's the safety net for the single-spawn paths (e.g. request_review).
    if (liveAgentCount() >= maxAgents) {
      throw new Error(
        `agent cap reached: ${liveAgentCount()}/${maxAgents} live (incl. orchestrator). ` +
          `Wait for an agent to finish, or restart with a higher --max-agents.`,
      );
    }
    const agent = registry.create({ role: spec.role, ticket_id: spec.ticket_id });
    const resolved: SpawnSpec = { ...spec, model: spec.model ?? defaultModelForRole(spec.role) };
    const cmd = buildClaudeCommand(paths, agent.id, resolved);
    // Target THIS session's window explicitly. charm runs every session on the
    // default tmux server, and the daemon is a detached process: a `split-window`
    // with no `-t` lands in tmux's global "current session", which the daemon does
    // not control. With two charm sessions live, that can place this session's
    // sub-agent pane inside the OTHER session's window (breaking this session's
    // relayout and polluting the other's). Pinning to `${session}:${WINDOW}` keeps
    // the pane in the session that owns the agent.
    const pane = tmux.splitPane({ cmd, cwd: paths.root, direction: "h", target: `${session}:${WINDOW}` });
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
      try { tmux.killPane(a.pane_id); } catch { /* ignore */ }
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
    if (!tmuxAvailable || !orchestratorPaneId) return;
    pingPending.push(event);
    if (pingTimer) return; // already armed — coalesce into the pending flush
    pingTimer = setTimeout(() => {
      const events = pingPending;
      pingPending = [];
      pingTimer = null;
      // The pane may have vanished (orchestrator exited) during the window.
      if (!orchestratorPaneId || tmux.paneIndex(orchestratorPaneId) === null) return;
      // One line only: literal newlines typed into the pane would submit early.
      const line =
        `[charm] ${events.join("; ")}. Check list_agents() (read the ticket file .charm/tickets/<id>.md for the ` +
        `blocked agent's note and activity log): reap done/failed sub-agents with kill_agent, and for each blocked ` +
        `one either resolve what it was waiting on and resume it with continue_agent or abandon it with kill_agent, ` +
        `then advance the workflow per your orchestrator instructions.`;
      try { tmux.sendText(orchestratorPaneId, line); }
      catch (e) { console.error("[charmd] pingOrchestrator failed:", e); }
    }, 1200);
  }

  // --- Dead-pane liveness sweep --------------------------------------------
  // The daemon only learns a sub-agent finished when that agent calls
  // report_status. An agent whose Claude process exits or crashes WITHOUT a
  // clean report (ran out of turn, OOM, kill -9, a dead MCP shim) leaves two
  // pieces of garbage: a dead tmux pane (session-level `remain-on-exit on` keeps
  // it on screen) AND a stranded registry entry that never frees its
  // concurrent-agent slot — so the cap silently clogs over time until the fleet
  // can't spawn. Nothing else reaps these; tearDownAgent is only ever driven by
  // an explicit RPC. This sweep reconciles the registry against tmux ground
  // truth on a timer: any agent we believe is alive whose pane is gone / marked
  // dead / whose process id is gone is reaped — its ticket is reset to `failed`
  // (stays on the board so the system can retry it), its pane + slot are freed,
  // and the orchestrator is pinged to advance.
  const SWEEP_MS = 15_000;
  // A `blocked` agent's Claude process is alive (idle, awaiting continue_agent),
  // so it is never seen dead and never falsely reaped. To avoid racing a pane
  // that's a tick away from a normal teardown (e.g. kill_agent defers its own
  // teardown ~50ms), only reap after an agent is seen dead on two consecutive
  // sweeps.
  const deadStreak = new Map<string, number>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  function sweepDeadPanes() {
    if (!tmuxAvailable) return;
    let panes: { pane_id: string; pid: number; dead: boolean }[];
    try {
      panes = tmux.listPanes();
    } catch (e) {
      console.error("[charmd] sweep: listPanes failed:", e);
      return;
    }
    // Empty means the tmux query failed (status != 0 -> []), NOT that every pane
    // vanished: a live session always has at least the console + orchestrator
    // panes. Reaping off a failed query would mass-kill the fleet, so skip the
    // tick and try again next time.
    if (panes.length === 0) return;
    const byPane = new Map(panes.map((p) => [p.pane_id, p]));
    for (const a of registry.list()) {
      // Only agents we believe are live and that own a pane can be leaked.
      if (a.state !== "spawning" && a.state !== "running" && a.state !== "blocked") continue;
      if (!a.pane_id) continue;
      const pane = byPane.get(a.pane_id);
      // Dead if the pane is gone (killed), tmux marks it dead (command exited
      // under remain-on-exit), or its foreground process is no longer alive.
      const dead = !pane || pane.dead || (pane.pid > 0 && !isProcessAlive(pane.pid));
      if (!dead) {
        deadStreak.delete(a.id);
        continue;
      }
      const streak = (deadStreak.get(a.id) ?? 0) + 1;
      deadStreak.set(a.id, streak);
      if (streak < 2) continue; // give a normal teardown one more tick to win
      deadStreak.delete(a.id);
      console.error(
        `[charmd] sweep: reaping dead agent ${a.id} (pane ${a.pane_id}, ticket ${a.ticket_id ?? "-"}); ` +
          `process exited without report_status.`,
      );
      // Reset the ticket so the system can retry it. Mirrors a self-kill's
      // terminal state (failed/failed): `failed` stays on the board for
      // reassignment rather than dropping off like `cancelled`.
      if (a.ticket_id) {
        try {
          store.update(a.ticket_id, { status: "failed", stage: "failed" });
          store.appendLog(a.ticket_id, {
            agent: a.id,
            kind: "failed",
            text: "system: agent pane died without reporting; reaped by the liveness sweep so this ticket can be retried.",
          });
        } catch {
          /* ignore — a missing/locked ticket must not abort the sweep */
        }
      }
      tearDownAgent(a.id);
      pingOrchestrator(
        `${a.id} died on ${a.ticket_id ?? "?"} (pane gone, no report_status) — reaped, ticket reset to failed for retry`,
      );
    }
    // Forget streak bookkeeping for agents that no longer exist.
    for (const id of [...deadStreak.keys()]) if (!registry.get(id)) deadStreak.delete(id);

    // Orphan-pane pass: kill any tmux pane that is marked dead and not owned by
    // a registered agent. These arise when tearDownAgent's kill-pane call fails
    // silently (e.g. remain-on-exit panes that don't respond normally) — the
    // agent drops from the registry but the zombie pane lingers indefinitely.
    const knownPanes = new Set(agentPaneIds);
    for (const pane of panes) {
      if (!pane.dead) continue;
      if (knownPanes.has(pane.pane_id)) continue;
      console.error(`[charmd] sweep: removing orphan dead pane ${pane.pane_id}`);
      try { tmux.killPane(pane.pane_id); } catch { /* ignore */ }
    }
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
      case "promote": {
        // Move hand-authored ticket DRAFTS from the scratchpad into the canonical
        // tickets dir + sqlite index. This is the bridge that turns a cheap local
        // file write by the orchestrator into a real, spawnable ticket without
        // round-tripping the whole body through create_tickets. With no `tickets`
        // arg, promote every draft currently in the scratchpad.
        const input = PromoteInput.parse(params ?? {});
        const names = input.tickets ?? store.listDrafts();
        const promoted = names.map((n) => store.promoteDraft(n).frontmatter);
        // Newly promoted tickets belong on the board immediately.
        if (promoted.length > 0) refreshCoordination();
        return promoted;
      }
      case "create_proposal": {
        const input = CreateProposalInput.parse(params);
        return createProposal(paths, input.name);
      }
      case "list_proposals":
        return listProposals(paths);
      case "finish_proposal": {
        const input = FinishProposalInput.parse(params);
        return finishProposal(paths, input.name);
      }
      case "spawn_review_agents": {
        const input = SpawnReviewersInput.parse(params);
        // Clamp to the concurrent-agent cap, same as spawn_workers: spawn up to
        // the free slots and defer the rest for a later retry.
        const slots = remainingAgentSlots();
        const toSpawn = input.ticket_ids.slice(0, slots);
        const deferred = input.ticket_ids.slice(slots);
        const ids: string[] = [];
        for (const tid of toSpawn) {
          ids.push(spawnAgent({
            role: "reviewer",
            ticket_id: tid,
            prompt: `Read .charm/tickets/${tid}.md and review it.`,
            interactive: true,
          }));
        }
        if (deferred.length > 0) {
          console.error(
            `[charmd] spawn_review_agents: agent cap ${maxAgents} reached (${liveAgentCount()} live); ` +
              `deferred ${deferred.length} ticket(s).`,
          );
        }
        return { agent_ids: ids, ...(deferred.length > 0 ? { deferred, max_agents: maxAgents } : {}) };
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
        // Clamp to the concurrent-agent cap: spawn only as many as we have free
        // slots for, and let the rest fall into `deferred` so the orchestrator
        // retries them once running agents finish and free their slots.
        const slots = remainingAgentSlots();
        const toSpawn = runnable.slice(0, slots);
        const cappedOut = runnable.length - toSpawn.length;
        const ids: string[] = [];
        for (const tid of toSpawn) {
          ids.push(spawnAgent({
            role: "worker",
            ticket_id: tid,
            prompt: `Read .charm/tickets/${tid}.md and complete it.`,
            interactive: true,
          }));
          store.update(tid, { status: "running", stage: "in_progress" });
        }
        // Deferred = not-yet-runnable (deps/touches) PLUS the ones clamped by the
        // cap. The orchestrator treats both the same: retry on the next tick.
        const deferred = input.ticket_ids.filter((id) => !toSpawn.includes(id));
        if (cappedOut > 0) {
          console.error(
            `[charmd] spawn_workers: agent cap ${maxAgents} reached (${liveAgentCount()} live); ` +
              `deferred ${cappedOut} runnable ticket(s).`,
          );
        }
        return { agent_ids: ids, deferred, ...(cappedOut > 0 ? { capped: cappedOut, max_agents: maxAgents } : {}) };
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
          // Reviewers enrich a ticket and hand off to workers — mark it `reviewed`
          // (ready for a worker to spawn) rather than `complete` (fully done). Only
          // worker/tester done signals genuine completion.
          const ticketDone = a.role === "reviewer" ? { status: "reviewed", stage: "review" } : { status: "complete", stage: "done" };
          store.update(a.ticket_id, ticketDone);
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
      case "set_ticket_state": {
        // Orchestrator-driven ticket lifecycle: write status and/or stage onto a
        // ticket addressed by id (not by the caller's own assignment — that's
        // set_ticket_status). The orchestrator owns the workflow, so it can move a
        // ticket it isn't itself on. Authorization mirrors cancel_ticket: operator
        // or main only. `cancelled` is excluded by the schema — route call-offs
        // through cancel_ticket. The transition is mirrored into the ticket's
        // activity log and COORDINATION.md is rebuilt.
        const input = SetTicketStateInput.parse(params);
        const callerRole = resolveCaller(input.caller_id);
        if (callerRole !== "operator" && callerRole !== "main") {
          throw new Error(
            `agent ${input.caller_id} (${callerRole}) may not set ticket state; that requires the orchestrator`,
          );
        }
        const t = store.read(input.ticket_id);
        if (!t) throw new Error(`unknown ticket: ${input.ticket_id}`);
        const patch: { status?: string; stage?: string } = {};
        if (input.status) patch.status = input.status;
        if (input.stage) patch.stage = input.stage;
        store.update(input.ticket_id, patch);
        const kind = input.status ? `status=${input.status}` : `stage=${input.stage}`;
        store.appendLog(input.ticket_id, {
          agent: input.caller_id ?? "operator",
          kind,
          text: input.note,
        });
        // Writing a ticket to a terminal status (complete/failed) means any agent
        // still on it is working moot — tear its pane down, same as cancel_ticket
        // does for a call-off. Non-terminal writes (ready/blocked/stage walks)
        // leave a live agent alone; it's still doing relevant work.
        if (input.status === "complete" || input.status === "failed") {
          const onTicket = registry.list().find((a) => a.role !== "main" && a.ticket_id === input.ticket_id);
          if (onTicket) tearDownAgent(onTicket.id);
        }
        refreshCoordination();
        // An operator writing state from the console is news to the orchestrator;
        // a write the orchestrator issued itself is not.
        if (callerRole === "operator") {
          pingOrchestrator(`${input.ticket_id} ${kind} by operator${input.note ? `: ${input.note}` : ""}`);
        }
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
        if (!tmuxAvailable || tmux.paneIndex(target.pane_id) === null) {
          throw new Error(`agent ${target.id}'s pane is gone — it may have exited; kill_agent and respawn instead`);
        }
        // Wake the blocked agent with the orchestrator's guidance (one line — a
        // literal newline would submit early), then optimistically flip it back
        // to running. The agent corrects this via its own report_status as it
        // proceeds, re-blocks, or finishes.
        tmux.sendText(target.pane_id, `[charm] Orchestrator: ${input.message}`);
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
        // Merge into the meta `charm start` wrote: keep the session identity
        // (uuid/session_name/root/socket/pid) and created_at, override only the
        // description. Falling back to this daemon's own identity if the file is
        // missing/corrupt so the record stays coherent for `stop`/`attach`.
        let prev: Partial<SessionMeta> = {};
        if (existsSync(paths.metaJson)) {
          try { prev = SessionMeta.parse(JSON.parse(readFileSync(paths.metaJson, "utf8"))); }
          catch { /* corrupted — rebuild from what we know */ }
        }
        const meta: SessionMeta = {
          uuid: prev.uuid ?? opts.uuid,
          session_name: prev.session_name ?? session,
          root: prev.root ?? paths.root,
          socket: prev.socket ?? paths.socket,
          pid: prev.pid ?? process.pid,
          description: input.description,
          created_at: prev.created_at ?? now,
          updated_at: now,
          source: "agent",
        };
        writeFileSync(paths.metaJson, JSON.stringify(meta, null, 2) + "\n");
        return { ok: true };
      }
      case "set_mode": {
        // Mid-session fleet-mode swap (research <-> development), driven by the
        // `:dev`/`:research` tmux command. Two effects:
        //  1. Re-point future spawns. defaultModelForRole() reads CHARM_MODE live
        //     on every spawn, so mutating it here means every agent the
        //     orchestrator spawns from now on runs on the new mode's model.
        //     Already-running panes keep the model they were spawned with.
        //  2. Live-swap the orchestrator itself. Its pane is an interactive
        //     Claude Code session, so injecting `/model <id>` switches its model
        //     WITHOUT losing context; a follow-up note tells it the mode changed
        //     so it can adjust its approach.
        const { mode } = params as { mode: string };
        if (!isMode(mode)) throw new Error(`invalid mode: ${mode} (expected research|development)`);
        process.env.CHARM_MODE = mode;
        // Clear any start-time fleet override (-m/--model / CHARM_MODEL). Switching
        // mode is an explicit request for that mode's model; leaving the override
        // set would shadow it in defaultModelForRole and the swap would silently
        // no-op for sub-agents.
        delete process.env.CHARM_MODEL;
        const model = resolveModel(MODE_MODEL[mode]);
        if (tmuxAvailable && orchestratorPaneId && tmux.paneIndex(orchestratorPaneId) !== null) {
          try {
            tmux.sendText(orchestratorPaneId, `/model ${model}`);
            tmux.sendText(
              orchestratorPaneId,
              `[charm] Mode switched to ${mode}: you are now running on ${model}, and every sub-agent you ` +
              `spawn from here on will run on ${model} too. Adjust your approach to match ${mode} mode.`,
            );
          } catch (e) {
            console.error("[charmd] set_mode orchestrator notify failed:", e);
          }
        }
        try { spawnSync("tmux", ["display-message", `charm: mode -> ${mode} (${model})`]); } catch { /* ignore */ }
        return { ok: true, mode, model };
      }
      case "shutdown": {
        // Kill the tmux session first so panes (console, agents) tear down
        // before the daemon disappears. Schedule cleanup on next tick so the
        // RPC reply gets flushed.
        setTimeout(() => {
          try { tmux.killSession(); } catch { /* ignore */ }
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
          prompt: `Read .charm/tickets/${input.ticket_id}.md and validate it.`,
          interactive: true,
        });
        return { agent_id: id };
      }
      default:
        throw new Error(`unknown method: ${method}`);
    }
  });

  const cleanup = (code = 0) => {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    try { server.stop(); } catch { /* ignore */ }
    // Reap any standalone graph viewers we spawned before we exit, so they don't
    // linger as orphans (covers SIGINT/SIGTERM, the shutdown RPC, and crashes).
    try { killGraphViewers(paths.graphPids); } catch { /* ignore */ }
    try { unlinkSync(paths.socket); } catch { /* ignore */ }
    try { unlinkSync(paths.pidFile); } catch { /* ignore */ }
    try { unlinkSync(paths.sessionMcpConfig); } catch { /* ignore */ }
    try { store.close(); } catch { /* ignore */ }
    process.exit(code);
  };
  // Wrap so the signal name Node passes as arg0 isn't forwarded as the exit code
  // (process.exit("SIGINT") would coerce to a bogus status). Both are intentional
  // shutdowns -> exit 0.
  process.on("SIGINT", () => cleanup(0));
  process.on("SIGTERM", () => cleanup(0));

  // Without these, a single throw in an RPC handler, a socket callback, or the
  // ping timer takes down the whole daemon — and because the normal teardown
  // never runs, it leaves its socket and pidfile behind, which then makes the
  // next `start` refuse ("already running"). That silent death with no log line
  // is exactly why post-sleep/long-run crashes were impossible to diagnose.
  // Log the cause with a timestamp (so a death can be correlated against a
  // sleep/wake in the system log) and tear down cleanly with a non-zero code.
  process.on("uncaughtException", (err) => {
    logCrash("uncaughtException", err);
    cleanup(1);
  });
  // Unhandled rejections are NOT treated as fatal here. The post-sleep burst is
  // full of fire-and-forget tmux/RPC calls that reject benignly after their pane
  // vanished; killing the daemon on those would make the sleep problem worse, not
  // better. Log loudly instead — if a real crash follows, the rejection line
  // above it is the lead.
  process.on("unhandledRejection", (reason) => {
    logCrash("unhandledRejection", reason);
  });

  console.log(`[charmd] listening on ${paths.socket} (session=${session}, root=${paths.root})`);

  // Start the dead-pane liveness sweep once we're listening (no agents exist
  // before this, so there's nothing to reap earlier). Cleared in cleanup().
  sweepTimer = setInterval(sweepDeadPanes, SWEEP_MS);
}

/** Timestamped crash logging. The daemon's stdout/stderr are redirected to its
 *  per-session charmd.log (see cli.ts `start`), so a plain console.error lands in
 *  that file; the ISO timestamp is what lets a death be lined up against a
 *  sleep/wake event. */
function logCrash(kind: string, err: unknown): void {
  const ts = new Date().toISOString();
  const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  console.error(`[charmd] ${ts} ${kind}: ${detail}`);
}

main().catch((e) => {
  logCrash("fatal (startup)", e);
  process.exit(1);
});
