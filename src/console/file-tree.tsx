// Files-tab tree component for the charm console.
//
// This module owns ONLY the keyboard-driven directory tree and the helpers the
// integration ticket (app.tsx wiring) consumes. The public surface is exactly
// three symbols — `TreeNode`, `isBinaryFile`, `FileTree` — and is the stable
// contract the Files tab depends on; keep it that way.
//
// The PARENT owns the bordered Box, the panel header, and the panel height.
// `FileTree` renders only the indented tree rows. It never calls `onOpenFile`
// during render (that would trip React's "setState during render" warning) —
// the call fires from a `useEffect` keyed on the cursor's current node and from
// the `useInput` handler.
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  readdirSync,
  statSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { join, dirname, relative, sep, isAbsolute } from "node:path";
import chokidar from "chokidar";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type TreeNode = {
  path: string; // absolute
  name: string; // basename (display)
  isDir: boolean;
  expanded?: boolean;
  children?: TreeNode[];
  depth: number;
};

// Null-byte / UTF-8 sniff of the first ~4KB. Used by both the tree (dim rows)
// and the viewer (placeholder). Returns a sane default (false) for missing or
// unreadable files rather than throwing during a render pass.
const SNIFF_BYTES = 4096;

export function isBinaryFile(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(SNIFF_BYTES);
    const n = readSync(fd, buf, 0, SNIFF_BYTES, 0);
    let slice: Uint8Array = buf.subarray(0, n);
    // A null byte is the definitive binary signal.
    if (slice.includes(0)) return true;
    // For a truncated read of a larger file, the tail may split a multibyte
    // UTF-8 sequence; trim that partial tail so a valid text file isn't flagged.
    if (n === SNIFF_BYTES) slice = trimPartialUtf8(slice);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(slice);
    } catch {
      return true; // not valid UTF-8 -> treat as binary
    }
    return false;
  } catch {
    return false; // missing/unreadable -> let the open attempt surface it
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// Drop a trailing, incomplete UTF-8 multibyte sequence from a truncated buffer.
function trimPartialUtf8(buf: Uint8Array): Uint8Array {
  let i = buf.length - 1;
  let cont = 0;
  while (i >= 0 && (buf[i]! & 0xc0) === 0x80) {
    cont++;
    i--;
  }
  if (i < 0) return buf;
  const lead = buf[i]!;
  let need: number;
  if ((lead & 0x80) === 0) need = 1;
  else if ((lead & 0xe0) === 0xc0) need = 2;
  else if ((lead & 0xf0) === 0xe0) need = 3;
  else if ((lead & 0xf8) === 0xf0) need = 4;
  else return buf; // invalid lead — let the decoder catch it
  if (cont + 1 < need) return buf.subarray(0, i); // incomplete -> drop it
  return buf;
}

// ---------------------------------------------------------------------------
// Path / tree helpers (module-scope, pure)
// ---------------------------------------------------------------------------

function depthOf(root: string, p: string): number {
  if (p === root) return -1;
  const rel = relative(root, p);
  if (!rel || rel.startsWith("..")) return -1;
  return rel.split(sep).length - 1;
}

function isUnder(parent: string, p: string): boolean {
  if (p === parent) return false;
  const rel = relative(parent, p);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

function isDirPath(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Read a directory's direct children into TreeNodes, applying the gitignore
// filter. `gitAllowed` is the set of allowed absolute paths (files plus their
// ancestor dirs); `null` means git was unavailable, so fall back to excluding
// only `.git`/`node_modules`. Unreadable dirs yield an empty list (caught).
function readDir(
  root: string,
  dir: string,
  gitAllowed: Set<string> | null,
): TreeNode[] {
  let ents: Dirent[];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const depth = depthOf(root, dir) + 1;
  const out: TreeNode[] = [];
  for (const e of ents) {
    if (e.name === ".git") continue; // always excluded
    const p = join(dir, e.name);
    // Dirent.isDirectory() is false for a symlink-to-dir, so symlinks fall
    // through as leaves — we never recurse into them (cycle-safe).
    const isDir = e.isDirectory();
    if (gitAllowed) {
      if (!gitAllowed.has(p)) continue;
    } else if (e.name === "node_modules") {
      continue;
    }
    out.push({ path: p, name: e.name, isDir, depth });
  }
  // Dirs first, then files, each alphabetical.
  out.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );
  return out;
}

// Flatten the cached tree into visible rows, descending only into expanded dirs.
function flatten(
  root: string,
  cache: Map<string, TreeNode[]>,
  expanded: Set<string>,
): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (dir: string) => {
    const kids = cache.get(dir);
    if (!kids) return;
    for (const n of kids) {
      out.push(n);
      if (n.isDir && expanded.has(n.path)) walk(n.path);
    }
  };
  walk(root); // top-level children are always shown
  return out;
}

// One-shot gitignore snapshot: `git ls-files --cached --others
// --exclude-standard` from the repo toplevel, normalized against `root` so the
// allowed-set membership test is correct even when `root` is a subdir of the
// repo. Returns the set of allowed absolute paths (each listed file plus every
// ancestor dir up to `root`), or `null` if git is unavailable / `root` is not a
// repo (caller then uses the hard-coded fallback).
async function loadGitAllowed(root: string): Promise<Set<string> | null> {
  const top = (await runGit(root, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top) return null;
  const listing = await runGit(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (listing == null) return null;
  const allowed = new Set<string>();
  for (const line of listing.split("\n")) {
    if (!line) continue;
    const abs = join(top, line);
    // Only paths under `root` matter; skip siblings of a subdir root.
    if (abs !== root && !isUnder(root, abs)) continue;
    allowed.add(abs);
    // Add every ancestor dir up to (and including) root so dirs containing an
    // allowed file render.
    let cur = dirname(abs);
    while (cur === root || isUnder(root, cur)) {
      allowed.add(cur);
      if (cur === root) break;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return allowed;
}

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    return out;
  } catch {
    return null;
  }
}

function defaultExpanded(root: string): Set<string> {
  const s = new Set<string>();
  const charm = join(root, ".charm");
  if (!isDirPath(charm)) return s;
  s.add(charm);
  for (const d of ["tickets", "proposals", "kb", "prompts", "scratchpad"]) {
    const p = join(charm, d);
    if (isDirPath(p)) s.add(p);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FileTree(props: {
  root: string;
  height: number;
  isActive: boolean;
  onOpenFile: (path: string | null) => void;
}): JSX.Element {
  const { root, height, isActive, onOpenFile } = props;

  // gitAllowed: undefined = loading, null = fallback (git unavailable), Set = ok.
  const [gitAllowed, setGitAllowed] = useState<Set<string> | null | undefined>(
    undefined,
  );
  const [gitTick, setGitTick] = useState(0);
  // Expansion is the only reactive tree state (drives the watcher scope). The
  // children cache and change-badges live in refs + a version bump so reads,
  // re-reads, and watcher events don't force a watcher re-subscribe.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const cacheRef = useRef<Map<string, TreeNode[]>>(new Map());
  const badgesRef = useRef<Set<string>>(new Set());
  const binCacheRef = useRef<Map<string, boolean>>(new Map());
  const expandedRef = useRef<Set<string>>(expanded);
  const didInit = useRef(false);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  // Load (or reload, on `r`) the gitignore snapshot.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const a = await loadGitAllowed(root);
      if (!cancelled) setGitAllowed(a);
    })();
    return () => {
      cancelled = true;
    };
  }, [root, gitTick]);

  // Rebuild the children cache whenever the gitignore set (re)loads or `r` is
  // pressed. On the first run, also apply the default-expanded set.
  useEffect(() => {
    if (gitAllowed === undefined) return;
    let exp = expandedRef.current;
    if (!didInit.current) {
      didInit.current = true;
      exp = defaultExpanded(root);
      // Drop gitignored .charm subdirs: defaultExpanded only checks the
      // filesystem, but readDir filters gitignored dirs out of their parent's
      // child list — keeping them expanded would watch dirs that never render.
      if (gitAllowed !== null) {
        exp = new Set([...exp].filter((p) => gitAllowed.has(p)));
      }
      expandedRef.current = exp;
      setExpanded(exp);
    }
    const cache = new Map<string, TreeNode[]>();
    cache.set(root, readDir(root, root, gitAllowed));
    for (const d of exp) cache.set(d, readDir(root, d, gitAllowed));
    cacheRef.current = cache;
    bump();
  }, [gitAllowed, gitTick, root]);

  // Live updates: watch `.charm/` plus the currently-expanded dirs (NOT the
  // whole root). Re-subscribes when the expanded set or git filter changes;
  // closes every watcher on unmount / re-subscribe so they don't leak.
  useEffect(() => {
    const watchPaths = [join(root, ".charm"), ...expanded].filter((p) =>
      existsSync(p),
    );
    if (watchPaths.length === 0) return;
    const allowed = gitAllowed ?? null;
    const exp = expanded;
    const isExpandedDir = (d: string) => d === root || exp.has(d);

    const handleChange = (p: string) => {
      // Climb from the changed path to the child of the nearest expanded dir.
      let cur = p;
      let parent = dirname(cur);
      while (!isExpandedDir(parent)) {
        if (parent === cur) return; // walked above root — ignore
        cur = parent;
        parent = dirname(cur);
      }
      if (cur === p) {
        // Direct child of an expanded dir changed -> re-read that dir so the
        // change (new/removed/edited entry) is reflected.
        cacheRef.current.set(parent, readDir(root, parent, allowed));
        binCacheRef.current.delete(p);
        bump();
      } else {
        // Deep change inside a collapsed subdir -> badge it until it's opened.
        badgesRef.current.add(cur);
        bump();
      }
    };

    const watcher = chokidar.watch(watchPaths, { ignoreInitial: true });
    watcher.on("all", (_evt, p) => {
      if (typeof p === "string") handleChange(p);
    });
    return () => {
      void watcher.close();
    };
  }, [expanded, gitAllowed, root]);

  const rows = flatten(root, cacheRef.current, expanded);

  // Clamp the cursor into range after refresh/collapse/live-update shrinks.
  useEffect(() => {
    setCursor((c) => Math.min(Math.max(0, c), Math.max(0, rows.length - 1)));
  }, [rows.length]);

  // Open the file (or signal a directory) the cursor lands on. Fired from an
  // effect — never during render. `onOpenFile` is intentionally omitted from
  // deps so a new parent-supplied identity doesn't refire it.
  const cursorNode = rows[cursor];
  useEffect(() => {
    if (!cursorNode) onOpenFile(null);
    else onOpenFile(cursorNode.isDir ? null : cursorNode.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorNode?.path, cursorNode?.isDir]);

  const expandDir = (node: TreeNode) => {
    cacheRef.current.set(node.path, readDir(root, node.path, gitAllowed ?? null));
    badgesRef.current.delete(node.path);
    setExpanded((prev) => {
      const n = new Set(prev);
      n.add(node.path);
      return n;
    });
  };

  const collapseDir = (node: TreeNode) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      for (const e of prev) {
        if (e === node.path || isUnder(node.path, e)) n.delete(e);
      }
      return n;
    });
    // Drop children (node + descendants) from the cache.
    for (const k of [...cacheRef.current.keys()]) {
      if (k === node.path || isUnder(node.path, k)) cacheRef.current.delete(k);
    }
    bump();
  };

  // Cursor of the parent row (first earlier row at a shallower depth).
  const parentIndex = (idx: number): number => {
    const node = rows[idx];
    if (!node) return idx;
    for (let i = idx - 1; i >= 0; i--) {
      const r = rows[i];
      if (r && r.depth < node.depth) return i;
    }
    return idx;
  };

  // Next/previous FILE row in `dir` (+1 / -1); stay put if none.
  const fileInDirection = (from: number, dir: 1 | -1): number => {
    for (let i = from + dir; i >= 0 && i < rows.length; i += dir) {
      const r = rows[i];
      if (r && !r.isDir) return i;
    }
    return from;
  };

  useInput(
    (input, key) => {
      if (key.downArrow && key.shift) {
        setCursor((c) => fileInDirection(c, 1));
      } else if (key.upArrow && key.shift) {
        setCursor((c) => fileInDirection(c, -1));
      } else if (key.downArrow || input === "j") {
        setCursor((c) => Math.min(rows.length - 1, c + 1));
      } else if (key.upArrow || input === "k") {
        setCursor((c) => Math.max(0, c - 1));
      } else if (key.return || key.rightArrow) {
        const node = rows[cursor];
        if (!node) return;
        if (node.isDir) {
          if (!expanded.has(node.path)) expandDir(node);
        } else {
          onOpenFile(node.path);
        }
      } else if (key.leftArrow || input === "h") {
        const node = rows[cursor];
        if (!node) return;
        if (node.isDir && expanded.has(node.path)) collapseDir(node);
        else setCursor(parentIndex(cursor));
      } else if (input === "r") {
        binCacheRef.current.clear();
        badgesRef.current = new Set();
        setGitTick((t) => t + 1);
      } else if (input === "g") {
        setCursor(0);
      } else if (input === "G") {
        setCursor(Math.max(0, rows.length - 1));
      }
    },
    { isActive },
  );

  const isBin = (p: string): boolean => {
    const c = binCacheRef.current;
    const hit = c.get(p);
    if (hit !== undefined) return hit;
    const v = isBinaryFile(p);
    c.set(p, v);
    return v;
  };

  // Window the visible rows around the cursor within `height` capacity.
  const capacity = Math.max(1, height);
  const top =
    rows.length <= capacity
      ? 0
      : Math.max(
          0,
          Math.min(cursor - Math.floor(capacity / 2), rows.length - capacity),
        );
  const slice = rows.slice(top, top + capacity);

  if (rows.length === 0) {
    return <Text dimColor wrap="truncate-end">(empty)</Text>;
  }

  return (
    <>
      {slice.map((node, i) => {
        const idx = top + i;
        const isCursor = idx === cursor;
        const indent = "  ".repeat(Math.max(0, node.depth));
        const marker = node.isDir
          ? expanded.has(node.path)
            ? "v "
            : "> "
          : "  ";
        const badge = badgesRef.current.has(node.path) ? " (!)" : "";
        const label = `${indent}${marker}${node.name}${node.isDir ? "/" : ""}${badge}`;
        const dim = !isCursor && !node.isDir && isBin(node.path);
        return (
          <Text
            key={node.path}
            color={isCursor ? "cyan" : undefined}
            bold={isCursor}
            dimColor={dim}
            wrap="truncate-end"
          >
            {label}
          </Text>
        );
      })}
    </>
  );
}
