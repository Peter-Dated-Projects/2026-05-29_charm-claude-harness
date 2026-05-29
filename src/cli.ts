#!/usr/bin/env bun
import { Command } from "commander";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { charmPaths } from "./paths.ts";
import { rpcCall } from "./daemon/rpc.ts";
import { Tmux } from "./daemon/tmux.ts";
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
    console.log(`  config:   ${paths.mcpConfig}`);
  });

program
  .command("start [goal...]")
  .description("start the daemon, open the tmux layout, and spawn the main agent; with no goal, opens a plain Claude window")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session", "charm")
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
    // Reuse an existing .charm/ if present, otherwise scaffold a fresh one.
    scaffoldCharmDir(paths, { force: false });
    if (!Tmux.available()) {
      console.error("tmux is required.");
      process.exit(2);
    }

    const goal = (goalParts ?? []).join(" ").trim();
    const plain = goal.length === 0;

    // 0. Resolve the charm mode (research -> Sonnet fleet, development -> Opus fleet).
    // From flags if given; otherwise an in-terminal prompt (or research as the
    // non-interactive fallback so piped/--no-attach usage doesn't hang).
    const mode = await resolveMode(opts);

    // 1. Spawn charmd in background. CHARM_MODE tells the daemon which model to
    // give every sub-agent it spawns (workers, reviewers, testers).
    const logFile = join(paths.logsDir, "charmd.log");
    const daemonEntry = resolveBinary("dev:daemon", "src/daemon/index.ts");
    const child = spawn("bun", ["run", daemonEntry, "--root", paths.root, "--session", opts.session], {
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
      env: { ...process.env, CHARM_MODE: mode },
    });
    child.unref();
    console.log(`[charm] daemon pid=${child.pid}, log=${logFile}`);

    // 2. Wait for socket
    await waitForSocket(paths.socket, 10_000);
    await rpcCall(paths.socket, "ping");

    // 3. Open tmux layout: window with main pane + console pane
    const tmux = new Tmux(opts.session);
    if (tmux.hasSession()) {
      console.error(`[charm] tmux session '${opts.session}' already exists. Use --session or kill it.`);
      process.exit(2);
    }
    tmux.newSession("charm", paths.root);

    // Layout: console on the left (pane 0), main agent on the right (pane 1).
    const { buildClaudeCommand, resolveModel, MODE_MODEL } = await import("./daemon/spawn.ts");
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
    const mainCmd = buildClaudeCommand(paths, "main-001", {
      role: "main",
      ticket_id: null,
      prompt: plain ? "" : `Goal: ${goal}. Begin Stage 0 (Discovery) per your system prompt.`,
      interactive: true,
      model: mainModel,
      plain,
    });
    const consoleEntry = resolveBinary("dev:console", "src/console/app.tsx");
    const consoleCmd = `bun run ${shellQuote(consoleEntry)} --root ${shellQuote(paths.root)}`;

    const consolePane = tmux.spawnInWindow("charm", consoleCmd, paths.root);
    const mainPane = tmux.splitPane({ cmd: mainCmd, cwd: paths.root, direction: "h", size: "65%" });

    // Tell the daemon which pane is the console (pinned left column) and
    // which panes already belong to the agent grid. From here on, every
    // sub-agent spawn triggers a relayout into a VS-Code-style grid.
    await rpcCall(paths.socket, "register_panes", {
      console_pane_id: consolePane,
      agent_pane_ids: [mainPane],
    });

    // Bind `:` (no prefix) to a tmux command-prompt that runs `charm ctl`.
    // Works from any pane — console or agent — so the user can quit/detach
    // the whole charm from wherever the cursor happens to be.
    const cliEntry = fileURLToPath(import.meta.url);
    const ctlTemplate =
      `${shellQuote(process.execPath)} ${shellQuote(cliEntry)} ctl ` +
      `--root ${shellQuote(paths.root)} --session ${shellQuote(opts.session)} %1`;
    tmux.bindCommandPrompt(ctlTemplate);

    // Focus the main agent pane so keystrokes go to Claude, not the console.
    tmux.selectPane(`${opts.session}:charm.1`);

    if (opts.attach !== false) tmux.attach();
    else console.log(`tmux session '${opts.session}' ready. attach with: tmux attach -t ${opts.session}`);
  });

program
  .command("attach")
  .description("attach to the tmux session for the charm")
  .option("-s, --session <name>", "tmux session", "charm")
  .action((opts) => {
    const tmux = new Tmux(opts.session);
    if (!tmux.hasSession()) {
      console.error(`no tmux session '${opts.session}'`);
      process.exit(2);
    }
    tmux.attach();
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
      if (!existsSync(paths.socket)) {
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
  .command("ctl <cmd>")
  .description("internal: handle a vim-style command (`:q`, `:a`) from the tmux key binding")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session", "charm")
  .action(async (cmd: string, opts) => {
    const paths = charmPaths(resolve(opts.root));
    const tmux = new Tmux(opts.session);
    const c = cmd.trim().toLowerCase();
    if (c === "q" || c === "quit") {
      try { await rpcCall(paths.socket, "shutdown"); }
      catch { tmux.killSession(); /* daemon already gone — make sure tmux dies too */ }
      return;
    }
    if (c === "a" || c === "detach") {
      spawn("tmux", ["detach-client", "-s", opts.session], { stdio: "ignore" });
      return;
    }
    // Unknown: surface in tmux status line briefly.
    spawn("tmux", ["display-message", `unknown charm command: ${cmd}`], { stdio: "ignore" });
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

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

  const mcpBin = process.env.CHARM_MCP_BIN ?? "charm-mcp";
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
}

function locateTemplateDir(name: string): string | null {
  // When running from source: <repo>/templates/<name>/
  // When running from compiled binary: alongside the binary, or fallback to ../templates/<name>
  const here = typeof import.meta.url === "string" ? dirname(fileURLToPath(import.meta.url)) : process.cwd();
  const candidates = [
    join(here, "..", "templates", name),
    join(here, "..", "..", "templates", name),
    join(process.cwd(), "templates", name),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function resolveBinary(_devScript: string, fallback: string): string {
  // For now, always run the TS source. Compiled-binary support comes from `bun build --compile`.
  const here = typeof import.meta.url === "string" ? dirname(fileURLToPath(import.meta.url)) : process.cwd();
  return resolve(here, "..", fallback);
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
