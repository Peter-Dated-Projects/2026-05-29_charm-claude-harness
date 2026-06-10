#!/usr/bin/env bun
import React, { useEffect, useState, useMemo } from "react";
import { render, Box, Text, useInput, useStdout } from "ink";
import { renderMarkdown, MarkdownRow } from "./markdown.tsx";
import { useMouseWheel } from "./mouse.ts";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import chokidar from "chokidar";
import { Command } from "commander";
import { charmPaths, type CharmPaths } from "../paths.ts";
import { rpcCall } from "../daemon/rpc.ts";
import type { ApprovalGate, Agent, TicketFrontmatter } from "../schema.ts";
import { FileTree, isBinaryFile } from "./file-tree.tsx";

type Tab = "artifacts" | "approvals" | "agents" | "files";

// The files list never shows fewer than this many rows, and is the default size.
const MIN_FILES_ROWS = 5;
// The viewer always keeps at least this many content rows when the list grows.
const MIN_VIEWER_ROWS = 3;

// Files tab horizontal split: tree panel default/min width in columns (content only).
const DEFAULT_TREE_COLS = 30;
const MIN_TREE_COLS = 15;
const MIN_VIEWER_COLS = 30;

const program = new Command();
program
  .option("-r, --root <path>", "project root", process.cwd())
  // The UUID must match the daemon's: it keys the per-session socket the console
  // polls. `charm start` passes it; omitted, we fall back to the legacy layout.
  .option("-u, --uuid <id>", "session UUID (control-plane key)")
  .parse(process.argv);
const CLI_OPTS = program.opts<{ root: string; uuid?: string }>();
const ROOT = resolve(CLI_OPTS.root);
const PATHS = charmPaths(ROOT, CLI_OPTS.uuid);

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

// Shared vertical-split geometry for the Artifacts and Files tabs: the live
// terminal-resize tick plus the deterministic chrome/clamp math. Both tabs read
// this single source so the +/- list-resize and terminal-resize handling can
// never fork between them. (Yoga's measureElement under flexGrow returns
// natural-content height, not the grown height, so dimensions are computed
// directly here.)
function useSplitLayout(filesRows: number) {
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
  const APP_CHROME = 2;           // tabs row + status row
  const PANEL_BORDERS = 2;        // top + bottom border on each panel
  const PANEL_PADX = 2;           // paddingX={1} on each side
  const FILES_HEADER = 1;         // header row inside the top (files/tree) panel
  const VIEWER_CHROME = PANEL_BORDERS + 2; // borders + title row + hint row
  const rowHeight = Math.max(3, termRows - APP_CHROME);

  // Vertical split: top list panel stacked above the viewer, both full width.
  // The top panel height is user-adjustable (+/-), floored at MIN_FILES_ROWS and
  // capped so the viewer always keeps MIN_VIEWER_ROWS of content.
  const maxFilesRows = Math.max(
    MIN_FILES_ROWS,
    rowHeight - (PANEL_BORDERS + FILES_HEADER) - (MIN_VIEWER_ROWS + VIEWER_CHROME),
  );
  const filesRowsEff = Math.min(Math.max(MIN_FILES_ROWS, filesRows), maxFilesRows);
  const filesPanelHeight = filesRowsEff + PANEL_BORDERS + FILES_HEADER;
  const viewerPanelHeight = Math.max(1, rowHeight - filesPanelHeight);
  const viewerHeight = Math.max(1, viewerPanelHeight - VIEWER_CHROME);
  const viewerWidth = Math.max(8, cols - PANEL_BORDERS - PANEL_PADX);

  return { rowHeight, maxFilesRows, filesRowsEff, filesPanelHeight, viewerPanelHeight, viewerHeight, viewerWidth };
}

// Shared markdown-viewer scroll STATE for both tabs: row layout, scroll
// position, wheel handling, and the clamp/reset effects. It deliberately owns
// NO key bindings — each tab wires its own keys to the returned setters so the
// two tabs can keep divergent keymaps (Artifacts: g/G scroll, r resets
// selection; Files: g/G/r belong to the tree). `resetKey` is whatever identity
// should snap scroll back to the top when it changes (the selected file path).
function useViewer(content: string, viewerWidth: number, viewerHeight: number, resetKey: string | null) {
  const rows = useMemo(() => renderMarkdown(content, viewerWidth), [content, viewerWidth]);
  const [scroll, setScroll] = useState(0);
  const maxScroll = Math.max(0, rows.length - viewerHeight);

  // Snap to top when the selected file changes; clamp when the row count shrinks.
  useEffect(() => { setScroll(0); }, [resetKey]);
  useEffect(() => { setScroll((s) => Math.min(s, maxScroll)); }, [maxScroll]);

  // Mouse wheel — keep handler stable across renders by depending only on maxScroll.
  const onWheel = React.useCallback(
    (delta: number) => setScroll((s) => Math.max(0, Math.min(maxScroll, s + delta))),
    [maxScroll],
  );
  useMouseWheel(onWheel);

  return {
    rows,
    scroll,
    pageDown: () => setScroll((s) => Math.min(maxScroll, s + viewerHeight)),
    pageUp: () => setScroll((s) => Math.max(0, s - viewerHeight)),
    halfDown: () => setScroll((s) => Math.min(maxScroll, s + Math.floor(viewerHeight / 2))),
    halfUp: () => setScroll((s) => Math.max(0, s - Math.floor(viewerHeight / 2))),
    toTop: () => setScroll(0),
    toBottom: () => setScroll(maxScroll),
  };
}

