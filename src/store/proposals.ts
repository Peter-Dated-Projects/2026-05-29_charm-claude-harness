import { readdirSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import type { CharmPaths } from "../paths.ts";

/**
 * Proposals are big feature-request documents in .charm/proposals/ (PROP-*.md).
 * Unlike tickets, they are not indexed in sqlite and do not map 1:1 to work —
 * the orchestrator reads a proposal and decides how to decompose it into tickets.
 * These helpers back the list_proposals and finish_proposal MCP tools: a read-only
 * listing of what feature requests exist, and a move of an accepted/superseded one
 * into proposals/finished/ to keep the active listing clean.
 */

export type ProposalEntry = {
  /** Filename without the .md suffix (e.g. "PROP-charm-harness-notes"). */
  name: string;
  /** First markdown heading, if any — a human-readable title. */
  title: string | null;
  /** The proposal's self-declared status (e.g. "draft"), parsed from a
   *  `**Status:** ...` or `Status: ...` line, or null if none is present. */
  status: string | null;
  /** True for entries living under proposals/finished/. */
  finished: boolean;
};

/** Pull a title (first `# heading`) and a declared status out of a proposal body
 *  without imposing any schema — proposals are free-form prose. */
function parseMeta(text: string): { title: string | null; status: string | null } {
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const statusMatch = text.match(/^\s*(?:\*\*Status:\*\*|Status:)\s*(.+?)\s*$/im);
  return {
    title: titleMatch?.[1]?.trim() ?? null,
    status: statusMatch?.[1]?.trim() ?? null,
  };
}

function readDir(dir: string, finished: boolean): ProposalEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "INDEX.md")
    .map((f) => {
      const { title, status } = parseMeta(readFileSync(join(dir, f), "utf8"));
      return { name: basename(f, ".md"), title, status, finished };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** List every proposal in .charm/proposals/, including those already moved to
 *  proposals/finished/ (flagged via `finished`). INDEX.md is excluded — it is the
 *  registry, not a proposal. */
export function listProposals(paths: CharmPaths): ProposalEntry[] {
  return [...readDir(paths.proposalsDir, false), ...readDir(paths.proposalsFinishedDir, true)];
}

/** Mark a proposal finished by moving .charm/proposals/<name>.md into
 *  proposals/finished/. Idempotency is not assumed: throws if the source is
 *  missing or a finished copy already exists, so a name typo or double-finish is
 *  surfaced rather than silently swallowed. */
export function finishProposal(paths: CharmPaths, name: string): ProposalEntry {
  const base = name.endsWith(".md") ? name.slice(0, -3) : name;
  const src = join(paths.proposalsDir, `${base}.md`);
  if (!existsSync(src)) throw new Error(`no proposal: ${base}`);
  const dest = join(paths.proposalsFinishedDir, `${base}.md`);
  if (existsSync(dest)) throw new Error(`proposal ${base} is already finished`);
  mkdirSync(paths.proposalsFinishedDir, { recursive: true });
  renameSync(src, dest);
  const { title, status } = parseMeta(readFileSync(dest, "utf8"));
  return { name: base, title, status, finished: true };
}
