---
id: charm-session-socket-path-is-in-meta-json-not-run-dir
root: gotchas
type: gotcha
status: current
summary: "The charm daemon socket is NOT at .charm/run/<uuid>/sock as the bridge spec/proposal state; the real path lives in that dir's meta.json `socket` field and points into the OS temp dir (e.g. /var/folders/.../charm-<uuid>.sock on macOS). Detect the session by reading meta.json, not by globbing for a sock file."
created: 2026-06-26
updated: 2026-06-26
---

The Phase 1 bridge spec (`zed-phase-1-bridge-spec.md` 2.2) and the proposal's
"Socket detection" section both say to find the charm daemon socket at
`.charm/run/<uuid>/sock`. **That file does not exist.** Verified against the live
charm session: each `.charm/run/<uuid>/` dir contains `charm.json`,
`charmd.pid`, `logs/`, `meta.json`, and `orchestrator-session.json` -- there is
no `sock` entry.

The real socket path is recorded in `meta.json`'s `socket` field and points
into the OS temp dir, not the run dir. On macOS:

```
/var/folders/jh/.../T/charm-<uuid>.sock
```

`charm.json` carries the same path in `mcpServers.charm.env.CHARM_SOCKET`, which
is the other reliable source.

**Implication for any code that connects to the daemon** (the Zed bridge, tools,
scripts): do not glob for a `sock` file. Read `<run_dir>/<uuid>/meta.json`, take
`socket`, and connect to that. The bridge's `detect_session` does exactly this,
and uses a connect-probe to pick the live session when several run dirs exist
(stale ones from prior sessions remain on disk; their daemons are dead so the
connect fails and they are skipped). Prefer the most-recently-updated
`meta.json` among the ones whose socket actually accepts a connection.

The bridge's own second socket (the inject listener it creates for the deferred
daemon-push path) IS placed in the run dir as `<run_dir>/<uuid>/inject.sock`,
per the spec -- that one the bridge owns and creates, so its location is a
choice, not a discovery problem.
