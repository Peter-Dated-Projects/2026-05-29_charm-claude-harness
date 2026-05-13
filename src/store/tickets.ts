import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import matter from "gray-matter";
import { Database } from "bun:sqlite";
import { TicketFrontmatter, type Ticket } from "../schema.ts";
import type { HarnessPaths } from "../paths.ts";

export class TicketStore {
  private db: Database;

  constructor(private paths: HarnessPaths) {
    mkdirSync(paths.ticketsDir, { recursive: true });
    mkdirSync(paths.harnessDir, { recursive: true });
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
