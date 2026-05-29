#!/usr/bin/env bun
import React, { useEffect, useState, useMemo } from "react";
import { render, Box, Text, useInput, useStdout } from "ink";
import { renderMarkdown, MarkdownRow } from "./markdown.tsx";
import { useMouseWheel } from "./mouse.ts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import chokidar from "chokidar";
import { Command } from "commander";
import { charmPaths, type CharmPaths } from "../paths.ts";
import { rpcCall } from "../daemon/rpc.ts";
import type { ApprovalGate, Agent, TicketFrontmatter } from "../schema.ts";

type Tab = "artifacts" | "approvals" | "agents";

const program = new Command();
program.option("-r, --root <path>", "project root", process.cwd()).parse(process.argv);
const ROOT = resolve(program.opts<{ root: string }>().root);
const PATHS = charmPaths(ROOT);

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

function useFileTree(paths: CharmPaths): string[] {
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

function ArtifactsTab({ status, inputActive }: { status: Status; inputActive: boolean }) {
  const files = useFileTree(PATHS);
  const stage = inferStage(status);
  const pendingTicket = status.pending_approvals.find((g) => g.stage === 2)?.ticket_id ?? null;
  const auto = defaultFile(stage, files, pendingTicket);
  const [selected, setSelected] = useState<string | null>(null);
  const active = selected ?? auto;
  const content = useFileContent(active);
  const { stdout } = useStdout();
  // Re-render on terminal resize so viewer dimensions stay live.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => forceTick((n) => n + 1);
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  const cols = stdout?.columns ?? 100;
  const termRows = stdout?.rows ?? 30;
  // Chrome accounting (deterministic — Yoga's measureElement under flexGrow
  // returns natural-content height not the grown height, so we compute directly).
  const APP_CHROME = 2;           // tabs row + status row
  const PANEL_BORDERS = 2;        // top + bottom border on each panel
  const PANEL_PADX = 2;           // paddingX={1} on each side
  const VIEWER_CHROME = PANEL_BORDERS + 2; // borders + title row + hint row
  const FILES_WIDTH = 28;
  const FILES_COLUMN_TOTAL = FILES_WIDTH + PANEL_BORDERS + PANEL_PADX;
  const VIEWER_HSIDE = PANEL_BORDERS + PANEL_PADX;
  const viewerHeight = Math.max(1, termRows - APP_CHROME - VIEWER_CHROME);
  const viewerWidth = Math.max(8, cols - FILES_COLUMN_TOTAL - VIEWER_HSIDE);
  const rowHeight = Math.max(3, termRows - APP_CHROME);

  const rows = useMemo(() => renderMarkdown(content, viewerWidth), [content, viewerWidth]);
  const [scroll, setScroll] = useState(0);
  const maxScroll = Math.max(0, rows.length - viewerHeight);

  // Clamp scroll when the file (and thus row count) changes
  useEffect(() => { setScroll(0); }, [active]);
  useEffect(() => { setScroll((s) => Math.min(s, maxScroll)); }, [maxScroll]);

  // Mouse wheel — keep handler stable across renders by depending only on maxScroll.
  const onWheel = React.useCallback(
    (delta: number) => setScroll((s) => Math.max(0, Math.min(maxScroll, s + delta))),
    [maxScroll],
  );
  useMouseWheel(onWheel);

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      if (!files.length) return;
      const idx = active ? files.indexOf(active) : 0;
      setSelected(files[Math.max(0, idx - 1)] ?? null);
    } else if (key.downArrow || input === "j") {
      if (!files.length) return;
      const idx = active ? files.indexOf(active) : 0;
      setSelected(files[Math.min(files.length - 1, idx + 1)] ?? null);
    } else if (input === "r") {
      setSelected(null);
    } else if (key.ctrl && input === "d") {
      setScroll((s) => Math.min(maxScroll, s + Math.floor(viewerHeight / 2)));
    } else if (key.ctrl && input === "u") {
      setScroll((s) => Math.max(0, s - Math.floor(viewerHeight / 2)));
    } else if (input === " " || key.pageDown) {
      setScroll((s) => Math.min(maxScroll, s + viewerHeight));
    } else if (input === "b" || key.pageUp) {
      setScroll((s) => Math.max(0, s - viewerHeight));
    } else if (input === "g") {
      setScroll(0);
    } else if (input === "G") {
      setScroll(maxScroll);
    }
  }, { isActive: inputActive });

  const slice = rows.slice(scroll, scroll + viewerHeight);
  const pct = rows.length === 0 ? 100 : Math.min(100, Math.round(((scroll + viewerHeight) / rows.length) * 100));

  // Files panel inner content rows = total panel height - borders - header row.
  // (Viewer has title + hint chrome; Files has only the header row.)
  const filesCapacity = Math.max(1, rowHeight - PANEL_BORDERS - 1);
  const activeIdx = active ? files.indexOf(active) : -1;
  const filesScroll = activeIdx < 0
    ? 0
    : Math.max(0, Math.min(files.length - filesCapacity, activeIdx - Math.floor(filesCapacity / 2)));
  const visibleFiles = files.slice(filesScroll, filesScroll + filesCapacity);

  return (
    <Box flexDirection="row" height={rowHeight} flexShrink={0} overflow="hidden">
      <Box flexDirection="column" width={FILES_WIDTH} height={rowHeight} flexShrink={0} borderStyle="single" paddingX={1} overflow="hidden">
        <Text bold wrap="truncate-end">Files <Text dimColor>(stage: {stage})</Text></Text>
        {files.length === 0 ? <Text dimColor wrap="truncate-end">(none)</Text> : visibleFiles.map((f) => {
          const rel = relative(ROOT, f);
          const isActive = f === active;
          const isAuto = f === auto && !selected;
          return (
            <Text key={f} color={isActive ? "cyan" : undefined} bold={isActive} wrap="truncate-end">
              {isActive ? "▶ " : "  "}{rel}{isAuto ? " ·" : ""}
            </Text>
          );
        })}
      </Box>
      <Box flexDirection="column" flexGrow={1} height={rowHeight} borderStyle="single" paddingX={1} overflow="hidden">
        <Box flexShrink={0}>
          <Text bold wrap="truncate-end">{active ? relative(ROOT, active) : "(no file)"}</Text>
          <Text> </Text>
          <Text dimColor wrap="truncate-end">
            {rows.length === 0 ? "" : `[${scroll + 1}-${Math.min(rows.length, scroll + viewerHeight)}/${rows.length} · ${pct}%]`}
          </Text>
        </Box>
        {slice.map((row, i) => <MarkdownRow key={scroll + i} row={row} />)}
        {/* Pad with blank lines so the hint stays glued to the panel bottom even on short files. */}
        {slice.length < viewerHeight &&
          Array.from({ length: viewerHeight - slice.length }).map((_, i) => (
            <Text key={`pad-${i}`}> </Text>
          ))}
        <Text dimColor wrap="truncate-end">
          ↑/↓ files · wheel/space/b page · ^d/^u half · g/G top/bot · r reset
        </Text>
      </Box>
    </Box>
  );
}

