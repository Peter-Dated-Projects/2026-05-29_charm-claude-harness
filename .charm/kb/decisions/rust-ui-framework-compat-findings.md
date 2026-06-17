---
id: rust-ui-framework-compat-findings
root: decisions
type: decision
status: current
summary: "For charm's Rust UI migration, the terminal-in-tmux vs windowed-app choice is the only hard fork; tmux control and Unix socket RPC are non-blockers across all frameworks."
created: 2026-06-16
updated: 2026-06-16
---

## Key finding

Every common assumption about "blockers" for Rust GUI frameworks in charm's context
turns out to be wrong except one.

**Non-blockers (any framework handles these):**
- tmux subprocess management: `std::process::Command` works in every Rust process
  regardless of UI library. No GUI framework creates a sandbox that restricts
  subprocess execution.
- Unix socket RPC (daemon side): charmd is a separate binary; the UI framework is
  irrelevant.
- SQLite, file I/O, process spawning, frontmatter parsing: all pure Rust stdlib/crates,
  independent of UI choice.
- Unix socket RPC (UI-to-daemon): Pure-Rust UI frameworks (GPUI, Slint, Iced, egui)
  can open sockets directly. WebView-backed frameworks (Tauri, Dioxus-desktop) need
  an IPC bridge layer but are not blocked.

**The one real fork:**
Whether charm's console stays in a tmux pane (terminal UI) or moves to a separate OS
window (GUI). This is a UX architecture decision, not a technical limitation:

- Terminal-in-tmux: only ratatui (directly) or dioxus-tui (less mature wrapper) can
  do this. None of Tauri, GPUI, Slint, Iced, or egui can render into a terminal pane.
- Windowed GUI: all six frameworks work, with varying tradeoffs on ecosystem richness,
  OTA update support, and CLI dispatch ergonomics.

**Why:** Tauri and friends are windowed-app frameworks by design. They open an OS
window on startup. There is no mode where they render into a pre-existing terminal.

**How to apply:** Before starting any Rust UI framework work, decide the terminal-vs-GUI
question first. That decision gates the framework shortlist (ratatui vs. everything
else). Do not spend time evaluating Tauri/GPUI/Iced if the requirement is to keep the
TUI in tmux.

See PROP-feature-compatibility-matrix.md for the full per-feature breakdown.
