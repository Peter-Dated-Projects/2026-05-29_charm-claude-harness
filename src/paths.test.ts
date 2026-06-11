import { expect, test } from "bun:test";
import { assertPlainName } from "./paths.ts";

/**
 * assertPlainName guards caller-supplied draft/proposal names (from LLM agents
 * via MCP tools) before they're joined into a directory. The risk it defends
 * against: an un-guarded `join(dir, name + ".md")` with a traversing name would
 * escape the intended directory and let the agent read/move/delete arbitrary
 * files. These pin the accept/reject boundary.
 */

test("assertPlainName accepts ordinary file-name segments", () => {
  for (const ok of ["T-001", "PROP-bug-triage", "draft_2", "a.b.c"]) {
    expect(() => assertPlainName(ok)).not.toThrow();
  }
});

test("assertPlainName rejects traversal, separators, and degenerate names", () => {
  for (const bad of [
    "",
    ".",
    "..",
    "../x",
    "../../etc/passwd",
    "a/b",
    "a\\b",
    "/abs",
    "foo/",
    "with\0null",
  ]) {
    expect(() => assertPlainName(bad)).toThrow(/invalid name/);
  }
});
