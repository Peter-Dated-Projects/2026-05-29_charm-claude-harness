import { unlinkSync, existsSync } from "node:fs";
import { RpcRequest, RpcResponse } from "../schema.ts";

export type Handler = (method: string, params: unknown) => Promise<unknown>;

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
            sock.write(JSON.stringify({ id: "?", ok: false, error: `bad request: ${e.message}` }) + "\n");
            continue;
          }
          try {
            const result = await handler(req.method, req.params);
            const resp = RpcResponse.parse({ id: req.id, ok: true, result });
            sock.write(JSON.stringify(resp) + "\n");
          } catch (e: any) {
            const resp = RpcResponse.parse({ id: req.id, ok: false, error: e?.message ?? String(e) });
            sock.write(JSON.stringify(resp) + "\n");
          }
        }
      },
      open: (sock) => {
        (sock as any).data = { buf: "" };
      },
      error: (_sock, err) => {
        console.error("[rpc] socket error", err);
      },
    },
  });
  return server;
}

export async function rpcCall<T = unknown>(socketPath: string, method: string, params?: unknown): Promise<T> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<T>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const sock = Bun.connect({
      unix: socketPath,
      socket: {
        data(s, data) {
          buf += data.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          try {
            const resp = RpcResponse.parse(JSON.parse(line));
            if (resp.id !== id) return;
            settled = true;
            s.end();
            if (resp.ok) resolve(resp.result as T);
            else reject(new Error(resp.error ?? "rpc error"));
          } catch (e) {
            settled = true;
            s.end();
            reject(e);
          }
        },
        open(s) {
          s.write(JSON.stringify({ id, method, params }) + "\n");
        },
        error(_s, err) {
          if (!settled) reject(err);
        },
        close() {
          if (!settled) reject(new Error("rpc socket closed before reply"));
        },
      },
    });
    void sock;
  });
}
