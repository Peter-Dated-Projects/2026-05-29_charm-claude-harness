import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { assertPlainName } from "../paths.ts";

/**
 * A charm worktree is an ORCHESTRATOR-MANAGED SIDE RESOURCE: a parallel line of
 * work checked out under .charm/worktrees/<name>/ via `git worktree add`. Each
 * worktree shares the main repo's object store but has its own working tree and
 * index — agents work independently without touching the main checkout, and
 * gitignored control-plane state (.charm/db.sqlite, tickets, etc.) is separate
 * per working tree. Worktrees appear in `git worktree list`, so GitHub Desktop
 * and other git tooling see them. The orchestrator opens worktrees via MCP tools
 * and is responsible for closing them; this class owns the git plumbing plus a
 * prune safety-net for orphans left by a crashed daemon.
 *
 * This is the ONE place that shells out to git for worktrees. All git calls run
 * with cwd = root (the main checkout) except where noted.
 * A non-zero exit throws with the git stderr so failures surface loudly.
 */
export class WorktreeManager {
  private readonly root: string;
  private readonly worktreesDir: string;

  // Serializes create() so two concurrent creates can't interleave their
  // collision check and `git worktree add`.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: { root: string; worktreesDir: string }) {
    this.root = opts.root;
    this.worktreesDir = opts.worktreesDir;
  }

  /** Run git with the given cwd (default = root). Throws with stderr on non-zero. */
  private git(args: string[], cwd: string = this.root): string {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
    }
    return r.stdout ?? "";
  }

  /**
   * Open a linked worktree under worktreesDir.
   *
   * Two modes:
   *  - opts.branch given: check out that EXISTING branch in the new worktree.
   *  - otherwise: cut a fresh `charm/<name>` branch off opts.base (default HEAD).
   *
   * SERIALIZED: every create runs inside the promise-chain mutex.
   */
  async create(
    name: string,
    opts?: { branch?: string; base?: string },
  ): Promise<{ name: string; path: string; branch: string }> {
    const run = this.chain.then(() => this.createLocked(name, opts));
    this.chain = run.catch(() => {});
    return run;
  }

  private createLocked(
    name: string,
    opts?: { branch?: string; base?: string },
  ): { name: string; path: string; branch: string } {
    assertPlainName(name);
    const path = join(this.worktreesDir, name);

    // Ensure the parent exists; `git worktree add` creates the leaf dir but not parents.
    mkdirSync(this.worktreesDir, { recursive: true });

    let branch: string;
    if (opts?.branch) {
      branch = opts.branch;
      this.git(["worktree", "add", path, branch]);
    } else {
      branch = `charm/${name}`;
      const base = opts?.base ?? "HEAD";
      this.git(["worktree", "add", "-b", branch, path, base]);
    }

    return { name, path, branch };
  }

  /**
   * Enumerate every worktree under worktreesDir via `git worktree list --porcelain`.
   * The main checkout (root) is excluded. Worktrees outside worktreesDir are excluded.
   */
  list(): { name: string; path: string; branch: string | null; head: string }[] {
    let raw: string;
    try {
      raw = this.git(["worktree", "list", "--porcelain"]);
    } catch {
      return [];
    }
    const records: { name: string; path: string; branch: string | null; head: string }[] = [];
    for (const block of raw.trim().split(/\n\n+/)) {
      const lines = block.trim().split("\n");
      let wPath = "";
      let head = "";
      let branch: string | null = null;
      for (const line of lines) {
        if (line.startsWith("worktree ")) wPath = line.slice("worktree ".length);
        else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
        else if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length);
      }
      if (!wPath || wPath === this.root) continue;
      if (!wPath.startsWith(this.worktreesDir + "/")) continue;
      const entryName = wPath.slice(this.worktreesDir.length + 1).split("/")[0];
      if (!entryName) continue;
      records.push({ name: entryName, path: wPath, branch, head });
    }
    return records;
  }

  /**
   * Close a worktree: `git worktree remove --force` deregisters it from
   * .git/worktrees and deletes the working tree. Falls back to rmSync if git
   * refuses (e.g. the worktree was never registered — half-created orphan).
   * `deleteBranch` additionally drops the charm/<name> branch in the main repo.
   */
  remove(name: string, opts?: { force?: boolean; deleteBranch?: boolean }): void {
    assertPlainName(name);
    const path = join(this.worktreesDir, name);
    const r = spawnSync("git", ["worktree", "remove", "--force", path], { cwd: this.root, encoding: "utf8" });
    if (r.status !== 0) {
      // Fallback: worktree dir exists but wasn't registered (half-created orphan).
      rmSync(path, { recursive: true, force: true });
    }
    if (opts?.deleteBranch) {
      spawnSync("git", ["branch", "-D", `charm/${name}`], { cwd: this.root, encoding: "utf8" });
    }
  }

  /**
   * Reap orphans: `git worktree prune` removes stale metadata from .git/worktrees/
   * for any worktree whose directory no longer exists. Intact worktrees are left alone.
   */
  prune(): void {
    spawnSync("git", ["worktree", "prune"], { cwd: this.root, encoding: "utf8" });
  }

  /**
   * Provision a freshly-created worktree (deps, etc.) so an agent can run in it.
   * TODO(phase-later): Bun-only frozen install (`bun install --frozen-lockfile`)
   * lands in a later phase. Intentionally a no-op for now.
   */
  async provision(path: string): Promise<void> {
    void path;
  }
}
