#!/usr/bin/env bun
import { Command } from "commander";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync, readFileSync, cpSync, rmSync, openSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { charmPaths, defaultSessionName, type CharmPaths } from "./paths.ts";
import { rpcCall } from "./daemon/rpc.ts";
import { createMultiplexer, multiplexerAvailable, type LaunchSpec } from "./daemon/multiplexer.ts";
import { killGraphViewers } from "./graph-viewers.ts";
import { fileURLToPath } from "node:url";

const program = new Command();
program
  .name("charm-claude")
  .description("Terminal-based multi-agent charm for Claude Code")
  .version("0.0.1");

program
  .command("init")
  .description("scaffold .charm/ (tickets, charm.json, prompt templates) in the current dir")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-f, --force", "overwrite existing prompt files", false)
  .action((opts) => {
    const paths = charmPaths(resolve(opts.root));
    scaffoldCharmDir(paths, { force: opts.force });
    console.log(`charm initialized at ${paths.charmDir}`);
    console.log(`  prompts:  ${paths.promptsDir}/`);
    console.log(`  tickets:  ${paths.ticketsDir}/`);
    console.log(`  kb:       ${paths.kbDir}/  (durable, git-tracked)`);
    console.log(`  skills:   ${paths.skillsDir}/  (operator skills + index)`);
    console.log(`  config:   ${paths.mcpConfig}`);
  });

