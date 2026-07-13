#!/usr/bin/env bun
import { Command } from "commander";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, cpSync, rmSync, openSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { charmPaths, sessionNameForId, briefPathFor, type CharmPaths } from "./paths.ts";
import { listBriefs, readBrief, scaffoldBrief, deleteBrief, isUneditedBrief, type Brief } from "./store/briefs.ts";
import { SessionMeta } from "./schema.ts";
import { rpcCall } from "./daemon/rpc.ts";
import { Tmux } from "./daemon/tmux.ts";
import { killGraphViewers } from "./graph-viewers.ts";
import { fileURLToPath } from "node:url";

const program = new Command();
program
  .name("charm-claude")
  .description("Terminal-based multi-agent charm for Claude Code")
  .version("0.0.1")
  .showHelpAfterError()
  .configureOutput({
    outputError: (str, write) => {
      // After goals were removed, `charm start "fix"` is the common footgun:
      // without allowExcessArguments(false) Commander would silently ignore the
      // string and open a plain window. Surface a directed fix instead of the
      // generic "too many arguments" line.
      if (/too many arguments for 'start'/.test(str)) {
        write(
          "error: charm start no longer accepts a positional goal.\n" +
            "  Use:  charm start --project           # pick/create a brief and run the pipeline\n" +
            "        charm start --project <slug>    # anchor to an existing brief\n" +
            "        charm start                     # plain Claude window\n",
        );
        return;
      }
      write(str);
    },
  });

program
  .command("init")
  .description("scaffold or refresh .charm/ in the current dir: re-copies template tooling (prompts, CHARM.md, charm.json), ensures the root CLAUDE.md imports it -- additive or update only, never deletes; kb/, COORDINATION.md, and settings.json are preserved")
  .allowExcessArguments(false)
  .option("-r, --root <path>", "project root", process.cwd())
  .action((opts) => {
    const paths = charmPaths(resolve(opts.root));
    // init always refreshes template-managed tooling (overwrite existing + add
    // new). User/runtime data (kb, coordination, settings) is still preserved.
    scaffoldCharmDir(paths, { refresh: true });
    console.log(`charm initialized at ${paths.charmDir}`);
    console.log(`  prompts:  ${paths.promptsDir}/`);
    console.log(`  tickets:  ${paths.ticketsDir}/  (run state, gitignored)`);
    console.log(`  kb:       ${paths.kbDir}/  (durable, git-tracked)`);
    console.log(`  charm:    ${paths.charmMd}  (workspace guardrails, loaded via the root CLAUDE.md import)`);
    console.log(`  config:   ${paths.mcpConfig}`);
  });

