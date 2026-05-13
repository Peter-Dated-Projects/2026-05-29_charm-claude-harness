#!/usr/bin/env bash
# Wrapper for the Claude Agent Harness — runs the TS sources via bun without
# requiring a global install. Forwards all subcommands to src/cli.ts.
#
# Usage:
#   ./harness.sh init [--root PATH]
#   ./harness.sh start "your goal here"
#   ./harness.sh status
#   ./harness.sh approve <gate_id> [--reject]
#   ./harness.sh attach
#   ./harness.sh stop          (kills daemon + tmux session)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="${HARNESS_SESSION:-harness}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 2; }
}

need bun
need tmux

# Make `harness-mcp` resolvable for spawned claude processes without a global install.
if ! command -v harness-mcp >/dev/null 2>&1; then
  export HARNESS_MCP_BIN="${HARNESS_MCP_BIN:-bun run ${REPO_DIR}/src/mcp/server.ts}"
fi

case "${1:-}" in
  "" | -h | --help | help)
    sed -n '4,12p' "$0"
    exit 0
    ;;
  stop)
    ROOT="${2:-$PWD}"
    PIDFILE="${ROOT}/.harness/harnessd.pid"
    if [[ -f "$PIDFILE" ]]; then
      PID="$(cat "$PIDFILE")"
      kill "$PID" 2>/dev/null && echo "killed harnessd pid=$PID" || true
      rm -f "$PIDFILE"
    fi
    tmux kill-session -t "$SESSION" 2>/dev/null && echo "killed tmux session '$SESSION'" || true
    ;;
  *)
    exec bun run "${REPO_DIR}/src/cli.ts" "$@"
    ;;
esac
