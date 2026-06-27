#!/usr/bin/env bun
import { Command } from "commander";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, cpSync, rmSync, openSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { charmPaths, sessionNameForId, type CharmPaths } from "./paths.ts";
import { SessionMeta } from "./schema.ts";
import { rpcCall } from "./daemon/rpc.ts";
import { Tmux } from "./daemon/tmux.ts";
import { killGraphViewers } from "./graph-viewers.ts";
import { fileURLToPath } from "node:url";

const program = new Command();
program
  .name("charm-claude")
  .description("Terminal-based multi-agent charm for Claude Code")
  .version("0.0.1");

program
  .command("init")
  .description("scaffold or refresh .charm/ in the current dir: re-copies template tooling (prompts, skills, CHARM.md, charm.json), ensures the root CLAUDE.md imports it -- additive or update only, never deletes; kb/, COORDINATION.md, and settings.json are preserved")
  .option("-r, --root <path>", "project root", process.cwd())
  .action((opts) => {
    const paths = charmPaths(resolve(opts.root));
    // init always refreshes template-managed tooling (overwrite existing + add
    // new). User/runtime data (kb, coordination, settings) is still preserved.
    scaffoldCharmDir(paths, { refresh: true });
    console.log(`charm initialized at ${paths.charmDir}`);
    console.log(`  prompts:  ${paths.promptsDir}/`);
    console.log(`  tickets:  ${paths.ticketsDir}/`);
    console.log(`  kb:       ${paths.kbDir}/  (durable, git-tracked)`);
    console.log(`  skills:   ${paths.skillsDir}/  (operator skills + index)`);
    console.log(`  charm:    ${paths.charmMd}  (workspace guardrails, loaded via the root CLAUDE.md import)`);
    console.log(`  config:   ${paths.mcpConfig}`);
  });

