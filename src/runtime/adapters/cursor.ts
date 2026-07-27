import type { AgentRuntime, LaunchContext } from "../types.ts";
import { shellQuote } from "../shell.ts";

/**
 * Cursor CLI adapter — the operator's specialist pane (`:cursor` / `:so u`).
 *
 * This is deliberately the OPPOSITE of the Claude/Codex adapters: it is NOT a
 * fleet citizen. It launches the Cursor CLI bare so the human operator can talk
 * to it for fast research/navigation, and it must stay clean of Charm:
 *   - NO Charm MCP (no socket wiring, no --approve-mcps for Charm)
 *   - NO Charm system-prompt / instructions file consumed by the CLI
 *   - NO Charm env identity (CHARM_AGENT_ID / _ROLE / _SOCKET) exported into it
 *   - NO tickets, project briefs, coordination, or fleet context
 *
 * Charm still records a registry entry + pane for UX (grid, labels, kill), but
 * that is bookkeeping only — the session itself never learns it is inside Charm.
 * Workspace trust is handled by `--trust`, so no ~/.claude.json / CODEX_HOME
 * mutation is needed.
 */
export class CursorRuntime implements AgentRuntime {
  readonly kind = "cursor" as const;

  prettyModel(id: string): string {
    // Cursor uses its own default model unless a concrete id was pinned.
    return isConcreteModel(id) ? id : "cursor";
  }

  ensureWorkspaceReady(_dir: string): void {
    // Trust is passed per-launch via --trust; nothing to pre-approve on disk.
  }

  buildCommand(ctx: LaunchContext): string {
    const { paths, spec } = ctx;
    const workDir = spec.cwd ?? paths.root;

    const flags: string[] = ["--workspace", shellQuote(workDir), "--trust"];
    // Only pin a model when the caller passed a concrete id; otherwise let
    // Cursor apply its own default (pane label shows `cursor`).
    if (spec.model && isConcreteModel(spec.model)) {
      flags.push("--model", shellQuote(spec.model));
    }

    // Prefer the `agent` binary, falling back to `cursor-agent` when only the
    // longer-named shim is on PATH. No Charm env is exported — the pane is a
    // plain Cursor session in the project root.
    const args = flags.join(" ");
    return (
      `if command -v agent >/dev/null 2>&1; then exec agent ${args}; ` +
      `else exec cursor-agent ${args}; fi`
    );
  }
}

/** A concrete CLI model id worth forwarding to Cursor's --model. */
function isConcreteModel(id: string | undefined): boolean {
  if (!id) return false;
  return id !== "cursor" && id !== "auto";
}
