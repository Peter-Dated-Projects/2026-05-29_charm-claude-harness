#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { rpcCall, type RpcCallOpts } from "../daemon/rpc.ts";

/**
 * charm-mcp — stdio MCP shim spawned by every `claude` process.
 * It forwards tool calls to the running `charmd` over a Unix socket.
 *
 * The daemon socket path is provided via the CHARM_SOCKET env var (exported
 * by buildClaudeCommand). The agent's id (CHARM_AGENT_ID) is folded into
 * worker-side calls so the daemon knows which agent reported.
 */

const SOCKET = process.env.CHARM_SOCKET;
const AGENT_ID = process.env.CHARM_AGENT_ID;
if (!SOCKET) {
  console.error("[charm-mcp] CHARM_SOCKET env var is required");
  process.exit(1);
}

async function call<T>(method: string, params?: unknown, opts?: RpcCallOpts): Promise<T> {
  return rpcCall<T>(SOCKET!, method, params, opts);
}

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
  };
}

const server = new McpServer({ name: "charm-mcp", version: "0.0.1" });

server.registerTool(
  "create_tickets",
  {
    description: "Create one to three tickets per call. Each ticket needs a title, body, depends_on, and touches (file globs). To create more than 3, make multiple calls.",
    inputSchema: {
      tickets: z.array(z.object({
        title: z.string(),
        body: z.string(),
        depends_on: z.array(z.string()).default([]),
        touches: z.array(z.string()).default([]),
      })).min(1).max(3, "create_tickets accepts at most 3 tickets per call; split larger batches across multiple calls"),
    },
  },
  async (args) => ok(await call("create_tickets", args)),
);

server.registerTool(
  "promote",
  {
    description:
      "Promote hand-authored ticket DRAFTS from .charm/scratchpad/ into real, spawnable tickets. " +
      "Workflow: write each draft as a file in .charm/scratchpad/<name>.md following normal ticket " +
      "conventions (frontmatter with title/depends_on/touches + body) — a cheap local Write, no token " +
      "cost — then call promote to move it into .charm/tickets/ and index it in sqlite (the move + index " +
      "are why this must be an MCP call, not a raw file move: it keeps the board and db in sync). The " +
      "draft's own id (or its filename) is preserved, so cross-draft depends_on references survive. " +
      "Pass `tickets` (draft names, with or without .md) to promote specific drafts; omit it to promote " +
      "every draft in the scratchpad.",
    inputSchema: { tickets: z.array(z.string()).optional() },
  },
  async (args) => ok(await call("promote", args)),
);

server.registerTool(
  "create_proposal",
  {
    description:
      "Scaffold a new design proposal / feature-request doc in .charm/proposals/. Pass a free-text " +
      "`name`; the daemon auto-derives the canonical PROP-<slug>.md filename, writes a draft template " +
      "(Problem / Context / Proposal / Alternatives / Open Questions), and returns the file path. Edit " +
      "the returned file to flesh out the proposal. A proposal describes WHAT to build and its impact; " +
      "it does not dictate the ticket breakdown — you decide that later when you decompose it. Errors if " +
      "a proposal with that slug already exists (never clobbers).",
    inputSchema: { name: z.string().min(1) },
  },
  async (args) => ok(await call("create_proposal", args)),
);

server.registerTool(
  "list_proposals",
  {
    description:
      "List the design proposals / feature requests in .charm/proposals/ (PROP-*.md), each with its " +
      "title and self-declared status, including ones already moved to proposals/finished/. A proposal " +
      "describes WHAT to build and its impact; it does not dictate how many tickets to create — you read " +
      "the proposal file and decide the ticket decomposition. Use this to see the menu of feature requests " +
      "available to draw work from.",
    inputSchema: {},
  },
  async () => ok(await call("list_proposals")),
);

server.registerTool(
  "finish_proposal",
  {
    description:
      "Mark a proposal finished by moving .charm/proposals/<name>.md into proposals/finished/, keeping the " +
      "active proposals listing clean once a feature request has been fully decomposed into tickets (or " +
      "superseded). `name` is the proposal filename, with or without the .md suffix.",
    inputSchema: { name: z.string().min(1) },
  },
  async (args) => ok(await call("finish_proposal", args)),
);

server.registerTool(
  "spawn_review_agents",
  {
    description: "Spawn one headless reviewer agent per ticket id.",
    inputSchema: { ticket_ids: z.array(z.string()) },
  },
  async (args) => ok(await call("spawn_review_agents", args)),
);

server.registerTool(
  "spawn_workers",
  {
    description: "Spawn interactive worker agents. The daemon enforces dep + file-scope conflicts; conflicting tickets are returned as 'deferred'.",
    inputSchema: { ticket_ids: z.array(z.string()) },
  },
  async (args) => ok(await call("spawn_workers", args)),
);

