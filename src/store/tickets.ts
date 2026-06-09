import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import matter from "gray-matter";
import { Database } from "bun:sqlite";
import { TicketFrontmatter, type Ticket, type TicketStatus, type TicketStage } from "../schema.ts";
import type { CharmPaths } from "../paths.ts";

// Markers delimiting the daemon-managed activity log inside a ticket body. Plans,
// status changes, and orchestrator messages are appended here as timestamped
// lines; everything outside the markers (the human/agent-authored ticket
// description) is never touched. This is what lets COORDINATION.md stay a slim
// index — the verbose per-ticket history lives in the ticket file itself.
const LOG_BEGIN = "<!-- CHARM:LOG -->";
const LOG_END = "<!-- /CHARM:LOG -->";

/** A ticket as stored in the sqlite index — lighter than a full Ticket (no body).
 *  Returned by queryIndex; this is what callers query when they want ticket state
 *  without paying to read and parse every .md file. */
export type IndexedTicket = {
  id: string;
  title: string;
  status: TicketStatus;
  stage: TicketStage;
  depends_on: string[];
  touches: string[];
  updated_at: number;
};

/** Raw row shape as it comes back from sqlite (JSON columns still encoded). */
type IndexRow = {
  id: string;
  title: string;
  status: string;
  stage: string;
  depends_on: string;
  touches: string;
  path: string;
  updated_at: number;
};

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
    mkdirSync(paths.scratchpadDir, { recursive: true });
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

  /** List the ticket-draft filenames (without the .md suffix) currently sitting
   *  in the scratchpad. These are unindexed drafts the orchestrator authored by
   *  hand; they are not tickets until promoted. */
  listDrafts(): string[] {
    if (!existsSync(this.paths.scratchpadDir)) return [];
    return readdirSync(this.paths.scratchpadDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => basename(f, ".md"))
      .sort();
  }

  /** Promote a hand-authored draft from the scratchpad into a real, indexed
   *  ticket. Reads .charm/scratchpad/<name>.md, validates its frontmatter (the
   *  draft's own `id` wins, falling back to the filename — so cross-draft
   *  depends_on references survive promotion intact), writes it into ticketsDir,
   *  indexes it, and removes the draft. Throws if the draft is missing or if a
   *  ticket with the resolved id already exists (no silent clobber). */
  promoteDraft(name: string): Ticket {
    const draftName = name.endsWith(".md") ? name.slice(0, -3) : name;
    const draftPath = join(this.paths.scratchpadDir, `${draftName}.md`);
    if (!existsSync(draftPath)) throw new Error(`no draft in scratchpad: ${draftName}`);
    const parsed = matter(readFileSync(draftPath, "utf8"));
    // Mirror readPath: filename is the default id, frontmatter `id` overrides it.
    const fm = TicketFrontmatter.parse({ id: draftName, ...parsed.data });
    const destPath = join(this.paths.ticketsDir, `${fm.id}.md`);
    if (existsSync(destPath)) {
      throw new Error(`cannot promote ${draftName}: ticket ${fm.id} already exists`);
    }
    writeFileSync(destPath, matter.stringify(parsed.content, fm));
    this.indexOne({ frontmatter: fm, body: parsed.content, path: destPath });
    unlinkSync(draftPath);
    return { frontmatter: fm, body: parsed.content, path: destPath };
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

  /** Query the sqlite index, optionally filtered to a set of statuses, ordered by
   *  id. Reads the index (not the .md files), returning a lightweight row per
   *  ticket — no body. This is the queryable, status-filterable view that backs
   *  both COORDINATION.md and the list_tickets MCP tool, keeping the
   *  files -> sqlite -> COORDINATION.md derivation chain intact. Every create and
   *  update reindexes synchronously, so the index is never stale on read. */
  queryIndex(opts?: { statuses?: string[] }): IndexedTicket[] {
    const statuses = opts?.statuses ?? [];
    const sql = statuses.length
      ? `SELECT * FROM tickets WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY id`
      : "SELECT * FROM tickets ORDER BY id";
    const rows = this.db.query(sql).all(...statuses) as IndexRow[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status as TicketStatus,
      stage: r.stage as TicketStage,
      depends_on: JSON.parse(r.depends_on) as string[],
      touches: JSON.parse(r.touches) as string[],
      updated_at: r.updated_at,
    }));
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
