import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { charmPaths, slugifyBriefName, briefPathFor } from "../paths.ts";
import { listBriefs, readBrief, scaffoldBrief, deleteBrief, isUneditedBrief } from "./briefs.ts";

/** Fresh, isolated charm paths rooted in a throwaway temp dir per test. */
function freshPaths() {
  return charmPaths(mkdtempSync(join(tmpdir(), "charm-briefs-")));
}

test("slugifyBriefName sanitizes to [a-z0-9_-] and falls back on empty input", () => {
  expect(slugifyBriefName("Auth Token Rotation!")).toBe("auth-token-rotation");
  expect(slugifyBriefName("  Owner App  ")).toBe("owner-app");
  expect(slugifyBriefName("already-fine_1")).toBe("already-fine_1");
  expect(slugifyBriefName("!!!")).toBe("project");
  expect(slugifyBriefName("")).toBe("project");
});

test("scaffoldBrief writes a frontmatter'd file and returns its slug", () => {
  const paths = freshPaths();
  const { slug, path } = scaffoldBrief(paths, "Owner App");
  expect(slug).toBe("owner-app");
  const raw = readFileSync(path, "utf8");
  expect(raw).toContain("name: Owner App");
  expect(raw).toContain("## Current objective");
});

test("scaffoldBrief never overwrites an existing brief — it suffixes the slug", () => {
  const paths = freshPaths();
  const first = scaffoldBrief(paths, "Owner App");
  const second = scaffoldBrief(paths, "Owner App");
  expect(first.slug).toBe("owner-app");
  expect(second.slug).toBe("owner-app-2");
});

test("listBriefs reads name/description and sorts by name; skips non-md", () => {
  const paths = freshPaths();
  mkdirSync(paths.projectBriefsDir, { recursive: true });
  writeFileSync(
    join(paths.projectBriefsDir, "zebra.md"),
    "---\nname: Zebra\ndescription: last\n---\nbody\n",
  );
  writeFileSync(
    join(paths.projectBriefsDir, "alpha.md"),
    "---\nname: Alpha\ndescription: first\n---\nbody\n",
  );
  writeFileSync(join(paths.projectBriefsDir, "notes.txt"), "ignored");
  const briefs = listBriefs(paths);
  expect(briefs.map((b) => b.name)).toEqual(["Alpha", "Zebra"]);
  expect(briefs[0]!.description).toBe("first");
});

test("listBriefs is empty when the dir is absent", () => {
  expect(listBriefs(freshPaths())).toEqual([]);
});

test("readBrief returns the parsed body, or null for a missing slug", () => {
  const paths = freshPaths();
  mkdirSync(paths.projectBriefsDir, { recursive: true });
  writeFileSync(
    join(paths.projectBriefsDir, "proj.md"),
    "---\nname: Proj\n---\nThe operational context.\n",
  );
  const b = readBrief(paths, "proj");
  expect(b?.name).toBe("Proj");
  expect(b?.body).toBe("The operational context.");
  expect(readBrief(paths, "nope")).toBeNull();
});

test("isUneditedBrief flags a fresh scaffold and clears once the body is filled in", () => {
  const paths = freshPaths();
  const { slug } = scaffoldBrief(paths, "New Thing");
  expect(isUneditedBrief(readBrief(paths, slug)!)).toBe(true);
  writeFileSync(
    briefPathFor(paths, slug),
    "---\nname: New Thing\n---\nA real project doing real things.\n",
  );
  expect(isUneditedBrief(readBrief(paths, slug)!)).toBe(false);
});

test("deleteBrief removes the file and is a safe no-op when already gone", () => {
  const paths = freshPaths();
  const { slug } = scaffoldBrief(paths, "Doomed");
  expect(readBrief(paths, slug)).not.toBeNull();
  expect(deleteBrief(paths, slug)).toBe(true);
  expect(readBrief(paths, slug)).toBeNull();
  expect(deleteBrief(paths, slug)).toBe(false); // second delete: nothing to remove
});

test("a brief with no frontmatter name falls back to its slug", () => {
  const paths = freshPaths();
  mkdirSync(paths.projectBriefsDir, { recursive: true });
  writeFileSync(join(paths.projectBriefsDir, "bare.md"), "just a body, no frontmatter\n");
  expect(readBrief(paths, "bare")?.name).toBe("bare");
});
