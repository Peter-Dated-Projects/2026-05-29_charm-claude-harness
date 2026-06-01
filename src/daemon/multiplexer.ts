import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { serializeLaunchForShell, serializeLaunchToPs1 } from "./spawn.ts";
import { buildLayoutString } from "./layout.ts";

/**
 * Terminal-multiplexer abstraction. charm drives a multiplexer to give every
 * agent its own visible, addressable pane. tmux is the canonical backend
 * (macOS/Linux); psmux (a tmux-compatible Windows multiplexer, `cargo install
 * psmux`) is the native-Windows backend. Both expose the same verbs — session/
 * pane create, pane-id capture, send-keys, kill, layout — so the daemon and CLI
 * talk to this interface and never to a specific binary.
 *
 * Backends differ in three ways, all hidden here:
 *   - How a pane runs a command: tmux execs argv under `sh -c`; psmux runs it
 *     under `pwsh -NoProfile -Command`. Callers always pass a LaunchSpec
 *     (argv + env + cwd); each backend serializes it for its own shell.
 *   - Layout: tmux applies a precise custom-layout string; psmux supports only
 *     named presets, so its relayout approximates with `main-vertical`.
 *   - The `:` command-prompt binding exists on tmux only; it's a no-op elsewhere.
 */

/** A platform-agnostic description of a process to run in a pane. The argv/env
 *  source of truth produced by buildClaudeLaunch (and assembled inline for the
 *  console/other panes); the backend serializes it for its shell. */
export type LaunchSpec = { argv: string[]; env: Record<string, string>; cwd: string };