program
  .command("start")
  .description("start the daemon, open the tmux layout, and spawn the main agent; without --project, opens a plain Claude window")
  .allowExcessArguments(false)
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session (default: derived from the project dir)")
  .option(
    "-m, --model <model>",
    "override the model for the WHOLE fleet (main agent + every sub-agent), replacing the per-type defaults: sonnet-5 | sonnet-5-1m | haiku-4.5 | opus-4.7 | opus-4.7-1m | opus-4.8 | opus-4.8-1m | fable-5 (or a raw claude-* id)",
  )
  .option(
    "--max-agents <n>",
    "max concurrent agent sessions in this charm, INCLUDING the orchestrator (so n=10 allows the orchestrator + 9 sub-agents)",
    "10",
  )
  .option("--no-attach", "do not auto-attach to the tmux session")
  .option(
    "--workflow-enable",
    "keep Claude Code's built-in Workflow tool enabled for the WHOLE fleet (main agent + every sub-agent); off by default so all fan-out goes through charm's MCP tools",
    false,
  )
  .option("-u, --uuid <id>", "internal: pin this session's UUID (default: a fresh random one)")
  .option(
    "-p, --project [slug]",
    "anchor this session to a project brief (.charm/project-briefs/<slug>.md), injected into the orchestrator as standing context: bare --project opens an interactive picker (filter existing, or create new); --project <slug> selects one directly",
  )
  .action(async (opts) => {
    const root = resolve(opts.root);
    // --workflow-enable opts the whole environment back into the built-in Workflow
    // tool (charm strips it by default; see buildClaudeCommand). Set it on this CLI's
    // env now so it (a) reaches the in-process main-agent spawn below via
    // workflowEnabled() and (b) is inherited by the daemon through its {...process.env}
    // spread, so every sub-agent the daemon spawns keeps Workflow too.
    if (opts.workflowEnable) process.env.CHARM_WORKFLOW_ENABLE = "1";
    // Each `charm start` mints a fresh session UUID. It is this session's primary
    // key: its socket, pidfile, daemon log, meta, and graph-viewer pids all live
    // under .charm/run/<uuid>/, and its tmux name carries the uuid — so multiple
    // sessions (same dir or different) never collide, and a `:q` tears down only
    // the session it was pressed in.
    const sessionId = (opts.uuid as string | undefined) ?? randomUUID();
    const paths = charmPaths(root, sessionId);
    // Reuse an existing .charm/ if present, otherwise scaffold a fresh one. (The
    // shared workspace under .charm/ is created here; the per-session run dir is
    // created just below.) Scaffolding also writes the self-contained
    // .charm/.gitignore that governs what under .charm/ is tracked.
    scaffoldCharmDir(paths, { refresh: false });
    // Resolve the project brief (if --project was passed) BEFORE spawning the
    // daemon or touching tmux: the interactive picker and any $EDITOR open need a
    // clean TTY, exactly like confirm(). Returns null when --project was not given
    // (plain window), a resolved Brief otherwise, or exits on cancel/unknown-slug.
    const brief = await resolveProjectBrief(paths, opts.project);
    // Garbage-collect run dirs whose daemon is gone, so a crashed prior session
    // doesn't linger as a phantom in `stop`/`attach`'s session picker.
    pruneDeadSessions(root);
    mkdirSync(paths.runDir, { recursive: true });
    mkdirSync(paths.logsDir, { recursive: true });
    if (!Tmux.available()) {
      console.error("tmux is required.");
      process.exit(2);
    }

    // Resolve this session's tmux name. An explicit --session (or $CHARM_SESSION)
    // wins; otherwise it's derived from the dir basename + the uuid so it's unique
    // even against another `start` in the same directory. The name is no longer
    // re-derivable from the root alone, so we persist it: in this session's
    // meta.json (the per-session record) and in the per-directory last-session
    // pointer that `charm.sh` reads to attach right after launch.
    const session = opts.session ?? process.env.CHARM_SESSION ?? sessionNameForId(root, sessionId);

    // A session is "plain" (blank window, no orchestrator prompt) only when no
    // project brief was selected. A brief-anchored session always runs the
    // orchestrator — the brief is its standing context and current objective.
    const plain = !brief;

    // Resolve the orchestrator's model. Each agent role runs on a per-type model
    // (see DEFAULT_MODEL_BY_ROLE); the orchestrator (main) defaults to Opus.
    // -m/--model overrides the model for the WHOLE fleet (main + every sub-agent),
    // replacing the per-type defaults. Resolved up front so a bad alias fails
    // before we spawn anything; when -m is given the daemon receives it via
    // CHARM_MODEL so it hands the same id to every sub-agent.
    const { resolveModel, defaultModelForRole, buildClaudeCommand, defaultPermissionMode, MAIN_AGENT_ID } = await import("./daemon/spawn.ts");
    let fleetModel: string;
    try {
      fleetModel = opts.model ? resolveModel(opts.model) : defaultModelForRole("main");
    } catch (e: any) {
      console.error(e.message);
      process.exit(2);
    }

    // Concurrent-agent cap for this charm (passed to the daemon as CHARM_MAX_AGENTS).
    // Counts the orchestrator, so it must be >= 1 (1 = orchestrator only, no
    // sub-agents). Validate here so a bad value fails at the CLI, not silently in
    // the daemon.
    const maxAgents = Number(opts.maxAgents);
    if (!Number.isInteger(maxAgents) || maxAgents < 1) {
      console.error(`[charm] --max-agents must be an integer >= 1 (got "${opts.maxAgents}").`);
      process.exit(2);
    }

    // 1. Spawn charmd in background. CHARM_MODEL (set only when -m/--model was
    // given) pins the model for every role the daemon spawns, overriding the
    // per-type defaults.
    const logFile = join(paths.logsDir, "charmd.log");
    // Point the daemon's stdout/stderr at its log file rather than inheriting
    // this CLI's TTY. The daemon outlives `start`, so an inherited TTY would
    // (a) keep the parent's stdio fds open after we exit and (b) let stray
    // daemon writes corrupt the tmux session once the terminal is handed off.
    const logFd = openSync(logFile, "a");
    const [daemonCmd, ...daemonPrefix] = resolveChild("daemon");
    const child = spawn(daemonCmd!, [...daemonPrefix, "--root", paths.root, "--session", session, "--uuid", sessionId], {
      stdio: ["ignore", logFd, logFd],
      detached: true,
      env: { ...process.env, CHARM_MAX_AGENTS: String(maxAgents), ...(opts.model ? { CHARM_MODEL: fleetModel } : {}) },
    });
    child.unref();
    console.log(`[charm] daemon pid=${child.pid}, log=${logFile}`);

    // Persist this session's identity now that we have the daemon pid. The
    // meta.json is the per-session record `stop`/`attach`/`status` read to find
    // and pick a session; the last-session pointer is the per-directory hint
    // `charm.sh` uses to attach to the session it just launched. The daemon later
    // enriches meta.json with the agent-set description (preserving these fields).
    writeSessionMeta(paths, {
      uuid: sessionId,
      session_name: session,
      root: paths.root,
      socket: paths.socket,
      pid: child.pid,
    });
    writeFileSync(paths.lastSessionFile, session + "\n");

    // 2. Wait for socket
    await waitForSocket(paths.socket, 10_000);
    await rpcCall(paths.socket, "ping");

    // 3. Open tmux layout: window with main pane + console pane
    const tmux = new Tmux(session);
    if (tmux.hasSession()) {
      console.error(`[charm] tmux session '${session}' already exists. Use --session or kill it.`);
      process.exit(2);
    }
    tmux.newSession("charm", paths.root);
    // Record this session's socket as a per-session tmux option. The `:` binding
    // reads it back via format expansion at keypress time, so `:q` resolves to
    // whichever session it was pressed in — see bindCommandPrompt below.
    tmux.setOption("@charm_socket", paths.socket);

    // Layout: console on the left (pane 0), main agent on the right (pane 1).
    // fleetModel + buildClaudeCommand + MAIN_AGENT_ID were resolved/imported above.
    const modelNote = opts.model
      ? `all agents on ${fleetModel} (-m override)`
      : `orchestrator on ${fleetModel}, sub-agents on per-type defaults`;
    const workflowNote = opts.workflowEnable ? " | Workflow tool enabled fleet-wide" : "";
    const briefNote = brief ? ` | project: ${brief.name}` : "";
    console.log(`[charm] ${modelNote} | max agents: ${maxAgents}${workflowNote}${briefNote}${plain ? " | plain window (pass --project to run the pipeline)" : ""}`);
    // Mint and persist the orchestrator's Claude-side conversation id plus the
    // launch settings it was spawned with. charm launches the main agent under
    // `claude --session-id <uuid>` (so it owns the id rather than discovering it),
    // then records {claude_session_id, model, permission_mode} to
    // orchestratorSessionFile — the conversation the operator wants back via
    // `charm resume`, along with the model + permission mode resume must re-supply
    // to relaunch it faithfully. Its own file (not meta.json) keeps it readable
    // across a daemon restart.
    const orchestratorSessionId = randomUUID();
    // The orchestrator's resume record. Written now with the launch settings, and
    // re-written below with the console + orchestrator pane ids once the panes
    // exist — so `charm resume` can faithfully relaunch the conversation AND, if
    // the daemon has since died, restart it and re-register those panes.
    const sessionRecord: Record<string, unknown> = {
      claude_session_id: orchestratorSessionId,
      model: fleetModel,
      permission_mode: defaultPermissionMode(),
      max_agents: maxAgents,
      // Persist so `charm resume` re-supplies CHARM_WORKFLOW_ENABLE to the relaunched
      // daemon + orchestrator, keeping the fleet's Workflow posture across a resume.
      workflow_enable: !!opts.workflowEnable,
      // Persist the brief slug so `charm resume` re-reads and re-injects the brief:
      // resume rebuilds the system prompt but the brief lives in a file, not the
      // conversation, so without this the resumed orchestrator would lose its
      // standing context. Only set when the session is project-anchored.
      ...(brief ? { project_brief: brief.slug } : {}),
    };
    writeFileSync(paths.orchestratorSessionFile, JSON.stringify(sessionRecord, null, 2) + "\n");
    const mainCmd = buildClaudeCommand(paths, MAIN_AGENT_ID, {
      role: "main",
      ticket_id: null,
      prompt: kickoffPrompt(brief),
      interactive: true,
      model: fleetModel,
      plain,
      claudeSessionId: orchestratorSessionId,
      projectBrief: brief ? { name: brief.name, slug: brief.slug, body: brief.body } : undefined,
    });
    const consoleArgv = resolveChild("console");
    const consoleCmd = `${consoleArgv.map(shellQuote).join(" ")} --root ${shellQuote(paths.root)} --uuid ${shellQuote(sessionId)}`;

    const consolePane = tmux.spawnInWindow("charm", consoleCmd, paths.root);
    const mainPane = await tmux.splitPane({ cmd: mainCmd, cwd: paths.root, direction: "h", size: "65%" });

    // Tell the daemon which pane is the console (pinned left column) and
    // which panes already belong to the agent grid. From here on, every
    // sub-agent spawn triggers a relayout into a VS-Code-style grid.
    await rpcCall(paths.socket, "register_panes", {
      console_pane_id: consolePane,
      agent_pane_ids: [mainPane],
    });

    // Persist the pane ids so `charm resume` can re-register them with a fresh
    // daemon if the original one has died (the daemon's in-memory pane tracking
    // is lost on death; these survive on disk). Pane ids are stable for the life
    // of the tmux session, which outlives the daemon.
    sessionRecord.console_pane_id = consolePane;
    sessionRecord.orchestrator_pane_id = mainPane;
    writeFileSync(paths.orchestratorSessionFile, JSON.stringify(sessionRecord, null, 2) + "\n");

    // Bind `:` (no prefix) to a tmux command-prompt that runs `charm ctl`.
    // Works from any pane — console or agent — so the user can quit/detach
    // the whole charm from wherever the cursor happens to be.
    //
    // CRITICAL: the binding must NOT bake in THIS session's identity. tmux key
    // tables (`root`) are server-global, not per-session — so each `charm start`
    // overwrites the single `:` entry for the whole server. If the entry carried
    // a fixed --socket/--session, pressing `:q` in an OLDER session would fire
    // the NEWEST session's identity and kill the wrong charm. Instead we pass
    // tmux format tokens (`#{@charm_socket}`, `#{session_name}`) that tmux expands
    // at keypress time, in the context of the session the key was pressed in. The
    // @charm_socket option was set per-session above, so `:q` always resolves to
    // the socket of the session you pressed it in. (The tokens are intentionally
    // NOT shell-quoted — they must reach tmux literally to be expanded.)
    //
    // Re-invoke THIS cli for the prompt. From source that's `bun <cli.ts> ctl …`;
    // a compiled binary dispatches its own subcommands, so it's just
    // `<binary> ctl …` (its embedded cli.ts path isn't on disk).
    const selfArgv = isCompiled()
      ? [process.execPath]
      : [process.execPath, fileURLToPath(import.meta.url)];
    const ctlTemplate =
      `${selfArgv.map(shellQuote).join(" ")} ctl ` +
      `--socket "#{@charm_socket}" --session "#{session_name}" %1`;
    tmux.bindCommandPrompt(ctlTemplate);

    // Two layout hooks, deliberately split by what each event needs. Both use
    // run-shell -b (background) so tmux never blocks key/mouse processing on the
    // RPC roundtrip.
    //
    // `window-layout-changed` fires on every manual divider drag (and on our own
    // select-layout). It routes to `clamp_console`, which only snaps the sidebar
    // back under its cap and NEVER recomputes the agent grid. The Claude panes
    // have no width policy — the user drags them freely — so re-applying a full
    // computed layout on each frame of a drag fought the cursor (the daemon read
    // a stale mid-drag width and select-layout snapped it back) and round-trip
    // rounding nudged untouched dividers. Clamp-only removes that friction, and
    // because the clamp is a no-op once the sidebar is within its cap, it also
    // can't feed itself a layout-changed loop.
    //
    // `client-resized` fires on terminal size changes and routes to a full
    // `relayout` — there the agent grid genuinely must be re-fit to the new
    // window, not just the sidebar clamped.
    const base = `${selfArgv.map(shellQuote).join(" ")} ctl`;
    const sock = `--socket "#{@charm_socket}"`;
    tmux.setHook("window-layout-changed", `${base} clamp_console ${sock}`, { background: true });
    tmux.setHook("client-resized", `${base} relayout ${sock}`, { background: true });

    // Focus the main agent pane so keystrokes go to Claude, not the console.
    tmux.selectPane(`${session}:charm.1`);

    if (opts.attach !== false) tmux.attach();
    else console.log(`tmux session '${session}' ready. attach with: tmux attach -t ${session}`);
  });

