---
id: 0011-phase3-canvas-render-model
root: decisions
type: decision
status: current
summary: "Phase 3 orchestration canvas splits rendering into a back canvas() layer (connectors + traveling dots) and absolutely-positioned div cards (text), derives the tree from first-class CharmState fields only, and animates via request_animation_frame in render (which self-pauses on backgrounded tabs) rather than the spec's cx.spawn timer."
created: 2026-06-26
updated: 2026-06-26
---

The Phase 3 orchestration canvas (`crates/charm_canvas`) is a center-pane
`workspace::Item` (`OrchestrationItem`) opened by the `charm: Show Orchestration`
action. Three decisions shaped the build:

**1. Layered rendering, not all-canvas.** The Spike-3 perf bench painted cards as
quads to measure worst case, but the shipped view paints only the connectors
(`PathBuilder::stroke` + `window.paint_path`) and the traveling dots
(`window.paint_quad(fill(...))`) in a back `canvas()` layer; the cards themselves
are ordinary absolutely-positioned `div()`s. Reason: divs render real text /
borders / a dashed worktree box for free, and manual text shaping in a raw
canvas is painful. Alignment works because the `canvas()` fills the relative
container, so its `bounds.origin` equals the cards' `(left:0, top:0)` anchor --
the canvas paint offsets logical coords by `bounds.origin`, the cards use the
same logical coords (scaled by zoom) from 0.

**2. Animation = `window.request_animation_frame()` in `render`, not a spawned
timer.** The phase-3 spec sketched a `cx.spawn` 16ms loop with an explicit
"pause when not visible" check. We use the simpler bench pattern instead: call
`request_animation_frame()` at the end of `render` and advance the dot phase by
real elapsed time (`Instant`). This is inherently visibility-gated -- a `Pane`
only renders its ACTIVE item, so a backgrounded Orchestration tab is never
rendered, never re-arms the frame request, and the dots stop; selecting the tab
again resumes them. No `Task` field, no manual active/focus tracking. (See the
companion gotcha [[canvas-raf-self-pauses-on-inactive-tab]].)

**3. Hierarchy from first-class fields only.** `derive_scene` (pure, no gpui)
builds one worktree group per `CharmState.sub_orchestrators` entry and fills each
group by filtering `agents` on `worktree_name == sub_orchestrator.worktree`;
standalone = agents with `worktree_name == None`. It never reads ticket
`touches:` (a unit test asserts two agents on an identical ticket footprint but
different worktrees land in different groups). Layout is a second pure function
(`layout_scene`, plain `f32` coords) so both are unit-tested without a GPUI
dependency. Builds against an old daemon degrade gracefully: `sub_orchestrators`
is `#[serde(default)]` on `StatusSnapshot`, so an absent field yields no groups
and the canvas shows the orchestrator + flat standalone cards.

Deferred for v1: per-connector edge-state coloring (all dots gold), text scaling
under zoom (zoom scales positions/box sizes only), and scroll for scenes taller
than the viewport.
