#!/usr/bin/env bash
# Wrapper for the Claude Agent Charm — runs the TS sources via bun without
# requiring a global install. Forwards all subcommands to src/cli.ts.
#
# Usage:
#   ./charm.sh init [--root PATH]
#   ./charm.sh start "your goal here"
#   ./charm.sh status
#   ./charm.sh approve <gate_id> [--reject]
#   ./charm.sh attach
#   ./charm.sh stop          (kills daemon + tmux session)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="${CHARM_SESSION:-charm}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 2; }
}

need bun
need tmux

# Make `charm-mcp` resolvable for spawned claude processes without a global install.
if ! command -v charm-mcp >/dev/null 2>&1; then
  export CHARM_MCP_BIN="${CHARM_MCP_BIN:-bun run ${REPO_DIR}/src/mcp/server.ts}"
fi

case "${1:-}" in
  "" | -h | --help | help)
    sed -n '4,12p' "$0"
    exit 0
    ;;
  stop)
    ROOT="${2:-$PWD}"
    PIDFILE="${ROOT}/.charm/charmd.pid"
    if [[ -f "$PIDFILE" ]]; then
      PID="$(cat "$PIDFILE")"
      kill "$PID" 2>/dev/null && echo "killed charmd pid=$PID" || true
      rm -f "$PIDFILE"
    fi
    tmux kill-session -t "$SESSION" 2>/dev/null && echo "killed tmux session '$SESSION'" || true
    ;;
  *)
    exec bun run "${REPO_DIR}/src/cli.ts" "$@"
    ;;
esac
