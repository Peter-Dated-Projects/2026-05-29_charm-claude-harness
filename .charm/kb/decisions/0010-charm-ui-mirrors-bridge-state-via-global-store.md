---
id: 0010-charm-ui-mirrors-bridge-state-via-global-store
root: decisions
type: decision
status: current
summary: "Phase 2 UI mirrors the gpui-free bridge's Arc<Mutex<CharmState>> into a single global CharmStore gpui entity refreshed by one background task that cx.notify()s; panels cx.observe it (no per-panel polling), because crates/charm has no gpui dep and Phase 2's touches exclude it (so no notify channel could be added there)."
created: 2026-06-26
updated: 2026-06-26
---

**Context.** Phase 1's `crates/charm` bridge is deliberately gpui-free: it polls
the daemon on its own std thread and folds each tick into an
`Arc<Mutex<CharmState>>`, exposed via `bridge.state()`. The Phase 2 panels (the
left Charm explorer and the right Orchestrate/General console) need to re-render
when that state changes. gpui views cannot observe a raw mutex, and Phase 2's
ticket `touches` exclude `crates/charm`, so adding an on-poll notify channel
*inside* the bridge was off the table.

**Decision.** `crates/charm_ui` owns a single `CharmStore` gpui entity that holds
a *cloned* `CharmState` snapshot. It is created lazily on first panel construction
(`charm_store(cx)`), registered as a gpui global (`GlobalCharmStore`), and fed by
exactly ONE background task (`cx.spawn` + `background_executor().timer`, ~1000ms)
that locks `bridge.state()`, clones it in, and calls `cx.notify()`. Every panel
calls `cx.observe(&store, |_,_,cx| cx.notify())` and reads `store.read(cx).state()`
-- there is no per-panel polling and no per-panel file watch (the Ink console's
chokidar watches collapse into this one update path).

**The binary hands the state across the gpui boundary.** `crates/charm_ui` keeps a
`static OnceLock<Arc<Mutex<CharmState>>>`; `main.rs::init_charm_bridge` calls
`charm_ui::set_bridge_state(bridge.state())` right after starting the bridge and
before windows are built. No charm session -> never set -> panels render an empty
shell and stock Zed is unchanged (graceful degradation preserved).

**Consequences.** The UI is at most one refresh tick (~1s) behind the bridge,
which is itself one poll (~1.5s) behind the daemon. Acceptable for a read-out.
The clone-per-tick is cheap at v1 fleet size. The explorer reads the `.charm/`
*filesystem* (not `CharmState`) but still observes the store so a new ticket file
triggers a fresh tree scan. When the daemon hierarchy backend lands
(`sub_orchestrators`/`worktree_name`, the separate in-flight ticket), the sidebar
can light up grouping with no change to this mirror -- it already carries those
fields. See [[0009-phase1-spawn-relay-and-inject-gating]] and
[[gpui-panel-element-builder-and-update-traps]].
