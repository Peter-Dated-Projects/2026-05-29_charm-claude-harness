import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { assertPlainName } from "../paths.ts";

/**
 * A charm worktree is an ORCHESTRATOR-MANAGED SIDE RESOURCE: a parallel line of
 * work that is a COMPLETELY SEPARATE COPY of the repo, checked out under
 * .charm/worktrees/<name>/. It is NOT a linked `git worktree` — it is a full
 * standalone clone with its OWN .git (its own object store, index, and HEAD).
 * That isolation is the point: an agent working in a copy can edit anything,
 * including its own .charm (kb, proposals, scratchpad), and NONE of it touches
 * the main checkout. The copy shares the main repo's history at creation time and
 * wires main as its `origin`, so committed work can be merged back deliberately
 * and separately (e.g. `git fetch`/merge from main, or push the branch) — charm
 * itself does NO automatic merge-back.
 *
 * The orchestrator opens copies via MCP tools and is responsible for closing
 * them by session end; this class owns the git plumbing plus a prune safety-net
 * for half-created orphans left by a crashed daemon.
 *
 * This is the ONE place that shells out to git for worktrees. The clone runs with
 * cwd = root (the main checkout); per-copy git commands run with cwd = the copy.
 * A non-zero exit throws with the git stderr so failures surface loudly rather
 * than silently no-op.
 */
export class WorktreeManager {
  private readonly root: string;
  private readonly worktreesDir: string;

