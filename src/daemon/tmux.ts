import { spawnSync, spawn } from "node:child_process";

export class Tmux {
  constructor(public session: string) {}

  static available(): boolean {
    const r = spawnSync("which", ["tmux"]);
    return r.status === 0;
  }

  newSession(window: string, cwd: string): void {
    const r = spawnSync("tmux", ["new-session", "-d", "-s", this.session, "-n", window, "-c", cwd], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tmux new-session failed (${r.status})`);
  }

  hasSession(): boolean {
    const r = spawnSync("tmux", ["has-session", "-t", this.session]);
    return r.status === 0;
  }

  killSession(): void {
    spawnSync("tmux", ["kill-session", "-t", this.session]);
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
    spawn("tmux", ["attach-session", "-t", this.session], { stdio: "inherit" });
  }
}
