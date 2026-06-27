---
id: gpui-modal-on-state-change-must-be-workspace-scoped
root: gotchas
type: gotcha
status: current
summary: "A modal that must pop on a CharmStore change even when its panel is collapsed must be driven by a workspace-level observe_in (which has a Window), not from a dock panel's own observer; and toggle_modal CLOSES an already-open modal of the same type, so guard with active_modal::<T>() before re-opening."
created: 2026-06-26
updated: 2026-06-26
---

Hit building the Phase 6 approval-gate arrival modal (`crates/charm_ui/src/gate_modal.rs`).
Two gpui traps when you want a modal to fire on a shared-state change:

**1. Drive the modal from the workspace, not from a panel.** Opening a Zed modal
needs a `&mut Window` (`Workspace::toggle_modal(window, cx, build)`). A dock
panel's `cx.observe(&store, ..)` callback only gets `&mut Context<Self>` -- no
window -- and worse, a *collapsed* dock panel is not laid out, so a panel-driven
modal silently never fires when the dock is closed. That fails the whole point
of an "you can't miss it" modal. Instead register a window-scoped observer at the
workspace level, from the panel-init path that already holds a `Window`:

```rust
// inside initialize_panels' workspace.update_in(cx, |workspace, window, cx| { .. })
cx.observe_in(&store, window, move |workspace, store, window, cx| {
    // has workspace + window + cx here -> can call workspace.toggle_modal(..)
}).detach();
```

`Context::observe_in(&observed, window, |this, observed, window, cx| ..)` is the
window-carrying sibling of `observe`; it fires regardless of dock visibility.

**2. `toggle_modal` is a toggle: a same-type modal already up gets CLOSED, not
replaced.** `ModalLayer::toggle_modal` checks `active_modal.view().downcast::<V>()`
and, if it matches, hides it and returns without opening. So if a second gate
arrives while a `GateModal` is still up, a naive re-call would dismiss the modal
the operator is reading. Guard it:

```rust
if workspace.active_modal::<GateModal>(cx).is_some() { return; }
workspace.toggle_modal(window, cx, move |_w, cx| GateModal::new(gate, socket, cx));
```

For "fire only on arrival" semantics, keep a `HashSet<String>` of seen ids in the
observer closure (it is `FnMut`), `retain` it to still-pending ids each tick, and
treat `set.insert(id) == true` as a new arrival. Starting the set empty means a
gate already pending at launch surfaces on the first poll tick.
