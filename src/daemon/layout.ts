// Builds a tmux custom-layout string for the charm window.
//
// Window shape:
//   [ console column | orchestrator column | sub-agent grid ]
//
// The orchestrator (agentPaneIndexes[0], always registered first and never
// reordered) gets its own pinned column. Its width is `max(150, 40% of the agent
// region)` — a 150-col floor so it stays readable, with 40% taking over once the
// region is wide enough (past ~375 cols). If the region can't even cover the
// floor, the orchestrator takes whatever is available and the sub-agents are
// hidden by the caller (see shouldHideSubagents).
//
// The sub-agents (agentPaneIndexes[1..]) fill the remaining space as a grid that
// grows to stay as square as possible ("complete the square"). With n sub-agents
// the grid is rows = ceil(sqrt(n)), cols = ceil(n / rows). New panes extend the
// bounding box one shell at a time: add a bottom row (fill left-to-right), then a
// right column (fill top-to-bottom), alternating. So the spawn order 1..7 yields:
//
//   n=1   n=2   n=3   n=4   n=5   n=6   n=7
//    A    A     A C   A C   A C   A C   A C G
//         B     B     B D   B D   B D   B D
//                           E     E F   E F
//
// tmux layouts are strictly nested h/v splits — a pane cannot span across a split
// boundary — so a partially-filled last shell is rendered row-major: each row is
// an independent left-right split of its own panes. A row with fewer panes than
// the widest row therefore has wider cells (its columns won't line up pixel-exact
// with fuller rows above it); that's an unavoidable consequence of the tmux layout
// model, not a layout bug.
//
// Pane indexes are tmux #{pane_index} values at the moment of relayout — caller
// is responsible for looking them up fresh, since tmux renumbers on pane kills.

// Orchestrator gets at least this many columns, so it stays readable as
// sub-agents spawn and split the agent region.
export const ORCH_MIN_WIDTH = 150;
// ...but once the agent region is wide enough, it takes this fraction instead.
export const ORCH_FRACTION = 0.4;
// A sub-agent pane narrower than this is unusable; when the grid can't give every
// column at least this width, the caller hides the whole sub-grid (see
// shouldHideSubagents) rather than render a wall of slivers.
export const MIN_SUBAGENT_WIDTH = 8;

export type LayoutInputs = {
  windowWidth: number;
  windowHeight: number;
  consolePaneIndex: number;
  // [0] is the orchestrator; [1..] are the sub-agents to lay out in the grid.
  // When the sub-agents are hidden (moved to a background window), the caller
  // passes only [orchestrator] here and the orchestrator fills the agent region.
  agentPaneIndexes: number[];
  consoleWidth: number;
};

export function buildLayoutString(inp: LayoutInputs): string {
  const { windowWidth: W, windowHeight: H, consolePaneIndex: cIdx, agentPaneIndexes: a, consoleWidth: cw } = inp;
  if (a.length === 0) {
    return wrapChecksum(leaf(W, H, 0, 0, cIdx));
  }
  const agentX = cw + 1;
  const agentW = W - cw - 1;
  const consoleNode = leaf(cw, H, 0, 0, cIdx);

  // Orchestrator-only (no sub-agents, or sub-agents hidden): it fills the whole
  // agent region.
  if (a.length === 1) {
    const agentNode = leaf(agentW, H, agentX, 0, a[0]!);
    return wrapChecksum(leftRight(W, H, 0, 0, [consoleNode, agentNode]));
  }

  // Orchestrator column on the left of the agent region; sub-grid fills the rest.
  // The Math.max/Math.min are layout-validity guards: widths must stay positive
  // and leave at least 1 col for the sub-grid.
  const orchW = Math.max(1, Math.min(agentW - 2, orchestratorWidth(agentW)));
  const orchNode = leaf(orchW, H, agentX, 0, a[0]!);
  const subX = agentX + orchW + 1;
  const subW = agentW - orchW - 1;
  const subNode = buildSubGrid(subW, H, subX, 0, a.slice(1));
  const agentNode = leftRight(agentW, H, agentX, 0, [orchNode, subNode]);
  return wrapChecksum(leftRight(W, H, 0, 0, [consoleNode, agentNode]));
}

/** Orchestrator column width for a given agent-region width: a 150-col floor,
 *  rising to 40% of the region once that exceeds the floor. The caller clamps
 *  this against the actual region in buildLayoutString. */
export function orchestratorWidth(agentW: number): number {
  return Math.max(ORCH_MIN_WIDTH, Math.floor(agentW * ORCH_FRACTION));
}

/** Number of columns in the sub-agent grid for n sub-agents — equivalently the
 *  widest row's pane count (the first row always holds one cell per column). */
export function gridCols(n: number): number {
  if (n <= 0) return 0;
  const rows = Math.ceil(Math.sqrt(n));
  return Math.ceil(n / rows);
}

