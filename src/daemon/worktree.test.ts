import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { WorktreeManager } from "./worktree.ts";

/**
 * Exercises WorktreeManager against a real throwaway git repo. The whole point
 * of this module is correct git plumbing, so we don't mock git — we init a repo
 * under os.tmpdir(), drive the manager, and assert against real git state. A
 * worktree here is a real linked `git worktree`: its .git is a pointer file back
 * to the main repo's object store, not a separate clone with its own `origin`.
 */

// Canonicalize through realpathSync: on macOS tmpdir() is `/var/...`, a symlink
// to `/private/var/...`; keeping the manager's root and our assertions on the
// resolved form avoids spurious path mismatches.
const ROOT = realpathSync(tmpdir());
const REPO = join(ROOT, `charm-wt-test-${process.pid}`);
const WORKTREES = join(REPO, ".charm", "worktrees");

function git(args: string[], cwd: string = REPO): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout ?? "";
}

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(REPO, { recursive: true });
  git(["init", "-b", "main"]);
  // Identity + a commit so HEAD exists (you can't clone an unborn branch usefully).
  git(["config", "user.email", "test@charm.local"]);
  git(["config", "user.name", "charm test"]);
  writeFileSync(join(REPO, "README.md"), "hello\n");
  // Keep the test hermetic: park the worktrees under an ignored dir inside the
  // throwaway repo so they never show up as untracked changes in the main
  // checkout (the real layout puts them outside the repo, at ~/.charm-worktrees/).
  writeFileSync(join(REPO, ".gitignore"), ".charm/worktrees/\n");
  git(["add", "README.md", ".gitignore"]);
  git(["commit", "-m", "init"]);
});

afterAll(() => rmSync(REPO, { recursive: true, force: true }));

test("create makes a linked worktree on a fresh charm/<name> branch", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  const r = await wt.create("alpha");
  expect(r.name).toBe("alpha");
  expect(r.branch).toBe("charm/alpha");
  expect(r.path).toBe(join(WORKTREES, "alpha"));
  expect(existsSync(r.path)).toBe(true);
  // It is a LINKED worktree: its .git is a pointer FILE (not a dir), on the cut
  // branch, and its common git dir resolves back to the main repo's .git (shared
  // object store — no separate clone, no `origin`).
  expect(lstatSync(join(r.path, ".git")).isFile()).toBe(true);
  expect(git(["rev-parse", "--abbrev-ref", "HEAD"], r.path).trim()).toBe("charm/alpha");
  const commonDir = git(["rev-parse", "--git-common-dir"], r.path).trim();
  const resolvedCommon = realpathSync(isAbsolute(commonDir) ? commonDir : join(r.path, commonDir));
  expect(resolvedCommon).toBe(realpathSync(join(REPO, ".git")));
  // The committed content is checked out from the shared object store.
  expect(readFileSync(join(r.path, "README.md"), "utf8")).toBe("hello\n");
});

test("list includes the worktree with its branch; main root is not listed", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  const entries = wt.list();
  expect(entries.some((e) => e.path === REPO)).toBe(false);
  const alpha = entries.find((e) => e.path === join(WORKTREES, "alpha"));
  expect(alpha).toBeDefined();
  expect(alpha!.branch).toBe("charm/alpha");
  expect(alpha!.head.length).toBeGreaterThan(0);
});

test("edits in a worktree never touch the main checkout", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  const r = await wt.create("isolated");
  // Commit a new file inside the worktree on its own branch.
  writeFileSync(join(r.path, "only-in-copy.txt"), "secret\n");
  git(["add", "only-in-copy.txt"], r.path);
  git(["commit", "-m", "worktree-only change"], r.path);
  // Main is untouched: no file, still on main, HEAD unchanged from the worktree's parent.
  expect(existsSync(join(REPO, "only-in-copy.txt"))).toBe(false);
  expect(git(["rev-parse", "--abbrev-ref", "HEAD"], REPO).trim()).toBe("main");
  expect(git(["status", "--porcelain"], REPO).trim()).toBe("");
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

test("prune reaps a worktree whose dir vanished but keeps a valid one", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  const good = await wt.create("gamma");
  const gone = await wt.create("vanished");
  // Simulate a crashed session: the working tree dir disappears, leaving a stale
  // admin entry in .git/worktrees/. `git worktree prune` reaps that entry.
  rmSync(gone.path, { recursive: true, force: true });
  expect(git(["worktree", "list", "--porcelain"]).includes(gone.path)).toBe(true);
  wt.prune();
  expect(git(["worktree", "list", "--porcelain"]).includes(gone.path)).toBe(false);
  // The valid worktree is left intact (worktreesDir is shared across sessions).
  expect(existsSync(good.path)).toBe(true);
  expect(wt.list().some((e) => e.path === good.path)).toBe(true);
});

test("create symlinks gitignored .env files into the worktree", async () => {
  // A root env file and a nested one, both gitignored (so worktree add won't
  // bring them across on its own).
  writeFileSync(join(REPO, ".env"), "ROOT_SECRET=1\n");
  mkdirSync(join(REPO, "pkg"), { recursive: true });
  writeFileSync(join(REPO, "pkg", ".env.local"), "PKG_SECRET=2\n");
  // `.env` and `.env.*` (no leading slash) match those basenames at any depth.
  writeFileSync(join(REPO, ".gitignore"), ".charm/worktrees/\n.env\n.env.*\n");
  git(["add", ".gitignore"]);
  git(["commit", "-m", "ignore env"]);

  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  const r = await wt.create("envy");

  const rootLink = join(r.path, ".env");
  expect(lstatSync(rootLink).isSymbolicLink()).toBe(true);
  expect(readFileSync(rootLink, "utf8")).toBe("ROOT_SECRET=1\n"); // resolves to the main tree

  const nestedLink = join(r.path, "pkg", ".env.local");
  expect(lstatSync(nestedLink).isSymbolicLink()).toBe(true);
  expect(readFileSync(nestedLink, "utf8")).toBe("PKG_SECRET=2\n");
});
