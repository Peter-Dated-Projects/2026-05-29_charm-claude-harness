// Smoke: wait for the real daemon's readiness marker, then exercise the RPC
// path over whatever endpoint paths.ts chose (named pipe on Windows).
// Run after starting: bun run src/daemon/index.ts --root <dir> --session <s>
import { existsSync } from "node:fs";
import { charmPaths } from "../src/paths.ts";
import { rpcCall } from "../src/daemon/rpc.ts";

const root = process.argv[2] ?? "/tmp/charm-smoke";
const paths = charmPaths(root);
console.log("[smoke] endpoint:", paths.socket);
console.log("[smoke] ready marker:", paths.ready);

const start = Date.now();
while (Date.now() - start < 10_000) {
  if (existsSync(paths.ready)) break;
  await new Promise((r) => setTimeout(r, 100));
}
if (!existsSync(paths.ready)) { console.error("[smoke] daemon never became ready"); process.exit(1); }
console.log("[smoke] daemon ready");

const ping = await rpcCall(paths.socket, "ping");
console.log("[smoke] ping ->", JSON.stringify(ping));

const created = await rpcCall(paths.socket, "create_tickets", {
  tickets: [{ title: "smoke ticket", body: "transport smoke", depends_on: [], touches: ["src/x.ts"] }],
});
console.log("[smoke] create_tickets ->", JSON.stringify(created));

const status = await rpcCall<any>(paths.socket, "status");
console.log("[smoke] status.tickets.length ->", status.tickets.length);
console.log("[smoke] OK — RPC round-trips over", paths.socket.startsWith("\\\\") ? "named pipe" : "unix socket");
process.exit(0);
