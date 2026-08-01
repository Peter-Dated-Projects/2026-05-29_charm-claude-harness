---
name: charm-frieren-setup
description: Create or extend a project's frieren.sh — the single bash entry point for setup, running services, stop, status, logs, tests. Use when a repo needs a unified CLI or an existing frieren.sh needs a new command.
---

# charm-frieren-setup

One script at the repo root, `frieren.sh`, is the only interface to a project's
lifecycle. `./frieren.sh help` is the documentation.

## When to use

- A new repo needs a unified CLI entry point.
- A repo has several processes (db, api, worker, frontend) and no single way to start them.
- An existing `frieren.sh` needs a new command, or its commands have drifted from reality.

## The service model

Pick one and be consistent — mixing them is what makes these scripts confusing.

**Detached (default).** `run` starts services in the background and returns;
`stop` is the only teardown. Pids and logs go to a gitignored state dir. Choose
this unless the user asks otherwise: it leaves the terminal free, survives
closing it, and makes `status`/`logs` meaningful.

**Foreground.** `run` blocks, holds every child, and tears them down on Ctrl-C
via a trap. Simpler, but the terminal is captive and there is nothing to query.

Detached costs four extra commands — `stop`, `status`, `logs`, plus pid tracking
— and they are not optional. Detached services with no way to list or stop them
is the worst of both.

## Skeleton

```bash
#!/usr/bin/env bash
# frieren.sh — <project> entrypoint
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Every path and port overridable, defaults inline — no separate config file.
API_DIR="${API_DIR:-$ROOT/apps/api}"
APP_PORT="${APP_PORT:-8000}"
STATE_DIR="${STATE_DIR:-$ROOT/.frieren}"   # gitignore this
PID_DIR="$STATE_DIR/run"
LOG_DIR="$STATE_DIR/logs"

SERVICES="api worker web"                   # start order

svc_dir() { case "$1" in web) echo "$WEB_DIR" ;; *) echo "$API_DIR" ;; esac; }
svc_cmd() {
    case "$1" in
        api)    echo "uv run uvicorn app.main:app --reload --port $APP_PORT" ;;
        worker) echo "uv run python -m worker" ;;
        web)    echo "pnpm dev" ;;
    esac
}

# Always returns 0 — a non-zero return trips `set -e` at the assignment site.
svc_pid() {
    local file="$PID_DIR/$1.pid" pid
    if [ -f "$file" ]; then
        pid="$(cat "$file" 2>/dev/null || true)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; fi
    fi
    return 0
}

svc_start() {
    local name="$1" pid
    pid="$(svc_pid "$name")"
    if [ -n "$pid" ]; then echo "==> $name already running (pid $pid)"; return 0; fi
    mkdir -p "$PID_DIR" "$LOG_DIR"
    # $cmd unquoted on purpose: it carries its own splitting.
    # nohup so closing the terminal doesn't take the stack down.
    ( cd "$(svc_dir "$name")" && exec nohup env PYTHONUNBUFFERED=1 $(svc_cmd "$name") ) \
        >"$LOG_DIR/$name.log" 2>&1 &
    echo $! >"$PID_DIR/$name.pid"
    disown 2>/dev/null || true
    echo "==> $name started (pid $!) — .frieren/logs/$name.log"
}

case "${1:-help}" in
    run)            shift; cmd_run "$@" ;;      # NOTE the shift
    stop)           cmd_stop ;;
    status)         cmd_status ;;
    logs)           shift; cmd_logs "$@" ;;
    ...
esac
```

## The five things that bite

### 1. Subcommand arg indexing

The dispatcher passes `"$@"`, which still contains the command word. A handler
reading `${2:-help}` works when called from dispatch and silently misbehaves
when called internally as `cmd_database up` — `$2` is unset, so it falls through
to the usage branch and does nothing. The failure is quiet: `up` prints its
usage text and never starts the database, and the whole thing only looks fine
because the service was already running from an earlier session.

**Shift in the dispatcher, read `$1` in the handler.** Then internal callers and
the CLI agree.

```bash
database)  shift; cmd_database "$@" ;;
...
cmd_database() { local subcmd="${1:-help}"; ... }
```

### 2. Killing a shim doesn't kill the server

