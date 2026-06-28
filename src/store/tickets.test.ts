import { expect, test } from "bun:test";
import { authoredBody, LOG_BEGIN, LOG_END } from "./tickets.ts";

// authoredBody must mirror the strip in charm-watch (rust/src/main.rs): it returns
// the author-written portion of a ticket body, excluding the daemon-managed
// activity-log region, so idle-detection baselines findings independently of the
// daemon's own log appends.

test("authoredBody strips the activity-log region", () => {
  const body = `# Findings\n\nThe real problem is X.\n\n${LOG_BEGIN}\n## Activity\n\n- spawned\n- done\n${LOG_END}\n`;
  expect(authoredBody(body)).toBe("# Findings\n\nThe real problem is X.\n\n\n");
});

test("authoredBody returns the body unchanged when there is no log region", () => {
  const body = "# Findings\n\nJust the question, no log yet.";
  expect(authoredBody(body)).toBe(body);
});

test("authoredBody growth is the findings signal idle-detection keys off", () => {
  const seed = "# Question\n\nWhy does auth fail?";
  const withFindings = `# Question\n\nWhy does auth fail?\n\nAnswer: expiry ignored at auth.ts:42.\n${LOG_BEGIN}\n- log\n${LOG_END}`;
  // The daemon baselines the seed's authored length; once findings are added the
  // authored length grows past it even though the log region is excluded.
  expect(Buffer.byteLength(authoredBody(withFindings).trim(), "utf8"))
    .toBeGreaterThan(Buffer.byteLength(authoredBody(seed).trim(), "utf8"));
});