export interface Multiplexer {
  readonly session: string;
  /** Create the detached session with one initial window rooted at cwd. */
  newSession(window: string, cwd: string): void;
  hasSession(): boolean;
  killSession(): void;
  /** Bind `:` (no prefix) to a command-prompt running cmdTemplate. No-op on
   *  backends without a command-prompt (psmux). */
  bindCommandPrompt(cmdTemplate: string): void;
  /** Run launch in the initial window's only pane; return its pane id. */
  spawnInWindow(window: string, launch: LaunchSpec): string;
  /** Split the active pane and run launch; return the new pane id. */
  splitPane(opts: { launch: LaunchSpec; direction?: "h" | "v"; target?: string; size?: string }): string;
  selectPane(target: string): void;
  killPane(paneId: string): void;
  /** Type a line into a pane and submit it (used to wake/continue agents). */
  sendText(paneId: string, text: string): void;
  /** Block until the user detaches. */
  attach(): void;
  /** True if the pane still exists. */
  paneAlive(paneId: string): boolean;
  /** Re-tile the window: console pane pinned as a column, agents filling the rest. */
  relayout(opts: { window: string; consolePaneId: string; agentPaneIds: string[] }): void;
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/** Resolve which multiplexer binary to drive. Real `tmux` wins when present
 *  (macOS/Linux). On Windows, psmux ships as `tmux`/`pmux`/`psmux`; we probe in
 *  that order so a psmux install is found whatever name it's invoked as.
 *  Returns the binary name, or null if none is available. */
export function resolveMultiplexerBin(): { bin: string; kind: "tmux" | "psmux" } | null {
  // On POSIX, only real tmux. On Windows, accept the psmux family.
  const candidates: { bin: string; kind: "tmux" | "psmux" }[] =
    process.platform === "win32"
      ? [{ bin: "psmux", kind: "psmux" }, { bin: "pmux", kind: "psmux" }, { bin: "tmux", kind: "psmux" }]
      : [{ bin: "tmux", kind: "tmux" }];
  for (const c of candidates) {
    const r = spawnSync(c.bin, ["-V"]);
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

export function multiplexerAvailable(): boolean {
  return resolveMultiplexerBin() !== null;
}

/** Construct the multiplexer backend for this platform. Defaults to tmux on
 *  POSIX and psmux on Windows; an explicit CHARM_MUX=tmux|psmux overrides. */
export function createMultiplexer(session: string): Multiplexer {
  const override = (process.env.CHARM_MUX ?? "").trim().toLowerCase();
  const resolved = resolveMultiplexerBin();
  const bin = resolved?.bin ?? (process.platform === "win32" ? "psmux" : "tmux");
  const kind = override === "tmux" || override === "psmux" ? override : (resolved?.kind ?? (process.platform === "win32" ? "psmux" : "tmux"));
  return kind === "psmux" ? new PsmuxBackend(session, bin) : new TmuxBackend(session, bin);
}

// ---------------------------------------------------------------------------
// tmux backend (macOS / Linux) — the original, battle-tested behavior.
// ---------------------------------------------------------------------------

class TmuxBackend implements Multiplexer {
  constructor(public readonly session: string, private readonly bin = "tmux") {}

  private run(args: string[], opts: { encoding?: "utf8" } = {}) {
    return spawnSync(this.bin, args, opts.encoding ? { encoding: "utf8" } : { stdio: "inherit" });
  }

  newSession(window: string, cwd: string): void {
    const r = spawnSync(this.bin, ["new-session", "-d", "-s", this.session, "-n", window, "-c", cwd], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tmux new-session failed (${r.status})`);
    // Keep dead panes visible so a crashing claude leaves its error on screen.
    spawnSync(this.bin, ["set-option", "-t", this.session, "remain-on-exit", "on"]);
    spawnSync(this.bin, ["set-option", "-t", this.session, "mouse", "on"]);
  }

  hasSession(): boolean {
    return spawnSync(this.bin, ["has-session", "-t", this.session]).status === 0;
  }

  killSession(): void {
    spawnSync(this.bin, ["kill-session", "-t", this.session]);
  }

  bindCommandPrompt(cmdTemplate: string): void {
    const inner = `run-shell '${cmdTemplate.replace(/'/g, `'\\''`)}'`;
    spawnSync(this.bin, ["bind-key", "-T", "root", ":", "command-prompt", "-p", ":", inner]);
  }

  splitPane(opts: { launch: LaunchSpec; direction?: "h" | "v"; target?: string; size?: string }): string {
    const args = ["split-window", opts.direction === "v" ? "-v" : "-h", "-P", "-F", "#{pane_id}", "-c", opts.launch.cwd];
    if (opts.target) args.push("-t", opts.target);
    if (opts.size) args.push("-l", opts.size);
    args.push("sh", "-c", serializeLaunchForShell(opts.launch));
    const r = spawnSync(this.bin, args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`tmux split-window failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  spawnInWindow(window: string, launch: LaunchSpec): string {
    const target = `${this.session}:${window}.0`;
    const r = spawnSync(
      this.bin,
      ["respawn-pane", "-k", "-t", target, "-c", launch.cwd, "sh", "-c", serializeLaunchForShell(launch)],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`tmux respawn-pane failed: ${r.stderr}`);
    const id = spawnSync(this.bin, ["display-message", "-p", "-t", target, "#{pane_id}"], { encoding: "utf8" });
    return id.stdout.trim();
  }

  selectPane(target: string): void {
    spawnSync(this.bin, ["select-pane", "-t", target]);
  }

  killPane(paneId: string): void {
    spawnSync(this.bin, ["kill-pane", "-t", paneId]);
  }

  sendText(paneId: string, text: string): void {
    // -l sends literally; send the text and the Enter as two calls so a trailing
    // "Enter" in the payload can't be read as a keypress.
    spawnSync(this.bin, ["send-keys", "-t", paneId, "-l", text]);
    spawnSync(this.bin, ["send-keys", "-t", paneId, "Enter"]);
  }

  attach(): void {
    spawnSync(this.bin, ["attach-session", "-t", this.session], { stdio: "inherit" });
  }

  paneAlive(paneId: string): boolean {
    const r = spawnSync(this.bin, ["display-message", "-p", "-t", paneId, "#{pane_index}"], { encoding: "utf8" });
    return r.status === 0 && Number.isFinite(Number(r.stdout.trim()));
  }

  private windowSize(window: string): { w: number; h: number } {
    const r = spawnSync(this.bin, ["display-message", "-p", "-t", `${this.session}:${window}`, "#{window_width}x#{window_height}"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`tmux display-message failed: ${r.stderr}`);
    const m = r.stdout.trim().match(/^(\d+)x(\d+)$/);
    if (!m) throw new Error(`bad window size: ${r.stdout}`);
    return { w: Number(m[1]), h: Number(m[2]) };
  }

  private paneIndex(paneId: string): number | null {
    const r = spawnSync(this.bin, ["display-message", "-p", "-t", paneId, "#{pane_index}"], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const n = Number(r.stdout.trim());
    return Number.isFinite(n) ? n : null;
  }

  private paneWidth(paneId: string): number | null {
    const r = spawnSync(this.bin, ["display-message", "-p", "-t", paneId, "#{pane_width}"], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const n = Number(r.stdout.trim());
    return Number.isFinite(n) ? n : null;
  }

  relayout({ window, consolePaneId, agentPaneIds }: { window: string; consolePaneId: string; agentPaneIds: string[] }): void {
    const win = this.windowSize(window);
    const cIdx = this.paneIndex(consolePaneId);
    if (cIdx === null) return;
    const agentIdxs: number[] = [];
    for (const pid of agentPaneIds) {
      const idx = this.paneIndex(pid);
      if (idx !== null) agentIdxs.push(idx);
    }
    if (agentIdxs.length === 0) return;
    // Preserve the console column's current width (the user may have dragged the
    // divider); fall back to a 35% share on the first layout. Floored at 40 cols
    // for TUI readability, capped so the agent grid keeps room.
    const cur = this.paneWidth(consolePaneId);
    const consoleWidth = Math.min(Math.max(20, win.w - 20), Math.max(40, cur ?? Math.floor(win.w * 0.35)));
    const layout = buildLayoutString({
      windowWidth: win.w,
      windowHeight: win.h,
      consolePaneIndex: cIdx,
      agentPaneIndexes: agentIdxs,
      consoleWidth,
    });
    const r = spawnSync(this.bin, ["select-layout", "-t", `${this.session}:${window}`, layout], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`tmux select-layout failed: ${r.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// psmux backend (Windows). tmux-compatible CLI with these adaptations:
//   - A pane command is passed as ONE PowerShell command-string arg after `--`.
//     psmux runs whatever follows `--` through its default shell as
//     `powershell.exe -NoLogo -Command "<that string>"` — it joins multi-arg
//     tails with spaces and drops their quoting, so passing
//     `pwsh -NoProfile -Command <script>` corrupts the script (and pwsh isn't
//     installed; psmux falls back to Windows PowerShell). We therefore hand it a
//     single self-contained PowerShell string (serializeLaunchForPwsh) and pin
//     default-shell to powershell so the wrapper is deterministic.
//   - layouts use presets (`main-vertical`), not custom layout strings;
//   - no command-prompt, so bindCommandPrompt is a no-op.
// NOTE: psmux executes pane processes only while a client is attached (it is a
// ConPTY renderer), unlike tmux's headless detached server. charm is used
// attached, so agents run during normal operation; detaching pauses them.
// ---------------------------------------------------------------------------

class PsmuxBackend implements Multiplexer {
  constructor(public readonly session: string, private readonly bin = "psmux") {}

  /** The argv tail psmux runs in a pane: `-- & '<script.ps1>'`.
   *  psmux hosts whatever follows `--` as `powershell.exe -NoLogo -Command
   *  "<joined>"`. Inlining the launch there fails: an agent's
   *  --append-system-prompt has double-quotes and newlines that break that
   *  double-quote wrapping (PowerShell errors "string is missing the
   *  terminator"). So we write the launch to a .ps1 and pass only `& '<path>'`
   *  — one arg, single-quoted path (handles spaces), no double-quotes to clash
   *  with psmux's wrapper. All the volatile content lives safely in the file. */
  private paneCmd(launch: LaunchSpec): string[] {
    // UTF-8 BOM so Windows PowerShell 5.1 doesn't garble non-ASCII prompt text.
    const script = "\uFEFF" + serializeLaunchToPs1(launch);
    const dir = join(tmpdir(), "charm-launch");
    mkdirSync(dir, { recursive: true });
    // Content-hashed name: identical launches reuse one file; different ones
    // never collide. (No Date.now()/random needed — and none would help here.)
    const path = join(dir, `${createHash("sha1").update(script).digest("hex").slice(0, 16)}.ps1`);
    writeFileSync(path, script);
    return ["--", `& '${path.replace(/'/g, "''")}'`];
  }

  newSession(window: string, cwd: string): void {
    // Start the initial window on the default interactive shell (no `-- cmd`) so
    // the session has a long-lived pane and persists; the real panes are added
    // by spawnInWindow/splitPane.
    const r = spawnSync(this.bin, ["new-session", "-d", "-s", this.session, "-n", window, "-c", cwd], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`psmux new-session failed (${r.status})`);
    // Pin the pane host shell to Windows PowerShell so our PowerShell launch
    // strings run under a known interpreter regardless of the user's psmux
    // default-shell config (cmd/bash/nu would otherwise mis-run them).
    spawnSync(this.bin, ["set-option", "-g", "default-shell", "powershell"]);
    spawnSync(this.bin, ["set-option", "-t", this.session, "remain-on-exit", "on"]);
    spawnSync(this.bin, ["set-option", "-t", this.session, "mouse", "on"]);
  }

  hasSession(): boolean {
    return spawnSync(this.bin, ["has-session", "-t", this.session]).status === 0;
  }

  killSession(): void {
    spawnSync(this.bin, ["kill-session", "-t", this.session]);
  }

  bindCommandPrompt(_cmdTemplate: string): void {
    // psmux has no command-prompt; the `:` quit/detach binding is unavailable.
    // Quit via `charm stop` instead. No-op.
  }

  /** Map a tmux size ("65%" or a cell count) onto psmux's `-p <percent>`. A
   *  bare cell count can't be expressed as a percent, so it's dropped (psmux
   *  falls back to an even split). */
  private sizeArgs(size?: string): string[] {
    if (!size) return [];
    const m = size.trim().match(/^(\d+)%$/);
    return m ? ["-p", m[1]!] : [];
  }

  spawnInWindow(window: string, launch: LaunchSpec): string {
    const target = `${this.session}:${window}.0`;
    const r = spawnSync(
      this.bin,
      ["respawn-pane", "-k", "-t", target, "-c", launch.cwd, ...this.paneCmd(launch)],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`psmux respawn-pane failed: ${r.stderr}`);
    const id = spawnSync(this.bin, ["display-message", "-p", "-t", target, "#{pane_id}"], { encoding: "utf8" });
    return id.stdout.trim();
  }

  splitPane(opts: { launch: LaunchSpec; direction?: "h" | "v"; target?: string; size?: string }): string {
    const args = ["split-window", opts.direction === "v" ? "-v" : "-h", "-P", "-F", "#{pane_id}", "-c", opts.launch.cwd];
    if (opts.target) args.push("-t", opts.target);
    args.push(...this.sizeArgs(opts.size));
    args.push(...this.paneCmd(opts.launch));
    const r = spawnSync(this.bin, args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`psmux split-window failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  selectPane(target: string): void {
    spawnSync(this.bin, ["select-pane", "-t", target]);
  }

  killPane(paneId: string): void {
    spawnSync(this.bin, ["kill-pane", "-t", paneId]);
  }

  sendText(paneId: string, text: string): void {
    spawnSync(this.bin, ["send-keys", "-t", paneId, "-l", text]);
    spawnSync(this.bin, ["send-keys", "-t", paneId, "Enter"]);
  }

  attach(): void {
    spawnSync(this.bin, ["attach-session", "-t", this.session], { stdio: "inherit" });
  }

  paneAlive(paneId: string): boolean {
    // display-message -t <bad id> silently falls back to the active pane on psmux
    // (returns a valid index, exit 0), so it can't detect a dead pane. List the
    // session's real pane ids and check membership instead.
    const r = spawnSync(this.bin, ["list-panes", "-s", "-t", this.session, "-F", "#{pane_id}"], { encoding: "utf8" });
    if (r.status !== 0) return false;
    return r.stdout.split("\n").map((l) => l.trim()).includes(paneId);
  }

  relayout({ window }: { window: string; consolePaneId: string; agentPaneIds: string[] }): void {
    // psmux can't apply a custom layout string, so approximate charm's
    // console-left + agents-right shape with the main-vertical preset (the first
    // pane — the console — gets the large left column, the rest stack at right).
    spawnSync(this.bin, ["select-layout", "-t", `${this.session}:${window}`, "main-vertical"]);
  }
}