program
  .command("stop")
  .description("stop a charm: close its graph viewers, kill its daemon, and tear down its tmux session")
  .allowExcessArguments(false)
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session name (when multiple run in this dir)")
  .option("-u, --uuid <id>", "session UUID (when multiple run in this dir)")
  .option("--all", "stop every charm session in this directory", false)
  .action((opts) => {
    const root = resolve(opts.root);
    // Pick which session(s) to stop. With --all, every session in the dir; else
    // the one named/uuid'd, or — when exactly one runs — that one. Ambiguity
    // (multiple sessions, no selector) is a hard error rather than a guess: a
    // wrong guess here is the very cross-session kill this whole change fixes.
    let targets: RunSession[];
    if (opts.all) {
      targets = listRunSessions(root);
      if (targets.length === 0) { console.log(`[charm] no charm sessions in ${root}`); return; }
    } else {
      try { targets = [resolveOneSession(root, opts)]; }
      catch (e: any) { console.error(e.message); process.exit(2); }
    }
    for (const t of targets) stopSession(t);
  });

program
  .command("attach")
  .description("attach to a charm's tmux session")
  .allowExcessArguments(false)
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session name (when multiple run in this dir)")
  .option("-u, --uuid <id>", "session UUID (when multiple run in this dir)")
  .action((opts) => {
    const root = resolve(opts.root);
    let target: RunSession;
    try { target = resolveOneSession(root, opts); }
    catch (e: any) { console.error(e.message); process.exit(2); }
    const tmux = new Tmux(target.meta.session_name ?? "");
    if (!tmux.hasSession()) {
      console.error(`no tmux session '${target.meta.session_name}'`);
      process.exit(2);
    }
    tmux.attach();
  });

/** True when Claude Code has actually persisted a conversation for `uuid`.
 *  charm mints the orchestrator's session id at `charm start` and records it up
 *  front, but Claude Code only writes `~/.claude/projects/<slug>/<uuid>.jsonl` on
 *  the first COMPLETED turn — so a recorded id can point at a conversation that
 *  never existed (orchestrator died before its first turn, or a plain
 *  window nobody typed into). `charm resume` must verify the file is on disk before
 *  shelling `claude --resume <uuid>`, otherwise it spawns a pane that dies with
 *  "No conversation found with session ID …" while the CLI reports success.
 *
 *  Globbing every project dir for `<uuid>.jsonl` (rather than reconstructing the
 *  cwd->slug munging Claude applies) keeps this robust to that internal rule
 *  changing: session ids are globally unique, so a hit in any project dir is THE
 *  conversation. */
function claudeConversationExists(uuid: string): boolean {
  const base = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try { dirs = readdirSync(base); }
  catch { return false; } // projects dir absent -> nothing to resume
  return dirs.some((d) => existsSync(join(base, d, `${uuid}.jsonl`)));
}

program
  .command("resume [session]")
  .description("relaunch the orchestrator pane on its saved conversation (claude --resume), or --continue for the most recent")
  .allowExcessArguments(false)
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session name (when multiple run in this dir)")
  .option("-u, --uuid <id>", "session UUID (when multiple run in this dir)")
  .option("--continue", "resume the orchestrator's most-recent conversation instead of its saved session id", false)
  .action(async (sessionArg: string | undefined, opts) => {
    const root = resolve(opts.root);
    // The positional `[session]` is a convenience selector: a bare
    // `charm resume my-session` picks that session by name (or uuid), same as
    // `--session`/`--uuid`. An explicit flag wins if both are given.
    const sel = sessionArg
      ? { ...opts, session: opts.session ?? sessionArg, uuid: opts.uuid }
      : opts;
    let target: RunSession;
    try { target = resolveOneSession(root, sel); }
    catch (e: any) { console.error(e.message); process.exit(2); }
    const paths = target.paths;

    // Read what charm recorded about the orchestrator at start: its Claude-side
    // conversation id plus the model + permission mode it was launched with, so
    // the relaunch is faithful (same MCP config, system prompt, model, perms).
    let record: {
      claude_session_id?: string;
      model?: string;
      permission_mode?: string;
      max_agents?: number;
      workflow_enable?: boolean;
      project_brief?: string;
      console_pane_id?: string;
      orchestrator_pane_id?: string;
    } = {};
    if (existsSync(paths.orchestratorSessionFile)) {
      try { record = JSON.parse(readFileSync(paths.orchestratorSessionFile, "utf8")); }
      catch { /* corrupt — fall through to the missing-id guard below */ }
    }
    const useContinue = !!opts.continue;
    if (!useContinue && !record.claude_session_id) {
      console.error(
        `[charm] no saved orchestrator session id for '${target.meta.session_name}' ` +
          `(${paths.orchestratorSessionFile} missing or unreadable). ` +
          `Retry with --continue to resume its most-recent conversation, or start a fresh charm.`,
      );
      process.exit(2);
    }
    // A recorded id is not a resumable conversation: Claude Code writes the session
    // file only on the first completed turn, so an orchestrator that died at startup
    // (or a plain window nobody used) leaves the id pointing at nothing. Catch that
    // HERE with a clear diagnosis, rather than shelling `claude --resume <uuid>` into
    // the pane where it dies with "No conversation found" while we print success.
    if (!useContinue && !claudeConversationExists(record.claude_session_id!)) {
      console.error(
        `[charm] the recorded conversation for '${target.meta.session_name}' ` +
          `(session id ${record.claude_session_id}) was never saved by Claude Code — ` +
          `the orchestrator likely exited before completing its first turn, or it was a ` +
          `plain window with no activity. There is nothing to resume under that id.\n` +
          `Retry with --continue to resume the most-recent conversation in this directory, ` +
          `or start a fresh charm.`,
      );
      process.exit(2);
    }

    const session = target.meta.session_name ?? "";
    const tmux = new Tmux(session);
    if (!tmux.hasSession()) {
      console.error(
        `[charm] tmux session '${session}' is not running; \`charm resume\` relaunches the orchestrator ` +
          `pane inside a live charm window. Start a fresh charm instead.`,
      );
      process.exit(2);
    }

    // Make sure the daemon backing this session is alive before relaunching the
    // orchestrator. If it died, its in-memory state (agent registry, pane
    // tracking) is gone, so a resumed orchestrator's charm MCP tools would have no
    // backend — it would come up wired to a dead socket. Restart a fresh daemon
    // and re-register the console + orchestrator panes (persisted at start). Any
    // sub-agents from before the crash are unrecoverable (their registry state is
    // gone), so their panes are reaped here; the orchestrator re-derives ticket
    // state from the on-disk board.
    let daemonAlive = false;
    try { await rpcCall(paths.socket, "ping"); daemonAlive = true; } catch { /* daemon down */ }
    if (!daemonAlive) {
      if (!record.console_pane_id || !record.orchestrator_pane_id) {
        console.error(
          `[charm] the daemon for '${session}' is down and there are no saved pane ids to re-register ` +
            `(this session predates pane-id persistence). Start a fresh charm instead.`,
        );
        process.exit(2);
      }
      console.log(`[charm] daemon for '${session}' is down; restarting it and re-registering panes.`);
      // Reap orphaned sub-agent panes — keep only the console + orchestrator, so
      // the fresh daemon adopts a clean two-pane layout.
      for (const p of tmux.listPanes()) {
        if (p.pane_id !== record.console_pane_id && p.pane_id !== record.orchestrator_pane_id) {
          await tmux.killPane(p.pane_id);
        }
      }
      // Spawn a fresh daemon, faithful to the original launch settings (mirrors
      // `charm start`). record.model is exactly the fleet model the daemon ran
      // with, so passing it reproduces the original fleet model whether or not
      // -m was used.
      mkdirSync(paths.logsDir, { recursive: true });
      const logFd = openSync(join(paths.logsDir, "charmd.log"), "a");
      const [daemonCmd, ...daemonPrefix] = resolveChild("daemon");
      const d = spawn(
        daemonCmd!,
        [...daemonPrefix, "--root", paths.root, "--session", session, "--uuid", target.sessionId],
        {
          stdio: ["ignore", logFd, logFd],
          detached: true,
          env: {
            ...process.env,
            ...(record.model ? { CHARM_MODEL: record.model } : {}),
            ...(record.permission_mode ? { CHARM_PERMISSION_MODE: record.permission_mode } : {}),
            ...(record.max_agents ? { CHARM_MAX_AGENTS: String(record.max_agents) } : {}),
            ...(record.workflow_enable ? { CHARM_WORKFLOW_ENABLE: "1" } : {}),
          },
        },
      );
      d.unref();
      try {
        await waitForSocket(paths.socket, 10_000);
        await rpcCall(paths.socket, "ping");
      } catch {
        console.error(`[charm] restarted daemon did not come up (see ${join(paths.logsDir, "charmd.log")}).`);
        process.exit(2);
      }
      await rpcCall(paths.socket, "register_panes", {
        console_pane_id: record.console_pane_id,
        agent_pane_ids: [record.orchestrator_pane_id],
      });
      console.log(`[charm] daemon restarted (pid=${d.pid}).`);
    }

    // Re-supply the original launch settings: model + permission mode are
    // re-applied so the resumed session behaves like the original spawn. With no
    // recorded model, fall back to the orchestrator's per-type default.
    const { buildClaudeCommand, resolveModel, defaultModelForRole, MAIN_AGENT_ID } = await import("./daemon/spawn.ts");
    let model: string | undefined;
    try {
      model = record.model ? resolveModel(record.model) : defaultModelForRole("main");
    } catch { model = undefined; }
    if (record.permission_mode) process.env.CHARM_PERMISSION_MODE = record.permission_mode;
    // Restore the fleet's Workflow posture for the in-process orchestrator relaunch
    // (the restarted daemon already got it via its env above; this covers the pane
    // buildClaudeCommand builds here in the CLI process).
    if (record.workflow_enable) process.env.CHARM_WORKFLOW_ENABLE = "1";
    // Re-inject the project brief. Resume rebuilds the system prompt from scratch,
    // and the brief lives in a file (not the conversation) — so without re-reading
    // it here the resumed orchestrator would come back stripped of its standing
    // context. A brief that was deleted since the original start is skipped (a
    // warning, not a failure — the conversation history still carries the work).
    let resumeBrief: Brief | null = null;
    if (record.project_brief) {
      resumeBrief = readBrief(paths, record.project_brief);
      if (!resumeBrief) {
        console.error(
          `[charm] project brief '${record.project_brief}' is gone; resuming without it.`,
        );
      }
    }

    const resumeCmd = buildClaudeCommand(paths, MAIN_AGENT_ID, {
      role: "main",
      ticket_id: null,
      prompt: "",
      interactive: true,
      model,
      resume: useContinue ? "continue" : { uuid: record.claude_session_id! },
      projectBrief: resumeBrief
        ? { name: resumeBrief.name, slug: resumeBrief.slug, body: resumeBrief.body }
        : undefined,
    });

    // Relaunch into the orchestrator's existing pane, reusing the same pane id.
    // Prefer the exact pane id the daemon tracks (robust once sub-agent panes have
    // shifted index numbering); fall back to the static index-1 target only if the
    // daemon is unreachable. `respawn-pane -k` kills whatever occupies that pane
    // (the exited/zombie orchestrator) and runs the resume command in place —
    // preserving the layout AND the pane id the daemon already tracks as the
    // orchestrator, so no daemon re-registration is needed while the daemon is up.
    let orchTarget = `${session}:charm.1`;
    try {
      const { pane_id } = await rpcCall<{ pane_id: string | null }>(paths.socket, "orchestrator_pane");
      if (pane_id) orchTarget = pane_id;
    } catch { /* daemon unreachable — fall back to the static index-1 target */ }
    const r = spawnSync("tmux", ["respawn-pane", "-k", "-t", orchTarget, "-c", paths.root, "sh", "-c", resumeCmd], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      console.error(`[charm] failed to relaunch orchestrator pane (${orchTarget}): ${r.stderr?.trim() || `exit ${r.status}`}`);
      process.exit(2);
    }
    spawnSync("tmux", ["set-option", "-p", "-t", orchTarget, "allow-passthrough", "on"]);
    spawnSync("tmux", ["select-pane", "-t", orchTarget]);
    console.log(
      `[charm] resumed orchestrator on session '${session}' ` +
        `(${useContinue ? "--continue" : `--resume ${record.claude_session_id}`}). attach with: charm attach -u ${target.sessionId}`,
    );
  });

