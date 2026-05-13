#!/usr/bin/env bun
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { Command } from "commander";
import { harnessPaths } from "../paths.ts";
import { TicketStore } from "../store/tickets.ts";
import { AgentRegistry } from "./registry.ts";
import { CoordinationWriter } from "./coord.ts";
import { Solver, type InFlight } from "./solver.ts";
import { Tmux } from "./tmux.ts";
import { ApprovalQueue } from "./approvals.ts";
import { startRpcServer } from "./rpc.ts";
import { buildClaudeCommand, type SpawnSpec } from "./spawn.ts";
import {
  CreateTicketsInput,
  SpawnReviewersInput,
  SpawnWorkersInput,
  AwaitApprovalInput,
  UpdatePlanInput,
  ReportStatusInput,
  RequestReviewInput,
} from "../schema.ts";

type DaemonOpts = { root: string; session: string };

async function main() {
  const program = new Command();
  program
    .name("harnessd")
    .option("--root <path>", "project root", process.cwd())
    .option("--session <name>", "tmux session name", "harness")
    .parse(process.argv);
  const opts = program.opts<DaemonOpts>();

  const paths = harnessPaths(opts.root);
  mkdirSync(paths.harnessDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });

  if (existsSync(paths.pidFile)) {
    const stale = Number(Bun.file(paths.pidFile).text());
    console.error(`[harnessd] pidfile exists (pid=${stale}); refusing to start. rm ${paths.pidFile} if stale.`);
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
    console.error("[harnessd] WARNING: tmux not on PATH; spawning panes will fail.");
  }

  const inFlight = (): InFlight[] =>
    registry
      .list()
      .filter((a) => a.role === "worker" && (a.state === "running" || a.state === "blocked") && a.ticket_id)
      .map((a) => {
        const t = store.read(a.ticket_id!);
        return { ticket_id: a.ticket_id!, touches: t?.frontmatter.touches ?? [] };
      });

  function spawnAgent(spec: SpawnSpec): string {
    const agent = registry.create({ role: spec.role, ticket_id: spec.ticket_id });
    const cmd = buildClaudeCommand(paths, agent.id, spec);
    const pane = tmux.splitPane({ cmd, cwd: paths.root, direction: "h" });
    registry.attach(agent.id, { pane_id: pane });
    coord.upsert(registry.get(agent.id)!);
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
            prompt: `Review and enrich tickets/${tid}.md in place.`,
            interactive: false,
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
            prompt: `Implement ticket T-${tid.slice(2)}. First read tickets/${tid}.md and COORDINATION.md, then call update_plan() with your plan, then implement.`,
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
      case "request_review": {
        const input = RequestReviewInput.parse(params);
        const id = spawnAgent({
          role: "tester",
          ticket_id: input.ticket_id,
          prompt: `Validate ticket ${input.ticket_id}: read tickets/${input.ticket_id}.md acceptance criteria, run tests, produce a checklist result. No code edits.`,
          interactive: false,
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

  console.log(`[harnessd] listening on ${paths.socket} (session=${opts.session}, root=${paths.root})`);
}

main().catch((e) => {
  console.error("[harnessd] fatal:", e);
  process.exit(1);
});
