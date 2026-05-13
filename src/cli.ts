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
  .description("scaffold .harness/, tickets/, harness.json, and prompt templates in the current dir")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-f, --force", "overwrite existing prompt files", false)
  .action((opts) => {
    const paths = harnessPaths(resolve(opts.root));
    mkdirSync(paths.harnessDir, { recursive: true });
    mkdirSync(paths.ticketsDir, { recursive: true });
    mkdirSync(paths.promptsDir, { recursive: true });
    mkdirSync(paths.logsDir, { recursive: true });

    // Drop prompt templates
    const templatesDir = locateTemplates();
    if (templatesDir) {
      for (const f of readdirSync(templatesDir)) {
        const dest = join(paths.promptsDir, f);
        if (existsSync(dest) && !opts.force) continue;
        cpSync(join(templatesDir, f), dest);
      }
    } else {
      console.warn("[harness init] prompt templates not found; skipping prompt scaffold");
    }

    // MCP config consumed by every `claude` process
    const mcpBin = process.env.HARNESS_MCP_BIN ?? "harness-mcp";
    const mcpConfig = {
      mcpServers: {
        harness: {
          command: mcpBin,
          args: [],
          env: {},
        },
      },
    };
    if (!existsSync(paths.mcpConfig) || opts.force) {
      writeFileSync(paths.mcpConfig, JSON.stringify(mcpConfig, null, 2) + "\n");
    }

    // Empty COORDINATION.md
    if (!existsSync(paths.coordinationMd)) {
      writeFileSync(paths.coordinationMd, "# COORDINATION.md\n\n_Daemon will populate this as agents check in._\n");
    }

    console.log(`harness initialized at ${paths.root}`);
    console.log(`  prompts:  ${paths.promptsDir}/`);
    console.log(`  tickets:  ${paths.ticketsDir}/`);
    console.log(`  config:   ${paths.mcpConfig}`);
  });

program
  .command("start <goal...>")
  .description("start the daemon, open the tmux layout, and spawn the main agent with this goal")
  .option("-r, --root <path>", "project root", process.cwd())
  .option("-s, --session <name>", "tmux session", "harness")
  .option("--no-attach", "do not auto-attach to the tmux session")
  .action(async (goalParts: string[], opts) => {
    const paths = harnessPaths(resolve(opts.root));
    if (!existsSync(paths.harnessDir)) {
      console.error("Run `harness init` first.");
      process.exit(2);
    }
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

    // The initial window has one pane. Put the main agent in it.
    const { buildClaudeCommand } = await import("./daemon/spawn.ts");
    const mainCmd = buildClaudeCommand(paths, "main-001", {
      role: "main",
      ticket_id: null,
      prompt: `Goal: ${goal}. Begin Stage 0 (Discovery) per your system prompt.`,
      interactive: true,
    });
    tmux.spawnInWindow("harness", mainCmd, paths.root);

    // Split right side for the Console pane
    const consoleEntry = resolveBinary("dev:console", "src/console/app.tsx");
    const consoleCmd = `bun run ${shellQuote(consoleEntry)} --root ${shellQuote(paths.root)}`;
    tmux.splitPane({ cmd: consoleCmd, cwd: paths.root, direction: "h", size: "40%" });

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

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

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
