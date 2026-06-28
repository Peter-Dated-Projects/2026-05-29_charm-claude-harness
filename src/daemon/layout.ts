// Builds a tmux custom-layout string for the charm window.
//
// Window shape:
//   [ console column | orchestrator column | sub-agent region ]
//
// The orchestrator (agentPaneIndexes[0], always registered first and never
// reordered) gets its own pinned column. Its width is whatever the user last
// dragged it to (seeded to ~a third of the agent region on the first layout) —
// there is no min/max clamp, so resizes are honored exactly rather than snapped.
//
// The sub-agents (agentPaneIndexes[1..]) fill the remaining space as a
// VS-Code-like editor-group grid (m = sub-agent count):
//   m=0: orchestrator fills the whole agent region (no column split)
//   m=1: single pane fills the sub region
//   m>=2: top row over bottom row (1-col horizontal divider between)
//         top row    = ceil(m/2) panes side-by-side
//         bottom row = floor(m/2) panes side-by-side
//
// Pane indexes are tmux #{pane_index} values at the moment of relayout — caller
// is responsible for looking them up fresh, since tmux renumbers on pane kills.

export type LayoutInputs = {
  windowWidth: number;
  windowHeight: number;
  consolePaneIndex: number;
  agentPaneIndexes: number[];
  consoleWidth: number;
  // Current cell widths for each agent pane (same order as agentPaneIndexes).
  // When provided, relayout preserves user-adjusted sizes proportionally instead
  // of dividing the agent region evenly. Zeros are treated as "no hint."
  agentPaneWidths?: number[];
};

export function buildLayoutString(inp: LayoutInputs): string {
  const { windowWidth: W, windowHeight: H, consolePaneIndex: cIdx, agentPaneIndexes: a, consoleWidth: cw } = inp;
  if (a.length === 0) {
    return wrapChecksum(leaf(W, H, 0, 0, cIdx));
  }
  const agentX = cw + 1;
  const agentW = W - cw - 1;
  const consoleNode = leaf(cw, H, 0, 0, cIdx);

  // Orchestrator-only: it fills the whole agent region (full width, full height).
  if (a.length === 1) {
    const agentNode = leaf(agentW, H, agentX, 0, a[0]!);
    return wrapChecksum(leftRight(W, H, 0, 0, [consoleNode, agentNode]));
  }

  // Give the orchestrator (a[0]) a full-height left column; the sub-agents grid
  // fills the rest. No min/max clamp on the claude panes: honor the
  // orchestrator's current width exactly so manual drags and window resizes are
  // never snapped back (the snap-back was the resize glitch — both the min and
  // max were recomputed from agentW, so they re-snapped every frame of a window
  // resize and made the sub-grid jump). agentPaneWidths is in agentPaneIndexes
  // order, so [0] is the orchestrator's current width. On the first layout there
  // is no hint yet, so seed it with ~a third of the agent region as a starting
  // size only. The Math.max/Math.min here are pure layout-validity guards (widths
  // must stay positive and leave room for the sub-grid), not a size policy.
  const subIdxs = a.slice(1);
  const orchHint = inp.agentPaneWidths?.[0] ?? 0;
  const orchSeed = Math.max(1, Math.floor(agentW * 0.35));
  const orchW = Math.max(1, Math.min(agentW - 2, orchHint > 0 ? orchHint : orchSeed));

  const orchNode = leaf(orchW, H, agentX, 0, a[0]!);
  const subX = agentX + orchW + 1;
  const subW = agentW - orchW - 1;
  const subNode = buildAgentRegion(subW, H, subX, 0, subIdxs, inp.agentPaneWidths?.slice(1));
  const agentNode = leftRight(agentW, H, agentX, 0, [orchNode, subNode]);
  return wrapChecksum(leftRight(W, H, 0, 0, [consoleNode, agentNode]));
}

function buildAgentRegion(W: number, H: number, X: number, Y: number, idxs: number[], widths?: number[]): string {
  if (idxs.length === 1) return leaf(W, H, X, Y, idxs[0]!);
  const topCount = Math.ceil(idxs.length / 2);
  const topH = Math.floor((H - 1) / 2);
  const bottomH = H - 1 - topH;
  const topRow = buildRow(W, topH, X, Y, idxs.slice(0, topCount), widths?.slice(0, topCount));
  const bottomRow = buildRow(W, bottomH, X, Y + topH + 1, idxs.slice(topCount), widths?.slice(topCount));
  return topBottom(W, H, X, Y, [topRow, bottomRow]);
}

function buildRow(W: number, H: number, X: number, Y: number, idxs: number[], hintWidths?: number[]): string {
  if (idxs.length === 1) return leaf(W, H, X, Y, idxs[0]!);
  const n = idxs.length;
  // Total interior width (cell area, excluding n-1 single-char dividers).
  const available = W - (n - 1);

  let interiorWidths: number[];
  const hints = hintWidths?.filter(w => w > 0);
  if (hints && hints.length === n) {
    // Scale user-adjusted widths proportionally to fit the available space,
    // so manual resizes survive agent spawns/kills without being discarded.
    const hintTotal = hints.reduce((a, b) => a + b, 0);
    const scaled = hints.map(w => Math.max(1, Math.round((w * available) / hintTotal)));
    // Fix any rounding drift in the last pane so widths sum exactly to available.
    const prefix = scaled.slice(0, -1).reduce((a, b) => a + b, 0);
    scaled[n - 1] = Math.max(1, available - prefix);
    interiorWidths = scaled;
  } else {
    const base = Math.floor(available / n);
    interiorWidths = idxs.map((_, i) => (i === n - 1 ? available - base * (n - 1) : base));
  }

  let cursor = X;
  const children: string[] = [];
  for (let i = 0; i < n; i++) {
    children.push(leaf(interiorWidths[i]!, H, cursor, Y, idxs[i]!));
    cursor += interiorWidths[i]! + 1;
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
