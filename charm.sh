#!/usr/bin/env bash
# Wrapper for the Claude Agent Charm — runs the TS sources via bun without
# requiring a global install. Forwards all subcommands to src/cli.ts.
#
# Usage:
#   ./charm.sh init [--root PATH]
#   ./charm.sh start "your goal here"     (prompts for research vs development mode)
#   ./charm.sh start --research "goal"     (Sonnet fleet) | --development / --dev (Opus fleet)
#   ./charm.sh status
#   ./charm.sh approve <gate_id> [--reject]
#   ./charm.sh attach
#   ./charm.sh stop          (kills daemon + tmux session)

set -euo pipefail

# Resolve REPO_DIR through any symlink chain so the wrapper works when invoked
# via a symlink on PATH (e.g. ~/.local/bin/charm -> this file). macOS ships BSD
# readlink without -f, so walk the chain manually.
SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
REPO_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
SESSION="${CHARM_SESSION:-charm}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 2; }
}

need bun
need tmux

# Pull the tmux session name out of an arg list (-s/--session NAME or
# --session=NAME), defaulting to "charm". Lets the wrapper attach to the right
# session after bun finishes setting it up.
parse_session() {
  local prev="" a session="charm"
  for a in "$@"; do
    case "$prev" in -s|--session) session="$a" ;; esac
    case "$a" in --session=*) session="${a#*=}" ;; esac
    prev="$a"
  done
  printf '%s' "$session"
}

# Make `charm-mcp` resolvable for spawned claude processes without a global install.
if ! command -v charm-mcp >/dev/null 2>&1; then
  export CHARM_MCP_BIN="${CHARM_MCP_BIN:-bun run ${REPO_DIR}/src/mcp/server.ts}"
fi

case "${1:-}" in
  "" | -h | --help | help)
    sed -n '4,13p' "$0"
    exit 0
    ;;
  stop)
    ROOT="${2:-$PWD}"
    PIDFILE="${ROOT}/.charm/charmd.pid"
    # Close standalone graph viewers first, by tracked PID. Done before killing
    # the daemon so they're reaped even if the daemon is already gone -- and so
    # it still works if viewers ever run outside the tmux session.
    VIEWERS="${ROOT}/.charm/graph-viewers.pids"
    if [[ -f "$VIEWERS" ]]; then
      while IFS= read -r vpid; do
        [[ -n "$vpid" ]] || continue
        kill "$vpid" 2>/dev/null && echo "closed graph viewer pid=$vpid" || true
      done < "$VIEWERS"
      rm -f "$VIEWERS"
    fi
    if [[ -f "$PIDFILE" ]]; then
      PID="$(cat "$PIDFILE")"
      kill "$PID" 2>/dev/null && echo "killed charmd pid=$PID" || true
      rm -f "$PIDFILE"
    fi
    tmux kill-session -t "$SESSION" 2>/dev/null && echo "killed tmux session '$SESSION'" || true
    ;;
  start)
    shift
    SESSION_NAME="$(parse_session "$@")"
    NO_ATTACH=0
    for a in "$@"; do [[ "$a" == "--no-attach" ]] && NO_ATTACH=1; done
    # bun brings up the daemon, tmux session, and panes, then exits WITHOUT
    # attaching (we force --no-attach). The wrapper owns the terminal handoff:
    # attaching from inside bun spawns the tmux client as an async child while
    # bun lingers as its parent, so the client never cleanly owns the terminal
    # and the shell tears it down the instant the UI finishes drawing -- tmux
    # then prints "[server exited unexpectedly]" even though the session is
    # alive. exec'ing tmux here makes the client the shell's foreground
    # process, exactly like a hand-typed `tmux attach`.
    bun run "${REPO_DIR}/src/cli.ts" start "$@" --no-attach || exit $?
    [[ "$NO_ATTACH" -eq 1 ]] && exit 0
    exec tmux attach-session -t "$SESSION_NAME"
    ;;
  attach)
    shift
    SESSION_NAME="$(parse_session "$@")"
    exec tmux attach-session -t "$SESSION_NAME"
    ;;
  *)
    exec bun run "${REPO_DIR}/src/cli.ts" "$@"
    ;;
esac