program
  .command("status")
  .description("print agents, tickets, pending approvals")
  .allowExcessArguments(false)
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session name (when multiple run in this dir)")
  .option("-u, --uuid <id>", "session UUID (when multiple run in this dir)")
  .action(async (opts) => {
    const root = resolve(opts.root);
    let target: RunSession;
    try { target = resolveOneSession(root, opts); }
    catch (e: any) { console.error(e.message); process.exit(1); }
    try {
      const s = await rpcCall<any>(target.paths.socket, "status");
      console.log(JSON.stringify(s, null, 2));
    } catch (e: any) {
      if (!existsSync(target.paths.socket)) {
        console.error("no charm daemon running. start one with: charm start");
      } else {
        console.error(`daemon unreachable: ${e.message}`);
      }
      process.exit(1);
    }
  });

program
  .command("tree")
  .description("print the ticket dependency tree — an ASCII DAG view of .charm/tickets/ (reads the board directly; no daemon required)")
  .allowExcessArguments(false)
  .option("-r, --root <path>", "project root", process.cwd())
  .action(async (opts) => {
    const root = resolve(opts.root);
    const paths = charmPaths(root);
    if (!existsSync(paths.ticketsDir)) {
      console.error(`[charm] no .charm/tickets/ under ${root}; nothing to show. Run \`charm init\` or \`charm start\` first.`);
      process.exit(1);
    }
    // Read straight off the .md files (the source of truth) rather than the
    // sqlite index, so the tree is correct even with no daemon running and never
    // writes to a db the daemon may have open. TicketStore.list() parses and
    // sorts the ticket files; we map down to the narrow shape the renderer wants.
    const { TicketStore } = await import("./store/tickets.ts");
    const { renderTicketTree, TREE_LEGEND } = await import("./tree.ts");
    const store = new TicketStore(paths);
    try {
      const tickets = store.list().map((t) => ({
        id: t.frontmatter.id,
        title: t.frontmatter.title,
        status: t.frontmatter.status,
        depends_on: t.frontmatter.depends_on,
      }));
      console.log(renderTicketTree(tickets));
      if (tickets.length) console.log(`\n${TREE_LEGEND}`);
    } finally {
      store.close();
    }
  });

// `charm worktree` groups the read-only worktree views. Open/close live ONLY on
// the orchestrator's MCP surface (create_worktree/close_worktree): those mutate
// git plumbing the daemon owns, so exposing them on the CLI would let an operator
// race the daemon's worktree set. The CLI stays read-only.
const worktreeCmd = program
  .command("worktree")
  .description("inspect the worktrees a charm session is managing (~/.charm-worktrees/<repo>/<name>/)");

worktreeCmd
  .command("list")
  .description("list the orchestrator-managed worktrees (asks a live daemon for the annotated view; falls back to scanning ~/.charm-worktrees/<repo>/ when no daemon is up)")
  .option("-r, --root <path>", "project root", process.cwd())
  .action(async (opts) => {
    const root = resolve(opts.root);
    // Prefer a live daemon: its list_worktrees annotates each copy with the agent
    // (if any) occupying it — richer than a bare dir scan. We don't resolveOneSession
    // here (copies are project-wide, not per-session run-state), so just probe the
    // newest live session's socket; absent one, fall back to scanning the dir.
    const live = listRunSessions(root).find((s) => s.alive);
    if (live) {
      try {
        const res = await rpcCall<any>(live.paths.socket, "list_worktrees");
        console.log(JSON.stringify(res, null, 2));
        return;
      } catch {
        // Daemon flagged alive but unreachable (mid-shutdown / stale pid) — drop to
        // the dir-scan fallback rather than erroring; the question is read-only.
      }
    }
    // No daemon: scan this repo's worktree group directly (~/.charm-worktrees/<repo>/),
    // same no-daemon-required ethos as `tree`. Each subdir is a `git worktree add`
    // worktree, so its .git is a gitdir-pointer FILE (not a dir) — existsSync matches
    // either. We read each one's branch from inside it. This mirrors
    // WorktreeManager.list() without needing the daemon.
    const worktreesDir = charmPaths(root).worktreesDir;
    if (!existsSync(worktreesDir)) {
      console.log("[]");
      return;
    }
    const copies = readdirSync(worktreesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(worktreesDir, e.name, ".git")))
      .map((e) => {
        const path = join(worktreesDir, e.name);
        const b = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path, encoding: "utf8" });
        return { name: e.name, path, branch: b.status === 0 ? b.stdout.trim() : null };
      });
    console.log(JSON.stringify(copies, null, 2));
  });

program
  .command("approve <gate_id>")
  .description("resolve a pending approval gate")
  .allowExcessArguments(false)
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session name (when multiple run in this dir)")
  .option("-u, --uuid <id>", "session UUID (when multiple run in this dir)")
  .option("--reject", "reject instead of approve", false)
  .action(async (gateId: string, opts) => {
    const root = resolve(opts.root);
    let target: RunSession;
    try { target = resolveOneSession(root, opts); }
    catch (e: any) { console.error(e.message); process.exit(1); }
    const res = await rpcCall<{ resolved: boolean }>(target.paths.socket, "approve_gate", {
      id: gateId,
      decision: opts.reject ? "reject" : "approve",
    });
    console.log(res);
  });

