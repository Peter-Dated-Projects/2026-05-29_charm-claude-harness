import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { basename } from "node:path";
import matter from "gray-matter";
import { briefPathFor, slugifyBriefName, type CharmPaths } from "../paths.ts";

/**
 * Project briefs: durable, per-project operational context the operator authors
 * once and reuses across sessions. Each is a `<slug>.md` under
 * .charm/project-briefs/ with `name`/`description` frontmatter and a freeform
 * body. `charm start --project` picks one; its body is injected into the
 * orchestrator's system prompt as standing context (see buildClaudeCommand).
 *
 * This module is the read/write seam for those files. It stays pure (no daemon,
 * no MCP) so both the CLI picker and the resume path can call it, and so the
 * slug/parse logic is unit-testable.
 */

/** A brief's frontmatter fields (all optional; slug is derived from the file name). */
export type BriefMeta = {
  slug: string;
  name: string;
  description: string;
  path: string;
};

/** A brief with its parsed body. */
export type Brief = BriefMeta & { body: string };

/** Parse one brief file into {meta, body}. Missing/blank frontmatter degrades to
 *  a name derived from the slug so a hand-created file still shows up sensibly. */
function parseBrief(slug: string, path: string): Brief {
  const parsed = matter(readFileSync(path, "utf8"));
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : slug;
  const description =
    typeof data.description === "string" ? data.description.trim() : "";
  return { slug, name, description, path, body: parsed.content.trim() };
}

/** List every brief under projectBriefsDir, sorted by name. Empty when the dir
 *  is absent (no briefs authored yet). Unreadable files are skipped rather than
 *  aborting the listing. */
export function listBriefs(paths: CharmPaths): BriefMeta[] {
  if (!existsSync(paths.projectBriefsDir)) return [];
  const out: BriefMeta[] = [];
  for (const f of readdirSync(paths.projectBriefsDir)) {
    if (!f.endsWith(".md")) continue;
    const slug = basename(f, ".md");
    const path = briefPathFor(paths, slug);
    try {
      const { name, description } = parseBrief(slug, path);
      out.push({ slug, name, description, path });
    } catch {
      /* unreadable/corrupt — skip so one bad file can't hide the rest */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one brief by slug, or null if it doesn't exist. */
export function readBrief(paths: CharmPaths, slug: string): Brief | null {
  const path = briefPathFor(paths, slug);
  if (!existsSync(path)) return null;
  return parseBrief(slug, path);
}

/** Delete a brief by slug. No-op if it's already gone, so a double-fire (or a
 *  stale picker list) can't throw. Returns true if a file was actually removed. */
export function deleteBrief(paths: CharmPaths, slug: string): boolean {
  const path = briefPathFor(paths, slug);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** True when a brief's body still carries the scaffold template's placeholders —
 *  i.e. it was created but never filled in. Used to WARN (not block) before
 *  starting a session on an empty brief; keyed off the first placeholder so a
 *  partially-filled brief no longer counts as unedited. */
export function isUneditedBrief(brief: Brief): boolean {
  return brief.body.includes("<One or two sentences");
}

/**
 * Scaffold a new brief from a template and return its slug + path. The slug is
 * derived from the typed name; if it collides with an existing brief a numeric
 * suffix is appended so a create never silently overwrites one. Does NOT open an
 * editor — the caller decides whether to (the CLI opens $EDITOR).
 */
export function scaffoldBrief(paths: CharmPaths, name: string): { slug: string; path: string } {
  mkdirSync(paths.projectBriefsDir, { recursive: true });
  const base = slugifyBriefName(name);
  let slug = base;
  for (let n = 2; existsSync(briefPathFor(paths, slug)); n++) slug = `${base}-${n}`;
  const path = briefPathFor(paths, slug);
  const displayName = name.trim() || slug;
  const body = matter.stringify(BRIEF_BODY_TEMPLATE, {
    name: displayName,
    description: "",
  });
  writeFileSync(path, body);
  return { slug, path };
}

/** The starter body for a freshly scaffolded brief — the operator fills these
 *  sections in. Kept ASCII-only (charm output rule) and section-oriented so the
 *  orchestrator gets structured standing context, not a blank page. */
const BRIEF_BODY_TEMPLATE = `
## What this project is

<One or two sentences: what the project does and who it's for.>

## Architecture / layout

<Key components, where they live, how they fit together.>

## Constraints and conventions

<Non-obvious rules an agent must respect: patterns to follow, things not to touch.>

## Links

<Curated index into this project's material: relevant .charm/kb/ notes, .charm/proposals/PROP-*.md, repo docs/source. Repo-relative links. Durable surfaces only - never scratchpad/tickets/run.>

## Current objective

<What this session (and near-term sessions) should be pushing toward.>
`.trimStart();
