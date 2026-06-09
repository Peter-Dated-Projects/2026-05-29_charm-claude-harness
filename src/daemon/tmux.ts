import { spawnSync } from "node:child_process";

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
   *  Defaults the split target to THIS session when no explicit target is given:
   *  charm runs every session on the default tmux server and the daemon is
   *  detached, so an untargeted `split-window` would land in tmux's global
   *  "current session" (possibly another live charm session) rather than the one
   *  this Tmux instance owns. */
  splitPane(opts: { cmd: string; cwd: string; direction?: "h" | "v"; target?: string; size?: string }): string {
    const args = [
      "split-window",
      opts.direction === "v" ? "-v" : "-h",
      "-P",
      "-F", "#{pane_id}",
      "-c", opts.cwd,
    ];
    args.push("-t", opts.target ?? this.session);
    if (opts.size) args.push("-l", opts.size);
    args.push("sh", "-c", opts.cmd);
    const r = spawnSync("tmux", args, { encoding: "utf8" });
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
    const pane = id.stdout.trim();
    spawnSync("tmux", ["set-option", "-p", "-t", pane, "allow-passthrough", "on"]);
    return pane;
  }

  killPane(paneId: string): void {
    spawnSync("tmux", ["kill-pane", "-t", paneId]);
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
  sendText(paneId: string, text: string): void {
    spawnSync("tmux", ["send-keys", "-t", paneId, "-l", text]);
    spawnSync("tmux", ["send-keys", "-t", paneId, "Enter"]);
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
  windowSize(window: string): { w: number; h: number } {
    const r = spawnSync(
      "tmux",
      ["display-message", "-p", "-t", `${this.session}:${window}`, "#{window_width}x#{window_height}"],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`tmux display-message failed: ${r.stderr}`);
    const m = r.stdout.trim().match(/^(\d+)x(\d+)$/);
    if (!m) throw new Error(`bad window size: ${r.stdout}`);
    return { w: Number(m[1]), h: Number(m[2]) };
  }

  /** Look up the current pane_index for a stable pane_id. Returns null if the pane no longer exists. */
  paneIndex(paneId: string): number | null {
    const r = spawnSync("tmux", ["display-message", "-p", "-t", paneId, "#{pane_index}"], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const n = Number(r.stdout.trim());
    return Number.isFinite(n) ? n : null;
  }

  /** Current width of a pane in cells. Returns null if the pane no longer exists. */
  paneWidth(paneId: string): number | null {
    const r = spawnSync("tmux", ["display-message", "-p", "-t", paneId, "#{pane_width}"], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const n = Number(r.stdout.trim());
    return Number.isFinite(n) ? n : null;
  }

  /** Apply a tmux custom layout string (incl. checksum prefix) to the named window. */
  applyLayout(window: string, layout: string): void {
    const r = spawnSync(
      "tmux",
      ["select-layout", "-t", `${this.session}:${window}`, layout],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`tmux select-layout failed: ${r.stderr}`);
  }
}
