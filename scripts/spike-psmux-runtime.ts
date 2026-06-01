// Drive the REAL PsmuxBackend to create a session + agent pane whose LaunchSpec
// writes a marker file, then exit (the default-shell initial pane keeps the
// session alive). A PowerShell harness then attaches and checks the marker —
// proving the backend's serialized launch actually executes under psmux on attach.
import { createMultiplexer, type LaunchSpec } from "../src/daemon/multiplexer.ts";

const session = process.argv[2]!;
const marker = process.argv[3]!;
const mux = createMultiplexer(session);
if (mux.hasSession()) mux.killSession();
mux.newSession("charm", process.cwd());

// LaunchSpec exactly as the daemon builds one (argv + env + cwd). argv runs a
// real program (powershell) that writes the marker then stays alive so the pane
// persists for inspection — same shape as launching `claude`.
const launch: LaunchSpec = {
  argv: ["powershell", "-NoProfile", "-NoExit", "-Command", `Set-Content -LiteralPath '${marker}' -Value started`],
  env: { CHARM_AGENT_ID: "worker-001", CHARM_SOCKET: "\\\\.\\pipe\\charm-x", MAX_THINKING_TOKENS: "32000" },
  cwd: process.cwd(),
};
const pane = mux.splitPane({ launch, direction: "h", size: "65%" });
console.log("PANE=" + pane);
console.log("SESSION=" + session);