server.registerTool(
  "await_approval",
  {
    description: "Block until a human approves or rejects this gate in the Console pane.",
    inputSchema: {
      stage: z.union([z.literal(0), z.literal(2), z.literal(4)]),
      label: z.string(),
      ticket_id: z.string().nullable().default(null),
      payload_path: z.string().nullable().default(null),
    },
  },
  // No timeout: this blocks until a human resolves the gate in the Console pane,
  // which can legitimately take minutes — a default timeout would abort the wait.
  // Fold in CHARM_AGENT_ID as caller_id so the daemon can link the gate to the
  // waiting agent and cancel it if that agent is torn down (the orchestrator's id
  // resolves to no tracked sub-agent, so the daemon simply leaves it unlinked).
  async (args) => ok(await call("await_approval", { caller_id: AGENT_ID ?? null, ...args }, { timeoutMs: 0 })),
);

server.registerTool(
  "update_plan",
  {
    description: "Worker-only: record your current plan before editing files. The daemon appends it to your ticket's activity log (.charm/tickets/<id>.md), not COORDINATION.md.",
    inputSchema: { plan: z.string() },
  },
  async (args) => {
    if (!AGENT_ID) throw new Error("CHARM_AGENT_ID not set");
    return ok(await call("update_plan", { agent_id: AGENT_ID, plan: args.plan }));
  },
);

server.registerTool(
  "read_coordination",
  {
    description:
      "Return the live coordination board (the rendered COORDINATION.md): one row per ticket that is not yet " +
      "complete — open, in-flight, or failed — with its stage, status, and the sub-agent on it (or '-' if " +
      "unassigned). Completed tickets drop off. This is the human-glanceable board; for a structured, filterable " +
      "query of ticket state use list_tickets, and for a ticket's full plan/history read .charm/tickets/<id>.md.",
    inputSchema: {},
  },
  async () => ok(await call("read_coordination")),
);

server.registerTool(
  "list_tickets",
  {
    description:
      "Query the ticket index (sqlite, the source-of-truth-derived index of every ticket). Returns id, title, " +
      "status, stage, depends_on, and touches per ticket. Pass `statuses` to filter (e.g. [\"ready\"] for the " +
      "runnable backlog, [\"failed\"] for tickets needing attention); omit it to get every ticket regardless of " +
      "state. Use this for triage/scheduling decisions; for a ticket's full body and activity log read " +
      ".charm/tickets/<id>.md.",
    inputSchema: {
      statuses: z
        .array(z.enum(["pending", "ready", "running", "blocked", "reviewed", "complete", "failed", "cancelled"]))
        .optional(),
    },
  },
  async (args) => ok(await call("list_tickets", args)),
);

server.registerTool(
  "report_status",
  {
    description: "Report this agent's state (running, blocked, done, failed) and an optional note.",
    inputSchema: {
      state: z.enum(["spawning", "running", "blocked", "done", "failed"]),
      note: z.string().optional(),
    },
  },
  async (args) => {
    if (!AGENT_ID) throw new Error("CHARM_AGENT_ID not set");
    return ok(await call("report_status", { agent_id: AGENT_ID, ...args }));
  },
);

server.registerTool(
  "set_ticket_status",
  {
    description:
      "Drive your OWN ticket's lifecycle. Set `status` (running while you work; complete when done; failed if you " +
      "hit a wall; blocked while waiting) and/or `stage` (e.g. in_progress -> review -> testing) as you progress. " +
      "Self-scoped: always applies to the ticket you were spawned on, never another's. `cancelled` is not " +
      "settable here — that's an operator call-off. The transition is recorded in your ticket's activity log " +
      "(.charm/tickets/<id>.md) and reflected on the coordination board.",
    inputSchema: {
      status: z.enum(["pending", "ready", "running", "blocked", "complete", "failed"]).optional(),
      stage: z.enum(["generated", "review", "approved", "in_progress", "testing", "done", "failed"]).optional(),
      note: z.string().optional(),
    },
  },
  async (args) => {
    if (!AGENT_ID) throw new Error("CHARM_AGENT_ID not set");
    return ok(await call("set_ticket_status", { agent_id: AGENT_ID, ...args }));
  },
);

server.registerTool(
  "set_ticket_state",
  {
    description:
      "Orchestrator-only: write a ticket's lifecycle directly, addressed by ticket_id. Set `status` " +
      "(pending/ready/running/blocked/reviewed/complete/failed) and/or `stage` (generated/review/approved/in_progress/" +
      "testing/done/failed) on ANY ticket — unlike set_ticket_status, which only drives a worker's own ticket. " +
      "Use it to schedule the backlog (flip a generated ticket to `ready`), walk a stage forward, or mark a " +
      "ticket complete/failed out of band. Writing a terminal status (complete/failed) tears down any sub-agent " +
      "still on the ticket. `cancelled` is not settable here — use cancel_ticket for a deliberate call-off. The " +
      "transition is recorded in the ticket's activity log (.charm/tickets/<id>.md) and the coordination board.",
    inputSchema: {
      ticket_id: z.string(),
      status: z.enum(["pending", "ready", "running", "blocked", "reviewed", "complete", "failed"]).optional(),
      stage: z.enum(["generated", "review", "approved", "in_progress", "testing", "done", "failed"]).optional(),
      note: z.string().optional(),
    },
  },
  async (args) => {
    if (!AGENT_ID) throw new Error("CHARM_AGENT_ID not set");
    return ok(await call("set_ticket_state", { caller_id: AGENT_ID, ...args }));
  },
);

