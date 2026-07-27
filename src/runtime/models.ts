import type { AgentRole } from "../schema.ts";
import type { RuntimeKind } from "./types.ts";

export type ModelFamilySpec = {
  /** Concrete CLI model id. */
  id: string;
  runtime: RuntimeKind;
  /** Claude-only: whether appending [1m] is valid. */
  supports1m: boolean;
  /** Pane / docs display name. */
  display: string;
};

/**
 * Caller-facing spawn families. Claude families optionally take a 1M window;
 * Codex families (sol/terra/luna) are fixed gpt-5.6 ids with no 1M suffix.
 */
export const SPAWN_MODEL_FAMILIES = {
  sonnet: { id: "claude-sonnet-5", runtime: "claude", supports1m: true, display: "sonnet-5" },
  haiku: { id: "claude-haiku-4-5-20251001", runtime: "claude", supports1m: false, display: "haiku-4.5" },
  opus: { id: "claude-opus-5", runtime: "claude", supports1m: true, display: "opus-5" },
  sol: { id: "gpt-5.6-sol", runtime: "codex", supports1m: false, display: "sol-5.6" },
  terra: { id: "gpt-5.6-terra", runtime: "codex", supports1m: false, display: "terra-5.6" },
  luna: { id: "gpt-5.6-luna", runtime: "codex", supports1m: false, display: "luna-5.6" },
} as const satisfies Record<string, ModelFamilySpec>;

export type SpawnModelFamily = keyof typeof SPAWN_MODEL_FAMILIES;

/** User-facing aliases for fleet/role overrides and CLI `-m`. */
export const MODEL_ALIASES: Record<string, string> = {
  "sonnet-5": "claude-sonnet-5",
  "sonnet-5-1m": "claude-sonnet-5[1m]",
  "haiku-4.5": "claude-haiku-4-5-20251001",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.7-1m": "claude-opus-4-7[1m]",
  "opus-4.8": "claude-opus-4-8",
  "opus-4.8-1m": "claude-opus-4-8[1m]",
  "opus-5": "claude-opus-5",
  "opus-5-1m": "claude-opus-5[1m]",
  "fable-5": "claude-fable-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-5",
  // Codex GPT-5.6 lineup — the only Codex models Charm will launch.
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-5.6-luna",
  "sol-5.6": "gpt-5.6-sol",
  "terra-5.6": "gpt-5.6-terra",
  "luna-5.6": "gpt-5.6-luna",
  "gpt-5.6-sol": "gpt-5.6-sol",
  "gpt-5.6-terra": "gpt-5.6-terra",
  "gpt-5.6-luna": "gpt-5.6-luna",
};

export const DEFAULT_MODEL_BY_ROLE: Record<AgentRole, string> = {
  main: "sonnet-5-1m",
  investigator: "opus-5",
  worker: "opus-5-1m",
  tester: "sonnet-5",
  researcher: "sonnet-5-1m",
  // Bare :so defaults to Claude Sonnet; `:so g` explicitly selects Codex Terra.
  suborchestrator: "sonnet-5-1m",
  // Cursor specialist pane omits --model so Cursor's own default applies; the
  // "cursor" sentinel is treated as non-concrete by the Cursor adapter and the
  // pane label. Never resolved through resolveModel (see defaultModelForRole).
  cursor: "cursor",
};

export function resolveSpawnModel(family: SpawnModelFamily, context1m: boolean = true): string {
  const spec = SPAWN_MODEL_FAMILIES[family];
  return context1m && spec.supports1m ? `${spec.id}[1m]` : spec.id;
}

/** Resolve a user-supplied model value to a concrete CLI model id. */
export function resolveModel(input: string): string {
  const v = input.trim();
  if (MODEL_ALIASES[v]) return MODEL_ALIASES[v]!;
  if (v.startsWith("claude-") || v.startsWith("gpt-5.6-")) return v;
  const choices = Object.keys(MODEL_ALIASES).join(", ");
  throw new Error(`unknown --model "${input}". Use one of: ${choices} (or a raw claude-*/gpt-5.6-* id)`);
}

export function runtimeKindForModel(modelId: string): RuntimeKind {
  if (modelId.startsWith("gpt-5.6-") || modelId === "sol" || modelId === "terra" || modelId === "luna") {
    return "codex";
  }
  const aliased = MODEL_ALIASES[modelId] ?? modelId;
  if (aliased.startsWith("gpt-5.6-")) return "codex";
  for (const spec of Object.values(SPAWN_MODEL_FAMILIES)) {
    if (spec.id === modelId || `${spec.id}[1m]` === modelId) return spec.runtime;
  }
  return "claude";
}

/**
 * The main orchestrator always runs on Claude Code. Suborchestrators (`:so`) and
 * every other role follow their resolved model id (Codex for sol/terra/luna).
 */