// Operator commands (restart, reset-kb) mutate shared session state — the ticket
// board, the durable KB. They are for the human operator or the orchestrator only.
// The charm skills that wrap them ship globally in the charm plugin, so a sub-agent
// (worker / investigator / tester / researcher) technically has them in its skill
// list; this is the HARD gate that stops one from actually running the destructive
// op. CHARM_AGENT_ROLE is exported per spawn (daemon/spawn.ts) and is unset for the
// human terminal, so the human is always allowed; only main/suborchestrator agents
// may run it.
function assertOperatorContext(action: string): void {
  const role = (process.env.CHARM_AGENT_ROLE ?? "").trim().toLowerCase();
  const allowed = role === "" || role === "main" || role === "suborchestrator";
  if (!allowed) {
    console.error(
      `[charm] refusing to ${action}: this is an operator action and a ${role} agent must not run it. ` +
        `Escalate to the orchestrator (report_status with state "blocked") instead.`,
    );
    process.exit(3);
  }
}

program
  .command("restart")
  .description("reset the ticket backlog: kill ticketed agents, wipe ticket files + the db index, reset COORDINATION.md (daemon, KB, and session stay up)")
  .allowExcessArguments(false)
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session name (when multiple run in this dir)")
  .option("-u, --uuid <id>", "session UUID (when multiple run in this dir)")
  .action(async (opts) => {
    assertOperatorContext("restart");
    const root = resolve(opts.root);
    // The ticket board (tickets/, db, COORDINATION.md) is shared per-directory,
    // but killing the in-flight agents needs a daemon socket — resolve the one
    // session whose fleet we're resetting.
    let target: RunSession;
    try { target = resolveOneSession(root, opts); }
    catch (e: any) { console.error(e.message); process.exit(2); }
    const paths = target.paths;
    // 1. Kill every agent currently assigned a ticket (operator caller = no
    //    caller_id). Done first so no agent reports done/failed against a ticket
    //    we are about to delete — report_status throws "unknown ticket" otherwise.
    try {
      const { agents = [] } = await rpcCall<{ agents: { id: string; ticket_id: string | null; role: string }[] }>(
        paths.socket,
        "status",
      );
      const ticketed = agents.filter((a) => a.ticket_id && a.role !== "main");
      for (const a of ticketed) {
        await rpcCall(paths.socket, "kill_agent", { agent_id: a.id });
        console.log(`killed ${a.id} (was on ${a.ticket_id})`);
      }
      console.log(ticketed.length ? `killed ${ticketed.length} ticketed agent(s)` : "no ticketed agents to kill");
    } catch (e: any) {
      console.log(`daemon unreachable (${e.message}) — skipping agent kill, continuing wipe`);
    }
    // 2. Delete the ticket markdown files — the source of truth.
    let removed = 0;
    if (existsSync(paths.ticketsDir)) {
      for (const f of readdirSync(paths.ticketsDir)) {
        if (f.endsWith(".md")) { rmSync(join(paths.ticketsDir, f)); removed++; }
      }
    }
    console.log(`removed ${removed} ticket file(s)`);
    // 3. Clear the derived index so nextId() resets to T-001 (it reads MAX(id)).
    if (existsSync(paths.db)) {
      const { Database } = await import("bun:sqlite");
      const db = new Database(paths.db);
      db.exec("DELETE FROM tickets");
      db.close();
      console.log("cleared tickets table in db.sqlite");
    }
    // 4. Reset COORDINATION.md, dropping any orphaned agent blocks.
    writeFileSync(paths.coordinationMd, "# COORDINATION.md\n\n_Daemon will populate this as agents check in._\n");
    console.log("reset COORDINATION.md");
  });

program
  .command("reset-kb")
  .description("DESTRUCTIVE: wipe .charm/kb/ and restore the pristine template scaffold (the durable knowledge base)")
  .allowExcessArguments(false)
  .option("-r, --root <path>", "project root", process.cwd())
  .action((opts) => {
    assertOperatorContext("reset the knowledge base");
    const paths = charmPaths(resolve(opts.root));
    // Confirm the template exists BEFORE destroying the live copy, so a missing
    // template can't leave the project with no kb at all. The destructive
    // confirmation gate is the charm-reset-kb skill's responsibility (it runs
    // before invoking this); this command itself is non-interactive so it never
    // hangs an unattended agent pane.
    const tmpl = locateTemplateDir("kb");
    if (!tmpl) {
      console.error("[charm] kb template not found; refusing to reset (would leave no kb).");
      process.exit(2);
    }
    rmSync(paths.kbDir, { recursive: true, force: true });
    cpSync(tmpl, paths.kbDir, { recursive: true });
    console.log(`[charm] reset ${paths.kbDir} to template`);
  });

program
  .command("ctl <cmd>")
  .description("internal: handle a vim-style command (`:q`, `:a`, `:so`) from the tmux key binding")
  .allowExcessArguments(false)
  .option("--socket <path>", "daemon socket of the session the key was pressed in")
  .option("-s, --session <name>", "tmux session the key was pressed in")
  .action(async (cmd: string, opts) => {
    // This runs from the `:` key binding, which passes the ACTIVE session's
    // identity via tmux format expansion (--socket #{@charm_socket}, --session
    // #{session_name}). So a `:q` always targets the session it was pressed in —
    // never a sibling charm that happens to share the tmux server. Both flags may
    // be absent/empty if a session was created outside `charm start`; we degrade
    // gracefully (kill by session name) rather than touch the wrong daemon.
    const socket = (opts.socket as string | undefined)?.trim() || "";
    const session = (opts.session as string | undefined)?.trim() || "";
    const c = cmd.trim().toLowerCase();
    if (c === "q" || c === "quit") {
      // Ask THIS session's daemon to shut down: it tears down its own tmux
      // session and reaps its own (per-session) graph viewers. If the socket is
      // unset or the daemon is already gone, fall back to killing the tmux
      // session by name so `:q` still closes the window.
      if (socket) {
        try { await rpcCall(socket, "shutdown"); return; }
        catch { /* daemon gone — fall through to the tmux fallback */ }
      }
      if (session) new Tmux(session).killSession();
      return;
    }
    if (c === "a" || c === "detach") {
      if (session) spawn("tmux", ["detach-client", "-s", session], { stdio: "ignore" });
      return;
    }
    // Spawn a suborchestrator: an interactive, operator-facing agent in its own
    // tmux window that has orchestrator-level MCP permissions. Useful when the
    // operator wants to delegate sub-tasks, query the fleet, or run parallel work
    // while the main orchestrator continues. Opens the new window immediately.
    const SO_ALIASES = new Set(["so", "sub", "suborchestrator"]);
    if (SO_ALIASES.has(c)) {
      if (socket) {
        try { await rpcCall(socket, "spawn_suborchestrator"); return; }
        catch { /* daemon gone — fall through */ }
      }
      spawn("tmux", ["display-message", `charm: cannot spawn suborchestrator (no daemon)`], { stdio: "ignore" });
      return;
    }
    // Recompute the layout: fired by the session's `client-resized` tmux hook so
    // the agent grid is re-fit and the sidebar's max-width clamp re-applies on
    // terminal resize. Fail silently if the daemon's gone — a resize must never error.
    if (c === "relayout") {
      if (socket) {
        try { await rpcCall(socket, "relayout"); } catch { /* daemon gone — nothing to relayout */ }
      }
      return;
    }
    // Clamp only the sidebar column back under its cap: fired by the session's
    // `window-layout-changed` hook on every manual divider drag. Deliberately does
    // NOT recompute the agent grid, so dragging Claude-pane dividers is
    // frictionless. Fail silently if the daemon's gone — a drag must never error.
    if (c === "clamp_console") {
      if (socket) {
        try { await rpcCall(socket, "clamp_console"); } catch { /* daemon gone — nothing to clamp */ }
      }
      return;
    }
    // Unknown: surface in tmux status line briefly.
    spawn("tmux", ["display-message", `unknown charm command: ${cmd}`], { stdio: "ignore" });
  });

