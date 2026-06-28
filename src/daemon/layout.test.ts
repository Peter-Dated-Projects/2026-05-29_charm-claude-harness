import { expect, test } from "bun:test";
import {
  buildLayoutString,
  gridCols,
  MIN_SUBAGENT_WIDTH,
  orchestratorWidth,
  shellCells,
  shouldHideSubagents,
} from "./layout.ts";

// A leaf in a tmux layout string is `WxH,X,Y,paneIndex`; a container is
// `WxH,X,Y{...}` or `WxH,X,Y[...]` (no trailing pane index). This regex matches
// only leaves, keyed by pane index.
type Leaf = { w: number; h: number; x: number; y: number };
function leaves(layout: string): Map<number, Leaf> {
  const m = new Map<number, Leaf>();
  for (const [, w, h, x, y, idx] of layout.matchAll(/(\d+)x(\d+),(\d+),(\d+),(\d+)/g)) {
    m.set(Number(idx), { w: Number(w), h: Number(h), x: Number(x), y: Number(y) });
  }
  return m;
}

test("shellCells grows the grid by completing the square", () => {
  // Spawn-order coordinates for the sequence Peter specified (n=1..7).
  expect(shellCells(1)).toEqual([{ r: 0, c: 0 }]);
  expect(shellCells(2)).toEqual([{ r: 0, c: 0 }, { r: 1, c: 0 }]);
  expect(shellCells(3)).toEqual([{ r: 0, c: 0 }, { r: 1, c: 0 }, { r: 0, c: 1 }]);
  expect(shellCells(4)).toEqual([
    { r: 0, c: 0 }, { r: 1, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 1 },
  ]);
  // n=5: new bottom row started (E at row 2, col 0).
  expect(shellCells(5)[4]).toEqual({ r: 2, c: 0 });
  // n=6: bottom row filled (F at row 2, col 1).
  expect(shellCells(6)[5]).toEqual({ r: 2, c: 1 });
  // n=7: new right column started at the top (G at row 0, col 2).
  expect(shellCells(7)[6]).toEqual({ r: 0, c: 2 });
});

test("gridCols is the widest row's pane count", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(gridCols)).toEqual([1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  expect(gridCols(0)).toBe(0);
});

test("orchestrator width is a 150 floor that yields to 40%", () => {
  expect(orchestratorWidth(300)).toBe(150); // 40% (120) < floor
  expect(orchestratorWidth(375)).toBe(150); // exactly at the crossover (40% = 150)
  expect(orchestratorWidth(400)).toBe(160); // 40% takes over
  expect(orchestratorWidth(1000)).toBe(400);
});

test("shouldHideSubagents trips when the sub-region can't fit min-width columns", () => {
  // agentW=160, n=4: orchW clamps to 150, subW=9, cols=2 -> need 16. Hide.
  expect(shouldHideSubagents(160, 4)).toBe(true);
  // agentW=300, n=4: subW=149, cols=2 -> need 16. Keep.
  expect(shouldHideSubagents(300, 4)).toBe(false);
  // No sub-agents: never hide.
  expect(shouldHideSubagents(50, 0)).toBe(false);
  // Boundary: subW exactly MIN*cols is NOT hidden (strict <).
  const agentW = 151 + 1 + MIN_SUBAGENT_WIDTH * 1; // orchW=150 (clamped), one col
  expect(shouldHideSubagents(agentW, 1)).toBe(false);
});

test("orchestrator-only layout fills the whole agent region", () => {
  const W = 400, H = 100, cw = 32;
  const layout = buildLayoutString({
    windowWidth: W, windowHeight: H, consolePaneIndex: 0, agentPaneIndexes: [1], consoleWidth: cw,
  });
  const l = leaves(layout);
  expect(l.get(0)).toEqual({ w: cw, h: H, x: 0, y: 0 }); // console
  expect(l.get(1)).toEqual({ w: W - cw - 1, h: H, x: cw + 1, y: 0 }); // orchestrator
});

test("grid layout: orchestrator column + one leaf per sub-agent", () => {
  const W = 600, H = 100, cw = 32;
  const subIdxs = [2, 3, 4, 5, 6]; // 5 sub-agents
  const layout = buildLayoutString({
    windowWidth: W, windowHeight: H, consolePaneIndex: 0, agentPaneIndexes: [1, ...subIdxs], consoleWidth: cw,
  });
  const l = leaves(layout);
  // console + orchestrator + every sub-agent present.
  expect(l.size).toBe(2 + subIdxs.length);
  const agentW = W - cw - 1;
  expect(l.get(1)!.w).toBe(orchestratorWidth(agentW)); // orchestrator column
  // Every sub-agent sits to the right of the orchestrator column.
  const subX = cw + 1 + orchestratorWidth(agentW) + 1;
  for (const idx of subIdxs) expect(l.get(idx)!.x).toBeGreaterThanOrEqual(subX);
});

test("grid rows partition the full height", () => {
  const W = 600, H = 99, cw = 32;
  // n=5 -> 3 rows. Distinct y-values among sub-agents should equal the row count.
  const layout = buildLayoutString({
    windowWidth: W, windowHeight: H, consolePaneIndex: 0, agentPaneIndexes: [1, 2, 3, 4, 5, 6], consoleWidth: cw,
  });
  const l = leaves(layout);
  const subYs = new Set([2, 3, 4, 5, 6].map((i) => l.get(i)!.y));
  expect(subYs.size).toBe(3);
});

test("layout string carries a 4-hex-digit checksum prefix", () => {
  const layout = buildLayoutString({
    windowWidth: 400, windowHeight: 100, consolePaneIndex: 0, agentPaneIndexes: [1], consoleWidth: 32,
  });
  expect(layout).toMatch(/^[0-9a-f]{4},/);
});
