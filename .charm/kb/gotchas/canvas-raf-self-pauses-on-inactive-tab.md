---
id: canvas-raf-self-pauses-on-inactive-tab
root: gotchas
type: gotcha
status: current
summary: "A GPUI Pane only renders its ACTIVE item, so an animation driven by window.request_animation_frame() inside render automatically pauses when its tab is backgrounded and resumes when reselected -- you do not need a separate spawned timer with manual visibility checks."
created: 2026-06-26
updated: 2026-06-26
---

When building an animated center-pane `Item`, the obvious approach (and what the
phase-3 spec sketched) is a `cx.spawn` loop that `timer(16ms).await`s and
`cx.notify()`s, plus an explicit "is the tab visible?" check to stop it when
backgrounded. That extra machinery is unnecessary.

A `workspace::Pane` renders only its **active** item; inactive tab items are not
rendered at all. So if you drive animation by calling
`window.request_animation_frame()` at the end of `render` (and advance state by
real elapsed time via `Instant`), the loop is self-gating:

- tab active -> `render` runs -> re-arms the frame request -> keeps animating;
- tab backgrounded -> `render` not called -> frame request never re-armed ->
  animation stops, zero CPU;
- tab reselected -> `render` runs again -> animation resumes.

This is the pattern `crates/charm_canvas` (`OrchestrationItem`) uses and what the
Spike-3 bench (`gpui/examples/charm_canvas_bench.rs`) validated. The one nuance:
because advancement is time-based, the dots jump forward by the elapsed gap on
resume rather than continuing from where they froze -- fine for a flow
indicator. If you ever need a spawned timer instead (e.g. to animate a
non-rendered surface), you must add the visibility check back yourself.