server.registerTool(
  "set_session_description",
  {
    description:
      "Main-agent: set or update a one-sentence (≤80 char) human-readable description of this session, " +
      "shown by `charm list`. Call this once near the end of Stage 0 (after PROJECT.md firms up) " +
      "and again any time you realize the framing has materially changed (e.g. scope pivot).",
    inputSchema: { description: z.string().min(1).max(80) },
  },
  async (args) => ok(await call("set_session_description", args)),
);

server.registerTool(
  "request_review",
  {
    description: "Worker-only: spawn a tester agent on a finished ticket.",
    inputSchema: { ticket_id: z.string() },
  },
  async (args) => ok(await call("request_review", args)),
);

server.registerTool(
  "list_agents",
  {
    description:
      "List every live sub-agent the daemon is tracking (id, role, state, ticket_id). " +
      "Use this before kill_agent to see exactly which agents exist and their ids. " +
      "The orchestrator (main agent) is not listed and cannot be killed.",
    inputSchema: {},
  },
  async () => ok(await call("list_agents")),
);

server.registerTool(
  "kill_agent",
  {
    description:
      "Terminate an agent: kill its tmux pane and drop it from the registry. If it was " +
      "mid-ticket, the ticket's terminal status depends on who killed it: a sub-agent killing " +
      "ITSELF marks the ticket `failed` (it couldn't finish); the orchestrator/operator killing " +
      "another agent marks it `cancelled` (a deliberate call-off).\n" +
      "- Orchestrator (main agent): may kill ANY sub-agent (reviewer/worker/tester) by id.\n" +
      "- Sub-agent: may kill ONLY ITSELF — omit agent_id (or pass your own id) to abort your " +
      "own ticket when you are stuck and cannot make progress.\n" +
      "The orchestrator can never be killed by anyone. Call list_agents first to get valid ids.",
    inputSchema: { agent_id: z.string().nullable().default(null) },
  },
  async (args) => {
    if (!AGENT_ID) throw new Error("CHARM_AGENT_ID not set");
    return ok(await call("kill_agent", { caller_id: AGENT_ID, agent_id: args.agent_id }));
  },
);

server.registerTool(
  "continue_agent",
  {
    description:
      "Resume a blocked sub-agent. Sends `message` (your guidance / the unblock info) into the " +
      "agent's pane to wake it, and flips it back to running.\n" +
      "- Use when an agent reported `blocked` and you have resolved what it was waiting on " +
      "(a dependency landed, a decision was made, info it needed). Read the ticket file " +
      "(.charm/tickets/<id>.md) for the agent's blocked note and activity log so your message addresses it.\n" +
      "- Orchestrator-only; the target must be a live sub-agent currently in the `blocked` state — call " +
      "list_agents first for valid ids. To abandon a stuck agent instead of resuming it, use kill_agent.",
    inputSchema: {
      agent_id: z.string(),
      message: z.string().min(1),
    },
  },
  async (args) => {
    if (!AGENT_ID) throw new Error("CHARM_AGENT_ID not set");
    return ok(await call("continue_agent", { caller_id: AGENT_ID, ...args }));
  },
);

server.registerTool(
  "cancel_ticket",
  {
    description:
      "Call off a ticket that is no longer wanted: marks it `cancelled`, drops it from the coordination board, " +
      "and tears down any agent working it. This is NOT how you handle a stuck agent you want to retry — for " +
      "that, kill_agent marks the ticket `failed` so it stays on the board for reassignment. Use cancel_ticket " +
      "only when the work itself should stop (descoped, superseded, no longer needed). Orchestrator/operator only.",
    inputSchema: {
      ticket_id: z.string(),
      note: z.string().optional(),
    },
  },
  async (args) => {
    if (!AGENT_ID) throw new Error("CHARM_AGENT_ID not set");
    return ok(await call("cancel_ticket", { caller_id: AGENT_ID, ...args }));
  },
);

server.registerTool(
  "open_graph",
  {
    description:
      "Open the charm graph viewer: a standalone, animated force-directed view of the " +
      "project graph (Obsidian-style nodes and edges) in a brand-new terminal window on " +
      "the user's computer, separate from the charm tmux session. Call this when the user " +
      "asks to see, open, or visualize the graph / map / dependency view. Each call opens " +
      "an independent window; closing it (q/Esc) or `charm stop` shuts it down.",
    inputSchema: {},
  },
  async () => ok(await call("open_graph")),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[charm-mcp] connected (agent=" + (AGENT_ID ?? "?") + ", socket=" + SOCKET + ")");
