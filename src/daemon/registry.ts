import type { Agent, AgentRole, AgentState } from "../schema.ts";

/** The agent states that occupy a live concurrency slot (a running Claude process
 *  / tmux pane). A freshly created agent is `spawning` for the whole splitPane
 *  subprocess, so it MUST count here — otherwise a concurrent spawn could solve
 *  against a stale view and double-claim a file. done/failed agents are reaped and
 *  free their slot, so they don't count. */
export function occupiesLiveSlot(state: AgentState): boolean {
  return state === "spawning" || state === "running" || state === "blocked";
}

/** True when an agent holds a claim on its ticket's `touches` files: any worker
 *  with a ticket assigned that is still present in the registry. The dependency
 *  solver subtracts these claims so two workers never edit the same file
 *  concurrently.
 *
 *  Deliberately NOT gated on occupiesLiveSlot: the claim must outlive the `done`
 *  state. report_status('done'/'failed') is a lightweight RPC that runs WITHOUT
 *  the layout lock, so the instant a worker flips to a terminal state its claim
 *  would otherwise vanish from inFlight() — even though its process may still be
 *  flushing writes and it hasn't been torn down. A concurrent spawn_workers
 *  acquiring the lock in that window could then spawn a second worker onto an
 *  overlapping `touches` set: the spawn-race reopened on the done->teardown tail.
 *  So the claim is released only by registry.remove() (the actual teardown), not
 *  by the state transition. The max-agents cap is a separate concern and DOES
 *  free on done/failed via occupiesLiveSlot — claim lifetime and slot lifetime
 *  are intentionally decoupled.
 *
 *  Exported (rather than inlined in the daemon) so the spawn-race regression test
 *  exercises the REAL predicate instead of a copy that can silently drift. */
export function holdsTicketClaim(a: Agent): boolean {
  return a.role === "worker" && a.ticket_id !== null;
}

export class AgentRegistry {
  private agents = new Map<string, Agent>();
  // Claude-side conversation UUID per agent, kept alongside (not inside) the
  // schema-validated Agent record. This is the id charm passes to
  // `claude --session-id` at spawn; recording it lets the operator later relaunch
  // the same conversation with `claude --resume <uuid>` (see `charm resume`).
  private claudeSessions = new Map<string, string>();
  private seq = 0;

  create(opts: { role: AgentRole; ticket_id: string | null; parent_id?: string | null; claude_session_id?: string }): Agent {
    this.seq += 1;
    const id = `${opts.role}-${String(this.seq).padStart(3, "0")}`;
    const agent: Agent = {
      id,
      role: opts.role,
      ticket_id: opts.ticket_id,
      // The agent that authorized this spawn (the spawning orchestrator's id), or
      // null for the root orchestrator / operator-spawned agents. Optional in the
      // opts so existing callers that don't track a parent keep working; the
      // hierarchy-aware spawn paths thread the authorizing caller_id through.
      parent_id: opts.parent_id ?? null,
      // Defaults to the shared tree; the daemon sets a real worktree later via
      // setWorktree() once one is opened for this agent (create()'s signature is
      // intentionally unchanged — null is the right default at spawn time).
      worktree_name: null,
      pane_id: null,
      pid: null,
      state: "spawning",
      started_at: Date.now(),
    };
    this.agents.set(id, agent);
    if (opts.claude_session_id) this.claudeSessions.set(id, opts.claude_session_id);
    return agent;
  }

  /** The Claude-side conversation UUID this agent was launched under (the value
   *  passed to `claude --session-id`), or undefined if charm didn't record one. */
  claudeSessionId(id: string): string | undefined {
    return this.claudeSessions.get(id);
  }

  attach(id: string, info: { pane_id?: string; pid?: number }): Agent {
    const a = this.require(id);
    if (info.pane_id !== undefined) a.pane_id = info.pane_id;
    if (info.pid !== undefined) a.pid = info.pid;
    a.state = "running";
    return a;
  }

  // Status notes are recorded in the ticket's activity log
  // (TicketStore.appendLog) by the daemon, not on the agent record, so the
  // in-memory record stays lean. The note param is kept for call-site
  // compatibility and intentionally unused here.
  setState(id: string, state: AgentState, _note?: string): Agent {
    const a = this.require(id);
    a.state = state;
    return a;
  }

  /** Record the worktree this agent is isolated in (the subdir name under
   *  ~/.charm-worktrees/<repo>/), or null to mark it back on the shared tree. Set by
   *  the daemon after a worktree is opened for the agent — create() always starts at
   *  null since most agents run in the shared tree. */
  setWorktree(id: string, name: string | null): Agent {
    const a = this.require(id);
    a.worktree_name = name;
    return a;
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }

  remove(id: string): void {
    this.agents.delete(id);
    this.claudeSessions.delete(id);
  }

  private require(id: string): Agent {
    const a = this.agents.get(id);
    if (!a) throw new Error(`unknown agent ${id}`);
    return a;
  }
}