`uv run`, `pnpm`, `npm run` are wrappers that spawn the real process. Signalling
the pid you launched orphans uvicorn's reloader or next's server, and the port
stays bound. Walk the tree, leaves first, so the real process gets SIGTERM and
can shut down cleanly:

```bash
kill_tree() {
    local sig="$1" pid="$2" child
    for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$sig" "$child"; done
    kill "$sig" "$pid" 2>/dev/null || true
}
```

Then TERM everything, drain with a bounded poll, and only then KILL. A worker
that finishes its in-flight job on SIGTERM needs that grace — killing it early
manufactures exactly the stale state its recovery path exists to clean up.

### 3. Silently ignored arguments

`./frieren.sh run dev` when `run` takes no arguments runs `run` and drops `dev`
on the floor. Reject extras instead:

```bash
reject_extra_args() {
    if [ "$#" -gt 1 ]; then
        echo "==> '$1' takes no arguments (got: ${*:2})" >&2
        exit 1
    fi
}
```

Better still, if a target is plausible, make it real: a `run` that dispatches to
`dev|api|worker|web` and defaults to the whole stack beats a `run` that ignores
what follows it.

### 4. macOS ships bash 3.2

`/usr/bin/env bash` on a stock Mac is 3.2, so avoid:

- `wait -n` — poll `kill -0` in a loop instead.
- Associative arrays — use `case` lookups keyed by service name.
- `${arr[@]}` on an empty array under `set -u` — keep pid lists as a
  space-separated string.
- `sed -u` — GNU only. For prefixing interleaved output use
  `awk -v tag=x '{ print "[" tag "] " $0; fflush() }'`.

Also, under `set -e`, `cmd && var=1` as a statement exits the script when `cmd`
is false. Write `if cmd; then var=1; fi`.

### 5. Ports and credentials

Guard a port before binding it, and say who holds it:

```bash
port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
```

Never hardcode a published container port — another project will already own
5432. Parameterize it in compose (`"127.0.0.1:${PG_HOST_PORT:-5432}:5432"`) and
override in a gitignored root `.env`. Container-to-container traffic is
unaffected; only the host mapping moves.

Services that raise at startup without credentials (a hosting worker needing an
API token) must be gated, not started blindly. Skip with a note when running the
whole stack; fail loudly with the missing variable names when asked for
directly.

## Command set

| Command | Does |
|---|---|
| `run [target]` | Start detached; bare `run` = everything, otherwise one app by name |
| `stop` | Every host service and every container. The only teardown |
| `status` | Which services are running, with pids, plus `docker compose ps` |
| `logs [service]` | `tail -f` the log files; all of them if omitted |
| `setup` | First run: `.env` from example, install deps, db up, migrate |
| `test` / `lint` / `clean` | Pass extra args through to the underlying tool |
| `database up\|down\|status\|logs\|shell` | Infra management |
| `migrate` / `revision "msg"` | Schema |
| `help` | The documentation |

Prerequisites belong to whoever needs them: `run api` should bring up the
database and migrate, so starting one app behaves the same as starting it inside
the full stack. Don't make the user remember the order.

## Rules

1. `set -euo pipefail`, establish `$ROOT`, `cd` to it — every command works from any directory.
2. Idempotent. Re-running a started service says so and leaves it alone.
3. Every path and port overridable by env var, defaults inline.
4. `help` lists exactly what exists. A stale help line is worse than none.
5. One command, one purpose. Aliases are fine when a name is already in the docs — say so in `help`.
6. Errors surface. `|| true` only in cleanup.
7. `chmod +x frieren.sh`, and gitignore the state dir.

## Verify before claiming it works

Shell scripts fail in ways that only show up at runtime. Actually run them:

- `bash -n frieren.sh` for syntax.
- Cold start: stop everything first, then `run` — a script that only works
  against already-running infra is the #1 bug here (see #1 above).
- Probe each service over HTTP, don't just check the process exists.
- `stop`, then confirm no survivors (`pgrep`) and every port freed (`lsof`).
- `stop` twice — the second must be a clean no-op.
- Kill one service and confirm `status` reports it as stopped.

## Philosophy

Each command captures institutional memory — the exact flags for the tricky
Docker setup, the right start order, the cleanup everyone forgets. The interface
stays stable while the implementation changes underneath.
