/**
 * Standalone Obsidian-style force-directed graph viewer.
 *
 * Renders a node-link graph to the terminal using raw ANSI + a braille canvas
 * (each character cell packs a 2x4 grid of dots, so an 80x40 terminal becomes a
 * 160x160 dot canvas — enough resolution for smooth edges and round-ish nodes).
 *
 * Deliberately does NOT use Ink. Ink reconciles a React tree every render, which
 * is the wrong cost model for a fullscreen animation. This owns stdout directly,
 * builds one string per frame, and writes it in a single call. That's why it can
 * run an animated physics sim at a steady frame rate without breaking a sweat.
 *
 * Run it standalone:    bun run src/console/graph.ts
 * Or pop a tmux window: tmux new-window 'bun run src/console/graph.ts'
 *
 * Keys:  q / Esc / Ctrl-C  quit      r  re-seed layout      space  pause physics
 */

import { appendGraphViewerPid, removeGraphViewerPid } from "../graph-viewers.ts";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const FPS = 12;
const PHYSICS_SUBSTEPS = 4; // physics ticks per rendered frame (stability)
const DT = 0.18;

const REPULSION = 1.4; // node-node push
const SPRING = 0.06; // edge pull toward rest length
const REST_LEN = 2.6; // desired edge length (layout units)
const GRAVITY = 0.012; // weak pull to center so islands don't drift off
const DAMP = 0.82; // velocity damping per substep (1 = none)

// 256-color palette, one hue per node group.
const GROUP_COLORS = [39, 213, 220, 84, 203, 141, 45, 208];
const EDGE_COLOR = 238; // dim gray
const LABEL_COLOR = 250;

// ---------------------------------------------------------------------------
// Graph model
// ---------------------------------------------------------------------------

