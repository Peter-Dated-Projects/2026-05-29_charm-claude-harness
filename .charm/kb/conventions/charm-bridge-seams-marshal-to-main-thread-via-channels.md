---
id: charm-bridge-seams-marshal-to-main-thread-via-channels
root: conventions
type: convention
status: current
summary: "The gpui-free charm crate exposes UI seams (InjectHandler trait, OnAgentSpawned) that are CALLED FROM BACKGROUND THREADS; the gpui side must not touch entities directly -- forward onto a futures mpsc channel and drain it in a foreground task spawned on the first Workspace via observe_new."
created: 2026-06-26
updated: 2026-06-26
---

The `crates/charm` bridge runs two background threads (the status poll loop and
the inject-server accept loop). Both of its UI seams are invoked from those
threads:

- `InjectHandler::handle(InjectRequest)` -- from an inject-server connection
  thread (the trait is declared `Send + Sync` for exactly this reason).
- the `OnAgentSpawned` callback -- from the poll thread.

gpui entities (`Entity<Terminal>`, `Workspace`, `Pane`) live on the main thread
and need a `&mut Window`/`cx`. So a seam implementation must **never** touch a
gpui entity directly. The convention Phase 4 established
(`crates/zed/src/charm_terminal.rs`):

1. The seam impl only forwards: `ChannelInjectHandler` and the spawn callback
   each `unbounded_send` onto a `futures::channel::mpsc` channel
   (`UnboundedSender<T>` is `Send + Sync` for `Send` payloads, satisfying the
   trait bound). No gpui types cross the thread boundary.
2. The receivers are handed to `install_on_first_workspace`, which registers
   `cx.observe_new::<Workspace>(...)`. NOTE: `observe_new` takes a **`Fn`**
   closure, not `FnMut` -- to consume the receivers exactly once, hold them in a
   `RefCell<Option<..>>` and `.borrow_mut().take()` on the first window (the app
   is single-threaded, so no `Mutex` needed).
3. On that first workspace, a manager gpui entity is created and two foreground
   tasks (`cx.spawn_in(window, ...)`) drain the channels, calling
   `entity.update_in(cx, |m, window, cx| ...)` -- the only place gpui state is
   touched. The detached drain tasks hold strong handles to the manager, which
   is what keeps it (and its agents pane) alive for the session.

The manager needs a `Window` + a pane to host terminals, which do not exist at
`init_charm_bridge` time (it runs early in `App::run`, before any window). The
`observe_new::<Workspace>` hook is the seam that defers manager construction
until a workspace exists. This is the canonical Zed pattern (see
`crates/zed/src/zed.rs`'s own `observe_new::<Workspace>` use).

Idle-gate caveat: the orchestrator/sub-orchestrator inject gate uses
`TerminalView` **focus** as the "operator is composing" signal (queue while
focused, flush via a bounded 250ms poll once focus leaves). Focus is the
concrete signal available off the view; detecting a half-typed-but-unfocused
command line is a finer refinement that was not needed for the gate to be safe.
Related: [[phase4-agent-command-not-on-status-wire]].
