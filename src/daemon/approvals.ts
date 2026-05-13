import type { ApprovalGate } from "../schema.ts";

type Waiter = { gate: ApprovalGate; resolve: (decision: "approve" | "reject") => void };

export class ApprovalQueue {
  private waiters = new Map<string, Waiter>();
  private seq = 0;
  private listeners = new Set<(snapshot: ApprovalGate[]) => void>();

  enqueue(opts: { stage: 0 | 2 | 4; label: string; ticket_id: string | null; payload_path: string | null }): Promise<"approve" | "reject"> {
    this.seq += 1;
    const gate: ApprovalGate = {
      id: `gate-${String(this.seq).padStart(3, "0")}`,
      stage: opts.stage,
      label: opts.label,
      ticket_id: opts.ticket_id,
      payload_path: opts.payload_path,
      resolved: false,
      created_at: Date.now(),
    };
    return new Promise<"approve" | "reject">((resolve) => {
      this.waiters.set(gate.id, { gate, resolve });
      this.notify();
    });
  }

  resolve(id: string, decision: "approve" | "reject"): boolean {
    const w = this.waiters.get(id);
    if (!w) return false;
    w.gate.resolved = true;
    w.gate.decision = decision;
    this.waiters.delete(id);
    w.resolve(decision);
    this.notify();
    return true;
  }

  pending(): ApprovalGate[] {
    return [...this.waiters.values()].map((w) => w.gate);
  }

  onChange(fn: (snapshot: ApprovalGate[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    const snap = this.pending();
    for (const l of this.listeners) l(snap);
  }
}