// Shared presentational viewer panel: the markdown-row slice, scroll indicator,
// bottom-glued hint, and short-file padding. Pure rendering — no input handling.
function ViewerPanel(props: {
  title: string;
  hint: string;
  rows: ReturnType<typeof renderMarkdown>;
  scroll: number;
  viewerHeight: number;
  viewerPanelHeight: number;
  flexGrow?: number;
}) {
  const { title, hint, rows, scroll, viewerHeight, viewerPanelHeight, flexGrow = 0 } = props;
  const slice = rows.slice(scroll, scroll + viewerHeight);
  const pct = rows.length === 0 ? 100 : Math.min(100, Math.round(((scroll + viewerHeight) / rows.length) * 100));
  return (
    <Box flexDirection="column" height={viewerPanelHeight} flexShrink={0} flexGrow={flexGrow} borderStyle="single" paddingX={1} overflow="hidden">
      <Box flexShrink={0}>
        <Text bold wrap="truncate-end">{title}</Text>
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
      <Text dimColor wrap="truncate-end">{hint}</Text>
    </Box>
  );
}

function ArtifactsTab({ status, inputActive }: { status: Status; inputActive: boolean }) {
  const files = useFileTree(PATHS);
  const stage = inferStage(status);
  const pendingTicket = status.pending_approvals.find((g) => g.stage === 2)?.ticket_id ?? null;
  const auto = defaultFile(stage, files, pendingTicket);
  const [selected, setSelected] = useState<string | null>(null);
  const [filesRows, setFilesRows] = useState(MIN_FILES_ROWS);
  const active = selected ?? auto;
  const content = useFileContent(active);
  const layout = useSplitLayout(filesRows);
  const viewer = useViewer(content, layout.viewerWidth, layout.viewerHeight, active);

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
    } else if (input === "+" || input === "=") {
      setFilesRows((n) => Math.min(layout.maxFilesRows, n + 1));
    } else if (input === "-" || input === "_") {
      setFilesRows((n) => Math.max(MIN_FILES_ROWS, n - 1));
    } else if (key.ctrl && input === "d") {
      viewer.halfDown();
    } else if (key.ctrl && input === "u") {
      viewer.halfUp();
    } else if (input === " " || key.pageDown) {
      viewer.pageDown();
    } else if (input === "b" || key.pageUp) {
      viewer.pageUp();
    } else if (input === "g") {
      viewer.toTop();
    } else if (input === "G") {
      viewer.toBottom();
    }
  }, { isActive: inputActive });

  // Files panel inner content rows = the user-adjustable, clamped row count.
  const filesCapacity = layout.filesRowsEff;
  const activeIdx = active ? files.indexOf(active) : -1;
  const filesScroll = activeIdx < 0
    ? 0
    : Math.max(0, Math.min(files.length - filesCapacity, activeIdx - Math.floor(filesCapacity / 2)));
  const visibleFiles = files.slice(filesScroll, filesScroll + filesCapacity);

  return (
    <Box flexDirection="column" height={layout.rowHeight} flexShrink={0} overflow="hidden">
      <Box flexDirection="column" height={layout.filesPanelHeight} flexShrink={0} borderStyle="single" paddingX={1} overflow="hidden">
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
      <ViewerPanel
        title={active ? relative(ROOT, active) : "(no file)"}
        hint="↑/↓ files · +/- resize list · wheel/space/b page · ^d/^u half · g/G top/bot · r reset"
        rows={viewer.rows}
        scroll={viewer.scroll}
        viewerHeight={layout.viewerHeight}
        viewerPanelHeight={layout.viewerPanelHeight}
      />
    </Box>
  );
}

// Compute the viewer placeholder for a binary file. statSync is guarded so a
// file deleted between selection and this render can't throw during render —
// fall back to a size-less placeholder.
function binaryPlaceholder(path: string): string {
  try {
    return `(binary file — ${statSync(path).size} bytes)`;
  } catch {
    return "(binary file)";
  }
}

