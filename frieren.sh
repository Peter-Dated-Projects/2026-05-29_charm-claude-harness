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

    # Kill every running charm process FIRST. Overwriting the binaries while old
    # daemons/agents are live leaves them running stale code against the new
    # on-disk binary — the version-skew that produces crash/restart churn and
    # wedged sessions. Tear it all down before we touch anything on disk. Called
    # with no args so it performs a real kill (not a dry run).
    echo "==> Killing any running charm processes before install..."
    cmd_kill

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

# Panic button: kill every charm process on this machine, across ALL sessions
# and directories. Unlike `stop` (graceful, one session by name), this is the
# sledgehammer for a wedged daemon or orphaned agents — it does not need a
# session name and does not care which directory you are in.
#
# What it targets:
#   - tmux sessions named charm / charm-*
#   - the charm binaries: charmd, charm, charm-mcp, charm-console, charm-graph
#   - dev-mode equivalents run from source via `bun run src/...`
#   - charm-spawned `claude` agents — identified by the `.charm/charm.json`
#     mcp-config in their argv, so your OTHER (non-charm) claude sessions,
#     including the one you may be reading this from, are left untouched.
# It then sweeps stale per-root pidfiles and tmpdir sockets so the next `start`
# is not blocked by a leftover "refusing to start" pidfile.
#
# Usage: ./frieren.sh kill [--dry-run|-n]
# Print the PIDs of every charm-related process, one per line, excluding the
# pipe-separated PID pattern in $1 (this script + its parent, so it can't kill
# itself). Matching is by argv via pgrep, which is reliable on macOS where
# reading another process's *environment* is restricted: the five charm
# binaries by exact name, charm-spawned `claude` agents by their
# `.charm/charm.json` mcp-config (so unrelated claude sessions are spared), and
# the `bun run src/...` dev-mode equivalents.
_charm_pids() {
    local exclude="$1"
    {
        pgrep -x charmd 2>/dev/null || true
        pgrep -x charm 2>/dev/null || true
        pgrep -x charm-mcp 2>/dev/null || true
        pgrep -x charm-console 2>/dev/null || true
        pgrep -x charm-graph 2>/dev/null || true
        pgrep -f '/\.charm/charm\.json' 2>/dev/null || true
        pgrep -f 'bun .*src/(daemon/index|mcp/server|cli)\.ts' 2>/dev/null || true
        pgrep -f 'bun .*src/console/(app\.tsx|graph\.ts)' 2>/dev/null || true
    } | sort -un | grep -vxE "$exclude" || true
}

