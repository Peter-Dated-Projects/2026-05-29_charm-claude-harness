import { unlinkSync, existsSync } from "node:fs";
import { RpcRequest, RpcResponse } from "../schema.ts";

export type Handler = (method: string, params: unknown) => Promise<unknown>;

// --- Backpressure-safe writes -------------------------------------------------
// Bun's socket.write() writes only what fits the kernel send buffer (≈8KB on
// macOS) and RETURNS the byte count — the unwritten tail is dropped, not queued.
// The old code ignored the return value, so any frame over ~8KB (a detailed
// create_tickets request, a large status reply) was silently truncated: the
// receiver never saw the framing "\n", never replied, and the call hung. We
// stash the unwritten tail on the socket and resend it from the connection's
// `drain` handler until the whole frame is out. Verified against a 2MB payload.

type PendingSocket = { write: (data: Uint8Array) => number; __pending?: Uint8Array | null };

/** Resume flushing whatever's left of a partially-written frame. Wire this to
 *  the socket's `drain` event on both client and server. */
function flushSocket(sock: PendingSocket): void {
  const p = sock.__pending;
  if (!p || p.length === 0) { sock.__pending = null; return; }
  const n = sock.write(p);
  sock.__pending = n >= p.length ? null : p.subarray(n);
}

/** Append a frame to the socket's outbound queue and write as much as fits now;
 *  the rest goes out on `drain`. */
function enqueueWrite(sock: PendingSocket, text: string): void {
  const bytes = new TextEncoder().encode(text);
  if (sock.__pending && sock.__pending.length > 0) {
    const merged = new Uint8Array(sock.__pending.length + bytes.length);
    merged.set(sock.__pending, 0);
    merged.set(bytes, sock.__pending.length);
    sock.__pending = merged;
  } else {
    sock.__pending = bytes;
  }
  flushSocket(sock);
}

/** Newline-delimited JSON-RPC over Unix domain socket. */
export function startRpcServer(socketPath: string, handler: Handler) {
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
  }
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data: async (sock, data) => {
        const state = (sock.data ?? {}) as { buf?: string };
        const combined = (state.buf ?? "") + data.toString("utf8");
        const lines = combined.split("\n");
        const trailing = lines.pop() ?? "";
        state.buf = trailing;
        (sock as unknown as { data: unknown }).data = state;
        for (const line of lines) {
          if (!line.trim()) continue;
          let req: ReturnType<typeof RpcRequest.parse>;
          try {
            req = RpcRequest.parse(JSON.parse(line));
          } catch (e: any) {
            enqueueWrite(sock as unknown as PendingSocket, JSON.stringify({ id: "?", ok: false, error: `bad request: ${e.message}` }) + "\n");
            continue;
          }
          try {
            const result = await handler(req.method, req.params);
            const resp = RpcResponse.parse({ id: req.id, ok: true, result });
            enqueueWrite(sock as unknown as PendingSocket, JSON.stringify(resp) + "\n");
          } catch (e: any) {
            const resp = RpcResponse.parse({ id: req.id, ok: false, error: e?.message ?? String(e) });
            enqueueWrite(sock as unknown as PendingSocket, JSON.stringify(resp) + "\n");
          }
        }
      },
      open: (sock) => {
        (sock as any).data = { buf: "" };
      },
      drain: (sock) => {
        flushSocket(sock as unknown as PendingSocket);
      },
      error: (_sock, err) => {
        console.error("[rpc] socket error", err);
      },
    },
  });
  return server;
}

export type RpcCallOpts = {
  /** Reject if the daemon hasn't replied within this many ms. Default 30s.
   *  Pass 0 (or a negative) to wait indefinitely — required for genuinely
   *  long-blocking handlers like `await_approval`, which parks until a human
   *  acts. Without a timeout a blocked or dead daemon makes the call hang
   *  forever, which surfaces to the agent as an MCP tool that never returns. */
  timeoutMs?: number;
  /** How many times to retry a *connection-phase* failure (default 2). Only
   *  failures that occur before the request is written are retried — see below. */
  connectRetries?: number;
};

/** A single connect→send→await round-trip. Rejections carry `charmRetryable`
 *  iff the failure happened before the request was sent (connect never
 *  established), so the caller can safely re-send even a non-idempotent method. */
function attemptCall<T>(socketPath: string, method: string, params: unknown, timeoutMs: number): Promise<T> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<T>((resolve, reject) => {
    let buf = "";
    let settled = false;
    let sock: { end: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Single settle gate: clears the timeout and runs the terminal action once.
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish(() => {
          try { sock?.end(); } catch { /* ignore */ }
          // A timeout means we sent the request but never heard back — the
          // daemon may have processed it, so this is deliberately NOT retryable.
          reject(new Error(`charmd did not respond within ${timeoutMs}ms (method=${method})`));
        });
      }, timeoutMs);
    }
    // Bun.connect returns a promise that rejects if the connection can't be
    // established (e.g. ENOENT when the daemon socket doesn't exist). None of
    // the socket handlers below fire in that case, so we must catch the connect
    // rejection here — otherwise rpcCall never settles and the failure surfaces
    // as an unhandled rejection that crashes the CLI.
    Bun.connect({
      unix: socketPath,
      socket: {
        data(s, data) {
          buf += data.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          let resp: ReturnType<typeof RpcResponse.parse>;
          try {
            resp = RpcResponse.parse(JSON.parse(line));
          } catch (e) {
            finish(() => { s.end(); reject(e); });
            return;
          }
          if (resp.id !== id) return; // not our reply; keep waiting
          finish(() => {
            s.end();
            if (resp.ok) resolve(resp.result as T);
            else reject(new Error(resp.error ?? "rpc error"));
          });
        },
        open(s) {
          sock = s;
          // Backpressure-safe: a request over ~8KB (a detailed create_tickets
          // body) won't fit one write() — enqueueWrite + the drain handler below
          // resend the tail until the whole frame is out. Without this the
          // daemon never sees the closing "\n" and the call hangs.
          enqueueWrite(s as unknown as PendingSocket, JSON.stringify({ id, method, params }) + "\n");
        },
        drain(s) {
          flushSocket(s as unknown as PendingSocket);
        },
        error(_s, err) {
          finish(() => reject(err));
        },
        close() {
          finish(() => reject(new Error("rpc socket closed before reply")));
        },
      },
    }).catch((err: any) => {
      // Connect itself failed: the request was never sent, so re-sending is safe
      // for any method (including non-idempotent ones like create_tickets).
      finish(() => { if (err && typeof err === "object") err.charmRetryable = true; reject(err); });
    });
  });
}

export async function rpcCall<T = unknown>(
  socketPath: string,
  method: string,
  params?: unknown,
  opts?: RpcCallOpts,
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const maxRetries = opts?.connectRetries ?? 2;
  let attempt = 0;
  while (true) {
    try {
      return await attemptCall<T>(socketPath, method, params, timeoutMs);
    } catch (err: any) {
      // Retry ONLY connection-phase failures (daemon momentarily down/restarting
      // — the request never reached it). Timeouts and mid-flight socket closes
      // are never retried: the daemon may have already applied the call.
      if (err?.charmRetryable && attempt < maxRetries) {
        attempt++;
        await Bun.sleep(100 * attempt);
        continue;
      }
      throw err;
    }
  }
}
