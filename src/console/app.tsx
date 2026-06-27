#!/usr/bin/env bun
import React, { useEffect, useState } from "react";
import { render, Box, Text, useInput, useStdout } from "ink";
import { resolve } from "node:path";
import { Command } from "commander";
import { charmPaths } from "../paths.ts";
import { rpcCall } from "../daemon/rpc.ts";
import type { ApprovalGate, Agent, TicketFrontmatter } from "../schema.ts";

type Tab = "approvals" | "agents";

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
  const [tab, setTab] = useState<Tab>("agents");
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
    if (input === "1") setTab("approvals");
    if (input === "2") setTab("agents");
    if (key.tab) setTab((t) => (t === "approvals" ? "agents" : "approvals"));
  });

  // Auto-flip to Approvals when something is waiting.
  useEffect(() => {
    if (pendingCount > 0 && tab === "agents") setTab("approvals");
  }, [pendingCount]);

  return (
    <Box flexDirection="column" height={termRows} overflow="hidden">
      <Box flexShrink={0}>
        <Text inverse={tab === "approvals"} wrap="truncate-end"> 1·Approvals{pendingCount ? ` (${pendingCount})` : ""} </Text>
        <Text> </Text>
        <Text inverse={tab === "agents"} wrap="truncate-end"> 2·Agents{finishedCount ? ` (${finishedCount} done)` : ""} </Text>
        <Text dimColor wrap="truncate-end">   ·  tab to switch · :q quit · :a detach · :so suborchestrator</Text>
      </Box>
      {tab === "approvals"
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
