// Builds a tmux custom-layout string for the charm window.
//
// Window shape:
//   [ console column | agent region ]
//
// Agent region (n = agent count) follows a VS-Code-like editor-group grid:
//   n=1: single pane fills the region
//   n>=2: top row over bottom row (1-col horizontal divider between)
//         top row    = ceil(n/2) panes side-by-side
//         bottom row = floor(n/2) panes side-by-side
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
  const agentNode = buildAgentRegion(agentW, H, agentX, 0, a, inp.agentPaneWidths);
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
