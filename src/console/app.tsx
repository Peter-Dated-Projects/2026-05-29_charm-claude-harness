#!/usr/bin/env bun
import React, { useEffect, useState, useMemo } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import chokidar from "chokidar";
import { Command } from "commander";
import { harnessPaths, type HarnessPaths } from "../paths.ts";
import { rpcCall } from "../daemon/rpc.ts";
import type { ApprovalGate, Agent, TicketFrontmatter } from "../schema.ts";

type Tab = "artifacts" | "approvals";

const program = new Command();
program.option("-r, --root <path>", "project root", process.cwd()).parse(process.argv);
const ROOT = resolve(program.opts<{ root: string }>().root);
const PATHS = harnessPaths(ROOT);

type Status = {
  tickets: TicketFrontmatter[];
  agents: Agent[];
  pending_approvals: ApprovalGate[];
};

function useStatus(intervalMs = 1500): Status {
  const [status, setStatus] = useState<Status>({ tickets: [], agents: [], pending_approvals: [] });
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const s = await rpcCall<Status>(PATHS.socket, "status");
        if (active) setStatus(s);
      } catch { /* daemon down — keep last */ }
    };
    void tick();
    const h = setInterval(tick, intervalMs);
    return () => { active = false; clearInterval(h); };
  }, [intervalMs]);
  return status;
}

function useFileTree(paths: HarnessPaths): string[] {
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    const compute = () => {
      const out: string[] = [];
      if (existsSync(paths.projectMd)) out.push(paths.projectMd);
      if (existsSync(paths.coordinationMd)) out.push(paths.coordinationMd);
      if (existsSync(paths.ticketsDir)) {
        for (const f of readdirSync(paths.ticketsDir).sort()) {
          if (f.endsWith(".md")) out.push(join(paths.ticketsDir, f));
        }
      }
      setFiles(out);
    };
    compute();
    const watcher = chokidar.watch(
      [paths.projectMd, paths.coordinationMd, paths.ticketsDir],
      { ignoreInitial: true, depth: 1 },
    );
    watcher.on("all", compute);
    return () => { void watcher.close(); };
  }, [paths.projectMd, paths.coordinationMd, paths.ticketsDir]);
  return files;
}

function useFileContent(path: string | null): string {
  const [content, setContent] = useState("");
  useEffect(() => {
    if (!path) { setContent(""); return; }
    const load = () => {
      try { setContent(readFileSync(path, "utf8")); }
      catch { setContent("(file not readable)"); }
    };
    load();
    const watcher = chokidar.watch(path, { ignoreInitial: true });
    watcher.on("all", load);
    return () => { void watcher.close(); };
  }, [path]);
  return content;
}

function inferStage(status: Status): "stage0" | "stage2" | "stage3" | "idle" {
  if (status.pending_approvals.some((g) => g.stage === 0)) return "stage0";
  if (status.pending_approvals.some((g) => g.stage === 2)) return "stage2";
  if (status.agents.some((a) => a.role === "worker" && a.state === "running")) return "stage3";
  return "idle";
}

function defaultFile(stage: ReturnType<typeof inferStage>, files: string[], approvalTicketId: string | null): string | null {
  if (stage === "stage0") return files.find((f) => f.endsWith("PROJECT.md")) ?? files[0] ?? null;
  if (stage === "stage2" && approvalTicketId) {
    return files.find((f) => f.endsWith(`${approvalTicketId}.md`)) ?? null;
  }
  if (stage === "stage3") return files.find((f) => f.endsWith("COORDINATION.md")) ?? null;
  return files[0] ?? null;
}

