import { z } from "zod";

export const TicketStage = z.enum(["generated", "review", "approved", "in_progress", "testing", "done", "failed"]);
export type TicketStage = z.infer<typeof TicketStage>;

export const TicketStatus = z.enum(["pending", "ready", "running", "blocked", "complete", "failed", "cancelled"]);
export type TicketStatus = z.infer<typeof TicketStatus>;

/** The statuses COORDINATION.md renders: every status except the two terminal
 *  "done with it" ones, `complete` and `cancelled`. Open and in-flight tickets
 *  obviously belong on the live board; `failed` stays too, because a failed ticket
 *  needs an operator's eyes (update the ticket, re-spawn a retry). Only a cleanly
 *  completed ticket, or one the operator deliberately called off, leaves the board. */
export const COORDINATION_STATUSES: TicketStatus[] = ["pending", "ready", "running", "blocked", "failed"];

/** Statuses a worker may set on its own ticket via set_ticket_status. `cancelled`
 *  is intentionally excluded: cancelling is a deliberate operator/orchestrator
 *  call-off (it flows from kill_agent), not something a worker decides about its
 *  own work — a worker that hits a wall reports `failed`, not `cancelled`. */
export const WORKER_SETTABLE_STATUSES: TicketStatus[] = ["pending", "ready", "running", "blocked", "complete", "failed"];

export const TicketFrontmatter = z.object({
  id: z.string().regex(/^T-\d{3,}$/),
  title: z.string().min(1),
  status: TicketStatus.default("pending"),
  stage: TicketStage.default("generated"),
  depends_on: z.array(z.string()).default([]),
  touches: z.array(z.string()).default([]),
});
export type TicketFrontmatter = z.infer<typeof TicketFrontmatter>;

export const Ticket = z.object({
  frontmatter: TicketFrontmatter,
  body: z.string(),
  path: z.string(),
});
export type Ticket = z.infer<typeof Ticket>;

