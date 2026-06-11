import type { Agent, AgentRole, AgentState } from "../schema.ts";

/** The agent states that occupy a live concurrency slot (a running Claude process
 *  / tmux pane). A freshly created agent is `spawning` for the whole splitPane
 *  subprocess, so it MUST count here — otherwise a concurrent spawn could solve
 *  against a stale view and double-claim a file. done/failed agents are reaped and
 *  free their slot, so they don't count. */
export function occupiesLiveSlot(state: AgentState): boolean {
  return state === "spawning" || state === "running" || state === "blocked";
}

/** True when an agent holds a live claim on its ticket's `touches` files: a worker
 *  in a live-slot state with a ticket assigned. The dependency solver subtracts
 *  these claims so two workers never edit the same file concurrently. Exported
 *  (rather than inlined in the daemon) so the spawn-race regression test exercises
 *  the REAL predicate instead of a copy that can silently drift from it. */
export function holdsTicketClaim(a: Agent): boolean {
  return a.role === "worker" && occupiesLiveSlot(a.state) && a.ticket_id !== null;
}

export class AgentRegistry {
  private agents = new Map<string, Agent>();
  // Claude-side conversation UUID per agent, kept alongside (not inside) the
  // schema-validated Agent record. This is the id charm passes to
  // `claude --session-id` at spawn; recording it lets the operator later relaunch
  // the same conversation with `claude --resume <uuid>` (see `charm resume`).
  private claudeSessions = new Map<string, string>();
  private seq = 0;

  create(opts: { role: AgentRole; ticket_id: string | null; claude_session_id?: string }): Agent {
    this.seq += 1;
    const id = `${opts.role}-${String(this.seq).padStart(3, "0")}`;
    const agent: Agent = {
      id,
      role: opts.role,
      ticket_id: opts.ticket_id,
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
