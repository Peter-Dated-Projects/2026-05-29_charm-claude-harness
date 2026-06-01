// Generate the REAL main-agent launch as a .ps1 exactly the way PsmuxBackend
// does, so we can parse-check it (the reported bug was a PowerShell "string is
// missing the terminator" from inlining the system prompt). Prints the path.
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { charmPaths } from "../src/paths.ts";
import { buildClaudeLaunch, serializeLaunchToPs1 } from "../src/daemon/spawn.ts";

const root = process.argv[2] ?? process.cwd();
const paths = charmPaths(root);
const launch = {
  ...buildClaudeLaunch(paths, "main-001", {
    role: "main",
    ticket_id: null,
    prompt: "Goal: build a thing. Begin Stage 0 (Discovery) per your system prompt.",
    interactive: true,
    model: "claude-sonnet-4-6",
  }),
  cwd: root,
};
const script = "﻿" + serializeLaunchToPs1(launch);
const dir = join(tmpdir(), "charm-launch");
mkdirSync(dir, { recursive: true });
const path = join(dir, "main-launch-test.ps1");
writeFileSync(path, script);
console.log(path);
