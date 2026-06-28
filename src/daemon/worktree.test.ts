import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorktreeManager } from "./worktree.ts";

/**
 * Exercises WorktreeManager against a real throwaway git repo. The whole point
 * of this module is correct git plumbing, so we don't mock git — we init a repo
 * under os.tmpdir(), drive the manager, and assert against real git state. A
 * worktree here is a STANDALONE COPY (its own .git), not a linked git worktree.
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
  // Mirror the real repo: worktree copies live under an ignored dir so they
  // never show up as untracked changes in the main checkout.
  writeFileSync(join(REPO, ".gitignore"), ".charm/worktrees/\n");
  git(["add", "README.md", ".gitignore"]);
  git(["commit", "-m", "init"]);
});

afterAll(() => rmSync(REPO, { recursive: true, force: true }));

test("create makes a standalone copy on a fresh charm/<name> branch", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  const r = await wt.create("alpha");
  expect(r.name).toBe("alpha");
  expect(r.branch).toBe("charm/alpha");
  expect(r.path).toBe(join(WORKTREES, "alpha"));
  expect(existsSync(r.path)).toBe(true);
  // It is its OWN repo: a .git of its own, on the cut branch, with origin -> main.
  expect(existsSync(join(r.path, ".git"))).toBe(true);
  expect(git(["rev-parse", "--abbrev-ref", "HEAD"], r.path).trim()).toBe("charm/alpha");
  expect(realpathSync(git(["remote", "get-url", "origin"], r.path).trim())).toBe(realpathSync(REPO));
  // The committed content came across as a real copy.
  expect(readFileSync(join(r.path, "README.md"), "utf8")).toBe("hello\n");
});

test("list includes the copy with its branch; main root is not listed", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  const entries = wt.list();
  expect(entries.some((e) => e.path === REPO)).toBe(false);
  const alpha = entries.find((e) => e.path === join(WORKTREES, "alpha"));
  expect(alpha).toBeDefined();
  expect(alpha!.branch).toBe("charm/alpha");
  expect(alpha!.head.length).toBeGreaterThan(0);
});

test("edits in a copy never touch the main checkout", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  const r = await wt.create("isolated");
  // Commit a new file inside the copy on its own branch.
  writeFileSync(join(r.path, "only-in-copy.txt"), "secret\n");
  git(["add", "only-in-copy.txt"], r.path);
  git(["commit", "-m", "copy-only change"], r.path);
  // Main is untouched: no file, still on main, HEAD unchanged from the copy's parent.
  expect(existsSync(join(REPO, "only-in-copy.txt"))).toBe(false);
  expect(git(["rev-parse", "--abbrev-ref", "HEAD"], REPO).trim()).toBe("main");
  expect(git(["status", "--porcelain"], REPO).trim()).toBe("");
});

test("collision (same name twice) throws", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  await expect(wt.create("alpha")).rejects.toThrow();
});

test("remove deletes the copy", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  await wt.create("beta");
  const path = join(WORKTREES, "beta");
  expect(existsSync(path)).toBe(true);
  wt.remove("beta", { deleteBranch: true });
  expect(existsSync(path)).toBe(false);
  expect(wt.list().some((e) => e.path === path)).toBe(false);
});

test("prune reaps a corrupt orphan but keeps a valid copy", async () => {
  const wt = new WorktreeManager({ root: REPO, worktreesDir: WORKTREES });
  const good = await wt.create("gamma");
  // A half-created orphan: a dir with no .git, as a crashed mid-clone would leave.
  const orphan = join(WORKTREES, "orphan");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "stray.txt"), "junk\n");
  wt.prune();
  expect(existsSync(orphan)).toBe(false);
  // The valid copy is left intact (worktreesDir is shared across sessions).
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
