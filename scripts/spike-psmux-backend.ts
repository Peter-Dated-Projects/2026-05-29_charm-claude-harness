// Structural test of the PsmuxBackend through the real createMultiplexer path.
// Verifies the CLI argument construction charm emits is accepted by psmux:
// session create, split-window returning a pane id, paneAlive, relayout, kill.
// NOTE: psmux runs pane *processes* only while attached, so this confirms the
// structural wiring (ids, exit codes), not that the launched command executes.
import { createMultiplexer, multiplexerAvailable, resolveMultiplexerBin, type LaunchSpec } from "../src/daemon/multiplexer.ts";

const session = "charm-psmux-struct";
console.log("platform:", process.platform);
console.log("multiplexerAvailable:", multiplexerAvailable());
console.log("resolved bin:", JSON.stringify(resolveMultiplexerBin()));

const mux = createMultiplexer(session);
console.log("backend ctor:", mux.constructor.name);

// A harmless long-lived command (won't actually run detached, but must serialize).
const launch: LaunchSpec = {
  argv: ["pwsh", "-NoProfile", "-Command", "Start-Sleep -Seconds 30"],
  env: { CHARM_AGENT_ID: "struct-001", CHARM_SOCKET: "\\\\.\\pipe\\charm-x" },
  cwd: process.cwd(),
};

try {
  if (mux.hasSession()) mux.killSession();
  mux.newSession("charm", process.cwd());
  console.log("newSession OK; hasSession:", mux.hasSession());

  const consolePane = mux.spawnInWindow("charm", { ...launch, argv: ["pwsh", "-NoProfile", "-Command", "Start-Sleep 30"] });
  console.log("spawnInWindow -> console pane id:", JSON.stringify(consolePane));

  const agentPane = mux.splitPane({ launch, direction: "h", size: "65%" });
  console.log("splitPane -> agent pane id:", JSON.stringify(agentPane));

  console.log("paneAlive(agent):", mux.paneAlive(agentPane));
  console.log("paneAlive('%999'):", mux.paneAlive("%999"));

  mux.relayout({ window: "charm", consolePaneId: consolePane, agentPaneIds: [agentPane] });
  console.log("relayout OK");

  mux.killPane(agentPane);
  console.log("killPane OK");

  const idsOk = /^%\d+$/.test(consolePane) && /^%\d+$/.test(agentPane);
  console.log(idsOk ? "PASS — structural wiring accepted by psmux" : "FAIL — pane ids not in %N form");
} finally {
  try { mux.killSession(); } catch { /* ignore */ }
}
