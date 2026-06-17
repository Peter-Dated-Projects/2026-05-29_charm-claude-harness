# PROP-gpui-deepdive

**Status:** draft
**Ticket:** T-018
**Verdict:** CONDITIONAL GO

---

## Summary

GPUI is the most production-proven GPU-accelerated Rust UI framework in existence: it
powers Zed, a shipping VSCode-competitor used daily by a large community. Its rendering
quality, cross-platform reach (macOS/Linux/Windows as of Oct 2025), and emerging crate
ecosystem make it the strongest candidate for a charm GUI rewrite. The framework is
pre-1.0 with deliberate API churn, Zed-centric maintenance, and sparse external
documentation — these are real costs, not dealbreakers, but they set the conditions
below.

---

## Research Areas

### 1. API and Programming Model

GPUI uses a **hybrid immediate + retained mode** architecture. The conceptual model:

- Declarative `Render` trait on views (similar to React's render method)
- `Div`-based element tree with Tailwind-style method-chain styling via the `Styled` trait
- Layout delegated to the **Taffy** library (flexbox + grid), so familiar CSS layout primitives apply
- State: entity-based ownership model (`Entity<T>`) for inter-component communication; no global state soup
- Async: GPUI ships its **own async executor** integrated into the platform event loop; `cx.spawn()` is the primary entry point; no Tokio required (but compatible)
- Rendering phases: layout -> prepaint (state prep) -> paint (scene construction) -> GPU submission; this is opaque to application code

**Panel/dock layout**: Zed's own dock and panel system is implemented on top of GPUI's
layout primitives and serves as a reference implementation. The `gpui-component` library
(Longbridge, Apache-2.0) provides a dock layout component explicitly designed for
resizable panel arrangements. Building a charm-style split pane layout is well-charted
territory.

**React/Elm comparison**:
- Closer to React than Elm: views hold local state, communicate via message-passing
  through entities, and re-render declaratively
- No virtual DOM diff — GPUI re-runs the element tree every frame but the GPU pipeline
  amortizes the cost
- No explicit signal/subscription wiring as in Elm; state changes propagate through
  entity subscriptions (`cx.observe`)

**Pre-1.0 caveat**: Breaking changes are common between versions and are not
communicated via semver. Vendoring at a pinned git commit and absorbing churn
periodically is the only practical strategy.

---

### 2. Distribution and Licensing

**License**: Apache-2.0. The main `gpui` crate on crates.io is Apache-2.0; Zed's overall
repo is Apache-2.0 / GPL-3.0 dual-licensed, but the GPUI crate itself is Apache-2.0 only.
No copyleft obligation for a tool built on it.

**Distribution**: The `gpui` crate exists on crates.io (version 0.2.2), but this version
is significantly behind the live Zed codebase. External developers who have tried the
crates.io release encounter missing APIs and behavior divergence. **Practical approach:
vendor from the Zed git repo at a pinned commit** (path dependency or git dependency in
`Cargo.toml`). This is what all active GPUI apps in the wild actually do.

**Maintenance**: Zed-team-only for core changes. External contributions are accepted but
must be submitted to the Zed repo and kept in sync with Zed's own needs. Zed maintainer
ConradIrwin has confirmed that component library development (e.g., new widgets) can
happen in separate crates without requiring core GPUI changes. The `gpui-component` library
(Longbridge) is an independent Apache-2.0 component ecosystem that operates at arm's
length from the Zed team.

---

### 3. Crate Availability for Charm's Needs

| Capability | Status | Source |
|---|---|---|
| Markdown rendering | Available | `gpui-component` (Longbridge) — native Markdown + simple HTML renderer included |
| Terminal emulator pane | Buildable, not prepackaged | Use `alacritty_terminal` for PTY/VTE + GPUI rendering layer; Zed's own terminal and the standalone `zTerm` project demonstrate the pattern |
| Resizable panel/dock layout | Available | `gpui-component` dock layout component |
| Tree view | Available | `gpui-component` tree view component |
| Force-directed graph | Emerging | `gpui-flow` (visual node editor), `ferrum-flow`, `gpui-d3rs` (D3-style plotting), `plotters-gpui`; none are force-directed out-of-box, but GPUI's canvas layer supports custom rendering |

**Terminal pane detail**: Zed's terminal uses `alacritty_terminal` for PTY management and
VTE parsing, with a custom GPUI rendering layer on top. A third-party developer published
a detailed walkthrough of building a standalone GPUI terminal emulator (`zTerm`) using
exactly this approach. The integration is not trivial (IME handling, cross-platform PTY
differences, render batching) but the pattern is proven. Charm would need to build this
component, not import a ready-made one.

**Force-directed graph detail**: The charm graph visualizer (currently braille canvas,
force-directed 3D physics) would need a custom implementation on GPUI's canvas primitives
or adaptation of `gpui-flow` / `ferrum-flow`. Neither of those is force-directed layout
specifically, but implementing a 2D force-directed graph on a GPUI canvas element is
feasible (the physics sim is pure Rust; only the render layer needs GPUI integration).

---

### 4. OTA Update Integration

Zed's auto-updater is a **custom in-process mechanism**:
- Spawns a background thread that polls a release endpoint every 60 minutes
- Downloads the new binary; applies it by replacing itself on disk
- Update takes effect on next launch (no Tauri, no electron-updater, no OS update framework)

**Reusability**: The auto-update logic is part of the `auto_updater` crate in the Zed
monorepo, also under Apache-2.0. It is vendorable. However, it has Zed-specific
assumptions (release API shape, Zed's signing infrastructure). A charm auto-updater would
need to adapt the pattern rather than reuse the code wholesale.

**Platform complications**:
- **Windows**: Cannot overwrite a running `.exe` in-place; the Zed team works around this
  by staging the new binary and replacing on next launch via a launcher stub. This is
  solvable but non-trivial.
- **macOS**: As of Oct 2025, updating signed files in-place can trigger OS security errors.
  Zed handles this via the macOS update model (replace bundle, re-sign). Charm would need
  the same.

Conclusion: auto-update is feasible for charm in Rust without Tauri, using Zed's approach
as a reference, but requires platform-specific work for each target OS.

---

### 5. Platform Support

| Platform | Status | Backend | Notes |
|---|---|---|---|
| macOS | Production | Metal | Zed's home platform; most mature path |
| Linux | Production | Wayland / X11 (configurable) | Ships with Zed; requires `libxkbcommon` and wayland/x11 system libs at build time |
| Windows | Beta (shipped Oct 2025) | DirectX 11 | Arrived later; required switch from Vulkan/Blade to DX11; path handling, keyboard, and auto-update have platform-specific quirks |
| Web (WASM) | Experimental | WebGPU | Not production-ready |

**Linux note**: Builders outside the Zed team report needing to install system libraries
(`libxkbcommon`, wayland, x11 dev headers) before a fresh build compiles. This is a
one-time setup cost, not a runtime dependency gap.

**Windows note**: The port required six weeks of work from four Zed engineers and
introduced a third shader dialect (DX11 alongside Metal and Vulkan). The architectural
principle of "write once, run three backends" holds but the abstraction is imperfect.
For charm, targeting macOS and Linux first with Windows as a follow-on is the
lower-risk path.

---

### 6. Real-World Build Experience

**Compile times**: Fresh builds take 10+ minutes on typical developer hardware (Rust's
standard large-dep cold-compile problem). Incremental rebuilds are fast. GPUI itself is
~5MB of crate source; the bigger cost is its dependency graph (wgpu, taffy, font-kit,
etc.). `sccache` or `mold` linker reduce iteration cost meaningfully.

**Documentation**: Sparse. The canonical learning resources are:
1. `/crates/gpui/examples/` in the Zed repo (~10 annotated examples)
2. Zed's own source (the definitive real-world reference for every pattern)
3. `gpui-component`'s Storybook (interactive component showcase)
4. Zed's Discord (`#gpui` channel, active but Zed-team-focused)

There is no standalone tutorial site or comprehensive book. A developer building on GPUI
outside the Zed team will spend the first week primarily reading Zed source code. This is
a real onboarding cost.

**Community traction**: The `awesome-gpui` list contains 30+ independent apps built on
GPUI, including a DAW, a PostgreSQL client, a Redis GUI, a Nostr client, and several code
editors. This demonstrates the framework is usable outside Zed — it is not a purely
internal tool. However, most of these projects are early-stage; none match Zed's
production scale.

**Pain points reported by external devs**:
- Git-only distribution (crates.io version lags; most devs vendor from git)
- Platform setup boilerplate on Linux
- IME support is complex and under-documented
- API churn: a feature working in one Zed commit may break in the next
- Windows cross-compile is not supported; must build natively on each platform

---

## Verdict: CONDITIONAL GO

GPUI is the right framework for a charm GUI rewrite **if the following conditions are
accepted**:

| Condition | Rationale |
|---|---|
| **Vendor GPUI from the Zed git repo at a pinned commit**, not crates.io | crates.io version is too stale; pinned git is the only practical approach |
| **Target macOS + Linux first; defer Windows** | Windows port is Oct 2025, battle-tested in Zed but the youngest platform; it can follow once macOS/Linux are solid |
| **Use `gpui-component` (Longbridge) for dock/markdown/tree** | Covers the majority of needed widgets under Apache-2.0; avoids reinventing what already exists |
| **Build the terminal pane as a thin GPUI wrapper over `alacritty_terminal`** | This is the Zed pattern and has been replicated by external devs; budget 1-2 weeks for the integration |
| **Implement the force-directed KB graph on GPUI canvas primitives** | No ready-made force-directed library; the physics sim is pure Rust and the render layer is a straightforward canvas integration |
| **Accept API churn as an ongoing maintenance cost** | GPUI is pre-1.0 and Zed-centric; allocate periodic "sync with upstream" work into the roadmap |
| **Accept 10+ min fresh build times** | Standard Rust large-dependency cost; use `sccache` + `mold` to keep iteration fast |

### Why not a conditional NO?

The risks above are real but bounded:
- The crate ecosystem (gpui-component, alacritty_terminal integration) covers the
  hard surface area
- Platform support is now genuinely cross-platform (macOS/Linux production, Windows beta)
- The awesome-gpui community demonstrates external usage is viable
- No better GPU-accelerated Rust UI option exists; the alternatives (iced, egui, slint)
  are either lower performance, less expressive, or have their own maturity gaps

### What would flip this to NO?

- If the charm UI needs Windows as a **first-class launch target** (not a follow-on),
  the Oct 2025 maturity level of the Windows backend is a meaningful risk
- If the team cannot tolerate absorbing API churn from upstream; a frozen API is not
  available with GPUI
- If a Tauri-based hybrid (web renderer) option becomes acceptable, that path has
  dramatically better documentation and tooling at the cost of GPU rendering quality

---

## References

- GPUI crates.io: https://crates.io/crates/gpui/versions
- Zed GPUI source: https://github.com/zed-industries/zed/tree/main/crates/gpui
- Awesome GPUI: https://github.com/zed-industries/awesome-gpui
- gpui-component (Longbridge): https://github.com/longbridge/gpui-component
- DeepWiki GPUI architecture: https://deepwiki.com/zed-industries/zed/2.2-ui-framework-(gpui)
- Building a GPUI terminal (zTerm): https://dev.to/zhiwei_ma_0fc08a668c1eb51/building-a-gpu-accelerated-terminal-emulator-with-rust-and-gpui-4103
- Windows porting friction (The Register): https://www.theregister.com/2025/08/22/everything_is_different_on_windows/
- Zed auto-update post-mortem: https://zed.dev/blog/auto-update-post-mortem
- Zed 1.0 announcement: https://zed.dev/blog/zed-1-0
