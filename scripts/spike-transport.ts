// Spike: can Bun.listen/connect use a Windows named pipe via the `unix:` option?
// Falls back to reporting failure so we know whether to use TCP loopback instead.
// Run: bun run scripts/spike-transport.ts

const PIPE = `\\\\.\\pipe\\charm-spike-${process.pid}`;

function log(...a: unknown[]) { console.log("[spike]", ...a); }

async function tryNamedPipe(): Promise<boolean> {
  log("attempting named pipe:", PIPE);
  let received = "";
  try {
    const server = Bun.listen({
      unix: PIPE,
      socket: {
        data(sock, data) {
          received += data.toString("utf8");
          sock.write("pong:" + received);
        },
        open() { log("server: client connected"); },
        error(_s, e) { log("server socket error:", e); },
      },
    });
    log("server listening OK");

    const reply = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const t = setTimeout(() => reject(new Error("timeout waiting for reply")), 3000);
      Bun.connect({
        unix: PIPE,
        socket: {
          open(s) { s.write("ping"); },
          data(s, d) {
            buf += d.toString("utf8");
            clearTimeout(t);
            s.end();
            resolve(buf);
          },
          error(_s, e) { clearTimeout(t); reject(e); },
        },
      }).catch(reject);
    });

    server.stop();
    log("round-trip reply:", JSON.stringify(reply));
    return reply.startsWith("pong:ping");
  } catch (e) {
    log("named pipe FAILED:", (e as Error).message);
    return false;
  }
}

async function tryTcp(): Promise<boolean> {
  log("attempting TCP loopback on 127.0.0.1:0 (ephemeral)");
  try {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(sock, data) { sock.write("pong:" + data.toString("utf8")); },
        open() { log("server: client connected"); },
        error(_s, e) { log("server socket error:", e); },
      },
    });
    const port = server.port;
    log("server listening on port", port);

    const reply = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const t = setTimeout(() => reject(new Error("timeout")), 3000);
      Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(s) { s.write("ping"); },
          data(s, d) { buf += d.toString("utf8"); clearTimeout(t); s.end(); resolve(buf); },
          error(_s, e) { clearTimeout(t); reject(e); },
        },
      }).catch(reject);
    });
    server.stop();
    log("round-trip reply:", JSON.stringify(reply));
    return reply.startsWith("pong:ping");
  } catch (e) {
    log("TCP FAILED:", (e as Error).message);
    return false;
  }
}

const pipeOk = await tryNamedPipe();
const tcpOk = await tryTcp();
log("==== RESULT ====");
log("named pipe usable:", pipeOk);
log("tcp loopback usable:", tcpOk);
log("recommended transport:", pipeOk ? "named-pipe" : tcpOk ? "tcp" : "NONE WORK");
process.exit(0);
