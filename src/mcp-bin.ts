/**
 * Resolve how Charm launches the MCP shim.
 *
 * CHARM_MCP_BIN may be:
 *   - unset            → installed `charm-mcp` on PATH
 *   - a binary path    → that executable, no args
 *   - a `.ts`/`.js`    → `bun run <file>` (source checkout)
 *   - `bun run <file>` → same, split into command + args
 *
 * Claude/Codex MCP config needs a real executable in `command` and a separate
 * `args` array — a multi-word string in `command` fails to spawn.
 */
export type McpLaunch = { command: string; args: string[] };

export function resolveMcpLaunch(envBin: string | undefined = process.env.CHARM_MCP_BIN): McpLaunch {
  const raw = (envBin ?? "").trim();
  if (!raw) return { command: "charm-mcp", args: [] };

  const bunRun = raw.match(/^bun\s+run\s+(.+)$/);
  if (bunRun) return { command: "bun", args: ["run", bunRun[1]!.trim()] };

  if (/\.(ts|js|mjs|cjs)$/.test(raw)) return { command: "bun", args: ["run", raw] };

  return { command: raw, args: [] };
}
