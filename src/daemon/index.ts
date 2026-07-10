#!/usr/bin/env bun
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { charmPaths, defaultSessionName, worktreePathFor, assertPlainName } from "../paths.ts";
import { TicketStore, authoredBody, LOG_BEGIN, LOG_END } from "../store/tickets.ts";
import { AgentRegistry, holdsTicketClaim, occupiesLiveSlot } from "./registry.ts";
import { CoordinationWriter } from "./coord.ts";
import { Solver, type InFlight, liveDependentsOf } from "./solver.ts";
import { Tmux } from "./tmux.ts";
import { buildLayoutString, shouldHideSubagents } from "./layout.ts";
import { WorktreeManager } from "./worktree.ts";
import { ApprovalQueue } from "./approvals.ts";
import { startRpcServer } from "./rpc.ts";
import { buildClaudeCommand, defaultModelForRole, ensureDirectoryTrusted, MAIN_AGENT_ID, newClaudeSessionId, resolveSpawnModel, type SpawnSpec } from "./spawn.ts";
import { killGraphViewers } from "../graph-viewers.ts";
import { createProposal, listProposals, finishProposal } from "../store/proposals.ts";
import {
  CreateTicketsInput,
  CreateProposalInput,
  PromoteInput,
  FinishProposalInput,
  SpawnInvestigatorsInput,
  SpawnWorkersInput,
  SpawnResearchersInput,
  AwaitApprovalInput,
  UpdatePlanInput,
  ReportStatusInput,
  SetTicketStatusInput,
  SetTicketStateInput,
  RequestReviewInput,
  SetSessionDescriptionInput,
  KillAgentInput,
  CancelTicketInput,
  ContinueAgentInput,
  CreateWorktreeInput,
  ListWorktreesInput,
  CloseWorktreeInput,
  SessionMeta,
  COORDINATION_STATUSES,
  type AgentRole,
} from "../schema.ts";

type DaemonOpts = { root: string; session: string; uuid?: string };

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** argv that runs the graph viewer. Resolution precedence:
 *    1. CHARM_GRAPH_BIN  -- explicit override (path to a charm-graph binary)
 *    2. compiled daemon  -- the `charm-graph` binary installed alongside charmd
 *    3. from TS source   -- `<bun> run src/console/graph.ts`
 *  A compiled binary's own module URL lives under Bun's embedded "$bunfs" root
 *  (not on disk) and process.execPath is the daemon binary rather than bun, so
 *  the source-style `<bun> run <file>` form only works when running from source. */
function graphBinArgs(): string[] {
  const override = process.env.CHARM_GRAPH_BIN;
  if (override) return [override];
  const url = typeof import.meta.url === "string" ? import.meta.url : "";
  const compiled = url.includes("/$bunfs/") || url.includes("/~BUN/");
  if (compiled) {
    const sibling = join(dirname(process.execPath), "charm-graph");
    return [existsSync(sibling) ? sibling : "charm-graph"];
  }
  return [process.execPath, "run", join(import.meta.dir, "../console/graph.ts")];
}

/** How to open ONE graph viewer in a brand-new OS terminal window, fully outside
 *  tmux. Returns a spawnSync-style spec (the daemon runs it and returns).
 *
 *  The viewer runs as `CHARM_GRAPH_PIDFILE=<file> CHARM_KB_DIR=<dir> <graphbin>; exit`
 *  inside the new window: it self-registers its PID for `charm stop` to reap,
 *  renders + live-watches the knowledge base at CHARM_KB_DIR, and the trailing
 *  `exit` lets the window close once the viewer quits (subject to the terminal's
 *  "close on clean exit" setting).
 *
 *  Which terminal: an explicit CHARM_GRAPH_TERMINAL_CMD wins (a custom launcher;
 *  it receives CHARM_GRAPH_CMD + CHARM_GRAPH_PIDFILE + CHARM_KB_DIR in its env).
 *  Otherwise we open the same program charm itself is running in, read from
 *  TERM_PROGRAM (inherited by the daemon from `charm start`). iTerm and Apple
 *  Terminal each get their own AppleScript dialect; anything else (or a missing
 *  TERM_PROGRAM) falls back to Terminal.app, which exists on every Mac. */