program
  .command("start [goal...]")
  .description("start the daemon, open the tmux layout, and spawn the main agent; with no goal, opens a plain Claude window")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session (default: derived from the project dir)")
  .option("--research", "research mode: default the fleet to Sonnet (overridable with -m/--model)", false)
  .option("--development", "development mode: default the fleet to Opus (overridable with -m/--model)", false)
  .option("--dev", "alias for --development", false)
  .option(
    "-m, --model <model>",
    "model for the WHOLE fleet (main agent + every sub-agent), honored in any mode and overriding the mode default: sonnet-4.6 | sonnet-4.6-1m | opus-4.6 | opus-4.7 | opus-4.7-1m | opus-4.8 | opus-4.8-1m (or a raw claude-* id)",
  )
  .option(
    "--max-agents <n>",
    "max concurrent agent sessions in this charm, INCLUDING the orchestrator (so n=10 allows the orchestrator + 9 sub-agents)",
    "10",
  )
  .option("--no-attach", "do not auto-attach to the tmux session")
  .option("-u, --uuid <id>", "internal: pin this session's UUID (default: a fresh random one)")
  .action(async (goalParts: string[], opts) => {
    const root = resolve(opts.root);
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

    const goal = (goalParts ?? []).join(" ").trim();
    const plain = goal.length === 0;

    // 0. Resolve the charm mode. Mode is the DEFAULT model selector and the
    // orchestrator's behavioral framing — research defaults the fleet to Sonnet,
    // development to Opus. From flags if given; otherwise an in-terminal prompt
    // (or research as the non-interactive fallback so piped/--no-attach usage
    // doesn't hang).
    const mode = await resolveMode(opts);

    // Resolve the fleet model. The mode sets the default; -m/--model overrides it
    // for the WHOLE fleet (main agent + every sub-agent) and is honored in ANY
    // mode — so you can run Opus in research mode or Sonnet in development mode.
    // Resolved up front so a bad alias fails before we spawn anything, and so the
    // daemon receives (via CHARM_MODEL) the exact id it will hand to sub-agents.
    const { resolveModel, MODE_MODEL, buildClaudeCommand, defaultPermissionMode, MAIN_AGENT_ID } = await import("./daemon/spawn.ts");
    let fleetModel: string;
    try {
      fleetModel = resolveModel(opts.model ?? MODE_MODEL[mode]);
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

    // 1. Spawn charmd in background. CHARM_MODE sets the fleet's default model and
    // behavioral framing; CHARM_MODEL (set only when -m/--model was given) pins the
    // model for every role the daemon spawns, independent of mode.
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
      env: { ...process.env, CHARM_MODE: mode, CHARM_MAX_AGENTS: String(maxAgents), ...(opts.model ? { CHARM_MODEL: fleetModel } : {}) },
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
    const modelNote = opts.model ? "-m override, all agents" : `${mode} default`;
    console.log(`[charm] mode: ${mode} | fleet model: ${fleetModel} (${modelNote}) | max agents: ${maxAgents}${plain ? " | plain window, no goal" : ""}`);
    // Mint and persist the orchestrator's Claude-side conversation id plus the
    // launch settings it was spawned with. charm launches the main agent under
    // `claude --session-id <uuid>` (so it owns the id rather than discovering it),
    // then records {claude_session_id, model, permission_mode, mode} to
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
      mode,
      max_agents: maxAgents,
    };
    writeFileSync(paths.orchestratorSessionFile, JSON.stringify(sessionRecord, null, 2) + "\n");
    const mainCmd = buildClaudeCommand(paths, MAIN_AGENT_ID, {
      role: "main",
      ticket_id: null,
      prompt: plain ? "" : `Goal: ${goal}. Begin Stage 1 (Investigation) per your system prompt.`,
      interactive: true,
      model: fleetModel,
      plain,
      claudeSessionId: orchestratorSessionId,
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

    // Focus the main agent pane so keystrokes go to Claude, not the console.
    tmux.selectPane(`${session}:charm.1`);

    if (opts.attach !== false) tmux.attach();
    else console.log(`tmux session '${session}' ready. attach with: tmux attach -t ${session}`);
  });

program
  .command("stop")
  .description("stop a charm: close its graph viewers, kill its daemon, and tear down its tmux session")
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

program
  .command("resume [session]")
  .description("relaunch the orchestrator pane on its saved conversation (claude --resume), or --continue for the most recent")
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
      mode?: string;
      max_agents?: number;
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
            ...(record.mode ? { CHARM_MODE: record.mode } : {}),
            ...(record.model ? { CHARM_MODEL: record.model } : {}),
            ...(record.permission_mode ? { CHARM_PERMISSION_MODE: record.permission_mode } : {}),
            ...(record.max_agents ? { CHARM_MAX_AGENTS: String(record.max_agents) } : {}),
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

    // Re-supply the original launch settings. The mode framing isn't reconstructed
    // (the orchestrator's own conversation history carries it); model + permission
    // mode are re-applied so the resumed session behaves like the original spawn.
    const { buildClaudeCommand, resolveModel, MODE_MODEL, MAIN_AGENT_ID } = await import("./daemon/spawn.ts");
    let model: string | undefined;
    try {
      model = record.model
        ? resolveModel(record.model)
        : record.mode && (record.mode === "research" || record.mode === "development")
        ? resolveModel(MODE_MODEL[record.mode])
        : undefined;
    } catch { model = undefined; }
    if (record.permission_mode) process.env.CHARM_PERMISSION_MODE = record.permission_mode;

    const resumeCmd = buildClaudeCommand(paths, MAIN_AGENT_ID, {
      role: "main",
      ticket_id: null,
      prompt: "",
      interactive: true,
      model,
      resume: useContinue ? "continue" : { uuid: record.claude_session_id! },
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
  .description("inspect the worktree copies a charm session is managing (.charm/worktrees/<name>/)");

worktreeCmd
  .command("list")
  .description("list the orchestrator-managed worktree copies (asks a live daemon for the annotated view; falls back to scanning .charm/worktrees/ when no daemon is up)")
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
    // No daemon: scan .charm/worktrees/ directly, same no-daemon-required ethos as
    // `tree`. Charm copies are standalone clones (not linked git worktrees), so we
    // enumerate the subdirs and read each one's branch from its own .git. This
    // mirrors WorktreeManager.list() without needing the daemon.
    const worktreesDir = join(root, ".charm", "worktrees");
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

program
  .command("restart")
  .description("reset the ticket backlog: kill ticketed agents, wipe ticket files + the db index, reset COORDINATION.md (daemon, KB, and session stay up)")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session name (when multiple run in this dir)")
  .option("-u, --uuid <id>", "session UUID (when multiple run in this dir)")
  .action(async (opts) => {
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
  .option("-r, --root <path>", "project root", process.cwd())
  .action((opts) => {
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
  .description("internal: handle a vim-style command (`:q`, `:a`, `:dev`/`:research`) from the tmux key binding")
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
    // Swap the fleet mode mid-session: research <-> development. Accepts the
    // mode's short aliases so `:d`/`:dev`/`:development` and `:r`/`:res`/
    // `:research` all work, mirroring the [r]/[d] startup picker. The daemon
    // re-points future spawns at the new model AND live-swaps the orchestrator
    // onto it via `/model` (its context is preserved). No socket -> no daemon to
    // tell, so just surface that in the status line.
    const DEV_ALIASES = new Set(["d", "dev", "development"]);
    const RES_ALIASES = new Set(["r", "res", "research"]);
    if (DEV_ALIASES.has(c) || RES_ALIASES.has(c)) {
      const mode = DEV_ALIASES.has(c) ? "development" : "research";
      if (socket) {
        try { await rpcCall(socket, "set_mode", { mode }); return; }
        catch { /* daemon gone — fall through to the status-line notice */ }
      }
      spawn("tmux", ["display-message", `charm: cannot switch to ${mode} mode (no daemon)`], { stdio: "ignore" });
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
    // Unknown: surface in tmux status line briefly.
    spawn("tmux", ["display-message", `unknown charm command: ${cmd}`], { stdio: "ignore" });
  });

program
  .command("session-name")
  .description("internal: print a session's tmux name for this root (used by charm.sh)")
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

type StartOpts = { research?: boolean; development?: boolean; dev?: boolean };

/** Decide the charm mode for a `start` run. Explicit flags win; conflicting flags
 *  error out. With no flag we show the in-terminal selector on a TTY, and fall
 *  back to research (the historical default) for non-interactive invocations. */
async function resolveMode(opts: StartOpts): Promise<"research" | "development"> {
  const wantsResearch = !!opts.research;
  const wantsDev = !!opts.development || !!opts.dev;
  if (wantsResearch && wantsDev) {
    console.error("[charm] pick one mode: --research or --development (not both).");
    process.exit(2);
  }
  if (wantsResearch) return "research";
  if (wantsDev) return "development";

  if (process.stdin.isTTY) {
    const { promptMode } = await import("./cli/mode-prompt.tsx");
    return promptMode();
  }
  console.error("[charm] no mode flag and no TTY for the prompt; defaulting to --research (Sonnet).");
  return "research";
}

/**
 * Scaffold (or refresh) the shared .charm/ workspace.
 *
 * `refresh` controls how template-managed *tooling* (prompts, operator skills,
 * the workspace CLAUDE.md, and charm.json) is treated when it already exists:
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

  // Seed the operator skills (restart, reset-kb) + their router index so the
  // main agent can discover and follow them on demand. Like prompts, these are
  // tooling (not user data): copy missing files, overwrite existing on refresh.
  const skillTemplates = locateTemplateDir("skills");
  if (skillTemplates) {
    cpSync(skillTemplates, paths.skillsDir, { recursive: true, force: refresh, errorOnExist: false });
  } else {
    console.warn("[charm] skill templates not found; skipping skills scaffold");
  }

  // Seed the shared workspace CHARM.md (guardrails + operator-skills router).
  // It lands at .charm/CHARM.md, and buildClaudeCommand (daemon/spawn.ts)
  // appends this local copy to every charm-spawned agent's system prompt.
  // Like prompts/skills it's tooling, not user data: copy if missing, and
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
  scaffoldClaudeSettings(paths);
}

/**
 * Write the self-contained .charm/.gitignore — the single source of truth for
 * what under .charm/ is committed. It ignores every child of .charm/ EXCEPT the
 * durable surfaces (kb, proposals, scratchpad, skills) and the file itself; the
 * ephemeral run state (run/, worktrees/, db.sqlite, charm.json, CHARM.md,
 * prompts/, tickets/, …) is left untracked. Tickets are intentionally NOT a
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
    "!/scratchpad\n" +
    "!/skills\n";
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