program
  .command("start [goal...]")
  .description("start the daemon, open the tmux layout, and spawn the main agent; with no goal, opens a plain Claude window")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session (default: derived from the project dir)")
  .option("--research", "research mode: run every agent on Sonnet", false)
  .option("--development", "development mode: run every agent on Opus", false)
  .option("--dev", "alias for --development", false)
  .option(
    "-m, --model <model>",
    "override the MAIN agent's model only (sub-agents follow the mode): sonnet-4.6 | sonnet-4.6-1m | opus-4.6 | opus-4.7 | opus-4.7-1m | opus-4.8 | opus-4.8-1m (or a raw claude-* id)",
  )
  .option("--no-attach", "do not auto-attach to the tmux session")
  .action(async (goalParts: string[], opts) => {
    const paths = charmPaths(resolve(opts.root));
    // Detect a first run BEFORE scaffolding creates .charm/, so we know whether
    // to offer the one-time .gitignore setup below.
    const firstRun = !existsSync(paths.charmDir);
    // Reuse an existing .charm/ if present, otherwise scaffold a fresh one.
    scaffoldCharmDir(paths, { force: false });
    if (!multiplexerAvailable()) {
      console.error(
        process.platform === "win32"
          ? "a terminal multiplexer is required: install psmux (`cargo install psmux`) — see PORTING-WINDOWS.md."
          : "a terminal multiplexer is required: install tmux.",
      );
      process.exit(2);
    }

    // Resolve and persist the tmux session name for this directory. Persisting it
    // lets `stop`/`attach`/`ctl` (and charm.sh) recover the exact name without
    // re-deriving — and the per-directory default is what lets multiple charms
    // run side by side without colliding on tmux's global session namespace.
    const session = resolveSession(paths, opts.session);
    writeFileSync(paths.sessionFile, session + "\n");

    const goal = (goalParts ?? []).join(" ").trim();
    const plain = goal.length === 0;

    // On the very first run in this dir, offer to wire up .gitignore.
    if (firstRun) await maybeConfigureGitignore(paths);

    // 0. Resolve the charm mode (research -> Sonnet fleet, development -> Opus fleet).
    // From flags if given; otherwise an in-terminal prompt (or research as the
    // non-interactive fallback so piped/--no-attach usage doesn't hang).
    const mode = await resolveMode(opts);

    // 1. Spawn charmd in background. CHARM_MODE tells the daemon which model to
    // give every sub-agent it spawns (workers, reviewers, testers).
    const logFile = join(paths.logsDir, "charmd.log");
    // Point the daemon's stdout/stderr at its log file rather than inheriting
    // this CLI's TTY. The daemon outlives `start`, so an inherited TTY would
    // (a) keep the parent's stdio fds open after we exit and (b) let stray
    // daemon writes corrupt the tmux session once the terminal is handed off.
    const logFd = openSync(logFile, "a");
    const [daemonCmd, ...daemonPrefix] = resolveChild("daemon");
    const child = spawn(daemonCmd!, [...daemonPrefix, "--root", paths.root, "--session", session], {
      stdio: ["ignore", logFd, logFd],
      detached: true,
      env: { ...process.env, CHARM_MODE: mode },
    });
    child.unref();
    console.log(`[charm] daemon pid=${child.pid}, log=${logFile}`);

    // 2. Wait for the daemon to come up (its readiness marker), then ping.
    await waitForDaemon(paths.ready, 10_000);
    await rpcCall(paths.socket, "ping");

    // 3. Open the multiplexer layout: window with main pane + console pane
    const mux = createMultiplexer(session);
    if (mux.hasSession()) {
      console.error(`[charm] session '${session}' already exists. Use --session or kill it.`);
      process.exit(2);
    }
    mux.newSession("charm", paths.root);

    // Layout: console on the left (pane 0), main agent on the right (pane 1).
    const { buildClaudeLaunch, resolveModel, MODE_MODEL, MAIN_AGENT_ID } = await import("./daemon/spawn.ts");
    let mainModel: string;
    try {
      // The mode picks the fleet's model; -m/--model is an advanced override of
      // the main pane only (sub-agents still follow the mode via CHARM_MODE).
      mainModel = resolveModel(opts.model ?? MODE_MODEL[mode]);
    } catch (e: any) {
      console.error(e.message);
      process.exit(2);
    }
    console.log(`[charm] mode: ${mode} | main agent model: ${mainModel}${plain ? " (plain window, no goal)" : ""}`);
    const mainLaunch: LaunchSpec = {
      ...buildClaudeLaunch(paths, MAIN_AGENT_ID, {
        role: "main",
        ticket_id: null,
        prompt: plain ? "" : `Goal: ${goal}. Begin Stage 0 (Discovery) per your system prompt.`,
        interactive: true,
        model: mainModel,
        plain,
      }),
      cwd: paths.root,
    };
    // The console pane runs the charm-console entrypoint (bun-run from source, or
    // the sibling binary when compiled) with no extra env.
    const consoleLaunch: LaunchSpec = {
      argv: [...resolveChild("console"), "--root", paths.root],
      env: {},
      cwd: paths.root,
    };

    const consolePane = mux.spawnInWindow("charm", consoleLaunch);
    const mainPane = mux.splitPane({ launch: mainLaunch, direction: "h", size: "65%" });

    // Tell the daemon which pane is the console (pinned left column) and
    // which panes already belong to the agent grid. From here on, every
    // sub-agent spawn triggers a relayout into a VS-Code-style grid.
    await rpcCall(paths.socket, "register_panes", {
      console_pane_id: consolePane,
      agent_pane_ids: [mainPane],
    });

    // Bind `:` (no prefix) to a command-prompt that runs `charm ctl`, so the user
    // can quit/detach from any pane. Supported on tmux; a no-op on backends
    // without a command-prompt (psmux), where `charm stop` is the quit path.
    // Re-invoke THIS cli: from source that's `bun <cli.ts> ctl …`; a compiled
    // binary dispatches its own subcommands, so it's just `<binary> ctl …`.
    const selfArgv = isCompiled()
      ? [process.execPath]
      : [process.execPath, fileURLToPath(import.meta.url)];
    const ctlTemplate =
      `${selfArgv.map(shellQuote).join(" ")} ctl ` +
      `--root ${shellQuote(paths.root)} --session ${shellQuote(session)} %1`;
    mux.bindCommandPrompt(ctlTemplate);

    // Focus the main agent pane so keystrokes go to Claude, not the console.
    mux.selectPane(`${session}:charm.1`);

    if (opts.attach !== false) mux.attach();
    else console.log(`session '${session}' ready. attach with: charm attach`);
  });

program
  .command("stop")
  .description("stop the charm: close all graph viewers, kill the daemon, and tear down the tmux session")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session (default: derived from the project dir)")
  .action(async (opts) => {
    const paths = charmPaths(resolve(opts.root));
    const session = resolveSession(paths, opts.session);
    // 1. Close standalone graph viewers first, by tracked PID. Done here (not
    // left to the daemon) so viewers still get reaped when the daemon is already
    // gone — and, in future, when viewers run outside the tmux session entirely.
    const killed = killGraphViewers(paths.graphPids);
    if (killed.length) console.log(`[charm] closed ${killed.length} graph viewer(s): ${killed.join(", ")}`);
    // 2. Ask the daemon to shut itself down gracefully (the `shutdown` RPC kills
    // the tmux session, then runs cleanup: removes the socket/ready/pidfile and
    // reaps viewers). This is the primary path and is REQUIRED on Windows, where
    // a SIGTERM via process.kill terminates the daemon abruptly without running
    // its handler — leaving the endpoint/ready/pidfile behind to block the next
    // start. Fall back to process.kill only if the daemon is already unreachable.
    let stopped = false;
    try {
      await rpcCall(paths.socket, "shutdown");
      console.log("[charm] daemon shut down");
      stopped = true;
    } catch {
      if (existsSync(paths.pidFile)) {
        const pid = Number(readFileSync(paths.pidFile, "utf8").trim());
        if (pid) {
          try { process.kill(pid); console.log(`[charm] killed daemon pid=${pid}`); stopped = true; }
          catch { console.log(`[charm] daemon pid=${pid} not running`); }
        }
      }
    }
    if (!stopped) console.log("[charm] no running daemon found");
    // 3. Tear down the multiplexer session (closes console, agent, graph panes).
    // The shutdown RPC already does this when the daemon was reachable; this
    // covers the fallback path (and is a harmless no-op when already gone).
    const mux = createMultiplexer(session);
    if (mux.hasSession()) {
      mux.killSession();
      console.log(`[charm] killed session '${session}'`);
    }
  });

