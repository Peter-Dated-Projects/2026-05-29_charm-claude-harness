#!/usr/bin/env bash
# frieren.sh — unified entry point for the Claude Agent Charm.
#
# Owns the project lifecycle (setup, dev, build, typecheck, test, clean) and
# delegates live runtime operations (init/start/status/stop/attach) to the
# existing ./charm.sh wrapper.
#
# Usage: ./frieren.sh <command>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

SELF="$(basename "$0")"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

need() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "missing dependency: $1" >&2
        exit 2
    }
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_setup() {
    echo "==> First-run setup..."
    need bun
    command -v tmux >/dev/null 2>&1 || echo "    note: tmux not found — required at runtime by 'start'/'attach'"
    echo "==> Installing dependencies (bun install)..."
    bun install
    echo "==> Done. Try: ./$SELF dev   or   ./$SELF start \"your goal\""
}

cmd_dev() {
    # Run a single component in dev mode (TS sources via bun, no compile step).
    need bun
    local component="${2:-console}"
    case "$component" in
        cli)     echo "==> Running CLI (src/cli.ts)...";            exec bun run src/cli.ts "${@:3}" ;;
        daemon)  echo "==> Running daemon (src/daemon/index.ts)..."; exec bun run src/daemon/index.ts "${@:3}" ;;
        mcp)     echo "==> Running MCP server (src/mcp/server.ts)..."; exec bun run src/mcp/server.ts "${@:3}" ;;
        console) echo "==> Running console TUI (src/console/app.tsx)..."; exec bun run src/console/app.tsx "${@:3}" ;;
        *)
            echo "Usage: ./$SELF dev cli|daemon|mcp|console" >&2
            exit 1
            ;;
    esac
}

cmd_build() {
    need bun
    echo "==> Installing dependencies (bun install)..."
    bun install
    local target="${2:-all}"
    case "$target" in
        all)
            echo "==> Building all binaries for host arch -> dist/..."
            bun run build
            ;;
        cli)     echo "==> Building charm-claude -> dist/charm-claude...";        bun run build:cli ;;
        mcp)     echo "==> Building charm-mcp -> dist/charm-mcp..."; bun run build:mcp ;;
        console) echo "==> Building charm-console -> dist/charm-console..."; bun run build:console ;;
        universal)
            # Cross-compile both Mac archs and lipo them into one fat binary each.
            need lipo
            echo "==> Building universal (arm64 + x64) Mac binaries..."
            for spec in \
                "src/cli.ts:charm-claude:" \
                "src/mcp/server.ts:charm-mcp:" \
                "src/console/app.tsx:charm-console:"; do
                local entry name extra
                entry="${spec%%:*}"; spec="${spec#*:}"
                name="${spec%%:*}"; extra="${spec#*:}"
                bun build "$entry" --compile --target=bun-darwin-arm64 --outfile "dist/arm64/$name" $extra
                bun build "$entry" --compile --target=bun-darwin-x64   --outfile "dist/x64/$name"   $extra
            done
            mkdir -p dist/universal
            for name in charm-claude charm-mcp charm-console; do
                lipo -create -output "dist/universal/$name" "dist/arm64/$name" "dist/x64/$name"
            done
            echo "==> Universal binaries in dist/universal/"
            ;;
        *)
            echo "Usage: ./$SELF build all|cli|mcp|console|universal" >&2
            exit 1
            ;;
    esac
}

cmd_typecheck() {
    need bun
    echo "==> Typechecking (tsc --noEmit)..."
    bun run typecheck
}

cmd_test() {
    need bun
    echo "==> Typechecking before tests..."
    bun run typecheck
    echo "==> Running tests (bun test)..."
    bun test "${@:2}"
}

cmd_clean() {
    echo "==> Removing build artifacts..."
    rm -rf dist/
    find . -name "*.log" -not -path "./node_modules/*" -delete 2>/dev/null || true
    find . -name ".DS_Store" -delete 2>/dev/null || true
    echo "    cleaned dist/ and *.log (kept node_modules/ — run 'clean deep' to remove)"
    if [[ "${2:-}" == "deep" ]]; then
        echo "==> Deep clean: removing node_modules/..."
        rm -rf node_modules/
    fi
}

# --- Runtime delegation to ./charm.sh ------------------------------------
# These commands manage a live charm session and forward straight through.

cmd_charm() {
    exec "$ROOT/charm.sh" "${@:2}"
}

cmd_start()  { exec "$ROOT/charm.sh" start  "${@:2}"; }
cmd_status() { exec "$ROOT/charm.sh" status "${@:2}"; }
cmd_attach() { exec "$ROOT/charm.sh" attach "${@:2}"; }
cmd_stop()   { exec "$ROOT/charm.sh" stop   "${@:2}"; }
cmd_init()   { exec "$ROOT/charm.sh" init   "${@:2}"; }

cmd_help() {
    cat <<EOF
Usage: ./$SELF <command>

Project lifecycle:
  setup                     Check deps (bun, tmux) and run 'bun install'
  dev cli|daemon|mcp|console   Run one component from TS source (default: console)
  build all|cli|mcp|console|universal   Compile binaries to dist/ (default: all)
  typecheck                 Run 'tsc --noEmit'
  test [args...]            Typecheck, then 'bun test'
  clean [deep]              Remove dist/ and logs ('deep' also drops node_modules/)

Runtime (delegates to ./charm.sh):
  init [--root PATH]        Initialize a charm workspace
  start "<goal>"            Launch daemon + console for a goal
  status                    Show charm status
  attach                    Attach to the running tmux session
  stop                      Kill daemon + tmux session
  charm <args...>           Pass any other subcommand straight to charm.sh

  help                      Show this message
EOF
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

case "${1:-help}" in
    setup)          cmd_setup "$@" ;;
    dev)            cmd_dev "$@" ;;
    build)          cmd_build "$@" ;;
    typecheck)      cmd_typecheck "$@" ;;
    test)           cmd_test "$@" ;;
    clean)          cmd_clean "$@" ;;
    init)           cmd_init "$@" ;;
    start)          cmd_start "$@" ;;
    status)         cmd_status "$@" ;;
    attach)         cmd_attach "$@" ;;
    stop)           cmd_stop "$@" ;;
    charm)        cmd_charm "$@" ;;
    help|--help|-h) cmd_help ;;
    *)
        echo "Unknown command: $1" >&2
        cmd_help >&2
        exit 1
        ;;
esac
