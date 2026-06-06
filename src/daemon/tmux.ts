import { spawnSync } from "node:child_process";

/**
 * Async tmux invocation. Unlike spawnSync (which blocks the daemon's single
 * event-loop thread for the full duration of the child process — and `tmux
 * split-window` launches a whole `claude`), this yields the loop while tmux
 * runs, so unrelated RPCs (create_tickets, report_status, list_tickets) keep
 * being serviced instead of stalling behind a spawn/relayout burst. Used for
 * every tmux call on the daemon's RPC-serving hot path; the startup/CLI-only
 * methods below stay synchronous since nothing is waiting on the socket yet.
 */
async function tmuxRun(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

/**
 * Pick a system-clipboard command for the current platform, or null if none is
 * on PATH. tmux's `copy-pipe` runs the returned string via `/bin/sh -c`, so a
 * multi-word command (e.g. `xclip -selection clipboard`) is fine as one entry.
 */
function clipboardCommand(): string | null {
  const candidates = ["pbcopy", "wl-copy", "xclip -selection clipboard", "xsel --clipboard --input"];
  for (const c of candidates) {
    const bin = c.split(" ")[0]!;
    if (spawnSync("which", [bin]).status === 0) return c;
  }
  return null;
}

export class Tmux {
  constructor(public session: string) {}

  static available(): boolean {
    const r = spawnSync("which", ["tmux"]);
    return r.status === 0;
  }

  newSession(window: string, cwd: string): void {
    const r = spawnSync("tmux", ["new-session", "-d", "-s", this.session, "-n", window, "-c", cwd], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tmux new-session failed (${r.status})`);
    // Keep dead panes visible so a crashing claude leaves its error on screen
    // instead of silently collapsing the layout.
    spawnSync("tmux", ["set-option", "-t", this.session, "remain-on-exit", "on"]);
    // Mouse: click to focus a pane, scroll inside it.
    spawnSync("tmux", ["set-option", "-t", this.session, "mouse", "on"]);
    // ...but with mouse on, route selections to the SYSTEM clipboard (below),
    // not tmux's private buffer — otherwise the user can't copy terminal output.
    this.enableClipboardCopy();
  }

  /**
   * Make text selection copy to the SYSTEM clipboard instead of tmux's private
   * paste buffer. This is required *because* we set `mouse on` above: with the
   * mouse captured, tmux turns a click-drag into a copy-mode selection and, by
   * default, yanks it into its own buffer — which the OS Cmd/Ctrl+V can't reach,
   * so terminal output becomes uncopyable. We rebind the end of a mouse drag and
   * the copy-mode-vi yank key to pipe the selection through the platform
   * clipboard command; `set-clipboard on` additionally lets tmux (and programs
   * running inside panes) push to the terminal's clipboard over OSC 52 where the
   * terminal supports it, which also covers the copy path when charm is used over
   * SSH. If no clipboard tool is on PATH we leave tmux's defaults untouched.
   *
   * Mouse drag-end uses `copy-pipe` (not `-and-cancel`) so the highlight stays
   * visible after release — visible feedback that the copy happened — while the
   * keyboard `y` cancels copy-mode afterward, as vi users expect.
   *
   * NB: tmux key tables are server-global (like the `:` binding in
   * bindCommandPrompt), so these binds apply across sessions; they're idempotent,
   * so re-applying on each `newSession` is harmless.
   */
  enableClipboardCopy(): void {
    const clip = clipboardCommand();
    if (!clip) return;
    spawnSync("tmux", ["set-option", "-t", this.session, "set-clipboard", "on"]);
    for (const table of ["copy-mode", "copy-mode-vi"]) {
      spawnSync("tmux", ["bind-key", "-T", table, "MouseDragEnd1Pane", "send-keys", "-X", "copy-pipe", clip]);
    }
    spawnSync("tmux", ["bind-key", "-T", "copy-mode-vi", "y", "send-keys", "-X", "copy-pipe-and-cancel", clip]);
  }

  hasSession(): boolean {
    const r = spawnSync("tmux", ["has-session", "-t", this.session]);
    return r.status === 0;
  }

  killSession(): void {
    spawnSync("tmux", ["kill-session", "-t", this.session]);
  }

  /**
   * Set a per-session tmux option (e.g. a user option `@charm_socket`) scoped to
   * THIS session. The `:` key binding reads these back via format expansion at
   * keypress time, so a `:q` resolves to whichever session it was pressed in —
   * the binding itself stays a single global entry, but the values it expands are
   * per-session. Best-effort: a failure here only degrades the dynamic binding to
   * its tmux-session fallback.
   */
  setOption(name: string, value: string): void {
    spawnSync("tmux", ["set-option", "-t", this.session, name, value]);
  }

  /**
   * Bind `:` (no prefix) at the session level so any pane — console or agent —
   * pops a tmux command-prompt that runs `cmdTemplate` with the typed text
   * substituted for `%%%`. The substitution happens via tmux's own `%1` token.
   */
  bindCommandPrompt(cmdTemplate: string): void {
    // `command-prompt -p ":" "run-shell '<cmd with %1>'"`
    const inner = `run-shell '${cmdTemplate.replace(/'/g, `'\\''`)}'`;
    spawnSync("tmux", [
      "bind-key", "-T", "root", ":",
      "command-prompt", "-p", ":", inner,
    ]);
  }

  /** Split current window and start a command. Returns the new pane id (e.g. "%17").
   *  Async (Bun.spawn): this is the heaviest tmux call on the hot path — it
   *  launches a `claude` in the new pane — so it must not block the event loop. */
  async splitPane(opts: { cmd: string; cwd: string; direction?: "h" | "v"; target?: string; size?: string }): Promise<string> {
    const args = [
      "split-window",
      opts.direction === "v" ? "-v" : "-h",
      "-P",
      "-F", "#{pane_id}",
      "-c", opts.cwd,
    ];
    if (opts.target) args.push("-t", opts.target);
    if (opts.size) args.push("-l", opts.size);
    args.push("sh", "-c", opts.cmd);
    const r = await tmuxRun(args);
    if (r.status !== 0) throw new Error(`tmux split-window failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  /**
   * Create a new window in this session running `cmd`, and return its pane id.
   * Used for standalone full-window views (e.g. the graph viewer) that should
   * not disturb the agent-grid layout in the main window. By default the pane
   * closes when the command exits (remain-on-exit off), overriding the
   * session-level `remain-on-exit on` we set for crashing agents.
   */
  newWindow(opts: { name: string; cmd: string; cwd: string; remainOnExit?: boolean }): string {
    const r = spawnSync(
      "tmux",
      ["new-window", "-t", this.session, "-n", opts.name, "-P", "-F", "#{pane_id}", "-c", opts.cwd, "sh", "-c", opts.cmd],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`tmux new-window failed: ${r.stderr}`);
    const pane = r.stdout.trim();
    spawnSync("tmux", ["set-option", "-p", "-t", pane, "remain-on-exit", opts.remainOnExit ? "on" : "off"]);
    return pane;
  }

  /** Bring the window containing `target` (window or pane id) to the foreground. */
  selectWindow(target: string): void {
    spawnSync("tmux", ["select-window", "-t", target]);
  }

  /** Start a command in the initial window's only pane (Stage 0 main agent). */
  spawnInWindow(window: string, cmd: string, cwd: string): string {
    const target = `${this.session}:${window}.0`;
    const r = spawnSync(
      "tmux",
      ["respawn-pane", "-k", "-t", target, "-c", cwd, "sh", "-c", cmd],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`tmux respawn-pane failed: ${r.stderr}`);
    const id = spawnSync("tmux", ["display-message", "-p", "-t", target, "#{pane_id}"], { encoding: "utf8" });
    return id.stdout.trim();
  }

  async killPane(paneId: string): Promise<void> {
    await tmuxRun(["kill-pane", "-t", paneId]);
  }

  /**
   * Type a line of text into a specific pane and submit it (Enter). Targeting is
   * by pane id, so this is independent of which pane currently holds focus — the
   * user's cursor never moves and their keystrokes to any other pane are
   * untouched. Used to wake the orchestrator when a sub-agent changes state.
   *
   * `-l` sends the text literally (no tmux key-name interpretation), so a stray
   * word like "Enter" or "C-c" in the message can't be read as a keypress. We do
   * NOT clear the pane's input line first: if a human happens to be typing into
   * this exact pane, our text appends rather than destroying their in-progress
   * input. Send the literal text and the Enter as two calls — a trailing "Enter"
   * inside an `-l` payload would be typed verbatim, not submitted.
   */
  async sendText(paneId: string, text: string): Promise<void> {
    await tmuxRun(["send-keys", "-t", paneId, "-l", text]);
    await tmuxRun(["send-keys", "-t", paneId, "Enter"]);
  }

  selectPane(paneId: string): void {
    spawnSync("tmux", ["select-pane", "-t", paneId]);
  }

  listPanes(): { pane_id: string; pid: number; cmd: string }[] {
    const r = spawnSync(
      "tmux",
      ["list-panes", "-s", "-t", this.session, "-F", "#{pane_id}\t#{pane_pid}\t#{pane_current_command}"],
      { encoding: "utf8" },
    );
    if (r.status !== 0) return [];
    return r.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pane_id, pid, cmd] = line.split("\t");
        return { pane_id: pane_id!, pid: Number(pid), cmd: cmd! };
      });
  }

  attach(): void {
    // Block until the user detaches. A non-blocking spawn() returns immediately
    // and lets the parent process race ahead / linger as the client's parent,
    // which leaves the tmux client without clean ownership of the terminal --
    // the shell then tears it down and tmux reports "[server exited
    // unexpectedly]" even though the session is fine. The shell wrapper
    // (charm.sh) prefers exec'ing tmux directly; this is the fallback for
    // anyone invoking the CLI without it.
    spawnSync("tmux", ["attach-session", "-t", this.session], { stdio: "inherit" });
  }

  /** Window dimensions in cells. */
  async windowSize(window: string): Promise<{ w: number; h: number }> {
    const r = await tmuxRun(
      ["display-message", "-p", "-t", `${this.session}:${window}`, "#{window_width}x#{window_height}"],
    );
    if (r.status !== 0) throw new Error(`tmux display-message failed: ${r.stderr}`);
    const m = r.stdout.trim().match(/^(\d+)x(\d+)$/);
    if (!m) throw new Error(`bad window size: ${r.stdout}`);
    return { w: Number(m[1]), h: Number(m[2]) };
  }

  /** Look up the current pane_index for a stable pane_id. Returns null if the pane no longer exists. */
  async paneIndex(paneId: string): Promise<number | null> {
    const r = await tmuxRun(["display-message", "-p", "-t", paneId, "#{pane_index}"]);
    if (r.status !== 0) return null;
    const n = Number(r.stdout.trim());
    return Number.isFinite(n) ? n : null;
  }

  /** Current width of a pane in cells. Returns null if the pane no longer exists. */
  async paneWidth(paneId: string): Promise<number | null> {
    const r = await tmuxRun(["display-message", "-p", "-t", paneId, "#{pane_width}"]);
    if (r.status !== 0) return null;
    const n = Number(r.stdout.trim());
    return Number.isFinite(n) ? n : null;
  }

  /** Apply a tmux custom layout string (incl. checksum prefix) to the named window. */
  async applyLayout(window: string, layout: string): Promise<void> {
    const r = await tmuxRun(["select-layout", "-t", `${this.session}:${window}`, layout]);
    if (r.status !== 0) throw new Error(`tmux select-layout failed: ${r.stderr}`);
  }
}
