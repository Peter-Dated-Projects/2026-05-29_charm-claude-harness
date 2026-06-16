import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { assertPlainName } from "../paths.ts";

/**
 * A git worktree is an ORCHESTRATOR-MANAGED SIDE RESOURCE: a parallel line of
 * work on its own branch, checked out under .charm/worktrees/<name>/. This is
 * purely additive to the default shared-tree model — charm does NOT do
 * merge-back; an agent in a worktree just uses normal git on its branch. The
 * orchestrator opens worktrees via MCP tools and is responsible for closing
 * them by session end; this class owns the git plumbing plus a prune safety-net
 * for orphans left by a crashed daemon.
 *
 * This is the ONE place that shells out to git for worktrees. All git runs with
 * an absolute cwd = root (the main worktree); a non-zero exit throws with the
 * git stderr so failures surface loudly rather than silently no-op.
 */
export class WorktreeManager {
  private readonly root: string;
  private readonly worktreesDir: string;

  // Serializes create() (see create's doc). Each create awaits the current tail
  // and replaces it with its own settled promise, so concurrent calls run
  // strictly one-after-another rather than racing `git worktree add`.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: { root: string; worktreesDir: string }) {
    this.root = opts.root;
    this.worktreesDir = opts.worktreesDir;
  }

  /** Run git in the main worktree (cwd = root). Throws with stderr on non-zero. */
  private git(args: string[]): string {
    const r = spawnSync("git", args, { cwd: this.root, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
    }
    return r.stdout ?? "";
  }

  /**
   * Open a worktree under worktreesDir.
   *
   * Two modes:
   *  - opts.branch given (the Graphite-stack case): check out that EXISTING
   *    branch into the new worktree.
   *  - otherwise: cut a fresh `charm/<name>` branch off opts.base (default HEAD).
   *
   * The name is guarded with assertPlainName (it arrives from an LLM agent via
   * MCP) and a collision — an existing path OR an already-registered worktree —
   * fails loud rather than reusing a dir that may hold another line of work.
   *
   * SERIALIZED: every create runs inside the promise-chain mutex. Concurrent
   * `git worktree add` on the same branch silently clobbers commits — a real
   * data-loss race — so the whole create (collision check through `worktree
   * add`) must be a single critical section, never two interleaving calls.
   */
  async create(
    name: string,
    opts?: { branch?: string; base?: string },
  ): Promise<{ name: string; path: string; branch: string }> {
    // Chain the entire create so two concurrent calls can't interleave their
    // collision check and `worktree add`. We capture the prior tail, await it,
    // and publish our own settled promise as the new tail before returning.
    const run = this.chain.then(() => this.createLocked(name, opts));
    // Swallow rejection on the shared tail so one failed create doesn't poison
    // every subsequent create; the awaited `run` below still sees the real error.
    this.chain = run.catch(() => {});
    return run;
  }

  private createLocked(
    name: string,
    opts?: { branch?: string; base?: string },
  ): { name: string; path: string; branch: string } {
    assertPlainName(name);
    const path = join(this.worktreesDir, name);

    if (existsSync(path)) {
      throw new Error(`worktree path already exists: ${path}`);
    }
    if (this.list().some((w) => w.path === path)) {
      throw new Error(`worktree already registered: ${path}`);
    }

    // Ensure the parent exists; `git worktree add` won't create intermediate dirs.
    mkdirSync(this.worktreesDir, { recursive: true });

    let branch: string;
    if (opts?.branch) {
      // Graphite-stack case: attach an existing branch to the new worktree.
      branch = opts.branch;
      this.git(["worktree", "add", path, branch]);
    } else {
      // Fresh-branch case: -b cuts a new charm/<name> off base (default HEAD).
      branch = `charm/${name}`;
      const args = ["worktree", "add", "-b", branch, path];
      if (opts?.base) args.push(opts.base);
      this.git(args);
    }

    return { name, path, branch };
  }

  /**
   * Enumerate every worktree from `git worktree list --porcelain`. Records are
   * blank-line separated; each line is `<key> [value]` (a bare `branch` line is
   * absent for a detached HEAD, hence branch is nullable). The first record is
   * the main worktree (the repo root). `head` is the commit oid; `detached`,
   * `locked`, `prunable` are presence-flag keys in the porcelain output.
   */
  list(): {
    path: string;
    branch: string | null;
    head: string;
    detached: boolean;
    locked: boolean;
    prunable: boolean;
  }[] {
    const out = this.git(["worktree", "list", "--porcelain"]);
    const records: {
      path: string;
      branch: string | null;
      head: string;
      detached: boolean;
      locked: boolean;
      prunable: boolean;
    }[] = [];

    let cur: (typeof records)[number] | null = null;
    const flush = () => {
      if (cur) records.push(cur);
      cur = null;
    };

    for (const line of out.split("\n")) {
      if (line === "") {
        // Blank line terminates a record.
        flush();
        continue;
      }
      // Key is the first token; the remainder (if any) is the value.
      const sp = line.indexOf(" ");
      const key = sp === -1 ? line : line.slice(0, sp);
      const value = sp === -1 ? "" : line.slice(sp + 1);
      switch (key) {
        case "worktree":
          // A `worktree` line starts a fresh record.
          flush();
          cur = { path: value, branch: null, head: "", detached: false, locked: false, prunable: false };
          break;
        case "HEAD":
          if (cur) cur.head = value;
          break;
        case "branch":
          if (cur) cur.branch = value;
          break;
        case "detached":
          if (cur) cur.detached = true;
          break;
        case "locked":
          if (cur) cur.locked = true;
          break;
        case "prunable":
          if (cur) cur.prunable = true;
          break;
      }
    }
    flush();
    return records;
  }

  /**
   * Remove a worktree. `--force` is needed when the worktree has a dirty or
   * locked tree. Removing a worktree does NOT delete its branch, so deleteBranch
   * additionally runs `git branch -D charm/<name>` — best-effort, since the
   * branch may have been renamed/merged away and a failed delete shouldn't mask
   * a successful worktree removal.
   */
  remove(name: string, opts?: { force?: boolean; deleteBranch?: boolean }): void {
    assertPlainName(name);
    const path = join(this.worktreesDir, name);
    const args = ["worktree", "remove"];
    if (opts?.force) args.push("--force");
    args.push(path);
    this.git(args);

    if (opts?.deleteBranch) {
      // Best-effort: a missing/checked-out branch here is not fatal.
      spawnSync("git", ["branch", "-D", `charm/${name}`], { cwd: this.root, encoding: "utf8" });
    }
  }

  /**
   * Reconcile git's worktree registry with what's actually on disk. `git
   * worktree prune` drops registry entries whose dirs vanished; we then delete
   * any stray child dir of worktreesDir that git does NOT list — orphans left
   * when a daemon crashed mid-create or was killed before remove(). The
   * registered set is keyed by absolute path, matching list()'s `path`.
   */
  prune(): void {
    this.git(["worktree", "prune"]);

    if (!existsSync(this.worktreesDir)) return;
    const registered = new Set(this.list().map((w) => w.path));
    for (const entry of readdirSync(this.worktreesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(this.worktreesDir, entry.name);
      if (!registered.has(full)) {
        // Orphan dir git no longer tracks — safe to delete.
        rmSync(full, { recursive: true, force: true });
      }
    }
  }

  /**
   * Provision a freshly-created worktree (deps, etc.) so an agent can run in it.
   * TODO(phase-later): Bun-only frozen install (`bun install --frozen-lockfile`)
   * lands in a later phase. Intentionally a no-op for now — do not implement
   * installs here yet.
   */
  async provision(path: string): Promise<void> {
    // No-op stub; see TODO above.
    void path;
  }
}
