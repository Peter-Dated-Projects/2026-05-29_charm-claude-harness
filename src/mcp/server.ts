#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { rpcCall } from "../daemon/rpc.ts";

/**
 * harness-mcp — stdio MCP shim spawned by every `claude` process.
 * It forwards tool calls to the running `harnessd` over a Unix socket.
 *
 * The daemon socket path is provided via the HARNESS_SOCKET env var (exported
 * by buildClaudeCommand). The agent's id (HARNESS_AGENT_ID) is folded into
 * worker-side calls so the daemon knows which agent reported.
 */

const SOCKET = process.env.HARNESS_SOCKET;
const AGENT_ID = process.env.HARNESS_AGENT_ID;
if (!SOCKET) {
  console.error("[harness-mcp] HARNESS_SOCKET env var is required");
  process.exit(1);
}

async function call<T>(method: string, params?: unknown): Promise<T> {
  return rpcCall<T>(SOCKET!, method, params);
}

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
  };
}

const server = new McpServer({ name: "harness-mcp", version: "0.0.1" });

server.registerTool(
  "create_tickets",
  {
    description: "Create one or more tickets. Each ticket needs a title, body, depends_on, and touches (file globs).",
    inputSchema: {
      tickets: z.array(z.object({
        title: z.string(),
        body: z.string(),
        depends_on: z.array(z.string()).default([]),
        touches: z.array(z.string()).default([]),
      })),
    },
  },
  async (args) => ok(await call("create_tickets", args)),
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
  async (args) => ok(await call("await_approval", args)),
);

server.registerTool(
  "update_plan",
  {
    description: "Worker-only: append/update this agent's plan in COORDINATION.md before editing files.",
    inputSchema: { plan: z.string() },
  },
  async (args) => {
    if (!AGENT_ID) throw new Error("HARNESS_AGENT_ID not set");
    return ok(await call("update_plan", { agent_id: AGENT_ID, plan: args.plan }));
  },
);

server.registerTool(
  "read_coordination",
  {
    description: "Return the current COORDINATION.md text so an agent can see what other in-flight agents are doing.",
    inputSchema: {},
  },
  async () => ok(await call("read_coordination")),
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
    if (!AGENT_ID) throw new Error("HARNESS_AGENT_ID not set");
    return ok(await call("report_status", { agent_id: AGENT_ID, ...args }));
  },
);

server.registerTool(
  "set_session_description",
  {
    description:
      "Main-agent: set or update a one-sentence (≤80 char) human-readable description of this session, " +
      "shown by `harness list`. Call this once near the end of Stage 0 (after PROJECT.md firms up) " +
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[harness-mcp] connected (agent=" + (AGENT_ID ?? "?") + ", socket=" + SOCKET + ")");
