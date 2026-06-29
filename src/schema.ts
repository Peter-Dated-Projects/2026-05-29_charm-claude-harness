import { z } from "zod";

export const TicketStage = z.enum(["generated", "investigating", "approved", "in_progress", "testing", "done", "failed"]);
export type TicketStage = z.infer<typeof TicketStage>;

export const TicketStatus = z.enum(["pending", "ready", "running", "blocked", "complete", "failed", "cancelled"]);
export type TicketStatus = z.infer<typeof TicketStatus>;

/** Whether a ticket is a Phase-A investigation (worked by an investigator: gather
 *  context, propose a fix, write findings into the body) or a Phase-B
 *  implementation/build ticket (worked by a worker). The orchestrator authors
 *  both kinds via create_tickets and spawns the matching role. Defaults to
 *  `implementation` so an unqualified ticket is a build ticket. */
export const TicketType = z.enum(["investigation", "implementation"]);
export type TicketType = z.infer<typeof TicketType>;

/** The statuses COORDINATION.md renders: every status except the two terminal
 *  "done with it" ones, `complete` and `cancelled`. Open and in-flight tickets
 *  obviously belong on the live board; `failed` stays too, because a failed
 *  ticket needs an operator's eyes (update the ticket, re-spawn a retry). Only a
 *  cleanly completed ticket, or one the operator deliberately called off, leaves
 *  the board. */
export const COORDINATION_STATUSES: TicketStatus[] = ["pending", "ready", "running", "blocked", "failed"];

/** Statuses a worker may set on its own ticket via set_ticket_status. `cancelled`
 *  is intentionally excluded: cancelling is a deliberate operator/orchestrator
 *  call-off (it flows from kill_agent), not something a worker decides about its
 *  own work — a worker that hits a wall reports `failed`, not `cancelled`.
 *
 *  `complete` IS intentionally worker-settable, by design — not an oversight. A
 *  worker can mark its own ticket complete (so can report_status('done')) without
 *  a mandatory tester gate, because the real gate is the human: the
 *  common path to completion is the operator stepping into the session and
 *  telling the agent it's done. Testing stays optional and orchestrator-driven
 *  (request_review) rather than forced on every ticket. */
export const WORKER_SETTABLE_STATUSES: TicketStatus[] = ["pending", "ready", "running", "blocked", "complete", "failed"];

/** Statuses the orchestrator/operator may write onto any ticket via set_ticket_state.
 *  Every status except `cancelled`: cancelling drops a ticket off the board and tears
 *  down its agent, which is cancel_ticket's job — keeping it out of this general state
 *  write means the two paths can't be confused. (Happens to match the worker set, but
 *  it's a distinct authorization surface: this one is keyed by ticket_id, not agent.) */
export const ORCHESTRATOR_SETTABLE_STATUSES: TicketStatus[] = ["pending", "ready", "running", "blocked", "complete", "failed"];