program
  .command("session-name")
  .description("internal: print a session's tmux name for this root (used by charm.sh)")
  .allowExcessArguments(false)
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session name (when multiple run in this dir)")
  .option("-u, --uuid <id>", "session UUID (when multiple run in this dir)")
  .action((opts) => {
    const root = resolve(opts.root);
    let target: RunSession;
    try { target = resolveOneSession(root, opts); }
    catch (e: any) { console.error(e.message); process.exit(2); }
    process.stdout.write((target.meta.session_name ?? "") + "\n");
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

/** A discovered charm session in a directory: its UUID, resolved per-session
 *  paths, parsed meta.json, and whether its daemon is currently alive. */
type RunSession = { sessionId: string; paths: CharmPaths; meta: SessionMeta; alive: boolean };

/** True for a pid that names a live process. Signal 0 does the kernel's
 *  existence/permission check without delivering a signal. */
function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Enumerate every charm session under <root>/.charm/run/, parsing each
 *  meta.json and flagging whether its daemon is alive. Newest first. Unreadable
 *  or meta-less run dirs are skipped (they're mid-creation or corrupt). */
function listRunSessions(root: string): RunSession[] {
  const { runRootDir } = charmPaths(root);
  if (!existsSync(runRootDir)) return [];
  const out: RunSession[] = [];
  for (const id of readdirSync(runRootDir)) {
    const paths = charmPaths(root, id);
    if (!existsSync(paths.metaJson)) continue;
    let meta: SessionMeta;
    try { meta = SessionMeta.parse(JSON.parse(readFileSync(paths.metaJson, "utf8"))); }
    catch { continue; }
    const pid = meta.pid ?? (existsSync(paths.pidFile) ? Number(readFileSync(paths.pidFile, "utf8").trim()) : undefined);
    out.push({ sessionId: id, paths, meta, alive: pidAlive(pid) });
  }
  return out.sort((a, b) => b.meta.created_at - a.meta.created_at);
}

/** Pick exactly one session for a command that operates on a single charm.
 *  Precedence: explicit --uuid, then --session / $CHARM_SESSION (by tmux name),
 *  else the single (preferring live) session in the dir. Ambiguity — multiple
 *  sessions and no selector — throws with a listing rather than guessing: a wrong
 *  guess is exactly the cross-session kill this change exists to prevent. */
function resolveOneSession(root: string, opts: { uuid?: string; session?: string }): RunSession {
  const all = listRunSessions(root);
  if (opts.uuid) {
    const s = all.find((s) => s.sessionId === opts.uuid);
    if (!s) throw new Error(`no charm session with uuid '${opts.uuid}' in ${root}`);
    return s;
  }
  const name = opts.session ?? process.env.CHARM_SESSION;
  if (name) {
    const matches = all.filter((s) => s.meta.session_name === name);
    if (matches.length === 0) throw new Error(`no charm session named '${name}' in ${root}`);
    if (matches.length > 1) throw new Error(`multiple charm sessions named '${name}' in ${root}; pass --uuid <id>`);
    return matches[0]!;
  }
  const live = all.filter((s) => s.alive);
  const pool = live.length ? live : all;
  if (pool.length === 1) return pool[0]!;
  if (pool.length === 0) throw new Error(`no charm session in ${root}. start one with: charm start`);
  const listing = pool
    .map((s) => `  ${s.meta.session_name}  (--uuid ${s.sessionId}${s.alive ? "" : ", dead"})${s.meta.description ? ` — ${s.meta.description}` : ""}`)
    .join("\n");
  throw new Error(`multiple charm sessions in ${root}; pick one with --session <name> or --uuid <id>:\n${listing}`);
}

/** Tear down one session: close its graph viewers, kill its daemon, reclaim its
 *  run-state files, kill its tmux session, and remove its run dir. Mirrors the
 *  daemon's own cleanup so it works whether the daemon is alive or already gone. */
function stopSession(t: RunSession): void {
  const { paths, meta } = t;
  const killed = killGraphViewers(paths.graphPids);
  if (killed.length) console.log(`[charm] closed ${killed.length} graph viewer(s): ${killed.join(", ")}`);
  if (existsSync(paths.pidFile)) {
    const pid = Number(readFileSync(paths.pidFile, "utf8").trim());
    if (pid) {
      try { process.kill(pid); console.log(`[charm] killed daemon pid=${pid}`); }
      catch { console.log(`[charm] daemon pid=${pid} not running`); }
    }
    try { unlinkSync(paths.pidFile); } catch { /* ignore */ }
  }
  try { if (existsSync(paths.socket)) unlinkSync(paths.socket); } catch { /* ignore */ }
  const session = meta.session_name;
  if (session) {
    const tmux = new Tmux(session);
    if (tmux.hasSession()) {
      tmux.killSession();
      console.log(`[charm] killed tmux session '${session}'`);
    }
  }
  // Drop the (now-defunct) run dir so it doesn't linger in the session picker.
  try { rmSync(paths.runDir, { recursive: true, force: true }); } catch { /* ignore */ }
  // Clear the per-dir last-session pointer if it named this session.
  try {
    if (session && existsSync(paths.lastSessionFile) && readFileSync(paths.lastSessionFile, "utf8").trim() === session) {
      unlinkSync(paths.lastSessionFile);
    }
  } catch { /* ignore */ }
}

/** Remove run dirs whose daemon is dead. Called at `start` so a crashed prior
 *  session doesn't haunt the picker; never touches a session with a live pid. */
function pruneDeadSessions(root: string): void {
  for (const s of listRunSessions(root)) {
    if (s.alive) continue;
    try { rmSync(s.paths.runDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Resolve the project brief for a `charm start` invocation from the --project
 * option value:
 *   - undefined  -> --project not passed: a plain session (null).
 *   - "<slug>"   -> select that brief directly; hard error if it doesn't exist.
 *   - true       -> bare --project: open the interactive picker (filter existing,
 *                   or create a new one, editing it in $EDITOR).
 *
 * Runs before the daemon/tmux come up so the picker and any editor own a clean
 * TTY. Cancelling the picker exits cleanly (0); creating a brief ALWAYS proceeds
 * to launch (on the template if no editor is available), never bailing.
 */
async function resolveProjectBrief(
  paths: CharmPaths,
  project: string | boolean | undefined,
): Promise<Brief | null> {
  if (project === undefined) return null;
  if (typeof project === "string") {
    const b = readBrief(paths, project);
    if (!b) {
      const available = listBriefs(paths).map((x) => x.slug);
      console.error(
        `[charm] no project brief '${project}' (looked for ${briefPathFor(paths, project)}).` +
          (available.length ? ` Available: ${available.join(", ")}.` : "") +
          ` Run \`charm start --project\` to pick or create one.`,
      );
      process.exit(2);
    }
    return b;
  }
  // Bare --project: interactive. Import the Ink picker lazily so a plain CLI
  // invocation never pays to load React/Ink.
  const { pickProject } = await import("./cli/project-picker.tsx");
  const result = await pickProject(listBriefs(paths), (slug) => {
    try {
      deleteBrief(paths, slug);
    } catch (e: any) {
      // A failed delete must not crash the picker; the row is already gone from
      // its view, and a leftover file just reappears next launch.
      console.error(`[charm] could not delete brief '${slug}': ${e?.message ?? e}`);
    }
  });
  if (result.action === "abort") {
    console.log("[charm] project selection cancelled.");
    process.exit(0);
  }
  if (result.action === "select") {
    const b = readBrief(paths, result.slug);
    if (!b) {
      console.error(`[charm] project brief '${result.slug}' disappeared before it could be read.`);
      process.exit(2);
    }
    return b;
  }
  // Create: scaffold from template, open $EDITOR to fill it in (best effort), and
  // ALWAYS proceed to launch with the resulting brief. Bailing here was a trap —
  // with no $EDITOR (or a GUI editor that returns before you've typed) the session
  // never started, so a freshly-created project appeared to "fail to load" on the
  // first run and only worked on a re-run once the file already existed. Starting
  // on a template brief is fine: it's re-read on `charm resume`, and the
  // orchestrator can help flesh it out.
  const { slug, path } = scaffoldBrief(paths, result.name);
  const opened = openInEditor(path);
  const b = readBrief(paths, slug);
  if (!b) {
    console.error(`[charm] could not read the brief just created at ${path}.`);
    process.exit(2);
  }
  if (!opened) {
    console.log(
      `[charm] created ${path} but no editor to open it ($VISUAL/$EDITOR unset). ` +
        `Starting with the template brief — edit that file (re-read on \`charm resume\`) ` +
        `or ask the orchestrator to help fill it in.`,
    );
  } else if (isUneditedBrief(b)) {
    console.log(
      `[charm] ${path} still looks like the unedited template. Starting anyway; ` +
        `flesh it out in the file (re-read on \`charm resume\`) or with the orchestrator.`,
    );
  }
  return b;
}

/** Open `path` in the operator's editor ($VISUAL/$EDITOR), blocking until it
 *  exits. Returns false when no editor is configured or the binary can't be
 *  launched, so the caller can fall back to a "fill it in and re-run" message.
 *  A non-zero editor exit still counts as opened — the file may well have been
 *  edited. The editor string is split on whitespace so `EDITOR="code --wait"`
 *  works. */
function openInEditor(path: string): boolean {
  const editor = (process.env.VISUAL || process.env.EDITOR || "").trim();
  if (!editor) return false;
  const [bin, ...args] = editor.split(/\s+/);
  const r = spawnSync(bin!, [...args, path], { stdio: "inherit" });
  return !r.error;
}

/** Build the orchestrator's kickoff message. A project-anchored session points
 *  the agent at its brief (already in the system prompt) and tells it to work
 *  the brief's current objective; a plain (no --project) session returns "" so
 *  Claude opens waiting for user input. */
function kickoffPrompt(brief: Brief | null): string {
  if (!brief) return "";
  return (
    `Project: ${brief.name}. Your operational brief is standing context in your system prompt ` +
    `(full file: .charm/project-briefs/${brief.slug}.md). ` +
    `Read the brief so you know the project's standing context and where its information lives. ` +
    `This is orientation only — do not start any work yet.`
  );
}

/** Write (or overwrite) a session's meta.json with its identity. created_at is
 *  preserved across rewrites; updated_at is stamped now. The daemon later merges
 *  in the agent-set description via the same file, preserving these fields. */
function writeSessionMeta(
  paths: CharmPaths,
  identity: { uuid: string; session_name: string; root: string; socket: string; pid: number | undefined },
): void {
  const now = Date.now();
  let created_at = now;
  let description = "";
  if (existsSync(paths.metaJson)) {
    try {
      const prev = SessionMeta.parse(JSON.parse(readFileSync(paths.metaJson, "utf8")));
      created_at = prev.created_at;
      description = prev.description;
    } catch { /* corrupt — start fresh */ }
  }
  const meta: SessionMeta = {
    ...identity,
    description,
    created_at,
    updated_at: now,
    source: "start",
  };
  mkdirSync(dirname(paths.metaJson), { recursive: true });
  writeFileSync(paths.metaJson, JSON.stringify(meta, null, 2) + "\n");
}

/**
 * Scaffold (or refresh) the shared .charm/ workspace.
 *
 * `refresh` controls how template-managed *tooling* (prompts, the workspace
 * CHARM.md, and charm.json) is treated when it already exists:
 *   - refresh=true  (charm init): re-copy every template file, overwriting the
 *     local copy. New template files are added, changed ones are updated. This
 *     is additive-or-modify only -- cpSync never removes a destination file that
 *     has no template counterpart, so local-only files survive.
 *   - refresh=false (charm start): additive only -- copy a template file only if
 *     it's missing locally, never overwrite. Keeps frequent starts from churning
 *     or reverting a hand-tuned workspace.
 *
 * Either way, user/runtime DATA is never clobbered: kb/ and COORDINATION.md are
 * seeded only when absent, and .claude/settings.json is merged (union), never
 * overwritten. Nothing is ever deleted.
 */
function scaffoldCharmDir(
  paths: ReturnType<typeof charmPaths>,
  { refresh }: { refresh: boolean },
) {
  mkdirSync(paths.charmDir, { recursive: true });
  mkdirSync(paths.ticketsDir, { recursive: true });
  // Orchestrator scratchpad for ticket drafts (promoted into ticketsDir via the
  // `promote` MCP tool) and the proposals tree (feature requests + a finished/
  // landing zone). Created empty; never clobbered on re-init.
  mkdirSync(paths.scratchpadDir, { recursive: true });
  mkdirSync(paths.proposalsDir, { recursive: true });
  // Per-project operational briefs (`charm start --project`). A durable, git-tracked
  // surface (re-included in .charm/.gitignore below); created empty and never
  // clobbered, so operator-authored briefs accumulate across sessions.
  mkdirSync(paths.projectBriefsDir, { recursive: true });
  mkdirSync(paths.promptsDir, { recursive: true });
  // NOTE: logsDir is deliberately NOT created here. It's per-session run state
  // (.charm/run/<uuid>/logs/), created by whoever owns a session — `start`,
  // restart, and the daemon each mkdir it with a session in scope. Creating it
  // in the shared scaffolder made `charm init` (which runs session-less) leave a
  // never-written .charm/logs/ behind.

  const templatesDir = locateTemplateDir("prompts");
  if (templatesDir) {
    for (const f of readdirSync(templatesDir)) {
      const dest = join(paths.promptsDir, f);
      if (existsSync(dest) && !refresh) continue;
      cpSync(join(templatesDir, f), dest);
    }
  } else {
    console.warn("[charm] prompt templates not found; skipping prompt scaffold");
  }

  // Seed the durable KB skeleton ONLY if it doesn't exist yet. The KB is real,
  // accumulating data -- never clobber it on re-init/start, even when refresh is
  // on (refresh is for template tooling, not user/agent knowledge).
  if (!existsSync(paths.kbDir)) {
    const kbTemplates = locateTemplateDir("kb");
    if (kbTemplates) {
      cpSync(kbTemplates, paths.kbDir, { recursive: true });
    } else {
      mkdirSync(paths.kbDir, { recursive: true });
      console.warn("[charm] kb templates not found; created empty .charm/kb/");
    }
  }

  // Seed the shared workspace CHARM.md (guardrails + operator-skills routing).
  // It lands at .charm/CHARM.md, and buildClaudeCommand (daemon/spawn.ts)
  // appends this local copy to orchestrator-role spawns and worktree spawns.
  // Like prompts it's tooling, not user data: copy if missing, and
  // refresh (overwrite) it on `charm init` so the workspace tracks the template.
  const charmTemplates = locateTemplateDir("charm");
  if (charmTemplates) {
    const src = join(charmTemplates, "CHARM.md");
    if (existsSync(src) && (!existsSync(paths.charmMd) || refresh)) {
      cpSync(src, paths.charmMd);
    }
  } else {
    console.warn("[charm] charm templates not found; skipping CHARM.md scaffold");
  }

  // Wire the workspace CHARM.md into the project's root CLAUDE.md so any Claude
  // session opened in the repo loads the shared context natively (via an `@`
  // import), not just charm-spawned agents.
  ensureRootClaudeImport(paths);

  const mcpBin = process.env.CHARM_MCP_BIN ?? "charm-mcp";
  const mcpConfig = {
    mcpServers: {
      charm: { command: mcpBin, args: [], env: {} },
    },
  };
  if (!existsSync(paths.mcpConfig) || refresh) {
    writeFileSync(paths.mcpConfig, JSON.stringify(mcpConfig, null, 2) + "\n");
  }

  if (!existsSync(paths.coordinationMd)) {
    writeFileSync(
      paths.coordinationMd,
      "# COORDINATION.md\n\n_Daemon will populate this as agents check in._\n",
    );
  }

  ensureCharmGitignore(paths, { refresh });
  untrackTickets(paths);
  scaffoldClaudeSettings(paths);
}

/**
 * Stop tracking .charm/tickets/ in git if a previous charm version committed it.
 * The .charm/.gitignore keeps tickets untracked GOING FORWARD, but git keeps a
 * file it already tracks even after it becomes gitignored — so an instance set up
 * before tickets were made run state still has them in the index, and re-running
 * init/start would otherwise leave them there. `git rm -r --cached` drops them
 * from the index (and thus from future commits) while leaving the working files
 * in place; the next session-close commit (or an operator commit) finalizes the
 * removal. Tickets are run state that churns on every spawn/status change and must
 * never live in git.
 *
 * Path-scoped (only .charm/tickets/) and non-fatal — a non-repo or any git failure
 * is logged and swallowed so it can never block init/start, mirroring the
 * session-close commit's discipline.
 */
function untrackTickets(paths: ReturnType<typeof charmPaths>) {
  const git = (args: string[]) => spawnSync("git", args, { cwd: paths.root, encoding: "utf8" });
  const inRepo = git(["rev-parse", "--is-inside-work-tree"]);
  if (inRepo.status !== 0 || inRepo.stdout.trim() !== "true") return;
  // Only act if something under .charm/tickets/ is actually tracked — otherwise
  // `git rm` would error ("did not match any files") and there's nothing to do.
  const tracked = git(["ls-files", "--", paths.ticketsDir]);
  if (tracked.status !== 0 || tracked.stdout.trim() === "") return;
  const rm = git(["rm", "-r", "--cached", "--quiet", "--", paths.ticketsDir]);
  if (rm.status !== 0) {
    console.error(`[charm] could not untrack ${paths.ticketsDir}: ${rm.stderr?.trim() ?? ""}`);
    return;
  }
  console.error(`[charm] untracked .charm/tickets/ (run state, now gitignored) — commit to finalize`);
}

/**
 * Write the self-contained .charm/.gitignore — the single source of truth for
 * what under .charm/ is committed. It ignores every child of .charm/ EXCEPT the
 * durable surfaces (kb, proposals, project-briefs, scratchpad) and the file itself; the
 * ephemeral run state (run/, db.sqlite, charm.json, CHARM.md, prompts/,
 * tickets/, …) is left untracked. Tickets are intentionally NOT a
 * durable surface — the daemon's session-close commit treats them as run state.
 *
 * The anchored `/*` matches only direct children of .charm/, so a `!/kb` style
 * negation re-includes the whole subtree beneath it (the children of an
 * un-ignored directory are never matched by `/*`). Living inside .charm/, the
 * rules travel with the directory and keep the project's root .gitignore clean;
 * nested-gitignore precedence makes them authoritative for any path under
 * .charm/.
 *
 * Seeded if absent on `charm start` (refresh=false) and overwritten on
 * `charm init` (refresh=true), matching how the other template tooling is kept
 * in sync.
 */
function ensureCharmGitignore(
  paths: ReturnType<typeof charmPaths>,
  { refresh }: { refresh: boolean },
) {
  if (existsSync(paths.charmGitignore) && !refresh) return;
  const body =
    "# charm: ignore everything under .charm/ EXCEPT the durable surfaces.\n" +
    "# Self-contained and committed, so the rules travel with .charm/ and never\n" +
    "# touch the project's root .gitignore. `/*` matches only direct children;\n" +
    "# each `!/<dir>` re-includes that whole subtree.\n" +
    "/*\n" +
    "!/.gitignore\n" +
    "!/kb\n" +
    "!/proposals\n" +
    "!/project-briefs\n" +
    "!/scratchpad\n";
  writeFileSync(paths.charmGitignore, body);
}

/**
 * Ensure the project's root CLAUDE.md imports the workspace CHARM.md so the
 * shared charm context loads into any Claude session opened in the repo.
 *
 * Two steps, both non-destructive:
 *   1. If <root>/CLAUDE.md doesn't exist, create it empty (it will then carry
 *      only the charm import).
 *   2. If it doesn't already import `.charm/CHARM.md`, append the import line at
 *      the bottom. An existing import (anywhere in the file) is left untouched, so
 *      re-running init/start never duplicates it.
 *
 * `@.charm/CHARM.md` is Claude Code's native file-import syntax; it resolves
 * relative to the root CLAUDE.md, i.e. to <root>/.charm/CHARM.md.
 */
function ensureRootClaudeImport(paths: ReturnType<typeof charmPaths>) {
  const importLine = "@.charm/CHARM.md";
  const existed = existsSync(paths.rootClaudeMd);
  const existing = existed ? readFileSync(paths.rootClaudeMd, "utf8") : "";
  if (existing.includes(importLine)) return;

  let out = existing;
  if (out.length > 0 && !out.endsWith("\n")) out += "\n"; // finish a dangling last line
  if (out.length > 0) out += "\n"; // blank separator before our block
  out +=
    "<!-- charm: load the shared multi-agent workspace context (auto-added by `charm init`) -->\n" +
    importLine +
    "\n";
  writeFileSync(paths.rootClaudeMd, out);
  console.log(
    existed
      ? `  claude:   appended ${importLine} import to ${paths.rootClaudeMd}`
      : `  claude:   created ${paths.rootClaudeMd} importing ${importLine}`,
  );
}

/**
 * Ensure <root>/.claude/settings.json grants the permissions charm's spawned
 * agents need: the charm MCP tool allow-list.
 *
 * Merge semantics, never clobber: an existing settings.json is preserved key for
 * key — we only union the template's allow entries into permissions.allow, and
 * we leave everything else (including the user's formatting) untouched. The write
 * is skipped entirely when the allow-list already contains every charm entry, so
 * repeated `charm start`s don't reformat or churn a user-maintained file.
 *
 * Note: the shared workspace CLAUDE.md is NOT wired in here. It is injected into
 * each agent's system prompt at spawn (see buildClaudeCommand in daemon/spawn.ts)
 * rather than via a SessionStart hook, so it reaches only charm-spawned sessions
 * and not every plain `claude` a user runs in the project.
 */
function scaffoldClaudeSettings(paths: ReturnType<typeof charmPaths>) {
  const tmplDir = locateTemplateDir("claude");
  if (!tmplDir) {
    console.warn("[charm] claude settings template not found; skipping .claude/settings.json");
    return;
  }
  const template = JSON.parse(readFileSync(join(tmplDir, "settings.json"), "utf8"));
  const wanted = template.permissions.allow as string[];
  // Spawned agents run unattended in tmux panes: a project `.mcp.json` would
  // otherwise stall them on a "do you trust this MCP server?" prompt. This key
  // auto-approves all project-scoped MCP servers so every spawned agent picks
  // them up silently. (Servers we pass via --mcp-config are already trusted; this
  // covers the ones Claude Code loads from .mcp.json on its own.)
  const wantMcpAutoApprove = template.enableAllProjectMcpServers === true;

  const fileExists = existsSync(paths.claudeSettings);
  let existing: any = {};
  if (fileExists) {
    try {
      existing = JSON.parse(readFileSync(paths.claudeSettings, "utf8"));
    } catch {
      console.warn(`[charm] ${paths.claudeSettings} is not valid JSON; leaving it untouched`);
      return;
    }
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) existing = {};
  }

  const before = JSON.stringify(existing);

  const isPlainObject = (v: any) => typeof v === "object" && v !== null && !Array.isArray(v);
  const perms = isPlainObject(existing.permissions)
    ? existing.permissions
    : (existing.permissions = {});
  const allow: string[] = Array.isArray(perms.allow) ? perms.allow : (perms.allow = []);
  for (const entry of wanted) if (!allow.includes(entry)) allow.push(entry);

  // Set the MCP auto-approve key only when the file doesn't already carry a value
  // for it — an explicit user choice (even `false`) is left untouched, matching
  // the never-clobber ethos above.
  if (wantMcpAutoApprove && !("enableAllProjectMcpServers" in existing)) {
    existing.enableAllProjectMcpServers = true;
  }

  // Nothing to add (and the file already exists) — don't rewrite/reformat it.
  if (fileExists && JSON.stringify(existing) === before) return;

  mkdirSync(paths.claudeDir, { recursive: true });
  writeFileSync(paths.claudeSettings, JSON.stringify(existing, null, 2) + "\n");
}

function locateTemplateDir(name: string): string | null {
  // When running from source: <repo>/templates/<name>/
  // When running from compiled binary: alongside the binary, or fallback to ../templates/<name>
  const here = typeof import.meta.url === "string" ? dirname(fileURLToPath(import.meta.url)) : process.cwd();
  const candidates = [
    join(here, "..", "templates", name),
    join(here, "..", "..", "templates", name),
    // Installed standalone binary: `frieren.sh install` copies templates into a
    // share/charm dir that sits a level above the binary's bin dir, e.g.
    // ~/.local/bin/charm -> ~/.local/share/charm/templates.
    join(dirname(process.execPath), "..", "share", "charm", "templates", name),
    join(process.cwd(), "templates", name),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** True when running as a `bun build --compile` standalone binary rather than
 *  from TS source via `bun run`. A compiled binary loads its entry module from
 *  Bun's embedded virtual filesystem, whose paths live under a "$bunfs" root
 *  (e.g. file:///$bunfs/root/charm). From TS source import.meta.url is a real
 *  file:// path on disk.
 *
 *  We key off that "$bunfs" marker rather than probing the path with existsSync:
 *  Bun reports the embedded path as existing (existsSync returns true in BOTH
 *  source and compiled runs), so an existence check can't tell them apart and
 *  would always report "source" — sending the compiled binary down the
 *  `bun run src/...` path against a virtual-fs path bun can't load. */
function isCompiled(): boolean {
  const url = typeof import.meta.url === "string" ? import.meta.url : "";
  // macOS/Linux use "/$bunfs/"; Windows standalone binaries use "B:/~BUN/".
  return url.includes("/$bunfs/") || url.includes("/~BUN/");
}

/** argv used to launch one of charm's sibling processes (daemon or console).
 *  From TS source we run the entrypoint via `bun run`; from a compiled binary
 *  we exec the sibling binary that `frieren.sh install` placed next to us on
 *  PATH — the repo's src/ files don't exist on disk inside the binary. */
function resolveChild(kind: "daemon" | "console"): string[] {
  if (!isCompiled()) {
    const sourceRel = kind === "daemon" ? "src/daemon/index.ts" : "src/console/app.tsx";
    const here = dirname(fileURLToPath(import.meta.url));
    return ["bun", "run", resolve(here, "..", sourceRel)];
  }
  const binName = kind === "daemon" ? "charmd" : "charm-console";
  const sibling = join(dirname(process.execPath), binName);
  return [existsSync(sibling) ? sibling : binName];
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for daemon socket ${path}`);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