interface Node {
  id: string;
  label: string;
  group: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Edge {
  source: string;
  target: string;
}

/** A small Obsidian-like graph: a few clusters of linked "notes". */
function dummyGraph(): { nodes: Node[]; edges: Edge[] } {
  const clusters: Record<string, string[]> = {
    discovery: ["PROJECT", "scope", "constraints", "stack", "risks"],
    tickets: ["T-001", "T-002", "T-003", "T-004", "T-005", "T-006"],
    workers: ["worker-A", "worker-B", "worker-C", "coordination"],
    infra: ["daemon", "tmux", "mcp-shim", "sqlite", "rpc"],
  };

  const nodes: Node[] = [];
  let group = 0;
  for (const members of Object.values(clusters)) {
    for (const label of members) {
      nodes.push({
        id: label,
        label,
        group,
        // seed in a small jittered cloud near origin
        x: (Math.random() - 0.5) * 4,
        y: (Math.random() - 0.5) * 4,
        vx: 0,
        vy: 0,
      });
    }
    group++;
  }

  const edges: Edge[] = [];
  const link = (a: string, b: string) => edges.push({ source: a, target: b });

  // intra-cluster spokes
  link("PROJECT", "scope");
  link("PROJECT", "constraints");
  link("PROJECT", "stack");
  link("scope", "risks");
  for (const t of clusters.tickets!) link("PROJECT", t);
  link("T-001", "T-003");
  link("T-002", "T-004");
  link("T-003", "T-005");
  link("daemon", "tmux");
  link("daemon", "rpc");
  link("daemon", "mcp-shim");
  link("daemon", "sqlite");
  link("worker-A", "coordination");
  link("worker-B", "coordination");
  link("worker-C", "coordination");

  // cross-cluster bridges (what makes it look like a real graph)
  link("stack", "daemon");
  link("T-001", "worker-A");
  link("T-002", "worker-B");
  link("T-004", "worker-C");
  link("coordination", "rpc");
  link("mcp-shim", "T-006");

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Braille canvas
// ---------------------------------------------------------------------------

// Dot -> bit within a braille cell. Indexed [subY 0..3][subX 0..1].
const BRAILLE_BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

class Frame {
  cols: number;
  rows: number;
  dotW: number;
  dotH: number;
  bits: Uint8Array; // braille bits per cell (edges)
  glyph: string[]; // node glyph per cell ('' = none)
  color: Int16Array; // color per cell (-1 = none)

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.dotW = cols * 2;
    this.dotH = rows * 4;
    this.bits = new Uint8Array(cols * rows);
    this.glyph = new Array(cols * rows).fill("");
    this.color = new Int16Array(cols * rows).fill(-1);
  }

  /** Set a braille dot at dot-space (dx, dy). */
  dot(dx: number, dy: number): void {
    if (dx < 0 || dy < 0 || dx >= this.dotW || dy >= this.dotH) return;
    const i = (dy >> 2) * this.cols + (dx >> 1);
    this.bits[i] = (this.bits[i] ?? 0) | BRAILLE_BIT[dy & 3]![dx & 1]!;
  }

  /** Bresenham line in dot space. */
  line(x0: number, y0: number, x1: number, y1: number): void {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.dot(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  /** Stamp a colored glyph at cell (cx, cy). */
  stamp(cx: number, cy: number, ch: string, color: number): void {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return;
    const i = cy * this.cols + cx;
    this.glyph[i] = ch;
    this.color[i] = color;
  }
}

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------

function step(nodes: Node[], edges: Edge[], byId: Map<string, Node>): void {
  // repulsion (all pairs)
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { d2 = 0.01; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
      const d = Math.sqrt(d2);
      const f = REPULSION / d2;
      const ux = dx / d, uy = dy / d;
      a.vx += ux * f; a.vy += uy * f;
      b.vx -= ux * f; b.vy -= uy * f;
    }
  }

  // springs (edges)
  for (const e of edges) {
    const a = byId.get(e.source)!;
    const b = byId.get(e.target)!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = SPRING * (d - REST_LEN);
    const ux = dx / d, uy = dy / d;
    a.vx += ux * f; a.vy += uy * f;
    b.vx -= ux * f; b.vy -= uy * f;
  }

  // gravity + integrate
  for (const n of nodes) {
    n.vx -= n.x * GRAVITY;
    n.vy -= n.y * GRAVITY;
    n.vx *= DAMP;
    n.vy *= DAMP;
    n.x += n.vx * DT;
    n.y += n.vy * DT;
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(nodes: Node[], edges: Edge[], byId: Map<string, Node>, cols: number, rows: number): string {
  const f = new Frame(cols, rows);
  const margin = 6;

  // fit layout bounding box into the dot canvas
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((f.dotW - margin * 2) / spanX, (f.dotH - margin * 2) / spanY);
  const ox = (f.dotW - spanX * scale) / 2;
  const oy = (f.dotH - spanY * scale) / 2;
  const dotX = (n: Node) => ox + (n.x - minX) * scale;
  const dotY = (n: Node) => oy + (n.y - minY) * scale;

  // edges first (under nodes)
  for (const e of edges) {
    const a = byId.get(e.source)!;
    const b = byId.get(e.target)!;
    f.line(dotX(a), dotY(a), dotX(b), dotY(b));
  }

  // nodes + labels on top
  for (const n of nodes) {
    const cx = Math.round(dotX(n) / 2);
    const cy = Math.round(dotY(n) / 4);
    const color = GROUP_COLORS[n.group % GROUP_COLORS.length]!;
    f.stamp(cx, cy, "●", color); // ●
    // label to the right if it fits
    for (let k = 0; k < n.label.length; k++) {
      f.stamp(cx + 2 + k, cy, n.label[k]!, LABEL_COLOR);
    }
  }

  // compose, minimizing color escapes
  let out = "\x1b[H";
  let cur = -2;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      let ch: string;
      let col: number;
      if (f.glyph[i]) {
        ch = f.glyph[i]!;
        col = f.color[i]!;
      } else if (f.bits[i]) {
        ch = String.fromCharCode(0x2800 | f.bits[i]!);
        col = EDGE_COLOR;
      } else {
        ch = " ";
        col = -1;
      }
      if (col !== cur) {
        out += col < 0 ? "\x1b[0m" : `\x1b[38;5;${col}m`;
        cur = col;
      }
      out += ch;
    }
    if (cy < rows - 1) out += "\x1b[0m\n", (cur = -2);
  }
  out += "\x1b[0m";
  return out;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function main(): void {
  let { nodes, edges } = dummyGraph();
  let byId = new Map(nodes.map((n) => [n.id, n] as const));
  let paused = false;

  const out = process.stdout;
  out.write("\x1b[?1049h\x1b[?25l\x1b[2J"); // alt screen, hide cursor, clear

  // Self-register so `charm stop` can reap this window even though it lives in a
  // separate OS terminal the daemon never sees. The daemon passes the tracking
  // file path via CHARM_GRAPH_PIDFILE; absent it (e.g. run by hand) we just skip.
  const pidFile = process.env.CHARM_GRAPH_PIDFILE;
  if (pidFile) appendGraphViewerPid(pidFile, process.pid);

  const cleanup = () => {
    clearInterval(timer);
    out.off("resize", onResize);
    out.write("\x1b[0m\x1b[?25h\x1b[?1049l"); // reset, show cursor, leave alt screen
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    if (pidFile) removeGraphViewerPid(pidFile, process.pid);
  };
  const quit = () => { cleanup(); process.exit(0); };

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (buf: Buffer) => {
    const k = buf.toString();
    if (k === "q" || k === "\x1b" || k === "\x03") quit();
    else if (k === "r") { ({ nodes, edges } = dummyGraph()); byId = new Map(nodes.map((n) => [n.id, n] as const)); }
    else if (k === " ") paused = !paused;
  });
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);

  let frames = 0;
  let lastFpsT = performance.now();
  let fps = 0;

  const draw = () => {
    const cols = out.columns ?? 80;
    const rows = (out.rows ?? 24) - 1; // leave a status line
    if (!paused) for (let s = 0; s < PHYSICS_SUBSTEPS; s++) step(nodes, edges, byId);

    frames++;
    const now = performance.now();
    if (now - lastFpsT >= 1000) { fps = (frames * 1000) / (now - lastFpsT); frames = 0; lastFpsT = now; }

    const body = render(nodes, edges, byId, cols, rows);
    const status =
      `\x1b[${rows + 1};1H\x1b[0m\x1b[2K` +
      `\x1b[38;5;245m ${nodes.length} nodes · ${edges.length} edges · ${fps.toFixed(0)} fps` +
      `${paused ? " · PAUSED" : ""} · [q]uit [r]eseed [space]pause\x1b[0m`;
    out.write(body + status);
  };

  // Resize handling is poll-based at heart: draw() re-reads the terminal size
  // every frame and refits, so the graph adapts within one frame regardless.
  // This listener is the responsiveness layer — on resize, clear any stale
  // region (revealed when the window grows) and redraw immediately rather than
  // waiting up to one frame. Polling remains the backstop if the event misfires.
  const onResize = () => {
    out.write("\x1b[2J");
    draw();
  };
  out.on("resize", onResize);

  const timer = setInterval(draw, Math.round(1000 / FPS));
  draw();
}

main();