function FilesTab({ inputActive }: { inputActive: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [treeCols, setTreeCols] = useState(DEFAULT_TREE_COLS);

  // Track terminal resize so dimensions stay live.
  const { stdout } = useStdout();
  const [, setResizeTick] = useState(0);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setResizeTick((n) => n + 1);
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  const cols = stdout?.columns ?? 100;
  const termRows = stdout?.rows ?? 30;
  const APP_CHROME = 2;          // tabs row + status row
  const PANEL_BORDER_V = 2;      // top + bottom border
  const PANEL_CHROME_W = 4;      // left-border + left-pad + right-pad + right-border
  const TREE_HEADER = 1;         // "Files" header row inside the tree panel
  const VIEWER_CHROME_V = 2;     // title row + hint row inside the viewer panel

  const rowHeight = Math.max(3, termRows - APP_CHROME);
  const treeHeight = Math.max(1, rowHeight - PANEL_BORDER_V - TREE_HEADER);
  const viewerHeight = Math.max(1, rowHeight - PANEL_BORDER_V - VIEWER_CHROME_V);

  // Clamp tree panel width so the viewer always keeps MIN_VIEWER_COLS of content.
  const maxTreeCols = Math.max(MIN_TREE_COLS, cols - PANEL_CHROME_W * 2 - MIN_VIEWER_COLS);
  const treeColsEff = Math.min(Math.max(MIN_TREE_COLS, treeCols), maxTreeCols);
  const treePanelWidth = treeColsEff + PANEL_CHROME_W;
  // Viewer fills the remainder; its markdown renderer needs the content width.
  const viewerWidth = Math.max(8, cols - treePanelWidth - PANEL_CHROME_W);

  // Sniff only when the selection changes (FileTree dims binary rows with its
  // own cached sniff; this is the viewer's independent check).
  const binary = useMemo(() => (selected ? isBinaryFile(selected) : false), [selected]);
  // Don't read a binary file's bytes into the viewer at all — feed null so
  // useFileContent stays empty, and render a placeholder instead.
  const fileContent = useFileContent(binary ? null : selected);
  const viewerContent = useMemo(
    () => (binary && selected ? binaryPlaceholder(selected) : fileContent),
    [binary, selected, fileContent],
  );
  const viewer = useViewer(viewerContent, viewerWidth, viewerHeight, selected);

  // The Files-tab viewer owns ONLY +/-, page (Space/b), and half-page (^d/^u).
  // It MUST NOT bind j/k/arrows/shift-arrows/enter/right/left/h/r/g/G — those
  // are FileTree's keys, and Ink delivers every keypress to BOTH this handler
  // and FileTree's while the tab is focused, so the key sets must stay disjoint.
  useInput((input, key) => {
    if (input === "+" || input === "=") {
      setTreeCols((n) => Math.min(maxTreeCols, n + 2));
    } else if (input === "-" || input === "_") {
      setTreeCols((n) => Math.max(MIN_TREE_COLS, n - 2));
    } else if (key.ctrl && input === "d") {
      viewer.halfDown();
    } else if (key.ctrl && input === "u") {
      viewer.halfUp();
    } else if (input === " " || key.pageDown) {
      viewer.pageDown();
    } else if (input === "b" || key.pageUp) {
      viewer.pageUp();
    }
  }, { isActive: inputActive });

  return (
    <Box flexDirection="row" height={rowHeight} flexShrink={0} overflow="hidden">
      <Box flexDirection="column" width={treePanelWidth} height={rowHeight} flexShrink={0} borderStyle="single" paddingX={1} overflow="hidden">
        <Text bold wrap="truncate-end">Files</Text>
        <FileTree root={ROOT} height={treeHeight} isActive={inputActive} onOpenFile={setSelected} />
      </Box>
      <ViewerPanel
        title={selected ? relative(ROOT, selected) : "(no file)"}
        hint="j/k/arrows tree · enter/right open · h/left close · g/G/r tree · wheel/space/b page · ^d/^u half · +/- resize"
        rows={viewer.rows}
        scroll={viewer.scroll}
        viewerHeight={viewerHeight}
        viewerPanelHeight={rowHeight}
        flexGrow={1}
      />
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
    if (input === "4") setTab("files");
    if (key.tab && key.shift) setTab((t) => (t === "artifacts" ? "files" : t === "files" ? "agents" : t === "agents" ? "approvals" : "artifacts"));
    else if (key.tab) setTab((t) => (t === "artifacts" ? "approvals" : t === "approvals" ? "agents" : t === "agents" ? "files" : "artifacts"));
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
        <Text> </Text>
        <Text inverse={tab === "files"} wrap="truncate-end"> 4·Files </Text>
        <Text dimColor wrap="truncate-end">   ·  tab/shift-tab to switch · :q quit · :a detach</Text>
      </Box>
      {tab === "artifacts"
        ? <ArtifactsTab status={status} inputActive={true} />
        : tab === "approvals"
        ? <ApprovalsTab status={status} inputActive={true} />
        : tab === "agents"
        ? <AgentsTab status={status} inputActive={true} />
        : <FilesTab inputActive={true} />}
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          agents: {status.agents.length} · tickets: {status.tickets.length} · {ROOT}
        </Text>
      </Box>
    </Box>
  );
}

render(<App />);