function ArtifactsTab({ status }: { status: Status }) {
  const files = useFileTree(PATHS);
  const stage = inferStage(status);
  const pendingTicket = status.pending_approvals.find((g) => g.stage === 2)?.ticket_id ?? null;
  const auto = defaultFile(stage, files, pendingTicket);
  const [selected, setSelected] = useState<string | null>(null);
  const active = selected ?? auto;
  const content = useFileContent(active);

  useInput((input, key) => {
    if (!files.length) return;
    const idx = active ? files.indexOf(active) : 0;
    if (key.upArrow || input === "k") setSelected(files[Math.max(0, idx - 1)] ?? null);
    if (key.downArrow || input === "j") setSelected(files[Math.min(files.length - 1, idx + 1)] ?? null);
    if (input === "g") setSelected(null);
  });

  return (
    <Box flexDirection="row" flexGrow={1}>
      <Box flexDirection="column" width={28} borderStyle="single" paddingX={1}>
        <Text bold>Files <Text dimColor>(stage: {stage})</Text></Text>
        {files.length === 0 ? <Text dimColor>(none)</Text> : files.map((f) => {
          const rel = relative(ROOT, f);
          const isActive = f === active;
          const isAuto = f === auto && !selected;
          return (
            <Text key={f} color={isActive ? "cyan" : undefined} bold={isActive}>
              {isActive ? "▶ " : "  "}{rel}{isAuto ? " ·" : ""}
            </Text>
          );
        })}
      </Box>
      <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
        <Text bold>{active ? relative(ROOT, active) : "(no file)"}</Text>
        <Text>{truncate(content, 4000)}</Text>
      </Box>
    </Box>
  );
}

function ApprovalsTab({ status }: { status: Status }) {
  const [idx, setIdx] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const gates = status.pending_approvals;
  useInput(async (input, key) => {
    if (!gates.length) return;
    if (key.upArrow || input === "k") setIdx((i) => Math.max(0, i - 1));
    if (key.downArrow || input === "j") setIdx((i) => Math.min(gates.length - 1, i + 1));
    if (input === "y" || input === "a") {
      const g = gates[idx];
      if (!g) return;
      try {
        await rpcCall(PATHS.socket, "approve_gate", { id: g.id, decision: "approve" });
        setMessage(`approved ${g.id}`);
      } catch (e: any) { setMessage(e.message); }
    }
    if (input === "n" || input === "r") {
      const g = gates[idx];
      if (!g) return;
      try {
        await rpcCall(PATHS.socket, "approve_gate", { id: g.id, decision: "reject" });
        setMessage(`rejected ${g.id}`);
      } catch (e: any) { setMessage(e.message); }
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
      <Text bold>Pending approvals ({gates.length})</Text>
      {gates.length === 0 ? (
        <Text dimColor>nothing waiting</Text>
      ) : gates.map((g, i) => (
        <Box key={g.id} flexDirection="column" marginTop={1}>
          <Text color={i === idx ? "cyan" : undefined} bold={i === idx}>
            {i === idx ? "▶ " : "  "}[stage {g.stage}] {g.id} — {g.label}
          </Text>
          {g.ticket_id && <Text dimColor>  ticket: {g.ticket_id}</Text>}
          {g.payload_path && <Text dimColor>  payload: {g.payload_path}</Text>}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>[y]es / [n]o · ↑/↓ to navigate {message ? ` · ${message}` : ""}</Text>
      </Box>
    </Box>
  );
}

function App() {
  const [tab, setTab] = useState<Tab>("artifacts");
  const status = useStatus();
  const { exit } = useApp();
  const pendingCount = status.pending_approvals.length;

  useInput((input, key) => {
    if (input === "1") setTab("artifacts");
    if (input === "2") setTab("approvals");
    if (key.tab) setTab((t) => (t === "artifacts" ? "approvals" : "artifacts"));
    if (input === "q") exit();
  });

  // Auto-flip to Approvals when something is waiting
  useEffect(() => {
    if (pendingCount > 0 && tab === "artifacts") setTab("approvals");
  }, [pendingCount]);

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 30}>
      <Box>
        <Text inverse={tab === "artifacts"}> 1·Artifacts </Text>
        <Text> </Text>
        <Text inverse={tab === "approvals"}> 2·Approvals{pendingCount ? ` (${pendingCount})` : ""} </Text>
        <Text dimColor>   ·  tab to switch · q to quit</Text>
      </Box>
      {tab === "artifacts" ? <ArtifactsTab status={status} /> : <ApprovalsTab status={status} />}
      <Box>
        <Text dimColor>
          agents: {status.agents.length} · tickets: {status.tickets.length} · {ROOT}
        </Text>
      </Box>
    </Box>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n\n…(${s.length - n} more chars)`;
}

render(<App />);
