#!/usr/bin/env bun
import { Command } from "commander";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { harnessPaths } from "./paths.ts";
import { rpcCall } from "./daemon/rpc.ts";
import { Tmux } from "./daemon/tmux.ts";
import { fileURLToPath } from "node:url";

const program = new Command();
program
  .name("harness")
  .description("Terminal-based multi-agent harness for Claude Code")
  .version("0.0.1");

program
  .command("init")
  .description("scaffold .charm/ (tickets, harness.json, prompt templates) in the current dir")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-f, --force", "overwrite existing prompt files", false)
  .action((opts) => {
    const paths = harnessPaths(resolve(opts.root));
    scaffoldHarnessDir(paths, { force: opts.force });
    console.log(`harness initialized at ${paths.harnessDir}`);
    console.log(`  prompts:  ${paths.promptsDir}/`);
    console.log(`  tickets:  ${paths.ticketsDir}/`);
    console.log(`  config:   ${paths.mcpConfig}`);
  });

program
  .command("start <goal...>")
  .description("start the daemon, open the tmux layout, and spawn the main agent with this goal")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session", "harness")
  .option(
    "-m, --model <model>",
    "model for the main agent: sonnet-4.6 | sonnet-4.6-1m | opus-4.6 | opus-4.7 | opus-4.7-1m (or a raw claude-* id)",
    "opus-4.7",
  )
  .option("--no-attach", "do not auto-attach to the tmux session")
  .action(async (goalParts: string[], opts) => {
    const paths = harnessPaths(resolve(opts.root));
    // Reuse an existing .charm/ if present, otherwise scaffold a fresh one.
    scaffoldHarnessDir(paths, { force: false });
    if (!Tmux.available()) {
      console.error("tmux is required.");
      process.exit(2);
    }

    const goal = goalParts.join(" ");

    // 1. Spawn harnessd in background
    const logFile = join(paths.logsDir, "harnessd.log");
    const daemonEntry = resolveBinary("dev:daemon", "src/daemon/index.ts");
    const child = spawn("bun", ["run", daemonEntry, "--root", paths.root, "--session", opts.session], {
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
      env: { ...process.env },
    });
    child.unref();
    console.log(`[harness] daemon pid=${child.pid}, log=${logFile}`);

    // 2. Wait for socket
    await waitForSocket(paths.socket, 10_000);
    await rpcCall(paths.socket, "ping");

    // 3. Open tmux layout: window with main pane + console pane
    const tmux = new Tmux(opts.session);
    if (tmux.hasSession()) {
      console.error(`[harness] tmux session '${opts.session}' already exists. Use --session or kill it.`);
      process.exit(2);
    }
    tmux.newSession("harness", paths.root);

    // Layout: console on the left (pane 0), main agent on the right (pane 1).
    const { buildClaudeCommand, resolveModel } = await import("./daemon/spawn.ts");
    let mainModel: string;
    try {
      mainModel = resolveModel(opts.model);
    } catch (e: any) {
      console.error(e.message);
      process.exit(2);
    }
    console.log(`[harness] main agent model: ${mainModel}`);
    const mainCmd = buildClaudeCommand(paths, "main-001", {
      role: "main",
      ticket_id: null,
      prompt: `Goal: ${goal}. Begin Stage 0 (Discovery) per your system prompt.`,
      interactive: true,
      model: mainModel,
    });
    const consoleEntry = resolveBinary("dev:console", "src/console/app.tsx");
    const consoleCmd = `bun run ${shellQuote(consoleEntry)} --root ${shellQuote(paths.root)}`;

    const consolePane = tmux.spawnInWindow("harness", consoleCmd, paths.root);
    const mainPane = tmux.splitPane({ cmd: mainCmd, cwd: paths.root, direction: "h", size: "65%" });

    // Tell the daemon which pane is the console (pinned left column) and
    // which panes already belong to the agent grid. From here on, every
    // sub-agent spawn triggers a relayout into a VS-Code-style grid.
    await rpcCall(paths.socket, "register_panes", {
      console_pane_id: consolePane,
      agent_pane_ids: [mainPane],
    });

    // Bind `:` (no prefix) to a tmux command-prompt that runs `harness ctl`.
    // Works from any pane — console or agent — so the user can quit/detach
    // the whole harness from wherever the cursor happens to be.
    const cliEntry = fileURLToPath(import.meta.url);
    const ctlTemplate =
      `${shellQuote(process.execPath)} ${shellQuote(cliEntry)} ctl ` +
      `--root ${shellQuote(paths.root)} --session ${shellQuote(opts.session)} %1`;
    tmux.bindCommandPrompt(ctlTemplate);

    // Focus the main agent pane so keystrokes go to Claude, not the console.
    tmux.selectPane(`${opts.session}:harness.1`);

    if (opts.attach !== false) tmux.attach();
    else console.log(`tmux session '${opts.session}' ready. attach with: tmux attach -t ${opts.session}`);
  });

program
  .command("attach")
  .description("attach to the tmux session for the harness")
  .option("-s, --session <name>", "tmux session", "harness")
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
    const paths = harnessPaths(resolve(opts.root));
    try {
      const s = await rpcCall<any>(paths.socket, "status");
      console.log(JSON.stringify(s, null, 2));
    } catch (e: any) {
      console.error(`daemon unreachable: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("approve <gate_id>")
  .description("resolve a pending approval gate")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("--reject", "reject instead of approve", false)
  .action(async (gateId: string, opts) => {
    const paths = harnessPaths(resolve(opts.root));
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
  .option("-s, --session <name>", "tmux session", "harness")
  .action(async (cmd: string, opts) => {
    const paths = harnessPaths(resolve(opts.root));
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
    spawn("tmux", ["display-message", `unknown harness command: ${cmd}`], { stdio: "ignore" });
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

function scaffoldHarnessDir(
  paths: ReturnType<typeof harnessPaths>,
  { force }: { force: boolean },
) {
  mkdirSync(paths.harnessDir, { recursive: true });
  mkdirSync(paths.ticketsDir, { recursive: true });
  mkdirSync(paths.promptsDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });

  const templatesDir = locateTemplates();
  if (templatesDir) {
    for (const f of readdirSync(templatesDir)) {
      const dest = join(paths.promptsDir, f);
      if (existsSync(dest) && !force) continue;
      cpSync(join(templatesDir, f), dest);
    }
  } else {
    console.warn("[harness] prompt templates not found; skipping prompt scaffold");
  }

  const mcpBin = process.env.HARNESS_MCP_BIN ?? "harness-mcp";
  const mcpConfig = {
    mcpServers: {
      harness: { command: mcpBin, args: [], env: {} },
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

function locateTemplates(): string | null {
  // When running from source: <repo>/templates/prompts/
  // When running from compiled binary: alongside the binary, or fallback to ../templates/prompts
  const here = typeof import.meta.url === "string" ? dirname(fileURLToPath(import.meta.url)) : process.cwd();
  const candidates = [
    join(here, "..", "templates", "prompts"),
    join(here, "..", "..", "templates", "prompts"),
    join(process.cwd(), "templates", "prompts"),
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