export const TicketFrontmatter = z.object({
  id: z.string().regex(/^T-\d{3,}$/),
  title: z.string().min(1),
  type: TicketType.default("implementation"),
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

export const AgentRole = z.enum(["main", "investigator", "worker", "tester", "researcher", "suborchestrator"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentState = z.enum(["spawning", "running", "blocked", "done", "failed"]);
export type AgentState = z.infer<typeof AgentState>;

/** The subset of states an agent may SELF-report via report_status. `spawning`
 *  and `running` are daemon-managed (registry.create() / attach() /
 *  continue_agent), never self-assigned: exposing them let an agent mark itself
 *  `running` while it was truly blocked, defeating continue_agent's
 *  blocked-only guard, or report `spawning` to muddy the slot-occupancy model.
 *  An agent only ever legitimately reports that it is blocked, done, or failed. */
export const AGENT_REPORTABLE_STATES = ["blocked", "done", "failed"] as const;

export const Agent = z.object({
  id: z.string(),
  role: AgentRole,
  ticket_id: z.string().nullable(),
  // The agent that authorized this agent's spawn (the spawning orchestrator's
  // id), or null for the root orchestrator and operator-spawned agents. This is
  // the hierarchy edge the Zed orchestration canvas draws the agent tree from:
  // the registry records who spawned whom so sub_orchestrators (in the status
  // RPC) can count each sub-orchestrator's children. Defaults to null so a record
  // built without a parent (the orchestrator itself, an operator `:so`) still
  // parses, exactly like ticket_id/worktree_name.
  parent_id: z.string().nullable().default(null),
  // The orchestrator-managed worktree this agent is isolated in
  // (~/.charm-worktrees/<repo>/<name>/), or null for the default shared-tree
  // execution. Nullable like ticket_id: most agents run in the shared tree, and the
  // daemon sets the real value later via setWorktree once a worktree is opened.
  worktree_name: z.string().nullable(),
  pane_id: z.string().nullable(),
  pid: z.number().nullable(),
  state: AgentState,
  started_at: z.number(),
});
export type Agent = z.infer<typeof Agent>;

export const ApprovalGate = z.object({
  id: z.string(),
  // Stage 2 = the worker-ticket plan (after investigation synthesis); stage 4 =
  // the merge diff. There is no stage-0 gate — discovery was removed in favor of
  // the investigation phase, which opens with no human gate.
  stage: z.union([z.literal(2), z.literal(4)]),
  label: z.string(),
  payload_path: z.string().nullable(),
  ticket_id: z.string().nullable(),
  // The agent parked on this gate (waiting in await_approval), if any. Lets the
  // daemon cancel a gate whose owner is torn down so it doesn't linger as a
  // zombie on the board. Null for gates not tied to a single waiting agent.
  agent_id: z.string().nullable().default(null),
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
  // Orchestrator-only (folded in by the MCP shim); a sub-agent cannot author
  // tickets. Absent => human operator (console/CLI), also allowed.
  caller_id: z.string().optional(),
  tickets: z.array(z.object({
    title: z.string(),
    body: z.string(),
    // "investigation" => a Phase-A context-gathering ticket worked by an
    // investigator; "implementation" (default) => a Phase-B build ticket worked
    // by a worker. The orchestrator authors both kinds through this one tool.
    type: TicketType.default("implementation"),
    depends_on: z.array(z.string()).default([]),
    touches: z.array(z.string()).default([]),
  })).min(1).max(3, "create_tickets accepts at most 3 tickets per call; split larger batches across multiple calls"),
});
export type CreateTicketsInput = z.infer<typeof CreateTicketsInput>;

// promote ingests ticket DRAFTS the orchestrator wrote into .charm/scratchpad/
// (cheap local writes, no MCP round-trip) into the canonical .charm/tickets/
// directory and the sqlite index — which is what makes a draft a real, spawnable
// ticket. `tickets` names the drafts to promote (with or without the .md suffix);
// omit it to promote every draft currently in the scratchpad.
export const PromoteInput = z.object({
  caller_id: z.string().optional(),
  tickets: z.array(z.string()).optional(),
});
export type PromoteInput = z.infer<typeof PromoteInput>;

// create_proposal scaffolds a new proposal file in .charm/proposals/ from a
// free-text name; the daemon derives the PROP-<slug>.md filename, writes a draft
// template, and returns the path. `name` is the human-readable proposal title.
export const CreateProposalInput = z.object({
  name: z.string().min(1),
});
export type CreateProposalInput = z.infer<typeof CreateProposalInput>;

// finish_proposal marks a proposal done by moving .charm/proposals/<name>.md into
// .charm/proposals/finished/. `name` is the proposal filename, with or without .md.
export const FinishProposalInput = z.object({
  name: z.string().min(1),
});
export type FinishProposalInput = z.infer<typeof FinishProposalInput>;

export const SpawnInvestigatorsInput = z.object({
  caller_id: z.string().optional(),
  ticket_ids: z.array(z.string()).min(1),
  // Optional worktree to run the spawned agents in: the plain `name` of an
  // already-open worktree (~/.charm-worktrees/<repo>/<name>/). When set, the daemon
  // resolves it to that checkout's cwd so the agent runs on its own branch and
  // its registry `worktree_name` is populated (the field is otherwise always null
  // because no spawn path passes a cwd today). Omit for default shared-tree
  // execution. assertPlainName guards it daemon-side before it's joined to a path.
  worktree: z.string().optional(),
});
export type SpawnInvestigatorsInput = z.infer<typeof SpawnInvestigatorsInput>;

export const SpawnWorkersInput = z.object({
  caller_id: z.string().optional(),
  ticket_ids: z.array(z.string()).min(1),
  // Optional worktree (plain name of an open ~/.charm-worktrees/<repo>/<name>/) to
  // run the spawned workers in; see SpawnInvestigatorsInput.worktree. Applies to every
  // worker in the batch.
  worktree: z.string().optional(),
});
export type SpawnWorkersInput = z.infer<typeof SpawnWorkersInput>;

// Researchers are spawned AD-HOC, not off a ticket: the orchestrator passes the
// research question(s) directly as free text. Unlike investigators (which work a
// canonical investigation ticket and write findings into its body), a researcher
// is a lightweight, ticket-less context-gathering agent — it reads broadly (code,
// docs, the web) and writes its findings to a scratchpad file it reports back. One
// agent is spawned per prompt in the batch. `worktree` mirrors the other spawn
// inputs (plain name of an open ~/.charm-worktrees/<repo>/<name>/), applied to every agent.
export const SpawnResearchersInput = z.object({
  caller_id: z.string().optional(),
  prompts: z.array(z.string().min(1)).min(1),
  worktree: z.string().optional(),
});
export type SpawnResearchersInput = z.infer<typeof SpawnResearchersInput>;

// Worktree management tools. A worktree is an orchestrator-managed side resource
// (a parallel line of work in its own `git worktree` — own working tree + index,
// sharing the main repo's object store — under ~/.charm-worktrees/<repo>/<name>/),
// so every tool is caller-gated to the orchestrator like spawn_workers. `name` is a
// plain segment
// (assertPlainName guards it daemon-side before it's joined into a path).
// branch/base steer create(); delete_branch steers close().
export const CreateWorktreeInput = z.object({
  caller_id: z.string().optional(),
  name: z.string(),
  // Existing branch to check out (Graphite-stack case); omit to cut a fresh
  // charm/<name> branch off `base` (default HEAD).
  branch: z.string().optional(),
  base: z.string().optional(),
});
export type CreateWorktreeInput = z.infer<typeof CreateWorktreeInput>;

export const ListWorktreesInput = z.object({
  caller_id: z.string().optional(),
});
export type ListWorktreesInput = z.infer<typeof ListWorktreesInput>;

export const CloseWorktreeInput = z.object({
  caller_id: z.string().optional(),
  name: z.string(),
  // After deleting the copy, also `git branch -D charm/<name>` in the MAIN repo
  // (best-effort) — for a branch that was already merged back.
  delete_branch: z.boolean().optional(),
});
export type CloseWorktreeInput = z.infer<typeof CloseWorktreeInput>;

export const AwaitApprovalInput = z.object({
  stage: z.union([z.literal(2), z.literal(4)]),
  label: z.string(),
  ticket_id: z.string().nullable().default(null),
  payload_path: z.string().nullable().default(null),
  // The agent parking on this gate, folded in by the MCP shim from CHARM_AGENT_ID.
  // Lets tearDownAgent cancel a gate its dying owner was waiting on instead of
  // leaving a zombie gate on the board. Absent for a caller that isn't a tracked
  // agent (e.g. the orchestrator's own stage gates).
  caller_id: z.string().nullable().default(null),
});
export type AwaitApprovalInput = z.infer<typeof AwaitApprovalInput>;

export const UpdatePlanInput = z.object({
  agent_id: z.string(),
  plan: z.string(),
});
export type UpdatePlanInput = z.infer<typeof UpdatePlanInput>;

export const ReportStatusInput = z.object({
  agent_id: z.string(),
  // Only blocked/done/failed are self-reportable; spawning/running are
  // daemon-managed (see AGENT_REPORTABLE_STATES).
  state: z.enum(AGENT_REPORTABLE_STATES),
  note: z.string().optional(),
});
export type ReportStatusInput = z.infer<typeof ReportStatusInput>;

// set_ticket_status lets a worker drive its own ticket's lifecycle directly:
// status (running while working, complete/failed when terminal) and/or stage
// (e.g. in_progress -> testing). Self-scoped — the daemon applies it to
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

// set_ticket_state is the orchestrator's lever to write any ticket's lifecycle
// directly, addressed by ticket_id (not by the caller's own assignment — that's
// set_ticket_status). The orchestrator owns the workflow, so it can move a ticket
// it isn't itself "on": flip a generated ticket to `ready`, walk a stage forward,
// mark something `complete`/`failed` out of band. caller_id authorization mirrors
// cancel_ticket: absent -> human operator; present -> the orchestrator (main).
// Sub-agents cannot use it. `cancelled` is excluded (see ORCHESTRATOR_SETTABLE_STATUSES);
// route deliberate call-offs through cancel_ticket. At least one of status/stage
// must be present, or the call is a no-op worth rejecting.
export const SetTicketStateInput = z
  .object({
    caller_id: z.string().optional(),
    ticket_id: z.string(),
    status: z.enum(ORCHESTRATOR_SETTABLE_STATUSES as [TicketStatus, ...TicketStatus[]]).optional(),
    stage: TicketStage.optional(),
    note: z.string().optional(),
  })
  .refine((v) => v.status !== undefined || v.stage !== undefined, {
    message: "set_ticket_state requires at least one of status or stage",
  });
export type SetTicketStateInput = z.infer<typeof SetTicketStateInput>;

export const RequestReviewInput = z.object({
  caller_id: z.string().optional(),
  ticket_id: z.string(),
  // Optional worktree (plain name of an open ~/.charm-worktrees/<repo>/<name>/) to run the
  // tester in; see SpawnInvestigatorsInput.worktree. A tester validating a worker
  // that ran in a worktree needs the same checkout to see its commit.
  worktree: z.string().optional(),
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