/** True when the agent region is too narrow to render the sub-grid at the minimum
 *  per-pane width — i.e. the sub-region can't give each of its columns
 *  MIN_SUBAGENT_WIDTH. The caller then hides the sub-agents (background window)
 *  and lets the orchestrator fill the region. Computed against the SAME clamped
 *  orchestrator width buildLayoutString uses, so the two never disagree. */
export function shouldHideSubagents(agentW: number, n: number): boolean {
  if (n <= 0) return false;
  const orchW = Math.max(1, Math.min(agentW - 2, orchestratorWidth(agentW)));
  const subW = agentW - orchW - 1;
  return subW < MIN_SUBAGENT_WIDTH * gridCols(n);
}

/** Shell-growth placement: the {row, col} of each sub-agent in spawn order, for n
 *  sub-agents. The grid grows by completing a square — add a bottom row (fill the
 *  existing columns left-to-right), then a right column (fill all rows
 *  top-to-bottom), alternating. The first row always ends up with one cell per
 *  column, so it is the widest. */
export function shellCells(n: number): { r: number; c: number }[] {
  const cells: { r: number; c: number }[] = [];
  let rows = 0;
  let cols = 0;
  while (cells.length < n) {
    if (rows === cols) {
      // Add a new bottom row, filling the existing columns left-to-right (the
      // very first row establishes the single starting column).
      const r = rows;
      const width = Math.max(cols, 1);
      rows++;
      for (let c = 0; c < width && cells.length < n; c++) cells.push({ r, c });
      if (cols === 0) cols = 1;
    } else {
      // rows > cols: add a new right column, filling all rows top-to-bottom.
      const c = cols;
      cols++;
      for (let r = 0; r < rows && cells.length < n; r++) cells.push({ r, c });
    }
  }
  return cells;
}

// Lay out n sub-agent panes (in spawn order) as a row-major grid: split the
// region into R equal-height rows, each an independent left-right split of the
// panes that fall on that row (ordered by column).
function buildSubGrid(W: number, H: number, X: number, Y: number, idxs: number[]): string {
  if (idxs.length === 1) return leaf(W, H, X, Y, idxs[0]!);
  const n = idxs.length;
  const cells = shellCells(n);
  const R = Math.max(...cells.map((c) => c.r)) + 1;
  // Group spawn indexes by row, then order each row left-to-right by column.
  const rows: { col: number; idx: number }[][] = Array.from({ length: R }, () => []);
  for (let i = 0; i < n; i++) rows[cells[i]!.r]!.push({ col: cells[i]!.c, idx: idxs[i]! });
  for (const row of rows) row.sort((p, q) => p.col - q.col);

  const interiorH = H - (R - 1); // total cell height, excluding R-1 row dividers
  const baseH = Math.floor(interiorH / R);
  let y = Y;
  const rowNodes: string[] = [];
  for (let r = 0; r < R; r++) {
    const rowH = r === R - 1 ? H - (y - Y) : baseH;
    rowNodes.push(buildRow(W, rowH, X, y, rows[r]!.map((p) => p.idx)));
    y += rowH + 1;
  }
  return topBottom(W, H, X, Y, rowNodes);
}

// Split a region into len(idxs) equal-width side-by-side panes.
function buildRow(W: number, H: number, X: number, Y: number, idxs: number[]): string {
  if (idxs.length === 1) return leaf(W, H, X, Y, idxs[0]!);
  const n = idxs.length;
  const interiorW = W - (n - 1); // total cell width, excluding n-1 col dividers
  const baseW = Math.floor(interiorW / n);
  let x = X;
  const children: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = i === n - 1 ? W - (x - X) : baseW; // last pane absorbs rounding drift
    children.push(leaf(w, H, x, Y, idxs[i]!));
    x += w + 1;
  }
  return leftRight(W, H, X, Y, children);
}

function leaf(w: number, h: number, x: number, y: number, idx: number): string {
  return `${w}x${h},${x},${y},${idx}`;
}
function leftRight(w: number, h: number, x: number, y: number, children: string[]): string {
  return `${w}x${h},${x},${y}{${children.join(",")}}`;
}
function topBottom(w: number, h: number, x: number, y: number, children: string[]): string {
  return `${w}x${h},${x},${y}[${children.join(",")}]`;
}

// tmux layout checksum (see layout-custom.c `layout_checksum`).
export function checksum(s: string): string {
  let csum = 0;
  for (let i = 0; i < s.length; i++) {
    csum = ((csum >> 1) + ((csum & 1) << 15)) & 0xffff;
    csum = (csum + s.charCodeAt(i)) & 0xffff;
  }
  return csum.toString(16).padStart(4, "0");
}

function wrapChecksum(layout: string): string {
  return `${checksum(layout)},${layout}`;
}
