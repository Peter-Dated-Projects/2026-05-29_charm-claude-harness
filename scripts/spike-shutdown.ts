// Verify graceful shutdown + state cleanup. Pass the SAME root (argv) the daemon
// was started with so endpoint/ready paths match under MSYS path translation.
import { existsSync } from "node:fs";
import { charmPaths } from "../src/paths.ts";
import { rpcCall } from "../src/daemon/rpc.ts";

const root = process.argv[2];
if (!root) { console.error("usage: spike-shutdown.ts <root>"); process.exit(2); }
const p = charmPaths(root);
console.log("[shutdown] endpoint:", p.socket);

const t0 = Date.now();
while (Date.now() - t0 < 8000 && !existsSync(p.ready)) await new Promise((r) => setTimeout(r, 100));
console.log("[shutdown] ready present:", existsSync(p.ready));
await rpcCall(p.socket, "ping");
console.log("[shutdown] ping ok");
await rpcCall(p.socket, "shutdown");
console.log("[shutdown] shutdown sent");
await new Promise((r) => setTimeout(r, 800));
const readyGone = !existsSync(p.ready);
const pidGone = !existsSync(p.pidFile);
console.log("[shutdown] after: ready removed:", readyGone, "| pidfile removed:", pidGone);
console.log("[shutdown]", readyGone && pidGone ? "PASS — graceful cleanup ran" : "FAIL — state left behind");
process.exit(readyGone && pidGone ? 0 : 1);