export const AgentRole = z.enum(["main", "reviewer", "worker", "tester"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentState = z.enum(["spawning", "running", "blocked", "done", "failed"]);
export type AgentState = z.infer<typeof AgentState>;

export const Agent = z.object({
  id: z.string(),
  role: AgentRole,
  ticket_id: z.string().nullable(),
  pane_id: z.string().nullable(),
  pid: z.number().nullable(),
  state: AgentState,
  started_at: z.number(),
});
export type Agent = z.infer<typeof Agent>;

export const ApprovalGate = z.object({
  id: z.string(),
  stage: z.union([z.literal(0), z.literal(2), z.literal(4)]),
  label: z.string(),
  payload_path: z.string().nullable(),
  ticket_id: z.string().nullable(),
  resolved: z.boolean().default(false),
  decision: z.enum(["approve", "reject"]).optional(),
  created_at: z.number(),
});
export type ApprovalGate = z.infer<typeof ApprovalGate>;

export const RpcRequest = z.object({
  id: z.string(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export const RpcResponse = z.object({
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type RpcResponse = z.infer<typeof RpcResponse>;

export const CreateTicketsInput = z.object({
  tickets: z.array(z.object({
    title: z.string(),
    body: z.string(),
    depends_on: z.array(z.string()).default([]),
    touches: z.array(z.string()).default([]),
  })),
});
export type CreateTicketsInput = z.infer<typeof CreateTicketsInput>;

export const SpawnReviewersInput = z.object({
  ticket_ids: z.array(z.string()).min(1),
});
export type SpawnReviewersInput = z.infer<typeof SpawnReviewersInput>;

export const SpawnWorkersInput = z.object({
  ticket_ids: z.array(z.string()).min(1),
});
export type SpawnWorkersInput = z.infer<typeof SpawnWorkersInput>;

export const AwaitApprovalInput = z.object({
  stage: z.union([z.literal(0), z.literal(2), z.literal(4)]),
  label: z.string(),
  ticket_id: z.string().nullable().default(null),
  payload_path: z.string().nullable().default(null),
});
export type AwaitApprovalInput = z.infer<typeof AwaitApprovalInput>;

export const UpdatePlanInput = z.object({
  agent_id: z.string(),
  plan: z.string(),
});
export type UpdatePlanInput = z.infer<typeof UpdatePlanInput>;

export const ReportStatusInput = z.object({
  agent_id: z.string(),
  state: AgentState,
  note: z.string().optional(),
});
export type ReportStatusInput = z.infer<typeof ReportStatusInput>;

// set_ticket_status lets a worker drive its own ticket's lifecycle directly:
// status (running while working, complete/failed when terminal) and/or stage
// (e.g. in_progress -> review -> testing). Self-scoped — the daemon applies it to
// the caller's assigned ticket; an agent cannot move another's ticket. At least
// one of status/stage must be present, or the call is a no-op worth rejecting.
// `cancelled` is not worker-settable (see WORKER_SETTABLE_STATUSES).
export const SetTicketStatusInput = z
  .object({
    agent_id: z.string(),
    status: z.enum(WORKER_SETTABLE_STATUSES as [TicketStatus, ...TicketStatus[]]).optional(),
    stage: TicketStage.optional(),
    note: z.string().optional(),
  })
  .refine((v) => v.status !== undefined || v.stage !== undefined, {
    message: "set_ticket_status requires at least one of status or stage",
  });
export type SetTicketStatusInput = z.infer<typeof SetTicketStatusInput>;

export const RequestReviewInput = z.object({
  ticket_id: z.string(),
});
export type RequestReviewInput = z.infer<typeof RequestReviewInput>;

// kill_agent authorization is driven by caller_id:
//  - absent  -> the human operator (Console pane); may kill any sub-agent.
//  - present -> folded in by the MCP shim from CHARM_AGENT_ID. The orchestrator
//    (main) may kill any sub-agent; a sub-agent may only kill itself.
// A null/absent agent_id means "kill myself" (only meaningful for an agent caller).
// The orchestrator id is always protected — see MAIN_AGENT_ID in daemon/spawn.ts.
export const KillAgentInput = z.object({
  caller_id: z.string().optional(),
  agent_id: z.string().nullable().default(null),
});
export type KillAgentInput = z.infer<typeof KillAgentInput>;

// continue_agent resumes a blocked sub-agent by typing a message into its pane
// and flipping it back to running. Only a blocked agent is a valid target — a
// running agent is actively working, so messaging its pane would corrupt the
// turn. Authorization mirrors
// kill_agent: caller_id absent -> human operator; present -> the orchestrator
// (main). Only those two may continue an agent — a sub-agent cannot drive
// another. The target must be named explicitly (no "continue myself").
export const ContinueAgentInput = z.object({
  caller_id: z.string().optional(),
  agent_id: z.string(),
  message: z.string().min(1),
});
export type ContinueAgentInput = z.infer<typeof ContinueAgentInput>;

// cancel_ticket is the deliberate "this ticket is no longer wanted" path. It is
// intentionally separate from kill_agent: killing a stuck agent marks its ticket
// `failed` so it stays on the board for retry, whereas cancelling marks it
// `cancelled` and drops it off. caller_id authorization mirrors kill_agent:
// absent -> human operator; present -> the orchestrator (main). Sub-agents cannot
// cancel tickets.
export const CancelTicketInput = z.object({
  caller_id: z.string().optional(),
  ticket_id: z.string(),
  note: z.string().optional(),
});
export type CancelTicketInput = z.infer<typeof CancelTicketInput>;

// One-sentence human-readable summary of this session, shown by `charm list`.
// 80-char cap is enforced here (not just in the prompt) so a chatty agent
// can't blow up the listing layout.
export const SetSessionDescriptionInput = z.object({
  description: z.string().min(1).max(80),
});
export type SetSessionDescriptionInput = z.infer<typeof SetSessionDescriptionInput>;

export const SessionMeta = z.object({
  // Per-session control-plane identity. A session's UUID is generated by
  // `charm start` and is the primary key for its run-state (socket, pidfile,
  // graph-viewer pids, tmux session name) under .charm/run/<uuid>/. It is what
  // lets multiple charm sessions coexist — in the same directory or different
  // ones — without colliding, and what scopes `:q` to the session it was pressed
  // in. All identity fields are optional so an older meta.json (description-only)
  // still parses; `start` writes them and set_session_description preserves them.
  uuid: z.string().optional(),
  session_name: z.string().optional(),
  root: z.string().optional(),
  socket: z.string().optional(),
  pid: z.number().optional(),
  description: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  source: z.enum(["agent", "fallback", "start"]).default("agent"),
});
export type SessionMeta = z.infer<typeof SessionMeta>;
