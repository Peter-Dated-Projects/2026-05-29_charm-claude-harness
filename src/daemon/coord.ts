import { openSync, closeSync, writeFileSync, readFileSync, existsSync, renameSync, fsyncSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import type { Agent } from "../schema.ts";
import type { CharmPaths } from "../paths.ts";

const HEADER = "# COORDINATION.md\n\n_Updated automatically by charmd. Do not edit by hand._\n\n";
const BEGIN = "<!-- BEGIN AGENT ";
const END = "<!-- END AGENT ";

type Entry = { agent: Agent; updated_at: number };

export class CoordinationWriter {
  private lockPath: string;
  constructor(private paths: CharmPaths) {
    this.lockPath = paths.coordinationMd + ".lock";
  }

  upsert(agent: Agent, plan?: string) {
    this.withLock(() => {
      const entries = this.readEntries();
      entries.set(agent.id, {
        agent: plan ? { ...agent, plan } : agent,
        updated_at: Date.now(),
      });
      this.writeEntries(entries);
    });
  }

  remove(agent_id: string) {
    this.withLock(() => {
      const entries = this.readEntries();
      entries.delete(agent_id);
      this.writeEntries(entries);
    });
  }

  read(): string {
    return existsSync(this.paths.coordinationMd) ? readFileSync(this.paths.coordinationMd, "utf8") : "";
  }

  private readEntries(): Map<string, Entry> {
    const m = new Map<string, Entry>();
    if (!existsSync(this.paths.coordinationMd)) return m;
    const text = readFileSync(this.paths.coordinationMd, "utf8");
    const re = new RegExp(`${BEGIN}([^ ]+) -->\\n([\\s\\S]*?)\\n${END}\\1 -->`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const id = match[1]!;
      const block = match[2]!;
      const jsonStart = block.indexOf("```json");
      const jsonEnd = block.indexOf("```", jsonStart + 6);
      if (jsonStart < 0 || jsonEnd < 0) continue;
      try {
        const json = block.slice(jsonStart + 7, jsonEnd).trim();
        const parsed = JSON.parse(json) as Entry;
        m.set(id, parsed);
      } catch { /* skip malformed */ }
    }
    return m;
  }

  private writeEntries(entries: Map<string, Entry>) {
    let out = HEADER;
    const sorted = [...entries.values()].sort((a, b) => a.agent.started_at - b.agent.started_at);
    for (const e of sorted) {
      const a = e.agent;
      out += `${BEGIN}${a.id} -->\n`;
      out += `## ${a.role} \`${a.id}\` — ${a.state}\n\n`;
      if (a.ticket_id) out += `- ticket: \`${a.ticket_id}\`\n`;
      if (a.pane_id) out += `- pane: \`${a.pane_id}\`\n`;
      out += `- updated: ${new Date(e.updated_at).toISOString()}\n`;
      if (a.plan) out += `\n### plan\n\n${a.plan}\n`;
      out += `\n\`\`\`json\n${JSON.stringify(e, null, 2)}\n\`\`\`\n\n`;
      out += `${END}${a.id} -->\n\n`;
    }
    this.atomicWrite(this.paths.coordinationMd, out);
  }

  private atomicWrite(path: string, text: string) {
    const tmp = join(dirname(path), `.${basename(path)}.tmp.${process.pid}`);
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  private withLock<T>(fn: () => T): T {
    const start = Date.now();
    let fd: number | null = null;
    while (true) {
      try {
        fd = openSync(this.lockPath, "wx");
        break;
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        if (Date.now() - start > 5000) throw new Error("COORDINATION.md lock timeout");
        Bun.sleepSync(20);
      }
    }
    try {
      return fn();
    } finally {
      if (fd !== null) closeSync(fd);
      try { require("node:fs").unlinkSync(this.lockPath); } catch { /* ignore */ }
    }
  }
}
