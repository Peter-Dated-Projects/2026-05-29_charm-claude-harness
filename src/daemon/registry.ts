import type { Agent, AgentRole, AgentState } from "../schema.ts";

export class AgentRegistry {
  private agents = new Map<string, Agent>();
  private seq = 0;

  create(opts: { role: AgentRole; ticket_id: string | null }): Agent {
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
    return agent;
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
  }

  private require(id: string): Agent {
    const a = this.agents.get(id);
    if (!a) throw new Error(`unknown agent ${id}`);
    return a;
  }
}
