#!/usr/bin/env bun
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { charmPaths } from "../paths.ts";
import { TicketStore } from "../store/tickets.ts";
import { AgentRegistry } from "./registry.ts";
import { CoordinationWriter } from "./coord.ts";
import { Solver, type InFlight } from "./solver.ts";
import { Tmux } from "./tmux.ts";
import { buildLayoutString } from "./layout.ts";
import { ApprovalQueue } from "./approvals.ts";
import { startRpcServer } from "./rpc.ts";
import { buildClaudeCommand, defaultModelForRole, type SpawnSpec } from "./spawn.ts";
import {
  CreateTicketsInput,
  SpawnReviewersInput,
  SpawnWorkersInput,
  AwaitApprovalInput,
  UpdatePlanInput,
  ReportStatusInput,
  RequestReviewInput,
  SetSessionDescriptionInput,
  SessionMeta,
} from "../schema.ts";

type DaemonOpts = { root: string; session: string };

async function main() {
  const program = new Command();
  program
    .name("charmd")
    .option("--root <path>", "project root", process.cwd())
    .option("--session <name>", "tmux session name", "charm")
    .parse(process.argv);
  const opts = program.opts<DaemonOpts>();

  const paths = charmPaths(opts.root);
  mkdirSync(paths.charmDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });

  if (existsSync(paths.pidFile)) {
    const stale = Number(Bun.file(paths.pidFile).text());
    console.error(`[charmd] pidfile exists (pid=${stale}); refusing to start. rm ${paths.pidFile} if stale.`);
    process.exit(2);
  }
  writeFileSync(paths.pidFile, String(process.pid));

  const store = new TicketStore(paths);
  store.reindexAll();
  const registry = new AgentRegistry();
  const coord = new CoordinationWriter(paths);
  const tmux = new Tmux(opts.session);
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

  // Pane layout state. consolePaneId is the Ink TUI pane (pinned left column);
  // agentPaneIds is every Claude pane in spawn order, starting with the "main"
  // agent pane registered by `cli.ts start` before any sub-agents.
  let consolePaneId: string | null = null;
  const agentPaneIds: string[] = [];
  const WINDOW = "charm";
  // Pane id of the standalone graph-viewer window, if one is open. Tracked so a
  // repeat open_graph call re-focuses the existing window instead of stacking.
  let graphPaneId: string | null = null;

  function relayout() {
    if (!tmuxAvailable || !consolePaneId || agentPaneIds.length === 0) return;
    try {
      const win = tmux.windowSize(WINDOW);
      const cIdx = tmux.paneIndex(consolePaneId);
      if (cIdx === null) return;
      const agentIdxs: number[] = [];
      for (const pid of agentPaneIds) {
        const idx = tmux.paneIndex(pid);
        if (idx !== null) agentIdxs.push(idx);
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
      });
      tmux.applyLayout(WINDOW, layout);
    } catch (e) {
      console.error("[charmd] relayout failed:", e);
    }
  }

  function spawnAgent(spec: SpawnSpec): string {
    const agent = registry.create({ role: spec.role, ticket_id: spec.ticket_id });
    const resolved: SpawnSpec = { ...spec, model: spec.model ?? defaultModelForRole(spec.role) };
    const cmd = buildClaudeCommand(paths, agent.id, resolved);
    const pane = tmux.splitPane({ cmd, cwd: paths.root, direction: "h" });
    registry.attach(agent.id, { pane_id: pane });
    coord.upsert(registry.get(agent.id)!);
    agentPaneIds.push(pane);
    relayout();
    return agent.id;
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
      case "list_tickets":
        return store.list().map((t) => t.frontmatter);
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
            prompt: `Implement ticket T-${tid.slice(2)}. First read .charm/tickets/${tid}.md and .charm/COORDINATION.md, then call update_plan() with your plan, then implement.`,
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
        const a = registry.setPlan(input.agent_id, input.plan);
        coord.upsert(a, input.plan);
        return { ok: true };
      }
      case "read_coordination":
        return { text: coord.read() };
      case "report_status": {
        const input = ReportStatusInput.parse(params);
        const a = registry.setState(input.agent_id, input.state, input.note);
        coord.upsert(a);
        if (input.state === "done" && a.ticket_id) {
          store.update(a.ticket_id, { status: "complete", stage: "done" });
        } else if (input.state === "failed" && a.ticket_id) {
          store.update(a.ticket_id, { status: "failed", stage: "failed" });
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
        if (a.pane_id) {
          try { tmux.killPane(a.pane_id); } catch { /* ignore */ }
          const i = agentPaneIds.indexOf(a.pane_id);
          if (i >= 0) agentPaneIds.splice(i, 1);
        }
        registry.remove(agent_id);
        coord.remove(agent_id);
        relayout();
        return { ok: true };
      }
      case "kill_agent": {
        const { agent_id } = params as { agent_id: string };
        const a = registry.get(agent_id);
        if (!a) throw new Error(`unknown agent: ${agent_id}`);
        if (a.pane_id) {
          try { tmux.killPane(a.pane_id); } catch { /* ignore */ }
          const i = agentPaneIds.indexOf(a.pane_id);
          if (i >= 0) agentPaneIds.splice(i, 1);
        }
        if (a.ticket_id && (a.state === "spawning" || a.state === "running")) {
          try { store.update(a.ticket_id, { status: "failed", stage: "failed" }); } catch { /* ignore */ }
        }
        registry.remove(agent_id);
        coord.remove(agent_id);
        relayout();
        return { ok: true };
      }
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
          try { tmux.killSession(); } catch { /* ignore */ }
          cleanup();
        }, 50);
        return { ok: true };
      }
      case "open_graph": {
        // Open the standalone force-directed graph viewer in its own tmux window.
        // Currently renders a demo graph; wiring it to live ticket/agent state is
        // a follow-up. The viewer is a separate process that owns its terminal with
        // raw ANSI (no Ink), so it animates without React reconciliation cost.
        if (!tmuxAvailable) throw new Error("tmux is not available; cannot open the graph viewer");
        if (graphPaneId && tmux.paneIndex(graphPaneId) !== null) {
          tmux.selectWindow(graphPaneId);
          return { ok: true, reused: true, pane: graphPaneId };
        }
        // CHARM_GRAPH_BIN lets a compiled build point at the `charm-graph` binary;
        // otherwise run the source under the same Bun runtime as the daemon.
        const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
        const graphBin = process.env.CHARM_GRAPH_BIN;
        const cmd = graphBin
          ? `exec ${q(graphBin)}`
          : `exec ${q(process.execPath)} run ${q(join(import.meta.dir, "../console/graph.ts"))}`;
        graphPaneId = tmux.newWindow({ name: "graph", cmd, cwd: paths.root });
        return { ok: true, reused: false, pane: graphPaneId };
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
    try { unlinkSync(paths.socket); } catch { /* ignore */ }
    try { unlinkSync(paths.pidFile); } catch { /* ignore */ }
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log(`[charmd] listening on ${paths.socket} (session=${opts.session}, root=${paths.root})`);
}

main().catch((e) => {
  console.error("[charmd] fatal:", e);
  process.exit(1);
});
