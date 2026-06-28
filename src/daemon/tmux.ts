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

export class Tmux {
  constructor(public session: string) {}

  // Monotonic suffix for per-call-unique tmux buffer names in sendText, so two
  // concurrent sends can never clobber each other's payload.
  private bufSeq = 0;

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
    // Mouse on: enables click-to-focus and pane resizing.
    spawnSync("tmux", ["set-option", "-t", this.session, "mouse", "on"]);
    // set-clipboard on: forward OSC 52 sequences from applications (e.g. Claude Code)
    // to the outer terminal so they can write to the system clipboard directly.
    spawnSync("tmux", ["set-option", "-t", this.session, "set-clipboard", "on"]);
    // allow-passthrough on: enables DCS passthrough for panes in this session.
    // When charm itself is attached through another tmux session, pane applications
    // that emit clipboard or other terminal-extended sequences (wrapped in the tmux
    // DCS passthrough envelope \ePtmux;...\e\\) can reach the outermost terminal
    // rather than being swallowed by an intermediate tmux layer.
    spawnSync("tmux", ["set-option", "-t", this.session, "allow-passthrough", "on"]);
    // Append tmux* and screen* to terminal-features so that when charm's session is
    // attached through another tmux (TERM=tmux-256color or screen-256color), tmux
    // knows the outer terminal supports clipboard (Ms) and will forward OSC 52
    // sequences from pane apps up through the tmux chain instead of discarding them.
    spawnSync("tmux", ["set-option", "-as", "terminal-features", "tmux*:clipboard"]);
    spawnSync("tmux", ["set-option", "-as", "terminal-features", "screen*:clipboard"]);
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
   * Install a session-level tmux hook that runs `cmd` whenever `hook` fires
   * (e.g. "client-resized"). Used to keep the layout — and the sidebar's
   * max-width clamp — in sync when the terminal is resized, since the daemon's
   * relayout otherwise only runs on fleet-grid mutations (spawn/kill/register).
   */
  setHook(hook: string, cmd: string, { background = false } = {}): void {
    const flag = background ? "-b " : "";
    spawnSync("tmux", ["set-hook", "-t", this.session, hook, `run-shell ${flag}'${cmd.replace(/'/g, `'\\''`)}'`]);
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

  /** Split a window and start a command. Returns the new pane id (e.g. "%17").
   *  Async (Bun.spawn): this is the heaviest tmux call on the hot path — it
   *  launches a `claude` in the new pane — so it must not block the event loop.
   *  Defaults the split target to THIS session when no explicit target is given:
   *  charm runs every session on the default tmux server and the daemon is
   *  detached, so an untargeted `split-window` would land in tmux's global
   *  "current session" (possibly another live charm session) rather than the one
   *  this Tmux instance owns. */
  async splitPane(opts: { cmd: string; cwd: string; direction?: "h" | "v"; target?: string; size?: string }): Promise<string> {
    const args = [
      "split-window",
      opts.direction === "v" ? "-v" : "-h",
      "-d",
      "-P",
      "-F", "#{pane_id}",
      "-c", opts.cwd,
    ];
    args.push("-t", opts.target ?? this.session);
    if (opts.size) args.push("-l", opts.size);
    args.push("sh", "-c", opts.cmd);
    const r = await tmuxRun(args);
    if (r.status !== 0) throw new Error(`tmux split-window failed: ${r.stderr}`);
    const pane = r.stdout.trim();
    spawnSync("tmux", ["set-option", "-p", "-t", pane, "allow-passthrough", "on"]);
    return pane;
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

  /** Start a command in the initial window's only pane (the main agent). */
  spawnInWindow(window: string, cmd: string, cwd: string): string {
    const target = `${this.session}:${window}.0`;
    const r = spawnSync(
      "tmux",
      ["respawn-pane", "-k", "-t", target, "-c", cwd, "sh", "-c", cmd],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`tmux respawn-pane failed: ${r.stderr}`);
    const id = spawnSync("tmux", ["display-message", "-p", "-t", target, "#{pane_id}"], { encoding: "utf8" });
    const pane = id.stdout.trim();
    spawnSync("tmux", ["set-option", "-p", "-t", pane, "allow-passthrough", "on"]);
    return pane;
  }

  async killPane(paneId: string): Promise<void> {
    await tmuxRun(["kill-pane", "-t", paneId]);
  }

  /**
   * Inject text into a specific pane's input and submit it (Enter). Targeting is
   * by pane id, so this is independent of which pane currently holds focus — the
   * user's cursor never moves and their keystrokes to any other pane are
   * untouched. Used to message a blocked sub-agent (continue_agent) and to wake
   * the orchestrator when a sub-agent changes state.
   *
   * Delivery is a tmux buffer + BRACKETED PASTE, not `send-keys -l`. The literal
   * keystroke approach dropped messages two ways:
   *   1. Multi-line — `send-keys -l "a\nb"` types the newline literally, and an
   *      Ink TUI input reads a newline as SUBMIT, so "a" was sent and "b" was
   *      orphaned in a fresh prompt. An LLM orchestrator routinely emits
   *      multi-line guidance, so those messages were truncated at the first
   *      newline.
   *   2. Keystroke race — a long `-l` blob immediately followed by Enter could be
   *      submitted before the TUI had ingested the whole blob.
   * A bracketed paste arrives as one atomic event (no keystroke race) and inserts
   * newlines as literal input rather than submitting, so the message lands intact
   * and the explicit Enter below submits the whole thing. We do NOT clear the
   * pane's input first: if a human is mid-type in this exact pane, the paste
   * appends rather than destroying their in-progress input.
   */
  async sendText(paneId: string, text: string): Promise<void> {
    const buf = `charm-paste-${++this.bufSeq}`;
    // `--` stops option parsing so a message beginning with `-` is safe.
    await tmuxRun(["set-buffer", "-b", buf, "--", text]);
    // `-p` wraps the payload in bracketed-paste markers; `-d` deletes the buffer
    // after pasting so buffers don't accumulate over a long-lived session.
    await tmuxRun(["paste-buffer", "-t", paneId, "-b", buf, "-d", "-p"]);
    // Submit the now-complete (possibly multi-line) input.
    await tmuxRun(["send-keys", "-t", paneId, "Enter"]);
  }

  selectPane(paneId: string): void {
    spawnSync("tmux", ["select-pane", "-t", paneId]);
  }

  /** List every pane in this session, including dead ones. With session-level
   *  `remain-on-exit on`, a pane whose command has exited stays listed with
   *  `dead: true` (and `#{pane_dead_status}` would hold its exit code) until
   *  something kills it — which is exactly what the daemon's liveness sweep keys
   *  off to reap agents that exited without reporting. A pane that was killed is
   *  simply absent from the list. */
  listPanes(): { pane_id: string; pid: number; cmd: string; dead: boolean }[] {
    const r = spawnSync(
      "tmux",
      ["list-panes", "-s", "-t", this.session, "-F", "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}"],
      { encoding: "utf8" },
    );
    if (r.status !== 0) return [];
    return r.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pane_id, pid, cmd, dead] = line.split("\t");
        return { pane_id: pane_id!, pid: Number(pid), cmd: cmd!, dead: dead === "1" };
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

  /** True iff the pane exists in this session AND its process is still alive.
   *  Under session-level `remain-on-exit on`, a pane whose command has exited
   *  stays listed — so `paneIndex` still returns a finite index for it — which
   *  makes paneIndex a false proxy for "process alive". This scans `listPanes()`
   *  (scoped to this session) and checks the `dead` flag: a pane that is absent
   *  (killed/never-existed) or present-but-dead reads as not-alive. Scoped-scan
   *  rather than `display-message -t <id>`, which falls back to a current pane
   *  for an unknown id instead of erroring. Use this (not paneIndex) to decide
   *  whether it's safe to send input to a pane. */
  async paneAlive(paneId: string): Promise<boolean> {
    const p = this.listPanes().find((x) => x.pane_id === paneId);
    return p !== undefined && !p.dead;
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

  /** The window's current layout string (`#{window_visible_layout}`, incl. the
   *  checksum prefix) — i.e. the live pane geometry right now, reflecting any
   *  manual divider drags. Compare against a freshly-computed target to decide
   *  whether a relayout actually needs to apply. Null if the lookup fails. */
  async currentLayout(window: string): Promise<string | null> {
    const r = await tmuxRun(["display-message", "-p", "-t", `${this.session}:${window}`, "#{window_visible_layout}"]);
    if (r.status !== 0) return null;
    const s = r.stdout.trim();
    return s.length > 0 ? s : null;
  }

  /** Apply a tmux custom layout string (incl. checksum prefix) to the named window. */
  async applyLayout(window: string, layout: string): Promise<void> {
    const r = await tmuxRun(["select-layout", "-t", `${this.session}:${window}`, layout]);
    if (r.status !== 0) throw new Error(`tmux select-layout failed: ${r.stderr}`);
  }

  /** Resize a single pane to an exact cell width. tmux gives the reclaimed (or
   *  borrowed) columns to the adjacent pane and leaves every other divider — in
   *  particular the agent grid's internal dividers — untouched. This is the
   *  surgical alternative to a full select-layout: used to snap the console
   *  column back to its cap on a manual divider drag without recomputing (and
   *  thereby nudging) the agent panes. */
  async resizePaneWidth(paneId: string, width: number): Promise<void> {
    const r = await tmuxRun(["resize-pane", "-t", paneId, "-x", String(width)]);
    if (r.status !== 0) throw new Error(`tmux resize-pane failed: ${r.stderr}`);
  }
}
