---
id: gpui-panel-element-builder-and-update-traps
root: gotchas
type: gotcha
status: current
summary: "Two gpui traps when building Zed dock panels: a per-row element-builder fn that returns `impl IntoElement` captures the `&mut Context` lifetime and fails inside a `.map()` (return `AnyElement` instead), and strong `Entity::update` returns `R` (infallible) while only `WeakEntity::update` returns `Result` for async refresh loops."
created: 2026-06-26
updated: 2026-06-26
---

Hit while building the Phase 2 charm panels (`crates/charm_ui`). Two distinct gpui
API surprises, both compile-time:

**1. RPIT element builders capture the `cx` lifetime.** A helper like
`fn render_row(&self, .., cx: &mut Context<Self>) -> impl IntoElement` ties the
returned element to the lifetime of *every* input, including `cx`. Calling it
inside `.children(rows.into_iter().map(|r| self.render_row(r, cx)))` fails with
"returns a reference to a captured variable which escapes the FnMut closure body"
-- the `.map` closure is `FnMut`, and the returned `impl IntoElement` is inferred
to borrow the captured `cx`. The element does NOT actually borrow `cx` (the
`cx.listener(..)` on-click handler is owned/`'static`); it is purely the RPIT
lifetime capture. Fix: give the builder a concrete owned return type --
`-> AnyElement` with `.into_any_element()` at the end. That severs the inferred
borrow and the `.map` compiles.

**2. `Entity::update` is infallible; `WeakEntity::update` returns `Result`.**
`Entity::<T>::update(&self, cx, f) -> R` (gpui `entity_map.rs`) returns the
closure result `R` directly and panics if the app/entity is gone -- so
`entity.update(cx, |..| ()).is_err()` does not compile (`()` has no `is_err`).
For a background refresh loop that must stop cleanly when the entity is dropped,
drive the **weak** handle: `WeakEntity::update(&self, cx, f) -> anyhow::Result<R>`
returns `Err` once the entity is gone. Pattern:

```rust
cx.spawn({
    let store = store.downgrade();          // WeakEntity
    async move |cx| {
        loop {
            cx.background_executor().timer(interval).await;
            if store.update(cx, |s, cx| s.refresh(cx)).is_err() { break; }
        }
    }
}).detach();
```

(`App::spawn` hands the closure `&mut AsyncApp`; `WeakEntity::update` with an
`AsyncApp` yields `anyhow::Result`.)