program
  .command("attach")
  .description("attach to the tmux session for the charm")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session (default: derived from the project dir)")
  .action((opts) => {
    const paths = charmPaths(resolve(opts.root));
    const session = resolveSession(paths, opts.session);
    const mux = createMultiplexer(session);
    if (!mux.hasSession()) {
      console.error(`no session '${session}'`);
      process.exit(2);
    }
    mux.attach();
  });

program
  .command("status")
  .description("print agents, tickets, pending approvals")
  .option("-r, --root <path>", "project root", process.cwd())
  .action(async (opts) => {
    const paths = charmPaths(resolve(opts.root));
    try {
      const s = await rpcCall<any>(paths.socket, "status");
      console.log(JSON.stringify(s, null, 2));
    } catch (e: any) {
      if (!existsSync(paths.ready)) {
        console.error("no charm daemon running. start one with: charm start");
      } else {
        console.error(`daemon unreachable: ${e.message}`);
      }
      process.exit(1);
    }
  });

program
  .command("approve <gate_id>")
  .description("resolve a pending approval gate")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("--reject", "reject instead of approve", false)
  .action(async (gateId: string, opts) => {
    const paths = charmPaths(resolve(opts.root));
    const res = await rpcCall<{ resolved: boolean }>(paths.socket, "approve_gate", {
      id: gateId,
      decision: opts.reject ? "reject" : "approve",
    });
    console.log(res);
  });