export function runtimeKindForRole(role: AgentRole, modelId: string): RuntimeKind {
  if (role === "main") return "claude";
  // The Cursor specialist pane is always hosted by the Cursor CLI, regardless
  // of any model id in play.
  if (role === "cursor") return "cursor";
  return runtimeKindForModel(modelId);
}

/** Compact pane label for known model ids. */
export function prettyModel(id: string): string {
  const DISPLAY: Record<string, string> = {
    "claude-opus-5": "opus-5",
    "claude-opus-5[1m]": "opus-5 1m",
    "claude-opus-4-8": "opus-4.8",
    "claude-opus-4-8[1m]": "opus-4.8 1m",
    "claude-opus-4-7": "opus-4.7",
    "claude-opus-4-7[1m]": "opus-4.7 1m",
    "claude-sonnet-5": "sonnet-5",
    "claude-sonnet-5[1m]": "sonnet-5 1m",
    "claude-haiku-4-5-20251001": "haiku-4.5",
    "claude-fable-5": "fable-5",
    "gpt-5.6-sol": "sol-5.6",
    "gpt-5.6-terra": "terra-5.6",
    "gpt-5.6-luna": "luna-5.6",
  };
  return DISPLAY[id] ?? id.replace(/^claude-/, "").replace(/^gpt-/, "");
}

export function defaultModelForRole(role: AgentRole): string {
  // The Cursor specialist pane has no Charm-resolved model — it uses Cursor's
  // own default. Return the sentinel directly so it never hits resolveModel
  // (which would throw on the non-model "cursor") and ignore fleet/role env
  // overrides, which target the Claude/Codex fleet, not this operator pane.
  if (role === "cursor") return "cursor";
  const roleOverride = process.env[`CHARM_MODEL_${role.toUpperCase()}`];
  if (roleOverride) {
    const resolved = resolveModel(roleOverride);
    // Main cannot leave Claude — fall back to the Claude role default.
    if (role === "main" && runtimeKindForModel(resolved) === "codex") {
      return resolveModel(DEFAULT_MODEL_BY_ROLE[role]);
    }
    return resolved;
  }
  const fleetOverride = process.env.CHARM_MODEL;
  if (fleetOverride) {
    const resolved = resolveModel(fleetOverride);
    if (role === "main" && runtimeKindForModel(resolved) === "codex") {
      return resolveModel(DEFAULT_MODEL_BY_ROLE[role]);
    }
    return resolved;
  }
  return resolveModel(DEFAULT_MODEL_BY_ROLE[role]);
}

/**
 * Resolve the model for an operator-spawned suborchestrator while honoring
 * same-runtime fleet/role overrides. An explicit runtime choice always wins:
 * a Codex override cannot turn bare `:so` into GPT, and a Claude override
 * cannot turn `:so g` into Claude.
 */
export function suborchestratorModelForRuntime(runtime: RuntimeKind = "claude"): string {
  const configured = defaultModelForRole("suborchestrator");
  if (runtimeKindForModel(configured) === runtime) return configured;
  return resolveModel(runtime === "codex" ? "terra" : DEFAULT_MODEL_BY_ROLE.suborchestrator);
}

export const THINKING_BUDGETS: Record<string, number> = {
  off: 0,
  low: 4000,
  medium: 10000,
  high: 32000,
  max: 64000,
};

export const DEFAULT_THINKING_BY_ROLE: Record<AgentRole, string> = {
  main: "max",
  investigator: "high",
  worker: "high",
  tester: "high",
  researcher: "high",
  suborchestrator: "max",
  // Cursor manages its own reasoning; Charm's thinking budget is not applied to
  // the Cursor adapter. Present only to satisfy the per-role record.
  cursor: "off",
};

export function defaultThinkingTokens(): number {
  const level = (process.env.CHARM_THINKING ?? "high").toLowerCase();
  return THINKING_BUDGETS[level] ?? THINKING_BUDGETS.high!;
}

export function defaultThinkingForRole(role: AgentRole): number {
  const override = (process.env[`CHARM_THINKING_${role.toUpperCase()}`] ?? "").toLowerCase();
  const level = override || DEFAULT_THINKING_BY_ROLE[role] || "high";
  return THINKING_BUDGETS[level] ?? THINKING_BUDGETS.high!;
}

/** Map Charm thinking budgets onto Codex discrete reasoning-effort levels.
 *  Codex defaults to `high` — Claude's `max` budget does not escalate past that. */
export function reasoningEffortForRole(role: AgentRole): "minimal" | "low" | "medium" | "high" | "xhigh" {
  const override = (process.env[`CHARM_THINKING_${role.toUpperCase()}`] ?? "").toLowerCase();
  const level = override || DEFAULT_THINKING_BY_ROLE[role] || "high";
  switch (level) {
    case "off":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "max":
    case "high":
    default:
      return "high";
  }
}