cmd_kill() {
    local dry=0
    case "${2:-}" in --dry-run | -n) dry=1 ;; esac
    local self=$$ parent=$PPID
    local excl="${self}|${parent}"
    echo "==> Charm panic kill$([[ $dry == 1 ]] && echo ' (dry run — nothing will be killed)')..."

    # 1. tmux sessions named charm / charm-*. Killing the session SIGHUPs its
    #    panes (the interactive agents); the explicit process sweep below reaps
    #    anything that detached or survived.
    if command -v tmux >/dev/null 2>&1; then
        local s
        while IFS= read -r s; do
            [[ -z "$s" ]] && continue
            case "$s" in
                charm | charm-*)
                    if [[ $dry == 1 ]]; then
                        echo "    [dry] tmux kill-session -t $s"
                    else
                        tmux kill-session -t "$s" 2>/dev/null \
                            && echo "    killed tmux session: $s" || true
                    fi
                    ;;
            esac
        done < <(tmux ls -F '#{session_name}' 2>/dev/null || true)
    fi

    # 2. Capture the --root of every live daemon BEFORE killing, so we can clean
    #    its pidfile afterward (a stale pidfile makes the next start refuse).
    local roots
    roots="$(ps -axo command= 2>/dev/null \
        | grep -E '(^|/)charmd .*--root' \
        | sed -E 's/.*--root[ =]+([^ ]+).*/\1/' \
        | sort -u || true)"

    # 3. Kill every charm process. We loop until a re-scan comes back empty,
    #    because tearing down the daemon or a tmux pane can leave a newly
    #    orphaned child (e.g. a charm-mcp whose parent agent just died) that
    #    wasn't in the first snapshot. Each round: SIGTERM, wait, SIGKILL
    #    survivors, then re-scan. After the rounds we verify and report anything
    #    that refused to die, so completeness is provable rather than assumed.
    local pids
    pids="$(_charm_pids "$excl")"

    if [[ -z "$pids" ]]; then
        echo "    no charm processes found"
    elif [[ $dry == 1 ]]; then
        echo "    charm PIDs: $(echo "$pids" | tr '\n' ' ')"
        echo "    [dry] would SIGTERM, wait, SIGKILL survivors, and repeat until a re-scan is clean"
        # shellcheck disable=SC2046
        ps -o pid=,command= -p $(echo "$pids" | tr '\n' ' ') 2>/dev/null \
            | sed 's/^/        /' || true
    else
        local round p alive
        for round in 1 2 3; do
            [[ -z "$pids" ]] && break
            echo "    round $round: SIGTERM $(echo "$pids" | tr '\n' ' ')"
            # shellcheck disable=SC2086
            kill -TERM $pids 2>/dev/null || true
            sleep 1
            alive=""
            for p in $pids; do
                kill -0 "$p" 2>/dev/null && alive="$alive $p"
            done
            if [[ -n "$alive" ]]; then
                # shellcheck disable=SC2086
                kill -KILL $alive 2>/dev/null || true
                echo "    SIGKILL survivors:$alive"
            fi
            pids="$(_charm_pids "$excl")"
        done
        if [[ -n "$pids" ]]; then
            echo "    WARNING: charm processes survived all rounds: $(echo "$pids" | tr '\n' ' ')"
            # shellcheck disable=SC2046
            ps -o pid=,command= -p $(echo "$pids" | tr '\n' ' ') 2>/dev/null \
                | sed 's/^/        /' || true
        else
            echo "    all charm processes ended"
        fi
    fi

    # 4. Sweep leftovers: per-root pidfiles + viewer pidlists, and the hashed
    #    tmpdir sockets. Stale pidfiles are what make a fresh start refuse.
    local r
    for r in $roots; do
        [[ -z "$r" ]] && continue
        local f
        # Per-session run state now lives under .charm/run/<uuid>/ (socket,
        # pidfile, graph-viewer pids, meta); the flat .charm/* paths are the
        # legacy single-session layout. Sweep both, plus the last-session pointer.
        for f in "$r/.charm/run" "$r/.charm/last-session" "$r/.charm/charmd.pid" "$r/.charm/graph-viewers.pids"; do
            if [[ -e "$f" ]]; then
                if [[ $dry == 1 ]]; then echo "    [dry] rm -r $f"
                else rm -rf "$f" && echo "    removed $f"; fi
            fi
        done
    done
    # The socket lives in the daemon's os.tmpdir() (charm-<hash>.sock). That can
    # differ from this shell's $TMPDIR, so sweep every candidate temp dir: the
    # current $TMPDIR, /tmp, and macOS's canonical per-user temp (DARWIN_USER_TEMP_DIR,
    # the /var/folders/.../T path that os.tmpdir() resolves to under a normal login).
    local tmpdirs=() seen_tmp=""
    local cand
    for cand in "${TMPDIR:-}" "/tmp" "$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"; do
        cand="${cand%/}"
        [[ -z "$cand" || ! -d "$cand" ]] && continue
        case "$seen_tmp" in *"|$cand|"*) continue ;; esac
        seen_tmp="${seen_tmp}|$cand|"
        tmpdirs+=("$cand")
    done
    local tmp sock
    for tmp in "${tmpdirs[@]}"; do
        for sock in "$tmp"/charm-*.sock; do
            [[ -S "$sock" ]] || continue
            if [[ $dry == 1 ]]; then echo "    [dry] rm $sock"
            else rm -f "$sock" && echo "    removed stale socket $sock"; fi
        done
    done

    echo "==> Done."
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
  stop                      Kill daemon + tmux session (one session, by name)
  kill [--dry-run|-n]       PANIC: kill ALL charm processes machine-wide
                            (every session/dir; spares non-charm claude sessions)
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
    kill)           cmd_kill "$@" ;;
    charm)        cmd_charm "$@" ;;
    help|--help|-h) cmd_help ;;
    *)
        echo "Unknown command: $1" >&2
        cmd_help >&2
        exit 1
        ;;
esac