program
  .command("restart")
  .description("reset the ticket backlog: kill ticketed agents, wipe ticket files + the db index, reset COORDINATION.md (daemon, KB, and session stay up)")
  .option("-r, --root <path>", "project root", process.cwd())
  .action(async (opts) => {
    const paths = charmPaths(resolve(opts.root));
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
  .description("internal: handle a vim-style command (`:q`, `:a`) from the tmux key binding")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session (default: derived from the project dir)")
  .action(async (cmd: string, opts) => {
    const paths = charmPaths(resolve(opts.root));
    const session = resolveSession(paths, opts.session);
    const mux = createMultiplexer(session);
    const c = cmd.trim().toLowerCase();
    if (c === "q" || c === "quit") {
      try { await rpcCall(paths.socket, "shutdown"); }
      catch { mux.killSession(); /* daemon already gone — make sure the session dies too */ }
      return;
    }
    if (c === "a" || c === "detach") {
      // ctl is only reached via the tmux `:` command-prompt binding (tmux-only),
      // so detach-client targets tmux directly.
      spawn("tmux", ["detach-client", "-s", session], { stdio: "ignore" });
      return;
    }
    // Unknown: surface in tmux status line briefly.
    spawn("tmux", ["display-message", `unknown charm command: ${cmd}`], { stdio: "ignore" });
  });

program
  .command("session-name")
  .description("internal: print the resolved tmux session name for a root (used by charm.sh)")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session (default: derived from the project dir)")
  .action((opts) => {
    const paths = charmPaths(resolve(opts.root));
    process.stdout.write(resolveSession(paths, opts.session) + "\n");
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

/** Resolve the tmux session name for a project root. Precedence:
 *    1. an explicit --session flag
 *    2. the $CHARM_SESSION env override
 *    3. the name a prior `start` persisted to .charm/session
 *    4. a stable default derived from the root path (so two directories never
 *       collide on tmux's global session namespace)
 *  This is the single source of truth for the name — `start` writes it, every
 *  other command (and the bash wrapper, via the `session-name` subcommand) reads
 *  it back through here so they all agree on which session belongs to this dir. */
function resolveSession(paths: CharmPaths, explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.CHARM_SESSION;
  if (env) return env;
  if (existsSync(paths.sessionFile)) {
    const s = readFileSync(paths.sessionFile, "utf8").trim();
    if (s) return s;
  }
  return defaultSessionName(paths.root);
}

/** On the first `start` in a directory, offer to add charm's run-state ignore
 *  rules to the project's .gitignore. The rules ignore the ephemeral run state
 *  (socket, db, tickets, logs, the resolved session name, …) while keeping the
 *  durable, git-tracked knowledge base at .charm/kb/. Opt-in and skipped silently
 *  when stdin isn't a TTY, when a .charm rule already exists, or when declined. */
async function maybeConfigureGitignore(paths: CharmPaths): Promise<void> {
  if (!process.stdin.isTTY) return;
  const gitignorePath = join(paths.root, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  // Already configured (any .charm or !.charm line present)? Leave it alone.
  if (/^\s*!?\.charm(\/|\b)/m.test(existing)) return;

  const { confirm } = await import("./cli/confirm-prompt.tsx");
  const ok = await confirm(
    "Add charm's run state to .gitignore?",
    "Ignores ephemeral run state (.charm/sock, db.sqlite, tickets, logs, …) " +
      "while keeping the durable knowledge base (.charm/kb/) tracked.",
  );
  if (!ok) return;

  const block =
    "# Charm run state is ephemeral and ignored, EXCEPT the durable knowledge base.\n" +
    "# `.charm/*` ignores the run-state children; `!.charm/kb/` re-includes the KB.\n" +
    ".charm/*\n" +
    "!.charm/kb/\n";
  // Separate cleanly from any existing content: ensure a trailing newline, then a
  // blank line before our block when the file already had text.
  const prefix = existing.length === 0 ? "" : (existing.endsWith("\n") ? "\n" : "\n\n");
  appendFileSync(gitignorePath, prefix + block);
  console.log(`[charm] added charm ignore rules to ${gitignorePath}`);
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

function scaffoldCharmDir(
  paths: ReturnType<typeof charmPaths>,
  { force }: { force: boolean },
) {
  mkdirSync(paths.charmDir, { recursive: true });
  mkdirSync(paths.ticketsDir, { recursive: true });
  mkdirSync(paths.promptsDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });

  const templatesDir = locateTemplateDir("prompts");
  if (templatesDir) {
    for (const f of readdirSync(templatesDir)) {
      const dest = join(paths.promptsDir, f);
      if (existsSync(dest) && !force) continue;
      cpSync(join(templatesDir, f), dest);
    }
  } else {
    console.warn("[charm] prompt templates not found; skipping prompt scaffold");
  }

  // Seed the durable KB skeleton ONLY if it doesn't exist yet. The KB is real,
  // accumulating data -- never clobber it on re-init/start, even with --force
  // (force is for prompt templates, not user/agent knowledge).
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
  // tooling (not user data): copy missing files, overwrite only with --force.
  const skillTemplates = locateTemplateDir("skills");
  if (skillTemplates) {
    cpSync(skillTemplates, paths.skillsDir, { recursive: true, force, errorOnExist: false });
  } else {
    console.warn("[charm] skill templates not found; skipping skills scaffold");
  }

  // The MCP shim command `claude` will spawn. Default to the bare name (resolved
  // on PATH), with the platform executable suffix on Windows so an installed
  // `charm-mcp.exe` is found — claude's process spawn does no PATHEXT lookup.
  const mcpBin = process.env.CHARM_MCP_BIN ?? (process.platform === "win32" ? "charm-mcp.exe" : "charm-mcp");
  const mcpConfig = {
    mcpServers: {
      charm: { command: mcpBin, args: [], env: {} },
    },
  };
  if (!existsSync(paths.mcpConfig) || force) {
    writeFileSync(paths.mcpConfig, JSON.stringify(mcpConfig, null, 2) + "\n");
  }

  if (!existsSync(paths.coordinationMd)) {
    writeFileSync(
      paths.coordinationMd,
      "# COORDINATION.md\n\n_Daemon will populate this as agents check in._\n",
    );
  }

  scaffoldClaudeSettings(paths);
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
  // Compiled siblings carry the platform's executable suffix (charmd.exe on
  // Windows). Without it, both the existsSync probe and the bare-name PATH
  // fallback miss — Windows process spawn does no PATHEXT resolution for argv[0].
  const binName = exeName(kind === "daemon" ? "charmd" : "charm-console");
  const sibling = join(dirname(process.execPath), binName);
  return [existsSync(sibling) ? sibling : binName];
}

/** Append the platform executable suffix (`.exe` on Windows) to a bare binary
 *  name so sibling-binary resolution and PATH lookups match the real file. */
function exeName(base: string): string {
  return process.platform === "win32" ? `${base}.exe` : base;
}

async function waitForDaemon(readyPath: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(readyPath)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for daemon (readiness marker ${readyPath})`);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
