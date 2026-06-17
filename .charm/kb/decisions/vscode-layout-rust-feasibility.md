---
id: vscode-layout-rust-feasibility
root: decisions
type: decision
status: current
summary: "egui+egui_dock is the fastest path to VSCode-style layout in Rust (prototype-ready); GPUI is production-grade but effectively internal to Zed; Tauri+webview is the easiest full-featured option; iced lacks too many built-in widgets."
created: 2026-06-16
updated: 2026-06-16
---

# VSCode-style layout feasibility in Rust GUI frameworks

Source proposal: `.charm/proposals/PROP-vscode-layout-feasibility.md`

## Summary

Five frameworks evaluated against charm's eight VSCode UI patterns (activity bar, side
panel, tabbed editor, bottom panel, status bar, command palette, diff view, inline
terminal).

| Framework | VSCode layout completeness | Practical effort |
|---|---|---|
| GPUI (Zed) | Full — all patterns proven in production | Very high; API not designed for external use |
| Floem (Lapce) | Partial — most patterns achievable, tabs/terminal need custom work | Medium-high; young but third-party-friendly |
| iced | Low — pane_grid is solid but tabs/activity bar/terminal all missing | High; too much to build from scratch |
| egui + egui_dock | Good — dock/tabs/panels built-in; command palette/terminal as small custom widgets | Low-medium; fastest prototype path |
| Tauri + web frontend | Full — web ecosystem has every pattern as mature libraries | Low; UI is JS/TS, Rust is backend only |

## Key decisions recorded

- **egui_dock** is the only third-party Rust crate that delivers a complete dock/tab/panel
  system (VS Code-style) without vendoring a production editor.
- **Inline terminal** is the largest shared effort regardless of framework: `alacritty_terminal`
  crate handles the model; the rendering widget is ~1,000-2,000 lines per framework. `egui-term`
  (community crate) and Zed/Lapce source provide reference implementations.
- **alacritty_terminal** is the standard library for real ANSI terminal emulation in Rust GUI apps.
  All three frameworks that have terminal support (GPUI, Floem, egui) use it.
- **Recommendation sequence:** egui+egui_dock for a prototype; GPUI if charm targets
  Zed-quality native feel; Tauri if distributing to non-terminal users is the priority.
- iced was eliminated: Elm architecture is fine, but the missing high-level widgets
  (tabs, activity bar, command palette, diff view, terminal) make it the highest-effort path
  for no offsetting benefit over egui.

## Why this matters for the Rust rewrite path

[[prop-ui-revamp-feasibility]] assessed Track B (Electron/Tauri) at ~17-25 days. The Tauri
path for VSCode-style layout specifically is much faster than the Electron estimate because
the web ecosystem has solved every pattern charm needs. The Rust rewrite proposal
([[prop-rust-rewrite]]) uses Ratatui for the TUI console, not a desktop GUI — these are
separate concerns.
