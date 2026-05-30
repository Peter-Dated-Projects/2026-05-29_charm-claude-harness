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
    // Mouse: click to focus a pane, scroll inside it.
    spawnSync("tmux", ["set-option", "-t", this.session, "mouse", "on"]);
  }

  hasSession(): boolean {
    const r = spawnSync("tmux", ["has-session", "-t", this.session]);
    return r.status === 0;
  }

  killSession(): void {
    spawnSync("tmux", ["kill-session", "-t", this.session]);
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

  /** Split current window and start a command. Returns the new pane id (e.g. "%17"). */
  splitPane(opts: { cmd: string; cwd: string; direction?: "h" | "v"; target?: string; size?: string }): string {
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
    const r = spawnSync("tmux", args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`tmux split-window failed: ${r.stderr}`);
    return r.stdout.trim();
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

  killPane(paneId: string): void {
    spawnSync("tmux", ["kill-pane", "-t", paneId]);
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
