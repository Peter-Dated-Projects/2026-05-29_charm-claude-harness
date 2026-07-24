import { test, expect } from "bun:test";
import { resolveMcpLaunch } from "./mcp-bin.ts";

test("resolveMcpLaunch defaults to charm-mcp", () => {
  expect(resolveMcpLaunch("")).toEqual({ command: "charm-mcp", args: [] });
  expect(resolveMcpLaunch(undefined)).toEqual({ command: "charm-mcp", args: [] });
});

test("resolveMcpLaunch turns a .ts path into bun run", () => {
  expect(resolveMcpLaunch("/repo/src/mcp/server.ts")).toEqual({
    command: "bun",
    args: ["run", "/repo/src/mcp/server.ts"],
  });
});

test("resolveMcpLaunch splits an explicit bun run string", () => {
  expect(resolveMcpLaunch("bun run /repo/src/mcp/server.ts")).toEqual({
    command: "bun",
    args: ["run", "/repo/src/mcp/server.ts"],
  });
});

test("resolveMcpLaunch keeps a plain binary path", () => {
  expect(resolveMcpLaunch("/Users/me/.local/bin/charm-mcp")).toEqual({
    command: "/Users/me/.local/bin/charm-mcp",
    args: [],
  });
});
