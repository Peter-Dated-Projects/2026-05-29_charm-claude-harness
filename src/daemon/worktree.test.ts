import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorktreeManager } from "./worktree.ts";

/**
 * Exercises WorktreeManager against a real throwaway git repo. The whole point
 * of this module is correct git plumbing, so we don't mock git — we init a repo
 * under os.tmpdir(), drive the manager, and assert against `git worktree list`'s
 * actual behavior.
 */

// Canonicalize through realpathSync: on macOS tmpdir() is `/var/...`, a symlink
// to `/private/var/...`, and git reports the canonical path in `worktree list` —
// so the manager's cwd and git's output must agree on the resolved form.
const ROOT = realpathSync(tmpdir());
const REPO = join(ROOT, `charm-wt-test-${process.pid}`);
const WORKTREES = join(REPO, ".charm", "worktrees");

function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(REPO, { recursive: true });
  git(["init", "-b", "main"]);
  // Identity + a commit so HEAD exists (you can't add a worktree off an unborn branch).
  git(["config", "user.email", "test@charm.local"]);
  git(["config", "user.name", "charm test"]);
  writeFileSync(join(REPO, "README.md"), "hello\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "init"]);
});

afterAll(() => rmSync(REPO, { recursive: true, force: true }));

test("create cuts a fresh charm/<name> branch and the path exists", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  const r = await wt.create("alpha");
  expect(r.name).toBe("alpha");
  expect(r.branch).toBe("charm/alpha");
  expect(r.path).toBe(join(WORKTREES, "alpha"));
  expect(existsSync(r.path)).toBe(true);
});

test("list includes the worktree with the right branch", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  const entries = wt.list();
  // First record is the main worktree (repo root).
  expect(entries[0]!.path).toBe(REPO);
  const alpha = entries.find((e) => e.path === join(WORKTREES, "alpha"));
  expect(alpha).toBeDefined();
  // Porcelain reports the branch as a full ref.
  expect(alpha!.branch).toBe("refs/heads/charm/alpha");
  expect(alpha!.detached).toBe(false);
});

test("collision (same name twice) throws", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  await expect(wt.create("alpha")).rejects.toThrow();
});

test("remove deletes the worktree", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  await wt.create("beta");
  const path = join(WORKTREES, "beta");
  expect(existsSync(path)).toBe(true);
  wt.remove("beta", { deleteBranch: true });
  expect(existsSync(path)).toBe(false);
  expect(wt.list().some((e) => e.path === path)).toBe(false);
});

test("prune cleans up an orphan dir left by a crashed daemon", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  await wt.create("gamma");
  const path = join(WORKTREES, "gamma");
  // Simulate a crash: the worktree dir vanishes but git's registry still lists it
  // as prunable, and a stray dir would otherwise linger.
  rmSync(path, { recursive: true, force: true });
  wt.prune();
  expect(existsSync(path)).toBe(false);
  expect(wt.list().some((e) => e.path === path)).toBe(false);
});
