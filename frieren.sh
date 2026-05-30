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

# charm spawns `claude` processes to run its agents, so the Claude Code CLI is a
# hard dependency. Fail loudly with install guidance rather than producing a
# binary whose agents silently can't launch.
need_claude() {
    command -v claude >/dev/null 2>&1 || {
        cat >&2 <<'MSG'
missing dependency: claude (the Claude Code CLI)
    charm launches `claude` processes to run its agents, so it must be on PATH.
    Install it, then re-run this command:
        npm install -g @anthropic-ai/claude-code
    Other install options: https://claude.com/claude-code
MSG
        exit 2
    }
}

# bun's `--compile` writes a ~60MB temp file (.<hash>.bun-build) into the
# current directory and orphans it even on a successful build. The package.json
# build scripts run from dist/ so these never touch the repo root; this sweep
# deletes whatever's left (incl. the universal target's root/dist temps and any
# orphans from an interrupted build). Wired as a build-time trap below.
sweep_bun_temp() {
    find "$ROOT" -path "$ROOT/node_modules" -prune -o \
        -name '*.bun-build' -type f -print0 2>/dev/null \
        | xargs -0 rm -f 2>/dev/null || true
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
    need_claude
    # Sweep bun's orphaned compile temps on the way out — even on failure/Ctrl-C.
    trap sweep_bun_temp EXIT INT TERM
    echo "==> Installing dependencies (bun install)..."
    bun install
    local target="${2:-all}"
    case "$target" in
        all)
            echo "==> Building all binaries for host arch -> dist/..."
            bun run build
            ;;
        cli)     echo "==> Building charm-claude -> dist/charm-claude...";        bun run build:cli ;;
        daemon)  echo "==> Building charmd -> dist/charmd...";       bun run build:daemon ;;
        mcp)     echo "==> Building charm-mcp -> dist/charm-mcp..."; bun run build:mcp ;;
        console) echo "==> Building charm-console -> dist/charm-console..."; bun run build:console ;;
        universal)
            # Cross-compile both Mac archs and lipo them into one fat binary each.
            need lipo
            echo "==> Building universal (arm64 + x64) Mac binaries..."
            for spec in \
                "src/cli.ts:charm-claude:" \
                "src/daemon/index.ts:charmd:" \
                "src/mcp/server.ts:charm-mcp:" \
                "src/console/app.tsx:charm-console:" \
                "src/console/graph.ts:charm-graph:"; do
                local entry name extra
                entry="${spec%%:*}"; spec="${spec#*:}"
                name="${spec%%:*}"; extra="${spec#*:}"
                bun build "$entry" --compile --target=bun-darwin-arm64 --outfile "dist/arm64/$name" $extra
                bun build "$entry" --compile --target=bun-darwin-x64   --outfile "dist/x64/$name"   $extra
            done
            mkdir -p dist/universal
            for name in charm-claude charmd charm-mcp charm-console charm-graph; do
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
    sweep_bun_temp
    find . -name "*.log" -not -path "./node_modules/*" -delete 2>/dev/null || true
    find . -name ".DS_Store" -delete 2>/dev/null || true
    echo "    cleaned dist/ and *.log (kept node_modules/ — run 'clean deep' to remove)"
    if [[ "${2:-}" == "deep" ]]; then
        echo "==> Deep clean: removing node_modules/..."
        rm -rf node_modules/
    fi
}

# Names of the binaries installed onto PATH. `charm` is the CLI (built from
# src/cli.ts as charm-claude); the others are spawned by name at runtime —
# charmd/charm-console by the CLI relative to its own path (resolveChild in
# src/cli.ts), charm-mcp by every claude process via .charm/charm.json, and
# charm-graph by the daemon relative to its own path (graphLaunchCmd in
# src/daemon/index.ts). They must all sit in the same directory.
INSTALL_BINS=(charmd charm-console charm-mcp charm-graph)   # plus `charm` (from charm-claude)

cmd_install() {
    # Build standalone binaries and install them onto PATH so `charm` works
    # anywhere — no repo, no bun, no node_modules needed at runtime.
    #
    #   <prefix>/charm                       CLI         (from dist/charm-claude)
    #   <prefix>/charmd                       daemon
    #   <prefix>/charm-console                TUI
    #   <prefix>/charm-mcp                    MCP shim
    #   <prefix>/../share/charm/templates/    prompt + kb templates (read at init/start)
    local prefix="${HOME}/.local/bin"
    if [[ "${2:-}" == "--prefix" ]]; then
        prefix="${3:?--prefix requires a directory}"
    fi

    # Build host-arch binaries first (also runs the bun + claude dependency checks).
    cmd_build build all

    mkdir -p "$prefix"
    local bindir; bindir="$(cd "$prefix" && pwd)"
    # Templates live a level above the bin dir, matching the lookup the binary
    # does at runtime: dirname(execPath)/../share/charm/templates.
    local sharedir; sharedir="$(cd "$bindir/.." && pwd)/share/charm"

    echo "==> Installing binaries to $bindir ..."
    install -m 0755 "dist/charm-claude" "$bindir/charm"
    local b
    for b in "${INSTALL_BINS[@]}"; do
        install -m 0755 "dist/$b" "$bindir/$b"
    done

    echo "==> Installing templates to $sharedir/templates ..."
    mkdir -p "$sharedir"
    rm -rf "$sharedir/templates"
    cp -R "$ROOT/templates" "$sharedir/templates"

    echo "==> Installed: charm, ${INSTALL_BINS[*]} -> $bindir"
    case ":$PATH:" in
        *":$bindir:"*)
            echo "    $bindir is on PATH. Run 'charm --help' to verify, then 'charm start \"your goal\"'."
            ;;
        *)
            echo "    NOTE: $bindir is not on your PATH. Add this to your shell profile:"
            echo "        export PATH=\"$bindir:\$PATH\""
            ;;
    esac
}

cmd_uninstall() {
    local prefix="${HOME}/.local/bin"
    if [[ "${2:-}" == "--prefix" ]]; then
        prefix="${3:?--prefix requires a directory}"
    fi
    local removed=0 f
    for f in charm "${INSTALL_BINS[@]}"; do
        if [[ -e "$prefix/$f" ]]; then
            rm -f "$prefix/$f"
            echo "==> Removed $prefix/$f"
            removed=1
        fi
    done
    # Remove the installed templates (dirname(prefix)/share/charm), if present.
    local sharedir="$prefix/../share/charm"
    if [[ -d "$sharedir" ]]; then
        rm -rf "$sharedir"
        echo "==> Removed $(cd "$(dirname "$sharedir")" && pwd)/$(basename "$sharedir")"
        removed=1
    fi
    [[ "$removed" == 0 ]] && echo "    Nothing to remove under $prefix"
    return 0
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
  build all|cli|daemon|mcp|console|universal   Compile binaries to dist/ (default: all)
  typecheck                 Run 'tsc --noEmit'
  test [args...]            Typecheck, then 'bun test'
  clean [deep]              Remove dist/ and logs ('deep' also drops node_modules/)
  install [--prefix DIR]    Build, then install charm + siblings to PATH (default: ~/.local/bin)
  uninstall [--prefix DIR]  Remove the installed charm binaries and templates

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
    install)        cmd_install "$@" ;;
    uninstall)      cmd_uninstall "$@" ;;
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
