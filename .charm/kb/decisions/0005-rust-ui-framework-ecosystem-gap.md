---
id: rust-ui-framework-ecosystem-gap
root: decisions
type: decision
status: current
summary: "For charm's native desktop UI, Tauri (WebView + TypeScript frontend) wins over pure-Rust frameworks because the charm-specific widget needs (terminal emulation, diff views, force-directed graph) have no ready-made crates in native Rust frameworks but are solved by the web ecosystem."
created: 2026-06-16
updated: 2026-06-16
related: prop-ui-revamp-feasibility
---

# Rust UI Framework: Ecosystem Gap is the Deciding Factor

Source research: `.charm/proposals/PROP-rust-ui-framework-comparison.md` (T-013)

## Finding

Pure-Rust GPU frameworks (Iced, Slint, GPUI, Floem) score well on performance and
startup time but all require building charm's core UI widgets from scratch:

- Terminal emulation: no ready-made crate. Tauri gets xterm.js.
- Diff view: no ready-made crate. Tauri gets react-diff-viewer or monaco-diff.
- Force-directed graph: limited (egui_graphs is basic). Tauri gets D3/vis-network.
- Markdown: egui_commonmark is usable; Iced/Slint/GPUI require DIY.

The performance headroom of GPU-native rendering is real but irrelevant for a
developer tool that renders at human-readable frame rates. Tauri's WebView startup
(400-800ms) is acceptable for a persistent desktop app.

## Practical sequence

1. Close Ink gaps first (KB browser, proposals tab) — TypeScript only, no new dep.
2. egui prototype (~2-3 weeks) if validating native-app value quickly.
3. Tauri (~5-6 weeks) for a polished desktop replacement worth shipping.
4. GPUI only if charm becomes a product with a dedicated Rust engineer and the team
   has already validated UI requirements are stable.

## Why: avoid investing in widget-building

GPUI is the highest-performance option but the Zed team spent months building the
widgets charm would need. Replicating that work for a tool at charm's current stage
would trade core-product velocity for UI infrastructure. Tauri lets the team stay
in TypeScript for the UI layer.