function ApprovalsTab({ status, inputActive }: { status: Status; inputActive: boolean }) {
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
  }, { isActive: inputActive });

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

function AgentsTab({ status, inputActive }: { status: Status; inputActive: boolean }) {
  const [idx, setIdx] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [killArm, setKillArm] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, "dismissing" | "killing">>({});
  const agents = status.agents;
  const selected = agents[Math.min(idx, agents.length - 1)];

  // Drop "dismissing"/"killing" markers for agents that have left the
  // registry. Until then the row stays red so the user sees instant feedback
  // during the brief window between RPC success and the next status poll.
  useEffect(() => {
    setPending((p) => {
      const liveIds = new Set(agents.map((a) => a.id));
      let changed = false;
      const next: Record<string, "dismissing" | "killing"> = {};
      for (const [id, v] of Object.entries(p)) {
        if (liveIds.has(id)) next[id] = v;
        else changed = true;
      }
      return changed ? next : p;
    });
  }, [agents]);
  const canDismiss = selected && (selected.state === "done" || selected.state === "failed");
  const canKill = selected && (selected.state === "spawning" || selected.state === "running");

  useInput(async (input, key) => {
    if (!agents.length) return;
    if (key.upArrow || input === "k") { setIdx((i) => Math.max(0, i - 1)); setKillArm(null); return; }
    if (key.downArrow || input === "j") { setIdx((i) => Math.min(agents.length - 1, i + 1)); setKillArm(null); return; }
    if (input === "d") {
      setKillArm(null);
      if (!selected) return;
      if (pending[selected.id]) return;
      if (!canDismiss) {
        setMessage(`cannot dismiss ${selected.id}: state is ${selected.state}`);
        return;
      }
      const targetId = selected.id;
      setPending((p) => ({ ...p, [targetId]: "dismissing" }));
      setMessage(`dismissing ${targetId}...`);
      try {
        await rpcCall(PATHS.socket, "dismiss_agent", { agent_id: targetId });
        setMessage(`dismissed ${targetId}`);
        setIdx((i) => Math.max(0, Math.min(i, agents.length - 2)));
      } catch (e: any) {
        setMessage(e.message);
        // Only clear pending on error — on success, the cleanup effect drops
        // it when the agent disappears from status, so the row stays red
        // through the brief window before the next poll prunes it.
        setPending((p) => { const n = { ...p }; delete n[targetId]; return n; });
      }
    }
    if (input === "x") {
      if (!selected) return;
      if (pending[selected.id]) return;
      if (!canKill) {
        setMessage(`cannot kill ${selected.id}: state is ${selected.state} (use [d] to dismiss)`);
        return;
      }
      if (killArm !== selected.id) {
        setKillArm(selected.id);
        setMessage(`press x again to kill ${selected.id}`);
        return;
      }
      const targetId = selected.id;
      setKillArm(null);
      setPending((p) => ({ ...p, [targetId]: "killing" }));
      setMessage(`killing ${targetId}...`);
      try {
        await rpcCall(PATHS.socket, "kill_agent", { agent_id: targetId });
        setMessage(`killed ${targetId}`);
        setIdx((i) => Math.max(0, Math.min(i, agents.length - 2)));
      } catch (e: any) {
        setMessage(e.message);
        setPending((p) => { const n = { ...p }; delete n[targetId]; return n; });
      }
    }
  }, { isActive: inputActive });

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
      <Text bold>Agents ({agents.length})</Text>
      {agents.length === 0 ? (
        <Text dimColor>no agents running</Text>
      ) : agents.map((a, i) => {
        const finished = a.state === "done" || a.state === "failed";
        const action = pending[a.id];
        const color = action
          ? "red"
          : finished ? (a.state === "done" ? "green" : "red") : i === idx ? "cyan" : undefined;
        const armed = killArm === a.id;
        const stateLabel = action === "killing" ? "killing..." : action === "dismissing" ? "dismissing..." : a.state;
        const badge = action ? "" : finished ? " [d to dismiss]" : armed ? " [x again to kill]" : "";
        return (
          <Text key={a.id} color={color} bold={i === idx} wrap="truncate-end">
            {i === idx ? "▶ " : "  "}{a.role} {a.id} — {stateLabel}
            {a.ticket_id ? ` · ${a.ticket_id}` : ""}
            {a.pane_id ? ` · ${a.pane_id}` : ""}
            {badge}
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ navigate · [d]ismiss done/failed · [x]·[x] kill running{message ? ` · ${message}` : ""}</Text>
      </Box>
    </Box>
  );
}

function App() {
  const [tab, setTab] = useState<Tab>("artifacts");
  const status = useStatus();
  const pendingCount = status.pending_approvals.length;
  const finishedCount = status.agents.filter((a) => a.state === "done" || a.state === "failed").length;
  const { stdout } = useStdout();
  // Track terminal height live so the App box clips to the *current* pane size,
  // not the size captured at mount. Without this, a tmux resize leaves a stale
  // height and content overflows above the viewport when scrolling.
  const [termRows, setTermRows] = useState<number>(stdout?.rows ?? 30);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setTermRows(stdout.rows ?? 30);
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  useInput((input, key) => {
    if (input === "1") setTab("artifacts");
    if (input === "2") setTab("approvals");
    if (input === "3") setTab("agents");
    if (key.tab && key.shift) setTab((t) => (t === "artifacts" ? "agents" : t === "agents" ? "approvals" : "artifacts"));
    else if (key.tab) setTab((t) => (t === "artifacts" ? "approvals" : t === "approvals" ? "agents" : "artifacts"));
  });

  // Auto-flip to Approvals when something is waiting
  useEffect(() => {
    if (pendingCount > 0 && tab === "artifacts") setTab("approvals");
  }, [pendingCount]);

  return (
    <Box flexDirection="column" height={termRows} overflow="hidden">
      <Box flexShrink={0}>
        <Text inverse={tab === "artifacts"} wrap="truncate-end"> 1·Artifacts </Text>
        <Text> </Text>
        <Text inverse={tab === "approvals"} wrap="truncate-end"> 2·Approvals{pendingCount ? ` (${pendingCount})` : ""} </Text>
        <Text> </Text>
        <Text inverse={tab === "agents"} wrap="truncate-end"> 3·Agents{finishedCount ? ` (${finishedCount} done)` : ""} </Text>
        <Text dimColor wrap="truncate-end">   ·  tab/shift-tab to switch · :q quit · :a detach</Text>
      </Box>
      {tab === "artifacts"
        ? <ArtifactsTab status={status} inputActive={true} />
        : tab === "approvals"
        ? <ApprovalsTab status={status} inputActive={true} />
        : <AgentsTab status={status} inputActive={true} />}
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          agents: {status.agents.length} · tickets: {status.tickets.length} · {ROOT}
        </Text>
      </Box>
    </Box>
  );
}

render(<App />);
