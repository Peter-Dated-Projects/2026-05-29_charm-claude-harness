#!/usr/bin/env pwsh
# Windows (PowerShell) launcher for the Claude Agent Charm -the analog of
# charm.sh. Runs the TS sources via bun without a global install; forwards every
# subcommand to src/cli.ts.
#
# Usage:
#   .\charm.ps1 init [--root PATH]
#   .\charm.ps1 status
#   .\charm.ps1 stop
#   .\charm.ps1 approve <gate_id> [--reject]
#   .\charm.ps1 start "your goal here"
#
# NOTE (Windows port, Phase 1): the headless surface -init, status, stop,
# approve, and the daemon/RPC/ticket store -runs natively on Windows today.
# The visible multi-pane UX (`start`/`attach`) still depends on a terminal
# multiplexer; native pane support is Phase 2 in PORTING-WINDOWS.md (WezTerm
# backend). Until then `start` will report that a multiplexer is required.

$ErrorActionPreference = 'Stop'
$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "missing dependency: bun (install from https://bun.sh, then re-run)"
    exit 2
}

# Make `charm-mcp` resolvable for spawned claude processes without a global
# install, mirroring charm.sh. Only set when a compiled charm-mcp.exe exists
# next to a dist/ build -a bare source path can't be an MCP `command`.
if (-not $env:CHARM_MCP_BIN) {
    $mcpExe = Join-Path $RepoDir 'dist\charm-mcp.exe'
    if (Test-Path $mcpExe) { $env:CHARM_MCP_BIN = $mcpExe }
}

# Forward all arguments straight through to the CLI entrypoint.
& bun run (Join-Path $RepoDir 'src\cli.ts') @args
exit $LASTEXITCODE