  // Serializes create() (see create's doc). Each create awaits the current tail
  // and replaces it with its own settled promise, so concurrent calls run
  // strictly one-after-another rather than racing two clones into the same dir.
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
   * Open a worktree (standalone copy) under worktreesDir.
   *
   * Two modes:
   *  - opts.branch given (the Graphite-stack case): check out that EXISTING
   *    branch in the copy (it comes across as origin/<branch> in the clone, and
   *    `git checkout <branch>` materializes a local tracking branch from it).
   *  - otherwise: cut a fresh `charm/<name>` branch off opts.base (default the
   *    main checkout's current HEAD).
   *
   * The name is guarded with assertPlainName (it arrives from an LLM agent via
   * MCP) and a collision — an existing path — fails loud rather than reusing a
   * dir that may hold another line of work.
   *
   * The clone uses --no-hardlinks so the copy is genuinely independent: its
   * objects are copied, not hardlinked, so neither repo's gc can ever disturb the
   * other. This is what makes it a "completely separate copy". Only committed
   * content is copied — gitignored run state (db.sqlite, run/, tickets, etc.) and
   * uncommitted edits in main are deliberately NOT carried in, so a copy never
   * duplicates the live control plane.
   *
   * SERIALIZED: every create runs inside the promise-chain mutex so two
   * concurrent creates can't interleave their collision check and clone.
   */
  async create(
    name: string,
    opts?: { branch?: string; base?: string },
  ): Promise<{ name: string; path: string; branch: string }> {
    // Chain the entire create so two concurrent calls can't interleave their
    // collision check and clone. We capture the prior tail, await it, and
    // publish our own settled promise as the new tail before returning.
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

    // Ensure the parent exists; `git clone` creates the leaf dir but not its parents.
    mkdirSync(this.worktreesDir, { recursive: true });

    // Full, independent copy of the main repo. --no-hardlinks copies objects
    // rather than sharing inodes; origin is set to the main checkout, which is
    // what later enables a deliberate merge-back.
    this.git(["clone", "--no-hardlinks", this.root, path]);

    let branch: string;
    if (opts?.branch) {
      // Graphite-stack case: materialize the existing branch in the copy. It
      // arrives as origin/<branch>; `git checkout <branch>` creates the matching
      // local branch (or just switches to it if it's already the cloned HEAD).
      branch = opts.branch;
      this.git(["checkout", branch], path);
    } else {
      // Fresh-branch case: cut charm/<name> off base (default the cloned HEAD,
      // i.e. main's current HEAD). A `base` may be a sha or a branch name; the
      // bare name resolves first, and we retry against origin/<base> for a branch
      // that only exists as a remote-tracking ref in the fresh clone.
      branch = `charm/${name}`;
      if (opts?.base) {
        try {
          this.git(["checkout", "-b", branch, opts.base], path);
        } catch {
          this.git(["checkout", "-b", branch, `origin/${opts.base}`], path);
        }
      } else {
        this.git(["checkout", "-b", branch], path);
      }
    }

    return { name, path, branch };
  }

  /**
   * Enumerate every worktree copy under worktreesDir. Each is a standalone clone
   * (its own .git), so — unlike the old linked-worktree model — there is no git
   * registry to consult: we scan the dir and read each copy's branch + HEAD with
   * git run inside it. A child dir without a .git is skipped here (prune() reaps
   * it). The main checkout is NOT included, since it lives at root, not under
   * worktreesDir.
   */
  list(): { name: string; path: string; branch: string | null; head: string }[] {
    if (!existsSync(this.worktreesDir)) return [];
    const records: { name: string; path: string; branch: string | null; head: string }[] = [];
    for (const entry of readdirSync(this.worktreesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(this.worktreesDir, entry.name);
      if (!existsSync(join(full, ".git"))) continue;
      let branch: string | null = null;
      let head = "";
      try {
        branch = this.git(["rev-parse", "--abbrev-ref", "HEAD"], full).trim() || null;
      } catch { /* corrupt/half-created copy — leave branch null */ }
      try {
        head = this.git(["rev-parse", "HEAD"], full).trim();
      } catch { /* same */ }
      records.push({ name: entry.name, path: full, branch, head });
    }
    return records;
  }

  /**
   * Close a worktree copy: delete its directory. Because the copy is a standalone
   * repo, removing the dir removes its branch and any committed-but-unmerged work
   * with it — there is nothing else to clean up. `force` is accepted for call-site
   * compatibility but is a no-op (the rm always forces). `deleteBranch`
   * additionally tries to drop a `charm/<name>` branch in the MAIN repo —
   * best-effort, for the case where the work was merged/pushed back and the
   * leftover branch should go too.
   */
  remove(name: string, opts?: { force?: boolean; deleteBranch?: boolean }): void {
    assertPlainName(name);
    const path = join(this.worktreesDir, name);
    rmSync(path, { recursive: true, force: true });

    if (opts?.deleteBranch) {
      // Best-effort: the branch may not exist in main at all; that is not fatal.
      spawnSync("git", ["branch", "-D", `charm/${name}`], { cwd: this.root, encoding: "utf8" });
    }
  }

  /**
   * Reap orphan dirs left by a crashed daemon. An orphan is a child of
   * worktreesDir that is NOT a valid standalone copy — no .git, or a .git whose
   * HEAD won't resolve (a clone killed mid-create). Those are always safe to
   * delete. Complete copies are deliberately LEFT in place: worktreesDir is
   * per-directory, shared by every session running in this repo, so blindly
   * wiping intact copies could destroy a co-resident session's in-flight work.
   * The normal teardown path is close_worktree (remove()), not prune().
   */
  prune(): void {
    if (!existsSync(this.worktreesDir)) return;
    for (const entry of readdirSync(this.worktreesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(this.worktreesDir, entry.name);
      const valid =
        existsSync(join(full, ".git")) &&
        spawnSync("git", ["rev-parse", "--git-dir"], { cwd: full, encoding: "utf8" }).status === 0;
      if (!valid) {
        // Half-created / corrupt orphan git no longer needs — safe to delete.
        rmSync(full, { recursive: true, force: true });
      }
    }
  }

  /**
   * Provision a freshly-created copy (deps, etc.) so an agent can run in it.
   * TODO(phase-later): Bun-only frozen install (`bun install --frozen-lockfile`)
   * lands in a later phase. Intentionally a no-op for now — do not implement
   * installs here yet.
   */
  async provision(path: string): Promise<void> {
    // No-op stub; see TODO above.
    void path;
  }
}