/** True if a process with this pid currently exists. Signal 0 does the kernel's
 *  permission/existence check without delivering a signal. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function graphLaunchSpec(pidFile: string, kbDir: string): { cmd: string; args: string[]; env?: NodeJS.ProcessEnv } {
  const inner =
    `CHARM_GRAPH_PIDFILE=${shq(pidFile)} CHARM_KB_DIR=${shq(kbDir)} ` +
    `${graphBinArgs().map(shq).join(" ")}; exit`;

  const custom = process.env.CHARM_GRAPH_TERMINAL_CMD;
  if (custom) {
    return {
      cmd: "sh",
      args: ["-c", custom],
      env: { ...process.env, CHARM_GRAPH_CMD: inner, CHARM_GRAPH_PIDFILE: pidFile, CHARM_KB_DIR: kbDir },
    };
  }

  if (process.platform !== "darwin") {
    throw new Error(
      "opening a separate terminal window is only built in for macOS; " +
        "set CHARM_GRAPH_TERMINAL_CMD to a launcher (it gets $CHARM_GRAPH_CMD).",
    );
  }

  // Escape for embedding inside an AppleScript double-quoted string literal.
  const asStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const termProgram = process.env.TERM_PROGRAM ?? "";

  if (termProgram === "iTerm.app") {
    // iTerm: make a new window from the default profile, then run the command in it.
    const script =
      `tell application "iTerm"\n` +
      `  set w to (create window with default profile)\n` +
      `  tell current session of w to write text ${asStr(inner)}\n` +
      `  activate\n` +
      `end tell`;
    return { cmd: "osascript", args: ["-e", script] };
  }

  // Apple Terminal (TERM_PROGRAM=Apple_Terminal) and the safe default for anything
  // else: `do script` with no target opens a fresh window and runs the command.
  const script = `tell application "Terminal"\n  do script ${asStr(inner)}\n  activate\nend tell`;
  return { cmd: "osascript", args: ["-e", script] };
}

async function main() {
  installTimestampedConsole();
  const program = new Command();
  program
    .name("charmd")
    .option("--root <path>", "project root", process.cwd())
    .option("--session <name>", "tmux session name (default: derived from --root)")
    .option("--uuid <id>", "session UUID (control-plane key; default: derived single-session layout)")
    .parse(process.argv);
  const opts = program.opts<DaemonOpts>();
  // cli.ts always passes an explicit --session; derive a per-directory default
  // only for the rare case of running charmd directly, so it never falls back to
  // a hardcoded "charm" that would collide with another directory's session.
  const session = opts.session ?? defaultSessionName(opts.root);

  // The UUID must match the one `charm start` used: it keys this session's
  // socket/pidfile/run dir, and start blocks waiting for exactly that socket. A
  // bare `charmd` (no --uuid) uses the legacy single-session layout under .charm/.
  const paths = charmPaths(opts.root, opts.uuid);
  mkdirSync(paths.charmDir, { recursive: true });
  mkdirSync(paths.runDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });

  if (existsSync(paths.pidFile)) {
    // NB: read synchronously. Bun.file().text() is async — `Number(Promise)`
    // is always NaN, which previously made this guard refuse *every* start
    // whenever any pidfile existed, even after a clean crash.
    const recorded = Number(readFileSync(paths.pidFile, "utf8").trim());
    if (Number.isInteger(recorded) && recorded > 0 && isProcessAlive(recorded)) {
      console.error(`[charmd] already running (pid=${recorded}); refusing to start a second daemon.`);
      process.exit(2);
    }
    // Stale pidfile (dead pid, or unparseable from a partial write). Reclaim it
    // instead of wedging — otherwise a crash permanently blocks restart until
    // someone hand-removes the file.
    console.error(`[charmd] removing stale pidfile (pid=${recorded}) from a prior crash`);
    try { unlinkSync(paths.pidFile); } catch { /* ignore */ }
  }
  writeFileSync(paths.pidFile, String(process.pid));

  // Write a per-session MCP config with CHARM_SOCKET in the env block.
  // This guarantees each session's charm-mcp is a distinct process: Claude Code
  // keys its MCP server registry on (command + env), so different sockets produce
  // different instances. Without this, all sessions share the one charm-mcp that
  // was started first — closing session A kills it and breaks every other session.
  {
    const mcpBin = process.env.CHARM_MCP_BIN ?? "charm-mcp";
    const cfg = {
      mcpServers: {
        charm: { command: mcpBin, args: [], env: { CHARM_SOCKET: paths.socket } },
      },
    };
    writeFileSync(paths.sessionMcpConfig, JSON.stringify(cfg, null, 2) + "\n");
  }

  ensureDirectoryTrusted(paths.root);

  const store = new TicketStore(paths);
  // Rebuild the sqlite index from the ticket .md files on disk. A single corrupt
  // / unparseable ticket file must not crash the daemon on boot — guard the
  // rebuild so a bad file is logged and the daemon still comes up with whatever
  // indexed cleanly. (The per-file skip lives in the store's rebuild loop; this
  // is the boot-time backstop so a rebuild that still throws can't abort start.)
  try {
    store.reindexAll();
  } catch (e) {
    console.error("[charmd] reindexAll failed on boot; starting with a partial index:", e);
  }
  const registry = new AgentRegistry();
  // Owns the git plumbing for orchestrator-managed worktrees (the side-resource
  // model: parallel branches checked out under ~/.charm-worktrees/<repo>/<name>/)
  // plus the prune safety-net for orphans a crashed daemon left behind.
  const worktrees = new WorktreeManager({ root: paths.root, worktreesDir: paths.worktreesDir });
  // Prune-on-boot safety-net: a daemon that crashed mid-session may have left
  // orphan worktrees (registry entries whose dir vanished, or dirs git no longer
  // tracks) under ~/.charm-worktrees/<repo>/. Reconcile them now so a fresh session starts
  // clean. Best-effort: a non-repo or transient git failure must not abort boot.
  try { worktrees.prune(); } catch (e) {
    console.error(`[charmd] worktree prune on boot failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
  const coord = new CoordinationWriter(paths);
  // A lock file present now is a crash leftover (the pidfile guard above already
  // proved no other daemon is live) — clear it so withLock doesn't freeze the
  // loop for 5s on the first write.
  coord.clearStaleLock();
  const tmux = new Tmux(session);
  const approvals = new ApprovalQueue();

  const tmuxAvailable = Tmux.available();
  if (!tmuxAvailable) {
    console.error("[charmd] WARNING: tmux not on PATH; spawning panes will fail.");
  }

  // The set of tickets whose files are currently claimed by a live worker, used
  // by the solver to defer any candidate whose `touches` overlap. CRITICAL:
  // `spawning` agents are included, not just running/blocked ones. A freshly
  // spawned worker sits in `spawning` for the whole splitPane subprocess; if its
  // claim weren't visible until it flipped to `running`, a concurrent
  // spawn_workers / request_review could solve against a stale view and pick a
  // ticket touching the same file — two workers editing one file (BUG: spawn-race
  // double-spawn). Claiming at `spawning` closes that window, provided the
  // read-solve-spawn section runs under the same critical section that flips the
  // new agent to `spawning` (see spawnAgent / the layout lock). The claim also
  // OUTLIVES `done`/`failed` (holdsTicketClaim is not gated on occupiesLiveSlot):
  // a worker reporting done without the lock would otherwise drop its claim while
  // its process is still flushing writes — the claim releases only on teardown
  // (registry.remove), closing that tail of the spawn-race.
  const inFlight = (): InFlight[] =>
    registry
      .list()
      .filter(holdsTicketClaim)
      .map((a) => {
        const t = store.read(a.ticket_id!);
        return { ticket_id: a.ticket_id!, touches: t?.frontmatter.touches ?? [] };
      });

  // Hard ceiling on concurrent agent sessions (tmux panes / live Claude processes)
  // in this charm, INCLUDING the orchestrator. Set at `charm start` via
  // --max-agents (CHARM_MAX_AGENTS); defaults to 10. The CLI validates it, but a
  // bare `charmd` may have it unset/garbage, so re-floor here.
  const maxAgents = (() => {
    const raw = Number(process.env.CHARM_MAX_AGENTS);
    return Number.isInteger(raw) && raw >= 1 ? raw : 10;
  })();

  // Agents occupying a live slot: the orchestrator (always present once its pane
  // is registered — it isn't in the registry) plus every sub-agent that's
  // spawning/running/blocked. done/failed agents are reaped and free their slot.
  const liveAgentCount = (): number =>
    (orchestratorPaneId ? 1 : 0) +
    registry.list().filter((a) => occupiesLiveSlot(a.state)).length;

  // Slots left before the cap. Batch spawners clamp to this so they never spawn
  // past the ceiling (and report the rest as deferred for a later retry).
  const remainingAgentSlots = (): number => Math.max(0, maxAgents - liveAgentCount());

  // Recompute COORDINATION.md from current state: one row per live ticket (every
  // status except `complete`), driven off the sqlite index — NOT the agent
  // registry. This is the board's whole point: an open-but-unassigned ticket and
  // a failed-but-needs-attention ticket both belong on it, neither of which has a
  // live agent. We join the registry only to annotate which sub-agent (if any) is
  // currently on each ticket. Fully derived, rebuilt and rewritten on every
  // change, so it stays small no matter how long the run.
  const refreshCoordination = () => {
    // A ticket can carry more than one non-main agent at once (e.g. a worker plus
    // a tester), so map ticket -> LIST of agents rather than a single
    // entry. The old single-entry map silently overwrote the first agent with the
    // second, hiding one of them from the board.
    const agentsByTicket = new Map<string, { id: string; state: string }[]>();
    for (const a of registry.list()) {
      if (a.role !== "main" && a.ticket_id) {
        const list = agentsByTicket.get(a.ticket_id) ?? [];
        list.push({ id: a.id, state: a.state });
        agentsByTicket.set(a.ticket_id, list);
      }
    }
    const rows = store.queryIndex({ statuses: COORDINATION_STATUSES }).map((t) => {
      const agents = agentsByTicket.get(t.id) ?? [];
      // CoordRow shows one agent slot, so when several share a ticket, join their
      // ids/states into the rendered cell rather than dropping all but one.
      return {
        ticket_id: t.id,
        about: t.title,
        stage: t.stage,
        status: t.status,
        agent_id: agents.length === 0 ? null : agents.map((a) => a.id).join(", "),
        agent_state: agents.length === 0 ? null : agents.map((a) => a.state).join(", "),
      };
    });
    coord.write(rows);
  };

  // Pane layout state. consolePaneId is the Ink TUI pane (pinned left column);
  // agentPaneIds is every Claude pane in spawn order, starting with the "main"
  // agent pane registered by `cli.ts start` before any sub-agents.
  let consolePaneId: string | null = null;
  const agentPaneIds: string[] = [];
  // Pane id of the orchestrator (main agent), set on register_panes. The daemon
  // wakes this pane when a sub-agent finishes so the orchestrator can reap it.
  let orchestratorPaneId: string | null = null;

  // Idle-detection state for interactive investigators (see sweepIdleInvestigators).
  // baseline: authored-body byte length captured at spawn — the bar an agent must
  // grow past for "wrote findings" to be true. idleState: the opaque {hash,
  // unchanged_since} blob charm-watch returns each tick, stored verbatim and fed
  // back so the Rust detector can measure how long a pane's screen has been stable.
  const investigatorBaseline = new Map<string, number>();
  const investigatorIdleState = new Map<string, { hash: string; unchanged_since: number }>();
  const WINDOW = "charm";
  // Background holding window for sub-agent panes when the agent region is too
  // narrow to render the grid (see shouldHideSubagents). Panes are moved here with
  // break-pane/join-pane and moved back when room returns; tmux destroys this
  // window automatically once its last pane leaves.
  const SUBAGENT_BG_WINDOW = "subagents";

  // The tmux pane-grid operations (splitPane/killPane/relayout) are now async and
  // mutate shared state (`agentPaneIds`) and the window layout. Serialize them
  // through this promise-chain mutex so two concurrent handlers can't interleave
  // their tmux calls and corrupt the grid. Lightweight RPCs (create_tickets,
  // report_status, list_tickets) do NOT take this lock, so they keep being
  // serviced in the gaps between a spawn's awaited tmux subprocesses — which is
  // the whole point of going async. Errors are swallowed off the chain so one
  // failed layout op can't poison every subsequent one.
  let layoutChain: Promise<unknown> = Promise.resolve();
  // Dedup for the "untracked live pane" relayout warning: an unmanaged live pane
  // in the main window can't be laid out around and can't be safely reaped, so
  // relayout logs it and bails. Without dedup that fires on every relayout
  // trigger (the exact 630-line storm this whole reconcile guards against);
  // remember the last set of stray ids and only re-log when it changes.
  let lastLiveStrayWarning: string | null = null;
  function withLayoutLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = layoutChain.then(fn, fn);
    layoutChain = run.then(() => {}, () => {});
    return run;
  }

  // Hard cap on the console/sidebar column width, in cells. Shared by the full
  // relayout (which bakes it into the layout string) and the console-only clamp
  // (which snaps just this column back to it on a manual divider drag).
  const MAX_CONSOLE_WIDTH = 32;

  // Move all sub-agent panes OUT of the main window into the background holding
  // window, leaving the main window showing only console + orchestrator. The
  // first pane creates the holding window (break-pane); the rest join it. Panes
  // already hidden (or gone) are skipped. Pane ids are stable across window moves,
  // so the registry, orchestrator wake, and auto-reap all keep working on hidden
  // panes. Best-effort per pane: a failed move logs and continues.
  async function hideSubagents(subPaneIds: string[]) {
    const panes = tmux.listPanes();
    const inMain = new Set(panes.filter((p) => p.window_name === WINDOW).map((p) => p.pane_id));
    let holdingExists = panes.some((p) => p.window_name === SUBAGENT_BG_WINDOW);
    for (const id of subPaneIds) {
      if (!inMain.has(id)) continue; // already hidden, or no longer present
      try {
        if (!holdingExists) {
          await tmux.breakPaneToWindow(id, SUBAGENT_BG_WINDOW);
          holdingExists = true;
        } else {
          await tmux.joinPaneToWindow(id, `${tmux.session}:${SUBAGENT_BG_WINDOW}`);
        }
      } catch (e) {
        console.error(`[charmd] hideSubagents: move ${id} failed:`, e);
      }
    }
  }

  // Bring any hidden sub-agent panes back into the main window. tmux destroys the
  // holding window once its last pane leaves; the caller re-applies the grid
  // layout immediately after, which positions the returned panes by index.
  async function restoreSubagents(subPaneIds: string[]) {
    const panes = tmux.listPanes();
    const hidden = new Set(panes.filter((p) => p.window_name !== WINDOW).map((p) => p.pane_id));
    for (const id of subPaneIds) {
      if (!hidden.has(id)) continue;
      try {
        await tmux.joinPaneToWindow(id, `${tmux.session}:${WINDOW}`);
      } catch (e) {
        console.error(`[charmd] restoreSubagents: move ${id} failed:`, e);
      }
    }
  }

  // The actual relayout work, assuming the caller already holds the layout lock.
  // agentPaneIds[0] is the orchestrator (main agent), [1..] the sub-agents in
  // spawn order. When the agent region is too narrow to render the sub-grid at the
  // minimum per-pane width, the sub-agents are moved to a background window and
  // the orchestrator fills the region (Peter's "hide all sub-agents" rule).
  async function relayoutLocked() {
    if (!tmuxAvailable || !consolePaneId || agentPaneIds.length === 0) return;
    try {
      const win = await tmux.windowSize(WINDOW);
      const orchPaneId = agentPaneIds[0]!;
      const subPaneIds = agentPaneIds.slice(1);

      // Preserve whatever width the console column currently has -- the user may
      // have dragged the divider, narrower or wider. No minimum: the user can
      // shrink it freely. The only constraints are MAX_CONSOLE_WIDTH (the cap the
      // user asked for) and never wider than the window minus 20 so the agent grid
      // keeps room. Fall back to a 35% share only on the first layout, when the
      // pane hasn't been sized yet. A manual divider drag does NOT come through
      // here -- it routes to clampConsoleLocked (see the hook split in cli.ts).
      const cur = await tmux.paneWidth(consolePaneId);
      const consoleWidth = Math.max(
        1,
        Math.min(MAX_CONSOLE_WIDTH, win.w - 20, cur ?? Math.floor(win.w * 0.35)),
      );

      const agentW = win.w - consoleWidth - 1;
      const n = subPaneIds.length;
      const hide = shouldHideSubagents(agentW, n);

      // Reconcile background-window placement BEFORE reading the fresh pane
      // indexes the layout string needs (the moves renumber panes).
      if (n > 0) {
        if (hide) await hideSubagents(subPaneIds);
        else await restoreSubagents(subPaneIds);
      }

      // Reconcile STRAY panes before building the layout. select-layout counts
      // panes: it hard-fails ("have N panes but need M") unless the layout string
      // enumerates every pane in the window. After the hide/restore step the main
      // window should hold exactly what this layout lists — console + orchestrator
      // + the visible sub-agents — so any OTHER pane is a desync that breaks EVERY
      // relayout until it's gone (this guards the observed failure: one untracked
      // pane -> 630 identical select-layout errors in a tight retrigger loop).
      // A stray DEAD pane is a zombie a prior kill-pane failed to remove: kill it
      // here and the count converges. A stray LIVE pane can't be safely reaped (it
      // may be an operator's own shell), so warn once (deduped) and skip — a layout
      // we can't apply isn't worth flooding the log over, and once that pane exits
      // it becomes a dead stray the next tick cleans up.
      {
        const expected = new Set<string>([consolePaneId, orchPaneId]);
        if (!hide) for (const id of subPaneIds) expected.add(id);
        const stray = tmux
          .listPanes()
          .filter((p) => p.window_name === WINDOW && !expected.has(p.pane_id));
        for (const p of stray.filter((p) => p.dead)) {
          console.error(`[charmd] relayout: killing stray dead pane ${p.pane_id} in ${WINDOW}`);
          if (!(await tmux.killPane(p.pane_id)))
            console.error(
              `[charmd] relayout: kill-pane ${p.pane_id} failed; grid layout will keep failing until it's gone`,
            );
        }
        const liveStray = stray.filter((p) => !p.dead).map((p) => p.pane_id);
        if (liveStray.length > 0) {
          const ids = liveStray.join(", ");
          if (lastLiveStrayWarning !== ids) {
            console.error(
              `[charmd] relayout: ${liveStray.length} untracked live pane(s) in ${WINDOW} (${ids}); ` +
                `skipping grid layout until they leave the window`,
            );
            lastLiveStrayWarning = ids;
          }
          return;
        }
        lastLiveStrayWarning = null;
      }

      const cIdx = await tmux.paneIndex(consolePaneId);
      if (cIdx === null) return;
      const orchIdx = await tmux.paneIndex(orchPaneId);
      if (orchIdx === null) return;
      // Orchestrator first; then the visible sub-agents (none when hidden, so the
      // orchestrator fills the whole agent region).
      const agentIdxs = [orchIdx];
      if (!hide) {
        for (const pid of subPaneIds) {
          const idx = await tmux.paneIndex(pid);
          if (idx !== null) agentIdxs.push(idx);
        }
      }

      const layout = buildLayoutString({
        windowWidth: win.w,
        windowHeight: win.h,
        consolePaneIndex: cIdx,
        agentPaneIndexes: agentIdxs,
        consoleWidth,
      });
      // Apply only when the live geometry differs from the target. This both
      // ENFORCES the console cap (a divider drag that makes the real layout differ
      // gets snapped back) and BREAKS the window-layout-changed feedback loop (once
      // the real layout equals the target, the next hook firing recomputes the same
      // target, sees it already matches, and skips). Compare without the leading
      // checksum, which can differ harmlessly.
      const dropChecksum = (s: string) => s.slice(s.indexOf(",") + 1);
      const current = await tmux.currentLayout(WINDOW);
      if (current && dropChecksum(current) === dropChecksum(layout)) return;
      await tmux.applyLayout(WINDOW, layout);
    } catch (e) {
      console.error("[charmd] relayout failed:", e);
    }
  }

  /** Standalone relayout (takes the lock). Use from handlers that aren't already
   *  inside a withLayoutLock section (e.g. register_panes). */
  const relayout = () => withLayoutLock(relayoutLocked);

  // Console-only clamp: enforce MAX_CONSOLE_WIDTH on the sidebar column WITHOUT
  // recomputing the agent grid. This is the manual-drag path (the
  // window-layout-changed hook). The agent panes have no width policy — the user
  // is meant to drag their dividers freely — so re-applying a full computed
  // layout on every frame of a drag was pure friction: the daemon read a stale
  // mid-drag width snapshot, rebuilt a layout from it, and select-layout snapped
  // the cursor back to where it was ~50ms ago (a tug-of-war), while proportional
  // re-scaling rounding nudged dividers the user never touched. So here we only
  // touch the one column that actually has a cap: if the sidebar got dragged
  // past the cap, resize JUST it back (tmux hands the reclaimed columns to the
  // adjacent orchestrator pane and leaves the agent grid alone); otherwise this
  // is a no-op and the drag is honored exactly. Full relayout still runs on
  // spawn/kill (direct relayoutLocked calls) and terminal resize (client-resized).
  async function clampConsoleLocked() {
    if (!tmuxAvailable || !consolePaneId || agentPaneIds.length === 0) return;
    try {
      const cur = await tmux.paneWidth(consolePaneId);
      if (cur === null) return;
      const win = await tmux.windowSize(WINDOW);
      const target = Math.max(1, Math.min(MAX_CONSOLE_WIDTH, win.w - 20));
      if (cur <= target) return; // within the cap — honor the drag, touch nothing
      await tmux.resizePaneWidth(consolePaneId, target);
    } catch (e) {
      console.error("[charmd] console clamp failed:", e);
    }
  }
  const clampConsole = () => withLayoutLock(clampConsoleLocked);

  // The core spawn, assuming the caller already holds the layout lock. This is
  // the read-solve-spawn critical section's building block: registry.create()
  // immediately flips the new agent to `spawning`, and because inFlight() counts
  // `spawning` agents, the agent's `touches` claim is visible the instant this
  // returns — to any handler that next acquires the lock. Batch spawners
  // (spawn_workers/spawn_investigators) call this inside ONE withLayoutLock that
  // wraps their whole solve+loop, so a concurrent spawner can't solve against a
  // pre-claim view and double-spawn onto the same file (BUG: spawn-race
  // double-spawn). Must NOT take the lock itself — the mutex is a non-reentrant
  // promise chain, so re-entering it from within a held section would deadlock.
  async function spawnAgentLocked(spec: SpawnSpec, parentId: string | null = null): Promise<string> {
    // Hard cap guard — the single chokepoint every spawn path flows through, so
    // no caller can exceed the ceiling even if a batch clamp is wrong. Batch
    // spawners pre-clamp to remainingAgentSlots() and never reach this throw;
    // it's the safety net for the single-spawn paths (e.g. request_review).
    // Inside the lock, so concurrent spawns can't both pass the check and
    // overshoot the ceiling.
    if (liveAgentCount() >= maxAgents) {
      throw new Error(
        `agent cap reached: ${liveAgentCount()}/${maxAgents} live (incl. orchestrator). ` +
          `Wait for an agent to finish, or restart with a higher --max-agents.`,
      );
    }
    // Mint the Claude-side conversation id here so charm both passes it to
    // `claude --session-id` AND records it on the registry entry — the two must
    // match for a later `claude --resume`/`--continue` to land on this session.
    const claudeSessionId = newClaudeSessionId();
    // parentId is the authorizing caller_id (the spawning orchestrator), recorded
    // on the child so the status RPC can derive the agent hierarchy. Passed as a
    // separate arg rather than on SpawnSpec to keep the spec type (in spawn.ts)
    // untouched.
    const agent = registry.create({ role: spec.role, ticket_id: spec.ticket_id, parent_id: parentId, claude_session_id: claudeSessionId });
    try {
      const resolved: SpawnSpec = { ...spec, model: spec.model ?? defaultModelForRole(spec.role), claudeSessionId };
      const cmd = buildClaudeCommand(paths, agent.id, resolved);
      // Pre-approve the agent's working directory BEFORE launching. NON-NEGOTIABLE:
      // an unattended agent in an untrusted dir hangs forever on Claude Code's "Do
      // you trust this directory?" dialog — `--permission-mode auto` does NOT skip
      // it. paths.root is already trusted at boot, so only a worktree cwd needs it.
      if (spec.cwd && spec.cwd !== paths.root) ensureDirectoryTrusted(spec.cwd);
      // Target THIS session's window explicitly. charm runs every session on the
      // default tmux server, and the daemon is a detached process: a `split-window`
      // with no `-t` lands in tmux's global "current session", which the daemon does
      // not control. With two charm sessions live, that can place this session's
      // sub-agent pane inside the OTHER session's window (breaking this session's
      // relayout and polluting the other's). Pinning to `${session}:${WINDOW}` keeps
      // the pane in the session that owns the agent.
      const pane = await tmux.splitPane({ cmd, cwd: spec.cwd ?? paths.root, direction: "h", target: `${session}:${WINDOW}` });
      registry.attach(agent.id, { pane_id: pane });
      // Stamp the new pane's status bar: charm id + running (blue) state. Cosmetic,
      // best-effort — never let a border update fail a spawn.
      try {
        await tmux.setPaneLabel(pane, agent.id);
        await tmux.setPaneState(pane, agent.state);
      } catch { /* border is cosmetic */ }
      // Record which worktree this agent is isolated in (the subdir name under
      // ~/.charm-worktrees/<repo>/), so list_worktrees can annotate each worktree with its
      // occupying agent. A non-worktree spawn (cwd === root) leaves it null.
      if (spec.cwd && spec.cwd !== paths.root) registry.setWorktree(agent.id, basename(spec.cwd));
      refreshCoordination();
      agentPaneIds.push(pane);
      await relayoutLocked();
      return agent.id;
    } catch (e) {
      // Roll back the just-created registry entry. registry.create() flips it to
      // `spawning` immediately (so its touches-claim is visible), but if the spawn
      // throws before/at splitPane the entry would otherwise sit in `spawning`
      // forever — occupiesLiveSlot counts it against maxAgents, and the dead-pane
      // sweep skips any agent with no pane_id, so the slot is never reclaimed. If a
      // pane was already created before the failure, kill it so it doesn't dangle.
      const stranded = registry.get(agent.id);
      if (stranded?.pane_id) {
        try {
          await tmux.killPane(stranded.pane_id);
        } catch {
          /* best effort */
        }
        const i = agentPaneIds.indexOf(stranded.pane_id);
        if (i >= 0) agentPaneIds.splice(i, 1);
      }
      registry.remove(agent.id);
      throw e;
    }
  }

  /** Public single-spawn entry point: takes the layout lock around one
   *  spawnAgentLocked. Used by single-spawn paths (request_review). Batch
   *  spawners do NOT use this — they take the lock once around their whole
   *  solve+loop and call spawnAgentLocked directly, so the solve and every spawn
   *  in the batch share one critical section. */
  function spawnAgent(spec: SpawnSpec, parentId: string | null = null): Promise<string> {
    return withLayoutLock(() => spawnAgentLocked(spec, parentId));
  }

  /** Resolve an optional worktree NAME (from a spawn RPC) to the cwd an agent
   *  should run in, or undefined for default shared-tree execution. The name is a
   *  plain segment naming an already-open worktree under ~/.charm-worktrees/<repo>/; we
   *  guard it with assertPlainName (same path-injection guard create_worktree
   *  uses) and require the checkout to already exist, so a typo'd or never-opened
   *  worktree fails loud here instead of spawning an agent into a missing dir.
   *  Once resolved, spawnAgentLocked's existing cwd path trusts the dir and
   *  records worktree_name via setWorktree — the field that is otherwise always
   *  null because no caller passed a cwd before this. */
  function resolveSpawnCwd(worktree: string | undefined): string | undefined {
    if (!worktree) return undefined;
    assertPlainName(worktree);
    const dir = worktreePathFor(paths, worktree);
    if (!existsSync(dir)) {
      throw new Error(
        `worktree "${worktree}" not found at ${dir} — open it with create_worktree before spawning into it`,
      );
    }
    return dir;
  }

  /** The path a spawned agent should READ its ticket from. Tickets are gitignored
   *  (see .charm/.gitignore — only kb/proposals/scratchpad/skills are re-included),
   *  so a worktree checkout has no .charm/tickets/ of its own. When an agent runs in
   *  a worktree (cwd set), point it at the MAIN repo's canonical ticket file via an
   *  absolute path; in the shared tree (cwd undefined) cwd IS the main repo, so the
   *  relative path resolves there unchanged. Only this initial read needs the
   *  redirect — every ticket MUTATION (update_plan, set_ticket_status, report_status)
   *  already flows through the daemon to the central main-repo store regardless of cwd. */
  function ticketReadPath(ticketId: string, cwd: string | undefined): string {
    return cwd ? join(paths.root, ".charm", "tickets", `${ticketId}.md`) : `.charm/tickets/${ticketId}.md`;
  }

  /** Kill an agent's pane and drop it from the registry, coordination doc, and
   *  pane grid, then relayout. Shared by dismiss_agent (done/failed cleanup) and
   *  kill_agent (forced termination). No-op if the agent is already gone. */
  function tearDownAgent(agent_id: string): Promise<void> {
    // Whoever tears this agent down first wins — a manual kill_agent,
    // cancel_ticket, a terminal set_ticket_state, the liveness sweep, or the
    // auto-reap timer itself. Cancel any pending auto-reap synchronously so it
    // can't fire a second, redundant teardown after this one completes.
    cancelAutoReap(agent_id);
    return withLayoutLock(async () => {
      const a = registry.get(agent_id);
      if (!a) return;
      if (a.pane_id) {
        try { await tmux.killPane(a.pane_id); } catch { /* ignore */ }
        const i = agentPaneIds.indexOf(a.pane_id);
        if (i >= 0) agentPaneIds.splice(i, 1);
      }
      // If the dying agent was parked in await_approval, its gate would otherwise
      // sit in the queue forever — a zombie row on the board and a Promise that
      // never resolves. Cancel (reject) any gate it owned so the parked call
      // returns and the board drops the gate.
      const cancelledGates = approvals.cancelForAgent(agent_id);
      if (cancelledGates.length > 0) {
        console.error(`[charmd] tearDownAgent: cancelled ${cancelledGates.length} pending gate(s) owned by ${agent_id}`);
      }
      registry.remove(agent_id);
      refreshCoordination();
      await relayoutLocked();
    });
  }

  /** Tear down EVERY non-main agent currently on a ticket, not just the first.
   *  A ticket can legitimately carry more than one helper at a time (a worker
   *  plus a tester), and the registry's old one-agent-per-ticket lookup
   *  (`.find`) silently reaped only one, leaking the rest. This filters all of
   *  them and tears each down. Returns the agent ids it reaped. */
  function tearDownTicketAgents(ticket_id: string): Promise<string[]> {
    const ids = registry
      .list()
      .filter((a) => a.role !== "main" && a.ticket_id === ticket_id)
      .map((a) => a.id);
    return Promise.all(ids.map((id) => tearDownAgent(id))).then(() => ids);
  }

  /** Resolve the role of a kill_agent caller. The human operator (Console pane)
   *  sends no caller_id and is treated as a privileged operator. An agent caller
   *  is identified by CHARM_AGENT_ID: the orchestrator's fixed id resolves to
   *  "main"; any other id is looked up in the registry. */
  function resolveCaller(caller_id: string | undefined): "operator" | AgentRole {
    if (caller_id === undefined) return "operator";
    if (caller_id === MAIN_AGENT_ID) return "main";
    const a = registry.get(caller_id);
    if (!a) throw new Error(`unknown caller agent: ${caller_id}`);
    return a.role;
  }

  // Lock fan-out + ticket-authoring tools (spawn_workers, spawn_investigators,
  // request_review, create_tickets, promote) to the orchestrator. Only the
  // orchestrator spawns sub-agents and authors tickets; a worker/investigator/tester
  // calling these is a confused agent fanning out its own fleet. The human
  // operator (console/CLI, no caller_id -> "operator") is always allowed.
  function assertOrchestrator(caller_id: string | undefined, tool: string): void {
    const role = resolveCaller(caller_id);
    if (role !== "operator" && role !== "main" && role !== "suborchestrator") {
      throw new Error(
        `agent ${caller_id} (${role}) may not call ${tool}; only the orchestrator or suborchestrator spawns sub-agents and authors tickets`,
      );
    }
  }

  // Wake the orchestrator when sub-agents change state, so it can reap finished
  // panes and advance the workflow. Bursts are coalesced into a single wake: if
  // five workers finish at once the orchestrator (on Opus) takes one turn, not
  // five. Events accumulate for a short window, then flush as one injected line.
  let pingPending: string[] = [];
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  function pingOrchestrator(event: string) {
    if (!tmuxAvailable || !orchestratorPaneId) return;
    pingPending.push(event);
    if (pingTimer) return; // already armed — coalesce into the pending flush
    pingTimer = setTimeout(async () => {
      const events = pingPending;
      pingPending = [];
      pingTimer = null;
      try {
        // The pane may have vanished OR died (orchestrator exited) during the
        // window. paneAlive — not paneIndex — because remain-on-exit keeps a dead
        // pane indexable; sending into a corpse would be a silent no-op.
        if (!orchestratorPaneId || !(await tmux.paneAlive(orchestratorPaneId))) return;
        // One line only: literal newlines typed into the pane would submit early.
        // Keep it short — the full reap/resume/abandon protocol lives in the
        // orchestrator prompt; this is just the wake + what changed.
        const line =
          `[charm] ${events.join("; ")}. Resolve any blocks and advance per your orchestrator instructions.`;
        await tmux.sendText(orchestratorPaneId, line);
      } catch (e) { console.error("[charmd] pingOrchestrator failed:", e); }
    }, 1200);
  }

  // --- Auto-reap of finished agents ----------------------------------------
  // A sub-agent that reports a terminal state (`done`/`failed`) leaves its pane
  // standing: its interactive Claude process idles in the REPL until something
  // tears it down. Historically that teardown was the orchestrator's job — it
  // called kill_agent on every finished agent — which burns an orchestrator
  // turn (and tokens) on pure bookkeeping that conveys no decision. So the
  // daemon reaps finished agents itself, a short grace after they report. The
  // orchestrator is STILL pinged (report_status pings on done/failed/blocked)
  // so it can advance the workflow — spawn the next wave, synthesize findings,
  // resolve blocks — it just no longer has to do the reaping.
  //
  // The grace period is deliberate: it lets the agent's process flush any final
  // writes and exit, and is well inside the window the manual reap already
  // operated in (the orchestrator could take many seconds to get around to a
  // kill_agent). Teardown still goes through tearDownAgent, which takes the
  // layout lock and releases the touches-claim only at registry.remove() — so
  // this changes nothing about the spawn-race claim discipline.
  //
  // `blocked` is NOT auto-reaped: that agent's process is alive and waiting for
  // the orchestrator's continue_agent. Set CHARM_AUTO_REAP_MS to tune the grace
  // (0 disables auto-reap entirely, restoring the manual-kill-only behavior).
  const AUTO_REAP_MS = (() => {
    const raw = Number(process.env.CHARM_AUTO_REAP_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
  })();
  const autoReapTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // After a done worker's claim is released at teardown, decide whether that
  // release is actually actionable to the orchestrator — i.e. it unblocks a
  // ticket that was deferred PURELY because its files overlapped this worker's
  // claim. The claim outlives `done` (holdsTicketClaim isn't gated on the live
  // slot) and only drops at registry.remove, so such a dependent stays deferred
  // through the auto-reap grace; the release is what opens it, and it needs its
  // own ping because the report_status `done` ping fired while the claim was
  // still held. But that only matters when something overlaps — every OTHER
  // done worker was already fully covered by the report_status ping, so firing
  // a second near-identical "file claim released" line for it is pure noise
  // (two wake lines per finish). Gate the second ping on a real overlap.
  //
  // Test: run the solver against current state (post-teardown, so this worker's
  // claim is gone and its ticket is `complete`). Any runnable ticket that
  // touches a path this worker just freed was, by definition, blocked by that
  // claim a moment ago — the solver defers on touch overlap — so its presence
  // in the runnable set now is exactly the frontier this release opened. A
  // dependent unblocked only by depends_on (no file overlap) is already covered
  // by the report_status ping, which named the completed ticket.
  function releaseOpensFrontier(freedTicketId: string): boolean {
    const t = store.read(freedTicketId);
    const freed = new Set(t?.frontmatter.touches ?? []);
    if (freed.size === 0) return false; // claimed no files -> released nothing
    const all = store.list();
    const completed = new Set(
      all.filter((x) => x.frontmatter.status === "complete").map((x) => x.frontmatter.id),
    );
    let runnable: string[];
    try {
      runnable = new Solver(all).nextRunnable({ completed, inFlight: inFlight() });
    } catch {
      // A malformed graph (cycle / dangling dep) is surfaced loudly elsewhere;
      // don't let it swallow the ping here — fall back to firing it.
      return true;
    }
    const byId = new Map(all.map((x) => [x.frontmatter.id, x]));
    return runnable.some((id) =>
      (byId.get(id)?.frontmatter.touches ?? []).some((p) => freed.has(p)),
    );
  }

  function scheduleAutoReap(agentId: string): void {
    if (AUTO_REAP_MS === 0) return; // auto-reap disabled
    if (autoReapTimers.has(agentId)) return; // already armed — first report wins
    const timer = setTimeout(() => {
      autoReapTimers.delete(agentId);
      const a = registry.get(agentId);
      // Reap only if it's still present AND still finished. done/failed are
      // terminal so a flip back shouldn't happen, but guard anyway so we never
      // tear down an agent that somehow re-entered a live state.
      if (!a || (a.state !== "done" && a.state !== "failed")) return;
      // A done worker holds its `touches`-claim until teardown (holdsTicketClaim
      // is released only at registry.remove, NOT at report_status). So its
      // teardown here is what opens the dependency frontier for any ticket whose
      // files overlap it — and a dependent wave the orchestrator tried to spawn
      // during the grace would have been deferred. Re-ping AFTER teardown so it
      // retries that frontier. Only a `done` worker can open a frontier this way:
      // a `failed` worker's ticket isn't `complete`, so its dependents stay
      // blocked regardless; investigators/testers hold no claim.
      const openedFrontier = a.role === "worker" && a.state === "done";
      const ticketId = a.ticket_id;
      console.error(
        `[charmd] auto-reap: tearing down finished agent ${agentId} (${a.role}, ${a.state}) ` +
          `after ${AUTO_REAP_MS}ms grace.`,
      );
      void tearDownAgent(agentId)
        .then(() => {
          // Fire the release ping ONLY when the freed claim actually opens a
          // deferred dependent. `openedFrontier` (worker+done) is the cheap
          // pre-gate; releaseOpensFrontier is the precise one, evaluated
          // post-teardown so it sees the claim already gone.
          if (openedFrontier && ticketId && releaseOpensFrontier(ticketId)) {
            pingOrchestrator(
              `${agentId} -> done${ticketId ? ` on ${ticketId}` : ""}. Its file claim is now released`,
            );
          }
        })
        .catch((e) => console.error(`[charmd] auto-reap teardown of ${agentId} failed:`, e));
    }, AUTO_REAP_MS);
    // A pending reap timer must not, by itself, keep the daemon's event loop
    // alive across shutdown.
    if (typeof timer.unref === "function") timer.unref();
    autoReapTimers.set(agentId, timer);
  }

  function cancelAutoReap(agentId: string): void {
    const t = autoReapTimers.get(agentId);
    if (t) { clearTimeout(t); autoReapTimers.delete(agentId); }
  }

  // --- Dead-pane liveness sweep --------------------------------------------
  // The daemon only learns a sub-agent finished when that agent calls
  // report_status. An agent whose Claude process exits or crashes WITHOUT a
  // clean report (ran out of turn, OOM, kill -9, a dead MCP shim) leaves two
  // pieces of garbage: a dead tmux pane (session-level `remain-on-exit on` keeps
  // it on screen) AND a stranded registry entry that never frees its
  // concurrent-agent slot — so the cap silently clogs over time until the fleet
  // can't spawn. Nothing else reaps these; tearDownAgent is only ever driven by
  // an explicit RPC. This sweep reconciles the registry against tmux ground
  // truth on a timer: any agent we believe is alive whose pane is gone / marked
  // dead / whose process id is gone is reaped — its ticket is reset to `failed`
  // (stays on the board so the system can retry it), its pane + slot are freed,
  // and the orchestrator is pinged to advance.
  const SWEEP_MS = 15_000;
  // A `blocked` agent's Claude process is alive (idle, awaiting continue_agent),
  // so it is never seen dead and never falsely reaped. To avoid racing a pane
  // that's a tick away from a normal teardown (e.g. kill_agent defers its own
  // teardown ~50ms), only reap after an agent is seen dead on two consecutive
  // sweeps.
  const deadStreak = new Map<string, number>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let investigatorSweepTimer: ReturnType<typeof setInterval> | null = null;

  function sweepDeadPanes() {
    if (!tmuxAvailable) return;
    let panes: { pane_id: string; pid: number; dead: boolean }[];
    try {
      panes = tmux.listPanes();
    } catch (e) {
      console.error("[charmd] sweep: listPanes failed:", e);
      return;
    }
    // Empty means the tmux query failed (status != 0 -> []), NOT that every pane
    // vanished: a live session always has at least the console + orchestrator
    // panes. Reaping off a failed query would mass-kill the fleet, so skip the
    // tick and try again next time.
    if (panes.length === 0) return;
    const byPane = new Map(panes.map((p) => [p.pane_id, p]));
    for (const a of registry.list()) {
      // Only agents we believe are live and that own a pane can be leaked.
      if (a.state !== "spawning" && a.state !== "running" && a.state !== "blocked") continue;
      if (!a.pane_id) continue;
      const pane = byPane.get(a.pane_id);
      // Dead if the pane is gone (killed), tmux marks it dead (command exited
      // under remain-on-exit), or its foreground process is no longer alive.
      const dead = !pane || pane.dead || (pane.pid > 0 && !isProcessAlive(pane.pid));
      if (!dead) {
        deadStreak.delete(a.id);
        continue;
      }
      const streak = (deadStreak.get(a.id) ?? 0) + 1;
      deadStreak.set(a.id, streak);
      if (streak < 2) continue; // give a normal teardown one more tick to win
      deadStreak.delete(a.id);
      console.error(
        `[charmd] sweep: reaping dead agent ${a.id} (pane ${a.pane_id}, ticket ${a.ticket_id ?? "-"}); ` +
          `process exited without report_status.`,
      );
      // Reset the ticket so the system can retry it — but ONLY when failing it is
      // actually meaningful. A tester (or any non-worker) dying must not clobber a
      // ticket a worker already drove to complete (that would trigger a redundant
      // retry of finished work). So only a dead WORKER fails its ticket, and even
      // then we skip the write if the ticket is already in a terminal status.
      // Mirrors a self-kill's terminal state (failed/failed): `failed` stays on the
      // board for reassignment rather than dropping off like `cancelled`.
      let failedTicket = false;
      if (a.ticket_id) {
        try {
          const current = store.read(a.ticket_id);
          const status = current?.frontmatter.status;
          const alreadyTerminal = status === "complete" || status === "cancelled";
          if (a.role === "worker" && !alreadyTerminal) {
            store.update(a.ticket_id, { status: "failed", stage: "failed" });
            store.appendLog(a.ticket_id, {
              agent: a.id,
              kind: "failed",
              text: "system: agent pane died without reporting; reaped by the liveness sweep so this ticket can be retried.",
            });
            failedTicket = true;
          } else {
            // A non-worker died, or the ticket is already done/handed-off: reap the
            // pane + slot but leave the ticket's status untouched.
            store.appendLog(a.ticket_id, {
              agent: a.id,
              kind: "reaped",
              text: `system: ${a.role} pane died without reporting; reaped by the liveness sweep (ticket status left as ${status ?? "?"}).`,
            });
          }
        } catch {
          /* ignore — a missing/locked ticket must not abort the sweep */
        }
      }
      tearDownAgent(a.id);
      // Only ping a retry when we actually reset the ticket to failed; reaping a
      // dead helper off an already-finished ticket isn't retry-worthy news.
      if (failedTicket) {
        pingOrchestrator(
          `${a.id} died on ${a.ticket_id ?? "?"} (pane gone, no report_status) — reaped, ticket reset to failed for retry`,
        );
      } else {
        pingOrchestrator(
          `${a.id} (${a.role}) died on ${a.ticket_id ?? "?"} (pane gone, no report_status) — reaped; ticket status left unchanged`,
        );
      }
    }
    // Forget streak bookkeeping for agents that no longer exist.
    for (const id of [...deadStreak.keys()]) if (!registry.get(id)) deadStreak.delete(id);

    // Orphan-pane pass: kill any tmux pane that is marked dead and not owned by
    // a registered agent. These arise when tearDownAgent's kill-pane call fails
    // silently (e.g. remain-on-exit panes that don't respond normally) — the
    // agent drops from the registry but the zombie pane lingers indefinitely.
    const knownPanes = new Set(agentPaneIds);
    // The console pane is tracked separately from agentPaneIds and is NOT an
    // orphan even when it shows up dead — never reap it here. A dead console
    // pane should be respawned (it's the operator's whole window into the run),
    // not killed; reaping it would leave the session blind. At minimum, protect
    // it so the orphan pass can't take it out on the next tick.
    if (consolePaneId) knownPanes.add(consolePaneId);
    for (const pane of panes) {
      if (!pane.dead) continue;
      if (knownPanes.has(pane.pane_id)) continue;
      console.error(`[charmd] sweep: removing orphan dead pane ${pane.pane_id}`);
      // Fire-and-forget (keeps the sweep sync), but DON'T swallow the outcome: a
      // silently-failed kill leaves the zombie in place and breaks every grid
      // relayout, which is exactly how one lingering pane snowballs into a storm.
      const orphanId = pane.pane_id;
      void tmux
        .killPane(orphanId)
        .then((ok) => {
          if (!ok)
            console.error(`[charmd] sweep: kill-pane ${orphanId} failed; zombie pane may linger and break relayout`);
        })
        .catch((e) => console.error(`[charmd] sweep: kill-pane ${orphanId} threw:`, e));
    }
  }

  // --- Idle-investigator done-enforcement -----------------------------------
  // An interactive investigator that writes its findings but forgets the
  // terminal report_status('done') lingers alive in its pane forever — the
  // dead-pane sweep only reaps DEAD panes, and a finished-but-idle Claude REPL is
  // very much alive. So a second sweep catches it: the charm-watch Rust binary
  // reads each investigator's pane (is the screen output-idle?) and ticket (did
  // the authored body grow past its spawn baseline?), and when both hold the
  // daemon auto-completes the ticket and reaps the pane — exactly what the agent's
  // own report_status('done') would have done. Detection (reading + checking)
  // lives in Rust; acting (sqlite, tickets, teardown) stays here, the single owner
  // of that state. CHARM_INVESTIGATOR_IDLE_MS tunes the output-idle grace; 0
  // disables the feature.
  const INVESTIGATOR_IDLE_MS = (() => {
    const raw = Number(process.env.CHARM_INVESTIGATOR_IDLE_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 45_000;
  })();

  // Resolve the charm-watch binary once. Dev runs it from the cargo target; a
  // compiled charmd uses the sibling binary next to it. Missing -> feature off
  // (logged once), so a build without the Rust crate still runs fine.
  let watchBin: string | null | undefined;
  function resolveWatchBin(): string | null {
    if (watchBin !== undefined) return watchBin;
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      process.env.CHARM_WATCH_BIN,
      join(dirname(process.execPath), "charm-watch"),
      resolve(here, "..", "..", "rust", "target", "release", "charm-watch"),
      resolve(here, "..", "..", "rust", "target", "debug", "charm-watch"),
    ].filter((c): c is string => !!c);
    for (const c of candidates) if (existsSync(c)) return (watchBin = c);
    console.error("[charmd] charm-watch binary not found; investigator idle-detection disabled (build with `bun run build:watch`).");
    return (watchBin = null);
  }

  let investigatorSweepBusy = false;
  async function sweepIdleInvestigators() {
    if (INVESTIGATOR_IDLE_MS === 0 || !tmuxAvailable || investigatorSweepBusy) return;
    const bin = resolveWatchBin();
    if (!bin) return;

    // Watch only live, non-blocked investigators that hold a pane, a ticket, and a
    // baseline. A `blocked` agent is legitimately idle awaiting continue_agent, so
    // it's excluded here (the watch-list, not the Rust binary, enforces that).
    const entries: {
      agent_id: string; pane_id: string; ticket_path: string;
      baseline_authored_len: number; prev_hash: string; prev_unchanged_since: number;
    }[] = [];
    for (const a of registry.list()) {
      if (a.role !== "investigator") continue;
      if (a.state !== "running" && a.state !== "spawning") continue;
      if (!a.pane_id || !a.ticket_id) continue;
      const baseline = investigatorBaseline.get(a.id);
      if (baseline === undefined) continue;
      const t = store.read(a.ticket_id);
      if (!t) continue;
      const prev = investigatorIdleState.get(a.id);
      entries.push({
        agent_id: a.id, pane_id: a.pane_id, ticket_path: t.path,
        baseline_authored_len: baseline,
        prev_hash: prev?.hash ?? "", prev_unchanged_since: prev?.unchanged_since ?? 0,
      });
    }
    // Drop idle/baseline state for agents that are gone, regardless of this tick.
    for (const id of [...investigatorIdleState.keys()]) if (!registry.get(id)) investigatorIdleState.delete(id);
    for (const id of [...investigatorBaseline.keys()]) if (!registry.get(id)) investigatorBaseline.delete(id);
    if (entries.length === 0) return;

    investigatorSweepBusy = true;
    try {
      const payload = JSON.stringify({
        log_begin: LOG_BEGIN, log_end: LOG_END,
        idle_threshold_secs: Math.floor(INVESTIGATOR_IDLE_MS / 1000),
        entries,
      });
      let out: string;
      try {
        const proc = Bun.spawn([bin], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        proc.stdin.write(payload);
        proc.stdin.end();
        const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        if (code !== 0) {
          console.error(`[charmd] charm-watch exited ${code}: ${(await new Response(proc.stderr).text()).trim()}`);
          return;
        }
        out = stdout;
      } catch (e) {
        console.error("[charmd] charm-watch spawn failed:", e);
        return;
      }

      let verdicts: {
        agent_id: string; hash: string; unchanged_since: number;
        idle_secs: number; findings_written: boolean; finished: boolean;
      }[];
      try {
        verdicts = JSON.parse(out);
      } catch {
        console.error("[charmd] charm-watch returned unparseable output:", out.slice(0, 200));
        return;
      }

      for (const v of verdicts) {
        // Persist the opaque idle blob for next tick (skip captures that failed,
        // marked by an empty hash, so a transient tmux hiccup doesn't reset state).
        if (v.hash) investigatorIdleState.set(v.agent_id, { hash: v.hash, unchanged_since: v.unchanged_since });
        if (!v.finished) continue;

        // Re-validate against current state — the agent may have reported done,
        // blocked, or been reaped between building the list and now.
        const a = registry.get(v.agent_id);
        if (!a || a.role !== "investigator" || !a.ticket_id) continue;
        if (a.state !== "running" && a.state !== "spawning") continue;

        try {
          const cur = store.read(a.ticket_id);
          const status = cur?.frontmatter.status;
          if (status !== "complete" && status !== "cancelled") {
            store.update(a.ticket_id, { status: "complete", stage: "done" });
            store.appendLog(a.ticket_id, {
              agent: a.id,
              kind: "done",
              text: `system: findings written and pane idle ${v.idle_secs}s without report_status; auto-completed by idle-detection.`,
            });
          }
        } catch (e) {
          console.error(`[charmd] idle-detection: completing ${a.ticket_id} failed:`, e);
          continue;
        }
        investigatorIdleState.delete(a.id);
        investigatorBaseline.delete(a.id);
        refreshCoordination();
        pingOrchestrator(`${a.id} -> done on ${a.ticket_id} (idle-detected: findings written, ${v.idle_secs}s silent, auto-completed)`);
        await tearDownAgent(a.id);
      }
    } finally {
      investigatorSweepBusy = false;
    }
  }

  const server = startRpcServer(paths.socket, async (method, params) => {
    switch (method) {
      case "ping":
        return { ok: true, ts: Date.now() };
      case "status": {
        const agents = registry.list();
        // Derive the sub-orchestrator summary the orchestration canvas needs (one
        // SubOrchestratorRecord per live suborchestrator): its id, the worktree it
        // runs in, its lifecycle state, and how many agents it spawned. agent_count
        // uses the parent_id edge now recorded at spawn time — children whose
        // parent_id points back at this sub-orchestrator.
        const sub_orchestrators = agents
          .filter((a) => a.role === "suborchestrator")
          .map((so) => ({
            id: so.id,
            worktree: so.worktree_name,
            status: so.state,
            agent_count: agents.filter((a) => a.parent_id === so.id).length,
          }));
        // The pane the user currently has focused, so the console can highlight
        // the matching agent row even while a sub-agent pane (not the console)
        // holds focus. Best-effort: a tmux hiccup just leaves it null and the
        // sidebar keeps its last selection.
        const active_pane_id = tmuxAvailable ? await tmux.activePane() : null;
        return {
          tickets: store.list().map((t) => t.frontmatter),
          agents,
          pending_approvals: approvals.pending(),
          sub_orchestrators,
          active_pane_id,
        };
      }
      case "list_tickets": {
        // Query the sqlite index, optionally filtered to a set of statuses. This
        // is the agent-facing backlog view (exposed as the list_tickets MCP tool)
        // and the queryable counterpart to COORDINATION.md's rendered board.
        const p = (params ?? {}) as { statuses?: string[] };
        return store.queryIndex({ statuses: p.statuses });
      }
      case "approve_gate": {
        const { id, decision } = params as { id: string; decision: "approve" | "reject" };
        return { resolved: approvals.resolve(id, decision) };
      }
      case "pending_approvals":
        return approvals.pending();
      case "register_panes": {
        // Called once by `cli.ts start` after creating the tmux session, so
        // the daemon knows which pane to pin as the console column and which
        // panes already belong to the agent grid (the main agent at minimum).
        const { console_pane_id, agent_pane_ids } = params as {
          console_pane_id: string;
          agent_pane_ids: string[];
        };
        consolePaneId = console_pane_id;
        agentPaneIds.length = 0;
        agentPaneIds.push(...agent_pane_ids);
        // The first agent pane is the orchestrator (main); cli.ts registers it
        // before any sub-agents. It's the pane the daemon wakes on sub-agent
        // state changes.
        orchestratorPaneId = agent_pane_ids[0] ?? null;
        // Install the per-pane status bar (thin top border: state-colored dot +
        // agent id + Claude's own activity title). Done here so it covers both
        // `charm start` and the daemon-restart path in `charm resume`, which both
        // call register_panes. The orchestrator gets a running (blue) bar; the
        // console gets an uncolored labelled bar (no @charm_state).
        tmux.configureAgentBorders(WINDOW);
        if (orchestratorPaneId) {
          await tmux.setPaneLabel(orchestratorPaneId, "orchestrator");
          await tmux.setPaneState(orchestratorPaneId, "running");
        }
        if (consolePaneId) await tmux.setPaneLabel(consolePaneId, "charm console");
        refreshCoordination();
        await relayout();
        return { ok: true };
      }
      case "relayout": {
        // Fired by the session's `client-resized` tmux hook (see cli.ts start):
        // recompute the grid so the sidebar's max-width clamp is re-applied AND
        // the agent grid is re-fit when the terminal is resized — both genuinely
        // need a fresh full layout. Safe to call any time; a no-op when no agent
        // panes are registered yet. Manual divider drags do NOT route here (they
        // go to `clamp_console`): select-layout would fight the user's drag.
        await relayout();
        return { ok: true };
      }
      case "clamp_console": {
        // Fired by the session's `window-layout-changed` tmux hook (every manual
        // divider drag). Enforces ONLY the sidebar cap — never recomputes the
        // agent grid — so dragging Claude-pane dividers is frictionless. No-op
        // when no panes are registered or the sidebar is within its cap.
        await clampConsole();
        return { ok: true };
      }
      // ---- MCP-facing tools ----
      case "create_tickets": {
        const input = CreateTicketsInput.parse(params);
        assertOrchestrator(input.caller_id, "create_tickets");
        // `t` carries `type` ("investigation" | "implementation"); store.create
        // threads it into the frontmatter and the index.
        const created = input.tickets.map((t) => store.create(t).frontmatter);
        return created;
      }
      case "promote": {
        // Move hand-authored ticket DRAFTS from the scratchpad into the canonical
        // tickets dir + sqlite index. This is the bridge that turns a cheap local
        // file write by the orchestrator into a real, spawnable ticket without
        // round-tripping the whole body through create_tickets. With no `tickets`
        // arg, promote every draft currently in the scratchpad.
        const input = PromoteInput.parse(params ?? {});
        assertOrchestrator(input.caller_id, "promote");
        const names = input.tickets ?? store.listDrafts();
        const promoted = names.map((n) => store.promoteDraft(n).frontmatter);
        // Newly promoted tickets belong on the board immediately.
        if (promoted.length > 0) refreshCoordination();
        return promoted;
      }
      case "create_proposal": {
        const input = CreateProposalInput.parse(params);
        return createProposal(paths, input.name);
      }
      case "list_proposals":
        return listProposals(paths);
      case "finish_proposal": {
        const input = FinishProposalInput.parse(params);
        return finishProposal(paths, input.name);
      }
      case "spawn_investigators": {
        const input = SpawnInvestigatorsInput.parse(params);
        assertOrchestrator(input.caller_id, "spawn_investigators");
        // One critical section around the slot clamp + spawn loop, so the cap
        // computation and every spawn it authorizes share a lock — a concurrent
        // spawner can't pass the same count-only cap check and overshoot the
        // ceiling between our clamp and our first claim. (Investigators don't claim
        // file `touches`, so the touch-conflict race doesn't apply here; the cap
        // is the shared resource that must be serialized.)
        // Resolve the optional worktree once for the whole batch (fails loud if it
        // names a non-existent checkout). parent_id is the authorizing caller_id so
        // the canvas can draw the orchestrator -> investigator edge.
        const cwd = resolveSpawnCwd(input.worktree);
        const parentId = input.caller_id ?? null;
        // Optional per-spawn model override; undefined falls back to the role default.
        const model = input.model ? resolveSpawnModel(input.model, input.context_1m ?? true) : undefined;
        return withLayoutLock(async () => {
          // Clamp to the concurrent-agent cap, same as spawn_workers: spawn up to
          // the free slots and defer the rest for a later retry.
          const slots = remainingAgentSlots();
          const toSpawn = input.ticket_ids.slice(0, slots);
          const deferred = input.ticket_ids.slice(slots);
          const ids: string[] = [];
          for (const tid of toSpawn) {
            const aid = await spawnAgentLocked({
              role: "investigator",
              ticket_id: tid,
              prompt: `Read ${ticketReadPath(tid, cwd)} and investigate it.`,
              cwd,
              model,
              // Interactive (like workers), NOT headless. An investigator that needs
              // a decision it can't make must be able to report_status('blocked')
              // and WAIT for the orchestrator to message guidance into its pane via
              // continue_agent (which sends keystrokes into a live REPL — impossible
              // for a one-shot `claude -p` whose process has already exited). The cost
              // is the idle-pane problem: an investigator that finishes normally lingers
              // alive in its pane and the dead-pane sweep (which only reaps DEAD panes)
              // won't reclaim it. The mitigation is the same as workers': the prompt
              // requires a terminal report_status('done') on completion, which marks
              // the ticket `complete`, pings the orchestrator, and lets it reap the pane.
              interactive: true,
            }, parentId);
            // Baseline how much the ticket body already holds, so idle-detection
            // can later tell "wrote findings then went silent" (auto-complete)
            // from "went silent having written nothing" (leave for the sweep).
            try {
              const t = store.read(tid);
              if (t) investigatorBaseline.set(aid, Buffer.byteLength(authoredBody(t.body).trim(), "utf8"));
            } catch { /* best-effort; a missing baseline just disables auto-done for this one */ }
            ids.push(aid);
          }
          if (deferred.length > 0) {
            console.error(
              `[charmd] spawn_investigators: agent cap ${maxAgents} reached (${liveAgentCount()} live); ` +
                `deferred ${deferred.length} ticket(s).`,
            );
          }
          return { agent_ids: ids, ...(deferred.length > 0 ? { deferred, max_agents: maxAgents } : {}) };
        });
      }
      case "spawn_researchers": {
        const input = SpawnResearchersInput.parse(params);
        assertOrchestrator(input.caller_id, "spawn_researchers");
        // Ad-hoc, ticket-less context-gathering agents. Unlike investigators
        // (one per investigation ticket, prompt synthesized from the ticket file),
        // a researcher is spawned directly off a free-text prompt the orchestrator
        // passes — ticket_id is null. One agent per prompt in the batch. Same
        // slot-clamp + parent-edge discipline as spawn_investigators (no `touches`
        // claim, so only the agent cap is the shared resource to serialize).
        const researchCwd = resolveSpawnCwd(input.worktree);
        const researchParentId = input.caller_id ?? null;
        // Optional per-spawn model override; undefined falls back to the role default.
        const researchModel = input.model ? resolveSpawnModel(input.model, input.context_1m ?? true) : undefined;
        return withLayoutLock(async () => {
          const slots = remainingAgentSlots();
          const toSpawn = input.prompts.slice(0, slots);
          const deferred = input.prompts.slice(slots);
          const ids: string[] = [];
          for (const prompt of toSpawn) {
            ids.push(await spawnAgentLocked({
              role: "researcher",
              ticket_id: null,
              prompt,
              cwd: researchCwd,
              model: researchModel,
              // Interactive, like every other sub-agent: a researcher that needs a
              // decision it can't make reports_status('blocked') and waits in its
              // pane for the orchestrator to continue_agent it. Its prompt (and
              // researcher.md) requires a terminal report_status('done'/'failed')
              // so the orchestrator is pinged and reaps the otherwise-idle pane.
              interactive: true,
            }, researchParentId));
          }
          if (deferred.length > 0) {
            console.error(
              `[charmd] spawn_researchers: agent cap ${maxAgents} reached (${liveAgentCount()} live); ` +
                `deferred ${deferred.length} prompt(s).`,
            );
          }
          return { agent_ids: ids, ...(deferred.length > 0 ? { deferred, max_agents: maxAgents } : {}) };
        });
      }
      case "spawn_workers": {
        const input = SpawnWorkersInput.parse(params);
        assertOrchestrator(input.caller_id, "spawn_workers");
        // Resolve the optional batch worktree (fails loud on a missing checkout)
        // and capture the authorizing caller as the parent of every worker spawned.
        const workerCwd = resolveSpawnCwd(input.worktree);
        const workerParentId = input.caller_id ?? null;
        // Optional per-spawn model override; undefined falls back to the role default.
        const workerModel = input.model ? resolveSpawnModel(input.model, input.context_1m ?? true) : undefined;
        // The whole read-solve-spawn runs under ONE layout-lock critical section.
        // Solving (inFlight + nextRunnable) and the spawn loop must share a lock so
        // a concurrent spawn_workers / request_review can't slip between this
        // handler's solve and its first claim and pick a ticket touching the same
        // file (BUG: spawn-race double-spawn). Because spawnAgentLocked flips each
        // new worker to `spawning` and inFlight() counts `spawning`, every claim is
        // visible to the next lock holder the instant we spawn it.
        return withLayoutLock(async () => {
          const all = store.list();
          // Fail loud on a ticket id that names no real ticket. The solver
          // silently drops unknown candidates, so without this a typo'd id would
          // never spawn and never error — it'd just sit in `deferred` forever and
          // the orchestrator would retry it in a loop. Mirrors the Solver
          // constructor's loud-failure stance on a dangling depends_on.
          const known = new Set(all.map((t) => t.frontmatter.id));
          const unknown = input.ticket_ids.filter((id) => !known.has(id));
          if (unknown.length > 0) {
            throw new Error(`spawn_workers: unknown ticket id(s): ${unknown.join(", ")}`);
          }
          const completed = new Set(
            all.filter((t) => t.frontmatter.status === "complete").map((t) => t.frontmatter.id),
          );
          const solver = new Solver(all);
          const runnable = solver.nextRunnable({
            completed,
            inFlight: inFlight(),
            candidates: input.ticket_ids,
          });
          // Clamp to the concurrent-agent cap: spawn only as many as we have free
          // slots for, and let the rest fall into `deferred` so the orchestrator
          // retries them once running agents finish and free their slots.
          const slots = remainingAgentSlots();
          const toSpawn = runnable.slice(0, slots);
          const cappedOut = runnable.length - toSpawn.length;
          const ids: string[] = [];
          for (const tid of toSpawn) {
            ids.push(await spawnAgentLocked({
              role: "worker",
              ticket_id: tid,
              prompt: `Read ${ticketReadPath(tid, workerCwd)} and complete it.`,
              cwd: workerCwd,
              model: workerModel,
              interactive: true,
            }, workerParentId));
            store.update(tid, { status: "running", stage: "in_progress" });
          }
          // Deferred = not-yet-runnable (deps/touches) PLUS the ones clamped by the
          // cap. The orchestrator retries these on the next tick — EXCEPT any that
          // are blocked by a cancelled dependency, which can never become runnable
          // (only a `complete` dep satisfies the solver). Surface those separately
          // so the orchestrator re-plans them instead of retrying forever — the
          // same deadlock cancel_ticket pings about, caught here for the case where
          // the orchestrator probes after the fact (e.g. a daemon restart).
          const deferred = input.ticket_ids.filter((id) => !toSpawn.includes(id));
          const byId = new Map(all.map((t) => [t.frontmatter.id, t]));
          const blockedByCancelledDep = deferred.filter((id) =>
            (byId.get(id)?.frontmatter.depends_on ?? []).some(
              (d) => byId.get(d)?.frontmatter.status === "cancelled",
            ),
          );
          if (cappedOut > 0) {
            console.error(
              `[charmd] spawn_workers: agent cap ${maxAgents} reached (${liveAgentCount()} live); ` +
                `deferred ${cappedOut} runnable ticket(s).`,
            );
          }
          return {
            agent_ids: ids,
            deferred,
            ...(blockedByCancelledDep.length > 0 ? { blocked_by_cancelled_dependency: blockedByCancelledDep } : {}),
            ...(cappedOut > 0 ? { capped: cappedOut, max_agents: maxAgents } : {}),
          };
        });
      }
      case "create_worktree": {
        const input = CreateWorktreeInput.parse(params);
        assertOrchestrator(input.caller_id, "create_worktree");
        // Mutates the worktree set, so it runs under the layout lock — same
        // discipline as spawn_workers. create() is itself serialized internally
        // (its promise-chain mutex), but taking the lock here keeps the worktree
        // set and the pane grid changing under one critical section.
        return withLayoutLock(() => worktrees.create(input.name, { branch: input.branch, base: input.base }));
      }
      case "list_worktrees": {
        const input = ListWorktreesInput.parse(params);
        assertOrchestrator(input.caller_id, "list_worktrees");
        // Read-only: no layout lock needed. Annotate each worktree with the live
        // agent (if any) whose worktree_name matches, so the orchestrator can see
        // which lines of work are occupied vs. closeable. Keyed by the plain name,
        // which is the last path segment of the worktree's checkout dir.
        const byName = new Map<string, string>();
        for (const a of registry.list()) {
          if (a.worktree_name) byName.set(a.worktree_name, a.id);
        }
        return {
          worktrees: worktrees.list().map((w) => ({
            ...w,
            agent_id: byName.get(basename(w.path)) ?? null,
          })),
        };
      }
      case "close_worktree": {
        const input = CloseWorktreeInput.parse(params);
        assertOrchestrator(input.caller_id, "close_worktree");
        // Mutates the worktree set -> layout lock. Removing a copy deletes its
        // whole repo, so any committed-but-unmerged work on its branch goes with
        // it (charm does no merge-back — merge deliberately before closing if you
        // want to keep it). delete_branch additionally drops a leftover
        // charm/<name> branch in the MAIN repo if the work was merged back.
        return withLayoutLock(async () => {
          worktrees.remove(input.name, { deleteBranch: input.delete_branch, force: true });
          return { closed: input.name };
        });
      }
      case "await_approval": {
        const input = AwaitApprovalInput.parse(params);
        const decision = await approvals.enqueue({
          stage: input.stage,
          label: input.label,
          ticket_id: input.ticket_id,
          payload_path: input.payload_path,
          // Only link the gate to a real, tracked sub-agent. The orchestrator
          // (main) is protected and never torn down, so linking its stage gates
          // would only risk cancelling them on a spurious match.
          agent_id: input.caller_id && registry.get(input.caller_id) ? input.caller_id : null,
        });
        return { decision };
      }
      case "update_plan": {
        const input = UpdatePlanInput.parse(params);
        const a = registry.get(input.agent_id);
        if (!a) throw new Error(`unknown agent: ${input.agent_id}`);
        // The plan lives only in the ticket's activity log, not on the in-memory
        // agent record or COORDINATION.md.
        if (a.ticket_id) store.appendLog(a.ticket_id, { agent: a.id, kind: "plan", text: input.plan });
        refreshCoordination();
        return { ok: true };
      }
      case "read_coordination":
        return { text: coord.read() };
      case "report_status": {
        const input = ReportStatusInput.parse(params);
        const a = registry.setState(input.agent_id, input.state, input.note);
        // Recolor the agent's status bar to its new state (blue/yellow/green/red).
        // Cosmetic and best-effort; done/failed panes are auto-reaped shortly after,
        // so their green/red bar is brief, while blocked (yellow) persists until
        // continue_agent — exactly the state worth flagging at a glance.
        if (a.pane_id) tmux.setPaneState(a.pane_id, input.state).catch(() => {});
        if (input.state === "done" && a.ticket_id) {
          // Every role's `done` completes its ticket. An investigation ticket
          // complete means the findings are written into its body (ready for the
          // orchestrator to synthesize into worker tickets); a worker/tester done
          // means the build/validation is finished. Same terminal state either way.
          store.update(a.ticket_id, { status: "complete", stage: "done" });
        } else if (input.state === "failed" && a.ticket_id) {
          store.update(a.ticket_id, { status: "failed", stage: "failed" });
        }
        // Record the status transition (and any note) in the ticket's activity
        // log. Done after the frontmatter update above so the log entry reflects
        // the new status. COORDINATION.md only shows the live state, not the note.
        if (a.ticket_id) store.appendLog(a.ticket_id, { agent: a.id, kind: input.state, text: input.note });
        refreshCoordination();
        // Wake the orchestrator on a sub-agent's done/failed/blocked so it can
        // advance the workflow (spawn the next wave, synthesize, resolve a
        // block). Never ping for the main agent itself.
        if (a.role !== "main" && (input.state === "done" || input.state === "failed" || input.state === "blocked")) {
          pingOrchestrator(`${a.id} -> ${input.state}${a.ticket_id ? ` on ${a.ticket_id}` : ""}`);
        }
        // Auto-reap a finished pane after a short grace, so the orchestrator
        // never has to spend a turn on kill_agent for routine cleanup — the
        // ping above is for advancing the workflow, not for reaping. `blocked`
        // is excluded: that agent is alive and waiting for continue_agent.
        if (a.role !== "main" && (input.state === "done" || input.state === "failed")) {
          scheduleAutoReap(a.id);
        }
        return { ok: true };
      }
      case "set_ticket_status": {
        // Worker-driven ticket lifecycle: the calling agent sets its OWN ticket's
        // status and/or stage. Self-scoped via agent_id (folded in by the MCP shim),
        // so an agent can never move another's ticket. `cancelled` is not settable
        // here (enforced by the input schema) — that's an operator call-off, not a
        // worker decision. Like report_status, the transition is mirrored into the
        // ticket's activity log, and COORDINATION.md is rebuilt.
        const input = SetTicketStatusInput.parse(params);
        const a = registry.get(input.agent_id);
        if (!a) throw new Error(`unknown agent: ${input.agent_id}`);
        if (!a.ticket_id) throw new Error(`agent ${input.agent_id} holds no ticket`);
        const patch: { status?: string; stage?: string } = {};
        if (input.status) patch.status = input.status;
        if (input.stage) patch.stage = input.stage;
        store.update(a.ticket_id, patch);
        const kind = input.status ? `status=${input.status}` : `stage=${input.stage}`;
        store.appendLog(a.ticket_id, { agent: a.id, kind, text: input.note });
        refreshCoordination();
        return { ok: true };
      }
      case "set_ticket_state": {
        // Orchestrator-driven ticket lifecycle: write status and/or stage onto a
        // ticket addressed by id (not by the caller's own assignment — that's
        // set_ticket_status). The orchestrator owns the workflow, so it can move a
        // ticket it isn't itself on. Authorization mirrors cancel_ticket: operator
        // or main only. `cancelled` is excluded by the schema — route call-offs
        // through cancel_ticket. The transition is mirrored into the ticket's
        // activity log and COORDINATION.md is rebuilt.
        const input = SetTicketStateInput.parse(params);
        const callerRole = resolveCaller(input.caller_id);
        if (callerRole !== "operator" && callerRole !== "main") {
          throw new Error(
            `agent ${input.caller_id} (${callerRole}) may not set ticket state; that requires the orchestrator`,
          );
        }
        const t = store.read(input.ticket_id);
        if (!t) throw new Error(`unknown ticket: ${input.ticket_id}`);
        const patch: { status?: string; stage?: string } = {};
        if (input.status) patch.status = input.status;
        if (input.stage) patch.stage = input.stage;
        store.update(input.ticket_id, patch);
        const kind = input.status ? `status=${input.status}` : `stage=${input.stage}`;
        store.appendLog(input.ticket_id, {
          agent: input.caller_id ?? "operator",
          kind,
          text: input.note,
        });
        // Writing a ticket to a terminal status (complete/failed) means any agent
        // still on it is working moot — tear its pane down, same as cancel_ticket
        // does for a call-off. Non-terminal writes (ready/blocked/stage walks)
        // leave a live agent alone; it's still doing relevant work.
        if (input.status === "complete" || input.status === "failed") {
          // Tear down ALL agents on the ticket (a worker plus a tester
          // can be on it at once), not just the first one found.
          void tearDownTicketAgents(input.ticket_id).catch((e) =>
            console.error(`[charmd] set_ticket_state: tearDownTicketAgents(${input.ticket_id}) failed:`, e),
          );
        }
        refreshCoordination();
        // An operator writing state from the console is news to the orchestrator;
        // a write the orchestrator issued itself is not.
        if (callerRole === "operator") {
          pingOrchestrator(`${input.ticket_id} ${kind} by operator${input.note ? `: ${input.note}` : ""}`);
        }
        return { ok: true };
      }
      case "dismiss_agent": {
        const { agent_id } = params as { agent_id: string };
        const a = registry.get(agent_id);
        if (!a) throw new Error(`unknown agent: ${agent_id}`);
        if (a.state !== "done" && a.state !== "failed") {
          throw new Error(`agent ${agent_id} is ${a.state}; only done/failed can be dismissed`);
        }
        await tearDownAgent(agent_id);
        return { ok: true };
      }
      case "kill_agent": {
        const input = KillAgentInput.parse(params);
        const callerRole = resolveCaller(input.caller_id);
        // A null/absent agent_id means "kill myself". That only resolves to a
        // concrete target for an agent caller; the human operator must name one.
        const targetId = input.agent_id ?? input.caller_id;
        if (!targetId) throw new Error("agent_id is required");

        // The orchestrator is protected: it is never a valid kill target, for any
        // caller. Guard on the id directly (it is not in the registry) so this holds
        // even before the target lookup.
        if (targetId === MAIN_AGENT_ID) {
          throw new Error("refusing to kill the orchestrator (main agent)");
        }
        const target = registry.get(targetId);
        if (!target) throw new Error(`unknown agent: ${targetId}`);

        const isSelf = targetId === input.caller_id;
        // Authorization: the human operator and the orchestrator may kill any
        // sub-agent; a sub-agent may only kill itself.
        if (callerRole !== "operator" && callerRole !== "main" && !isSelf) {
          throw new Error(
            `agent ${input.caller_id} (${callerRole}) may only kill itself; ` +
            `killing ${targetId} requires the orchestrator`,
          );
        }

        // Aborting an in-flight ticket. The terminal status depends on WHO killed
        // it: a worker tearing down its own pane couldn't finish -> `failed`; an
        // operator/orchestrator killing someone else's pane is a deliberate call-off
        // -> `cancelled`. Both surface differently in the log and on the board
        // (failed stays for a retry, cancelled drops off).
        // Aborting an in-flight ticket marks it `failed` (not `cancelled`) so it
        // stays on the board and surfaces for retry — killing a stuck/looping agent
        // is a "kill and reassign" move, not a "call this off" one. Deliberate
        // cancellation (the ticket is no longer wanted) is a separate, explicit path
        // — see cancel_ticket — precisely so it can't be confused with a retry kill.
        if (target.ticket_id && (target.state === "spawning" || target.state === "running")) {
          try { store.update(target.ticket_id, { status: "failed", stage: "failed" }); } catch { /* ignore */ }
        }

        if (isSelf) {
          // The caller is tearing down its own pane, which also kills the claude
          // process that issued this RPC. Defer one tick so the reply flushes
          // before the pane (and its MCP shim) dies — mirrors `shutdown`.
          setTimeout(() => { void tearDownAgent(targetId).catch((e) => console.error("[charmd] self-teardown failed:", e)); }, 50);
        } else {
          await tearDownAgent(targetId);
        }
        return { ok: true, killed: targetId };
      }
      case "cancel_ticket": {
        // Deliberate call-off: this ticket is no longer wanted. Distinct from
        // kill_agent (which fails a ticket for retry) — cancelling marks it
        // `cancelled`, drops it off the board, and tears down any agent on it.
        // Operator/orchestrator only; a sub-agent can't cancel work.
        const input = CancelTicketInput.parse(params);
        const callerRole = resolveCaller(input.caller_id);
        if (callerRole !== "operator" && callerRole !== "main") {
          throw new Error(
            `agent ${input.caller_id} (${callerRole}) may not cancel tickets; that requires the orchestrator`,
          );
        }
        const t = store.read(input.ticket_id);
        if (!t) throw new Error(`unknown ticket: ${input.ticket_id}`);
        if (t.frontmatter.status === "complete") {
          throw new Error(`ticket ${input.ticket_id} is already complete; nothing to cancel`);
        }
        store.update(input.ticket_id, { status: "cancelled" });
        store.appendLog(input.ticket_id, {
          agent: input.caller_id ?? "operator",
          kind: "cancelled",
          text: input.note,
        });
        // Stop ALL agents currently on this ticket — their work is moot now. A
        // ticket can carry more than one helper (worker + tester), so
        // reap every non-main agent on it, not just the first.
        await tearDownTicketAgents(input.ticket_id);
        refreshCoordination();
        // Surface the cancel to the orchestrator. Two independent reasons to ping:
        //   (1) An operator cancelling from the console is news; a cancel the
        //       orchestrator issued itself is not.
        //   (2) Regardless of who cancelled, any live ticket that depends on this
        //       one can no longer satisfy its dependency (only `complete` does).
        //       Rather than auto-resolving (cancelling them, dropping the edge),
        //       we report it and let the orchestrator review the workflow and
        //       decide — the deadlock must be visible, not silently patched.
        const blockedDependents = liveDependentsOf(store.list(), input.ticket_id);
        const notes: string[] = [];
        if (callerRole === "operator") {
          notes.push(`${input.ticket_id} cancelled by operator${input.note ? `: ${input.note}` : ""}`);
        }
        if (blockedDependents.length > 0) {
          const plural = blockedDependents.length === 1 ? "" : "s";
          notes.push(
            `${input.ticket_id} is a dependency of ${blockedDependents.join(", ")}, which can no longer run. ` +
              `Review the workflow and decide: drop the dependency, re-scope, or cancel ${blockedDependents.length === 1 ? "it" : "them"}.`,
          );
        }
        if (notes.length > 0) pingOrchestrator(notes.join(" "));
        return {
          ok: true,
          cancelled: input.ticket_id,
          ...(blockedDependents.length > 0 ? { blocked_dependents: blockedDependents } : {}),
        };
      }
      case "continue_agent": {
        const input = ContinueAgentInput.parse(params);
        const callerRole = resolveCaller(input.caller_id);
        // Only the human operator and the orchestrator may resume an agent. A
        // sub-agent cannot drive another sub-agent.
        if (callerRole !== "operator" && callerRole !== "main") {
          throw new Error(
            `agent ${input.caller_id} (${callerRole}) may not continue other agents; that requires the orchestrator`,
          );
        }
        // The orchestrator drives the workflow itself — it is never a target.
        if (input.agent_id === MAIN_AGENT_ID) {
          throw new Error("refusing to continue the orchestrator (main agent)");
        }
        const target = registry.get(input.agent_id);
        if (!target) throw new Error(`unknown agent: ${input.agent_id}`);
        // Only a blocked agent can be continued. `running` is the normal
        // actively-working state (set on attach), so typing into that pane would
        // inject mid-turn and corrupt the agent's work. done/failed are terminal
        // (spawn a fresh agent instead); spawning hasn't taken its first turn yet,
        // so there's nothing to resume.
        if (target.state !== "blocked") {
          throw new Error(
            `agent ${target.id} is ${target.state}; only a blocked agent can be continued`,
          );
        }
        if (!target.pane_id) throw new Error(`agent ${target.id} has no pane to message`);
        // paneAlive, not paneIndex: under session-level remain-on-exit a pane
        // whose claude has EXITED stays listed and still has a pane_index, so
        // paneIndex would report it present and we'd sendText into a dead pane,
        // then flip the registry to `running` — resurrecting a zombie. paneAlive
        // checks #{pane_dead}, so a retained-but-dead pane is correctly rejected.
        if (!tmuxAvailable || !(await tmux.paneAlive(target.pane_id))) {
          throw new Error(`agent ${target.id}'s pane is gone — it may have exited; kill_agent and respawn instead`);
        }
        // Wake the blocked agent with the orchestrator's guidance (one line — a
        // literal newline would submit early), then optimistically flip it back
        // to running. The agent corrects this via its own report_status as it
        // proceeds, re-blocks, or finishes.
        await tmux.sendText(target.pane_id, `[charm] Orchestrator: ${input.message}`);
        const a = registry.setState(target.id, "running");
        // Record the orchestrator's unblock message in the ticket's activity log
        // so the resume (and its guidance) is part of the ticket's history.
        if (a.ticket_id) store.appendLog(a.ticket_id, { agent: "orchestrator", kind: `continue -> ${a.id}`, text: input.message });
        refreshCoordination();
        return { ok: true, continued: target.id };
      }
      case "orchestrator_pane":
        // The exact pane id the daemon tracks as the orchestrator (main agent).
        // `charm resume` reads this to relaunch the orchestrator IN its own pane
        // by id — robust against tmux renumbering pane *indexes* once sub-agent
        // panes have been added/removed and the grid relaid out (the static
        // `<session>:charm.1` index is only correct before any sub-agent spawns).
        return { pane_id: orchestratorPaneId };
      case "list_agents":
        return registry.list().map((a) => ({
          id: a.id,
          role: a.role,
          state: a.state,
          ticket_id: a.ticket_id,
        }));
      case "set_session_description": {
        const input = SetSessionDescriptionInput.parse(params);
        const now = Date.now();
        // Merge into the meta `charm start` wrote: keep the session identity
        // (uuid/session_name/root/socket/pid) and created_at, override only the
        // description. Falling back to this daemon's own identity if the file is
        // missing/corrupt so the record stays coherent for `stop`/`attach`.
        let prev: Partial<SessionMeta> = {};
        if (existsSync(paths.metaJson)) {
          try { prev = SessionMeta.parse(JSON.parse(readFileSync(paths.metaJson, "utf8"))); }
          catch { /* corrupted — rebuild from what we know */ }
        }
        const meta: SessionMeta = {
          uuid: prev.uuid ?? opts.uuid,
          session_name: prev.session_name ?? session,
          root: prev.root ?? paths.root,
          socket: prev.socket ?? paths.socket,
          pid: prev.pid ?? process.pid,
          description: input.description,
          created_at: prev.created_at ?? now,
          updated_at: now,
          source: "agent",
        };
        writeFileSync(paths.metaJson, JSON.stringify(meta, null, 2) + "\n");
        return { ok: true };
      }
      case "shutdown": {
        // Kill the tmux session first so panes (console, agents) tear down
        // before the daemon disappears. Schedule cleanup on next tick so the
        // RPC reply gets flushed.
        setTimeout(() => {
          try { tmux.killSession(); } catch { /* ignore */ }
          cleanup();
        }, 50);
        return { ok: true };
      }
      case "open_graph": {
        // Open the standalone force-directed graph viewer in a brand-new OS
        // terminal window, fully outside tmux and the charm session. Each call
        // opens an independent window (any number can run at once); the viewer
        // self-registers its PID in paths.graphPids on startup and removes it on
        // exit, so `charm stop` / daemon teardown can reap every window.
        const spec = graphLaunchSpec(paths.graphPids, paths.kbDir);
        const r = spawnSync(spec.cmd, spec.args, { stdio: "ignore", env: spec.env });
        if (r.error) throw new Error(`failed to open graph viewer: ${r.error.message}`);
        if (r.status !== 0) throw new Error(`failed to open graph viewer (exit ${r.status})`);
        return { ok: true };
      }
      case "spawn_suborchestrator": {
        // Callable from the operator (`:so` / `:sub` / `:suborchestrator` tmux command) or
        // the main orchestrator. The suborchestrator joins the agent grid as a new
        // pane in the main charm window — NOT a separate tmux window — so it sits
        // alongside the console and the other agents in the existing multi-pane
        // layout instead of taking over the screen. It has orchestrator-level MCP
        // permissions — it can observe the fleet, author tickets, and spawn workers
        // on the operator's behalf while the main orchestrator continues its work.
        const claudeSessionId = newClaudeSessionId();
        // Record the authorizing caller as the parent. Normally the operator
        // (`:so`/`:sub` tmux command, no caller_id -> null); a main-orchestrator caller
        // would pass its id and become the parent edge.
        const soParentId = (params as { caller_id?: string } | undefined)?.caller_id ?? null;
        // Take the layout lock for the whole spawn: it mutates agentPaneIds and the
        // window layout, the same shared state every other spawn touches, so it must
        // not interleave with a concurrent spawn or relayout.
        return withLayoutLock(async () => {
          const agent = registry.create({ role: "suborchestrator", ticket_id: null, parent_id: soParentId, claude_session_id: claudeSessionId });
          const model = defaultModelForRole("suborchestrator");
          const cmd = buildClaudeCommand(paths, agent.id, {
            role: "suborchestrator",
            ticket_id: null,
            prompt: "",
            interactive: true,
            model,
            claudeSessionId,
          });
          try {
            // Split into THIS session's main window, exactly like every sub-agent
            // pane (see spawnAgentLocked), so the suborchestrator lands in the grid;
            // pin the target to `${session}:${WINDOW}` for the same reason — the
            // detached daemon must not let the split land in another session.
            const pane = await tmux.splitPane({ cmd, cwd: paths.root, direction: "h", target: `${session}:${WINDOW}` });
            registry.attach(agent.id, { pane_id: pane });
            agentPaneIds.push(pane);
            refreshCoordination();
            await relayoutLocked();
            // Focus the new pane so the operator can start directing it immediately.
            tmux.selectPane(pane);
            return { ok: true, agent_id: agent.id };
          } catch (e) {
            // Same rollback as spawnAgentLocked: drop the stranded pane + registry
            // entry so a failed spawn doesn't hold a slot or leave a zombie pane.
            const stranded = registry.get(agent.id);
            if (stranded?.pane_id) {
              try { await tmux.killPane(stranded.pane_id); } catch { /* best effort */ }
              const i = agentPaneIds.indexOf(stranded.pane_id);
              if (i >= 0) agentPaneIds.splice(i, 1);
            }
            registry.remove(agent.id);
            throw e;
          }
        });
      }
      case "request_review": {
        const input = RequestReviewInput.parse(params);
        assertOrchestrator(input.caller_id, "request_review");
        const reviewCwd = resolveSpawnCwd(input.worktree);
        const id = await spawnAgent({
          role: "tester",
          ticket_id: input.ticket_id,
          prompt: `Read ${ticketReadPath(input.ticket_id, reviewCwd)} and validate it.`,
          cwd: reviewCwd,
          // Interactive, same as investigators (and workers): a tester that can't run
          // the validation — unclear acceptance criteria, the diff doesn't match the
          // ticket, a broken environment — must report_status('blocked') and WAIT
          // for the orchestrator to message guidance into its live pane via
          // continue_agent. A one-shot `claude -p` couldn't be resumed. As with
          // investigators, the prompt requires a terminal report_status('done'/'failed')
          // so the orchestrator is pinged and reaps the otherwise-idle pane.
          interactive: true,
        }, input.caller_id ?? null);
        return { agent_id: id };
      }
      default:
        throw new Error(`unknown method: ${method}`);
    }
  });

  // Session-close git sync. On shutdown the daemon commits the durable charm
  // surfaces (KB, proposals, scratchpad) so a session's work product travels with
  // the repo instead of sitting dirty in the working tree forever. Tickets are
  // deliberately NOT committed — they're gitignored run state that churns on every
  // spawn/status change and would flood the changelog.
  // Deliberately simple: one commit at close, when the daemon is the SOLE git
  // writer (agents are being reaped), which sidesteps index-lock contention on
  // the shared tree. Two safety properties matter:
  //   - PATH-SCOPED: we `git add`/`git commit` only the charm surfaces, so this
  //     can never sweep an operator's or agent's unrelated staged/unstaged work
  //     into the commit (the partial-commit discipline). This stays path-scoped
  //     on purpose — it is NOT worktree-aware, so a worktree copy's branch work
  //     can never be swept into the main checkout's session-close commit.
  //   - NON-FATAL: any git failure (not a repo, detached HEAD, hook rejection,
  //     a lingering lock) is logged and swallowed — it must never block shutdown.
  // Opt out with CHARM_NO_AUTOCOMMIT=1. Commits land on the active branch.
  const commitSessionArtifacts = () => {
    if (process.env.CHARM_NO_AUTOCOMMIT) return;
    const surfaces = [paths.kbDir, paths.proposalsDir, paths.scratchpadDir]
      .filter((d) => existsSync(d));
    if (surfaces.length === 0) return;
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: paths.root, encoding: "utf8" });
    const inRepo = git(["rev-parse", "--is-inside-work-tree"]);
    if (inRepo.status !== 0 || inRepo.stdout.trim() !== "true") return;
    // Stage only the charm surfaces (picks up new, modified, and deleted files
    // within them; leaves everything else in the index untouched).
    const add = git(["add", "--", ...surfaces]);
    if (add.status !== 0) {
      console.error(`[charmd] session-close commit: git add failed: ${add.stderr?.trim() ?? ""}`);
      return;
    }
    // `git diff --cached --quiet` exits 0 when nothing is staged among these
    // paths -> nothing changed this session, so skip the empty commit.
    if (git(["diff", "--cached", "--quiet", "--", ...surfaces]).status === 0) return;
    const label = paths.sessionId ? paths.sessionId.slice(0, 8) : session;
    const msg = `charm session ${label}: sync KB, proposals, scratchpad`;
    // Pathspec on commit keeps it a partial commit: only the surfaces land, even
    // if the operator had other paths staged.
    const commit = git(["commit", "-m", msg, "--", ...surfaces]);
    if (commit.status !== 0) {
      console.error(`[charmd] session-close commit failed: ${commit.stderr?.trim() ?? ""}`);
      return;
    }
    console.error(`[charmd] session-close commit: ${(commit.stdout ?? "").trim().split("\n")[0] ?? "committed"}`);
  };

  const cleanup = (code = 0) => {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    if (investigatorSweepTimer) { clearInterval(investigatorSweepTimer); investigatorSweepTimer = null; }
    // Drop any pending auto-reap timers so they can't fire into a torn-down
    // daemon (they're unref'd, but clear them anyway for a clean shutdown).
    for (const t of autoReapTimers.values()) clearTimeout(t);
    autoReapTimers.clear();
    try { commitSessionArtifacts(); } catch (e) {
      console.error(`[charmd] session-close commit threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    try { server.stop(); } catch { /* ignore */ }
    // Reap any standalone graph viewers we spawned before we exit, so they don't
    // linger as orphans (covers SIGINT/SIGTERM, the shutdown RPC, and crashes).
    try { killGraphViewers(paths.graphPids); } catch { /* ignore */ }
    // Worktree teardown safety-net. The orchestrator is supposed to close every
    // worktree copy it opened (close_worktree) by session end; this catches the
    // ones it didn't. We name any still-present copies loudly so the operator
    // knows to reclaim them, then prune. NOTE: prune() reaps only corrupt/
    // half-created orphans, NOT intact copies — worktreesDir is shared by every
    // session in this repo, so an intact copy might belong to a co-resident
    // session and must never be swept here. Leaked-but-intact copies are left for
    // the operator (or a later explicit close_worktree). Best-effort: a git
    // failure must never block shutdown.
    try {
      const leaked = worktrees.list();
      if (leaked.length > 0) {
        console.error(
          `[charmd] session shutdown: ${leaked.length} worktree copy(ies) present; ` +
            `intact ones are left for the operator (prune reaps only orphans): ` +
            leaked.map((w) => w.path).join(", "),
        );
      }
      worktrees.prune();
    } catch (e) {
      console.error(`[charmd] worktree prune on shutdown failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
    try { unlinkSync(paths.socket); } catch { /* ignore */ }
    try { unlinkSync(paths.pidFile); } catch { /* ignore */ }
    try { unlinkSync(paths.sessionMcpConfig); } catch { /* ignore */ }
    try { store.close(); } catch { /* ignore */ }
    process.exit(code);
  };
  // Wrap so the signal name Node passes as arg0 isn't forwarded as the exit code
  // (process.exit("SIGINT") would coerce to a bogus status). Both are intentional
  // shutdowns -> exit 0.
  process.on("SIGINT", () => cleanup(0));
  process.on("SIGTERM", () => cleanup(0));

  // Without these, a single throw in an RPC handler, a socket callback, or the
  // ping timer takes down the whole daemon — and because the normal teardown
  // never runs, it leaves its socket and pidfile behind, which then makes the
  // next `start` refuse ("already running"). That silent death with no log line
  // is exactly why post-sleep/long-run crashes were impossible to diagnose.
  // Log the cause with a timestamp (so a death can be correlated against a
  // sleep/wake in the system log) and tear down cleanly with a non-zero code.
  process.on("uncaughtException", (err) => {
    logCrash("uncaughtException", err);
    cleanup(1);
  });
  // Unhandled rejections are NOT treated as fatal here. The post-sleep burst is
  // full of fire-and-forget tmux/RPC calls that reject benignly after their pane
  // vanished; killing the daemon on those would make the sleep problem worse, not
  // better. Log loudly instead — if a real crash follows, the rejection line
  // above it is the lead.
  process.on("unhandledRejection", (reason) => {
    logCrash("unhandledRejection", reason);
  });

  console.log(`[charmd] listening on ${paths.socket} (session=${session}, root=${paths.root})`);

  // Start the dead-pane liveness sweep once we're listening (no agents exist
  // before this, so there's nothing to reap earlier). Cleared in cleanup().
  sweepTimer = setInterval(sweepDeadPanes, SWEEP_MS);
  // Same cadence, separate timer: catch interactive investigators that finished
  // writing findings but never reported done. Skipped entirely when disabled
  // (CHARM_INVESTIGATOR_IDLE_MS=0) or when the charm-watch binary is absent.
  if (INVESTIGATOR_IDLE_MS > 0) {
    investigatorSweepTimer = setInterval(() => { void sweepIdleInvestigators(); }, SWEEP_MS);
  }
}

/** Prefix every daemon console line with an ISO timestamp. The daemon's
 *  stdout/stderr are redirected to its per-session charmd.log (see cli.ts
 *  `start`), so an unstamped line is undatable — and the whole point of this log
 *  is correlating a restart or death against wall-clock (and the system
 *  sleep/wake log). Wrap the console methods once, at the entry point, so every
 *  existing and future call site is stamped without threading a logger through
 *  the daemon. This does NOT catch errors the Bun runtime itself prints before
 *  our code runs (e.g. a "Module not found" from a mis-bundled binary). */
function installTimestampedConsole(): void {
  const stamp =
    (fn: (...a: unknown[]) => void) =>
    (...args: unknown[]) =>
      fn(`[${new Date().toISOString()}]`, ...args);
  console.log = stamp(console.log.bind(console));
  console.error = stamp(console.error.bind(console));
  console.warn = stamp(console.warn.bind(console));
  console.info = stamp(console.info.bind(console));
}

/** Crash logging. The console is already timestamped by installTimestampedConsole,
 *  so this just formats the cause; the stamp on the emitted line is what lets a
 *  death be lined up against a sleep/wake event. */
function logCrash(kind: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  console.error(`[charmd] ${kind}: ${detail}`);
}

main().catch((e) => {
  logCrash("fatal (startup)", e);
  process.exit(1);
});
