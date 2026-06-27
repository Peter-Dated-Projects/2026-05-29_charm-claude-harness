---
id: agentrecord-union-breaks-test-helper-literals-not-binary-build
root: gotchas
type: gotcha
status: current
summary: "When integrating the Zed phase branches, unioning new AgentRecord fields (phase-4 spawn spec) compiles the zed binary green but breaks lib-TEST struct literals in OTHER phase crates (charm_canvas), so `cargo build -p zed` passing does NOT mean `cargo test` passes."
created: 2026-06-26
updated: 2026-06-26
---

During the phase-2/3/4/6 integration merge (T-057), phase-4 added four fields to
`charm::AgentRecord` (`command: Option<String>`, `args: Vec<String>`,
`env: HashMap<String,String>`, `cwd: Option<String>`, all `#[serde(default)]`).
Git auto-merged `charm_bridge.rs` cleanly across all three merges and phase-4's
own test-helper literals already carried the fields, so `cargo build -p zed` went
green on the first try.

The trap: a DIFFERENT phase crate (phase-3's `charm_canvas`) has its own
`#[cfg(test)]` helper that constructs `AgentRecord` with a struct literal
(`crates/charm_canvas/src/model.rs`, the `fn agent(...)` helper). That literal is
only compiled under `cargo test`, not under the binary build, so it failed E0063
("missing fields `args`, `command`, `cwd` and 1 other field") only when the test
gate ran -- after the build gate had already reported success.

Takeaways for any integration that unions struct fields across branches:
- A green `cargo build -p <bin>` is NOT sufficient -- test-only struct literals in
  sibling crates won't compile until you also run `cargo test`. Always run both
  gates.
- After unioning fields onto a shared struct, grep every merged crate (not just
  the one that owns the struct) for `<StructName> {` literals, including
  `#[cfg(test)]` modules, and add the new fields.
- Fix used here: `command: None, args: Vec::new(), env: Default::default(),
  cwd: None` (matches the phase-4 daemon-spawn helper convention).
