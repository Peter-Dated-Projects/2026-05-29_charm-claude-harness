---
id: daemon-writes-charm-json-not-meta-json-at-boot
root: gotchas
type: gotcha
status: current
summary: "A daemon started directly (charmd, not via `charm start`) does NOT write meta.json at boot -- only charm.json (with mcpServers.charm.env.CHARM_SOCKET). meta.json appears lazily on set_session_description. So socket discovery for a fork-spawned daemon must fall back to charm.json."
created: 2026-06-26
updated: 2026-06-26
---

`charm start` (cli.ts) writes `meta.json` with the `socket` field BEFORE the
daemon is up, then spawns `charmd`. The bridge's `detect_session` was built
against that: it reads `<run_dir>/<uuid>/meta.json` and takes `socket`.

But the **daemon itself** (`src/daemon/index.ts main()`) does not write
`meta.json` at boot. It writes:
- `charmd.pid`
- `charm.json` (the per-session MCP config) -- and this carries the socket at
  `mcpServers.charm.env.CHARM_SOCKET`

`meta.json` is only written later, by the `set_session_description` RPC handler
(which the main agent calls once it picks a session description), and even then
it falls back to `paths.socket` if no prior meta existed.

Consequence for the Phase 5 fork-side bootstrap (T-058): when the fork starts
the daemon itself (no CLI in the loop), there is no `meta.json` until an agent
runs. A `detect_session` that only reads `meta.json` would never find the
fork-spawned daemon's socket, so the bridge would never connect.

Fix (T-058): `detect_session` now reads the socket from `meta.json` when present
and falls back to `read_charm_json_socket()` (parses
`mcpServers.charm.env.CHARM_SOCKET` out of `charm.json`) otherwise. `charm.json`
exists at boot, so a fork-spawned daemon is discoverable immediately. Recency
tiebreak among multiple live run dirs uses `meta.updated_at` when it exists, else
the newer of the two control-plane files' mtime. This makes detection work
identically for CLI-started and fork-started daemons.

Related: [[charm-session-socket-path-is-in-meta-json-not-run-dir]] (the socket is
in a field, not a `sock` file) -- this note adds that for a fork-spawned daemon
the field lives in `charm.json`, not `meta.json`.
