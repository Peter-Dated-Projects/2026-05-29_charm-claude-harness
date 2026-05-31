import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import matter from "gray-matter";
import { Database } from "bun:sqlite";
import { TicketFrontmatter, type Ticket } from "../schema.ts";
import type { CharmPaths } from "../paths.ts";

// Markers delimiting the daemon-managed activity log inside a ticket body. Plans,
// status changes, and orchestrator messages are appended here as timestamped
// lines; everything outside the markers (the human/agent-authored ticket
// description) is never touched. This is what lets COORDINATION.md stay a slim
// index — the verbose per-ticket history lives in the ticket file itself.
const LOG_BEGIN = "<!-- CHARM:LOG -->";
const LOG_END = "<!-- /CHARM:LOG -->";

/** Insert `line` just before the END marker of the managed log region, creating
 *  the region at the end of the body if it doesn't exist yet. Pure string op so
 *  it round-trips through gray-matter unchanged. */
function appendToLogRegion(body: string, line: string): string {
  const end = body.indexOf(LOG_END);
  const begin = body.indexOf(LOG_BEGIN);
  if (begin >= 0 && end > begin) {
    const before = body.slice(0, end).replace(/\s*$/, "\n");
    const after = body.slice(end);
    return `${before}${line}\n${after}`;
  }
  const base = body.replace(/\s*$/, "");
  const region = `${LOG_BEGIN}\n## Activity\n\n${line}\n${LOG_END}\n`;
  return base ? `${base}\n\n${region}` : region;
}

export class TicketStore {
  private db: Database;

  constructor(private paths: CharmPaths) {
    mkdirSync(paths.ticketsDir, { recursive: true });
    mkdirSync(paths.charmDir, { recursive: true });
    this.db = new Database(paths.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        touches TEXT NOT NULL,
        path TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
      CREATE INDEX IF NOT EXISTS idx_tickets_stage ON tickets(stage);
    `);
  }

  close() {
    this.db.close();
  }

  nextId(): string {
    const row = this.db.query("SELECT id FROM tickets ORDER BY id DESC LIMIT 1").get() as { id: string } | null;
    const n = row ? parseInt(row.id.slice(2), 10) + 1 : 1;
    return `T-${String(n).padStart(3, "0")}`;
  }

  create(input: { title: string; body: string; depends_on?: string[]; touches?: string[] }): Ticket {
    const id = this.nextId();
    const fm = TicketFrontmatter.parse({
      id,
      title: input.title,
      depends_on: input.depends_on ?? [],
      touches: input.touches ?? [],
    });
    const path = join(this.paths.ticketsDir, `${id}.md`);
    const text = matter.stringify(input.body, fm);
    writeFileSync(path, text);
    this.indexOne({ frontmatter: fm, body: input.body, path });
    return { frontmatter: fm, body: input.body, path };
  }

  read(id: string): Ticket | null {
    const path = join(this.paths.ticketsDir, `${id}.md`);
    if (!existsSync(path)) return null;
    return this.readPath(path);
  }

  readPath(path: string): Ticket {
    const raw = readFileSync(path, "utf8");
    const parsed = matter(raw);
    const frontmatter = TicketFrontmatter.parse({ id: basename(path, ".md"), ...parsed.data });
    return { frontmatter, body: parsed.content, path };
  }

  update(id: string, patch: Partial<{ status: string; stage: string; depends_on: string[]; touches: string[]; body: string; title: string }>): Ticket {
    const t = this.read(id);
    if (!t) throw new Error(`unknown ticket ${id}`);
    const fm = TicketFrontmatter.parse({ ...t.frontmatter, ...patch });
    const body = patch.body ?? t.body;
    const text = matter.stringify(body, fm);
    writeFileSync(t.path, text);
    this.indexOne({ frontmatter: fm, body, path: t.path });
    return { frontmatter: fm, body, path: t.path };
  }

  /** Append a timestamped entry to the ticket's managed activity log. This is
   *  where per-ticket working state lives now (plans, status transitions,
   *  orchestrator messages) — keeping COORDINATION.md a slim index. The agent
   *  who acted, the kind of entry, and an optional free-text note are recorded.
   *  Throws on an unknown ticket. */
  appendLog(id: string, entry: { agent: string; kind: string; text?: string }): Ticket {
    const t = this.read(id);
    if (!t) throw new Error(`unknown ticket ${id}`);
    const ts = new Date().toISOString();
    const note = entry.text?.trim() ? `: ${entry.text.trim().replace(/\s+/g, " ")}` : "";
    const line = `- ${ts}  \`${entry.agent}\`  ${entry.kind}${note}`;
    return this.update(id, { body: appendToLogRegion(t.body, line) });
  }

  list(): Ticket[] {
    if (!existsSync(this.paths.ticketsDir)) return [];
    return readdirSync(this.paths.ticketsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => this.readPath(join(this.paths.ticketsDir, f)))
      .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
  }

  reindexAll(): void {
    const all = this.list();
    this.db.exec("DELETE FROM tickets");
    for (const t of all) this.indexOne(t);
  }

  private indexOne(t: Ticket) {
    this.db.query(`
      INSERT INTO tickets (id, title, status, stage, depends_on, touches, path, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        status=excluded.status,
        stage=excluded.stage,
        depends_on=excluded.depends_on,
        touches=excluded.touches,
        path=excluded.path,
        updated_at=excluded.updated_at
    `).run(
      t.frontmatter.id,
      t.frontmatter.title,
      t.frontmatter.status,
      t.frontmatter.stage,
      JSON.stringify(t.frontmatter.depends_on),
      JSON.stringify(t.frontmatter.touches),
      t.path,
      Date.now(),
    );
  }
}
