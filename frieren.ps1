#!/usr/bin/env pwsh
# frieren.ps1 -Windows (PowerShell) project-lifecycle entry point, the analog of
# frieren.sh. Owns setup / dev / build / typecheck / test / clean and delegates
# live runtime operations (init/start/status/stop) to charm.ps1.
#
# Usage: .\frieren.ps1 <command>
#
# NOTE (Windows port): build produces native .exe binaries via bun's host
# target. The `install` path (placing binaries on PATH for global use) is
# deferred to the Phase 2 distribution work in PORTING-WINDOWS.md, since a global
# install is only useful once the native pane UI (multiplexer) lands.

# NOTE: not 'Stop'. Native tools (bun) print their script-echo to stderr, which
# under 'Stop' PowerShell escalates to a terminating error and aborts the build.
# We detect real failures via $LASTEXITCODE / output-file checks instead.
$ErrorActionPreference = 'Continue'
$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoDir

function Require-Bun {
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        Write-Error "missing dependency: bun (install from https://bun.sh)"
        exit 2
    }
}

$cmd = if ($args.Count -ge 1) { $args[0] } else { 'help' }
$rest = if ($args.Count -ge 1) { $args[1..($args.Count - 1)] } else { @() }

switch ($cmd) {
    'setup' {
        Require-Bun
        Write-Host "==> Installing dependencies (bun install)..."
        & bun install
        Write-Host "==> Done. Try: .\frieren.ps1 dev   or   .\charm.ps1 status"
    }
    'dev' {
        Require-Bun
        $component = if ($rest.Count -ge 1) { $rest[0] } else { 'console' }
        $extra = if ($rest.Count -ge 1) { $rest[1..($rest.Count - 1)] } else { @() }
        switch ($component) {
            'cli'     { & bun run src\cli.ts @extra }
            'daemon'  { & bun run src\daemon\index.ts @extra }
            'mcp'     { & bun run src\mcp\server.ts @extra }
            'console' { & bun run src\console\app.tsx @extra }
            default   { Write-Error "Usage: .\frieren.ps1 dev cli|daemon|mcp|console"; exit 1 }
        }
    }
    'build' {
        Require-Bun
        Write-Host "==> Installing dependencies (bun install)..."
        & bun install
        Write-Host "==> Building native .exe binaries -> dist\ ..."
        & bun run build
    }
    'typecheck' { Require-Bun; & bun run typecheck }
    'test'      { Require-Bun; & bun run typecheck; & bun test @rest }
    'clean' {
        Write-Host "==> Removing build artifacts (dist\)..."
        Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
        if ($rest.Count -ge 1 -and $rest[0] -eq 'deep') {
            Write-Host "==> Deep clean: removing node_modules\..."
            Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
        }
    }
    'install' {
        # Build native .exe binaries and place them (plus templates) on PATH so
        # `charm` works anywhere -no repo, no bun, no node_modules at runtime.
        # Mirrors frieren.sh cmd_install. Layout (matches the runtime lookups in
        # cli.ts resolveChild / locateTemplateDir):
        #   <bindir>\charm.exe                 CLI (from charm-claude.exe)
        #   <bindir>\charmd.exe charm-console.exe charm-mcp.exe charm-graph.exe
        #   <bindir>\..\share\charm\templates\ prompt + kb + skill templates
        Require-Bun
        if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
            Write-Host "    note: claude (Claude Code CLI) not found -charm spawns it at runtime; install it before 'charm start'."
        }
        # Default per-user prefix (no admin needed); `--prefix DIR` overrides the bindir.
        $bindir = Join-Path $env:LOCALAPPDATA 'charm\bin'
        if ($rest.Count -ge 2 -and $rest[0] -eq '--prefix') { $bindir = $rest[1] }

        Write-Host "==> Installing dependencies + building binaries..."
        & bun install
        & bun run build
        # bun writes its script-echo to stderr, so don't trust $LASTEXITCODE alone;
        # confirm the build actually produced the CLI binary.
        if (-not (Test-Path (Join-Path $RepoDir 'dist\charm-claude.exe'))) {
            Write-Error "build did not produce dist\charm-claude.exe"; exit 1
        }

        New-Item -ItemType Directory -Force $bindir | Out-Null
        $bindir = (Resolve-Path $bindir).Path
        # Templates live a level above bin, matching dirname(execPath)\..\share\charm.
        $sharedir = Join-Path (Split-Path $bindir -Parent) 'share\charm'

        # Windows won't overwrite a running .exe. A daemon (charmd), console, MCP
        # shim, or graph viewer left alive by a prior `charm start` holds these
        # binaries open and Copy-Item fails with a sharing violation. Stop any
        # charm process executing from THIS bindir first (matched by image path,
        # so we never touch unrelated processes or this installer itself).
        $running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.ExecutablePath -and $_.ExecutablePath.StartsWith($bindir, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($running.Count -gt 0) {
            Write-Host "==> Stopping $($running.Count) running charm process(es) holding the old binaries (a prior session)..."
            $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Milliseconds 600
        }

        Write-Host "==> Installing binaries to $bindir ..."
        Copy-Item -Force (Join-Path $RepoDir 'dist\charm-claude.exe') (Join-Path $bindir 'charm.exe')
        foreach ($b in @('charmd', 'charm-console', 'charm-mcp', 'charm-graph')) {
            Copy-Item -Force (Join-Path $RepoDir "dist\$b.exe") (Join-Path $bindir "$b.exe")
        }

        Write-Host "==> Installing templates to $sharedir\templates ..."
        New-Item -ItemType Directory -Force $sharedir | Out-Null
        Remove-Item -Recurse -Force (Join-Path $sharedir 'templates') -ErrorAction SilentlyContinue
        Copy-Item -Recurse -Force (Join-Path $RepoDir 'templates') (Join-Path $sharedir 'templates')

        # Ensure bindir is on the persistent User PATH (and this session's PATH).
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $entries = @($userPath -split ';' | Where-Object { $_ -ne '' })
        if ($entries -notcontains $bindir) {
            [Environment]::SetEnvironmentVariable('Path', (($entries + $bindir) -join ';'), 'User')
            $env:PATH = "$env:PATH;$bindir"
            Write-Host "==> Added $bindir to your User PATH (open a new shell to pick it up)."
        } else {
            Write-Host "==> $bindir already on PATH."
        }
        Write-Host "==> Installed: charm + siblings -> $bindir. Verify: charm --version"
    }
    'uninstall' {
        # Remove installed binaries, templates, and the PATH entry. Mirrors
        # frieren.sh cmd_uninstall.
        $bindir = Join-Path $env:LOCALAPPDATA 'charm\bin'
        if ($rest.Count -ge 2 -and $rest[0] -eq '--prefix') { $bindir = $rest[1] }
        $removed = 0
        foreach ($f in @('charm', 'charmd', 'charm-console', 'charm-mcp', 'charm-graph')) {
            $p = Join-Path $bindir "$f.exe"
            if (Test-Path $p) { Remove-Item -Force $p; Write-Host "==> Removed $p"; $removed = 1 }
        }
        $sharedir = Join-Path (Split-Path $bindir -Parent) 'share\charm'
        if (Test-Path $sharedir) { Remove-Item -Recurse -Force $sharedir; Write-Host "==> Removed $sharedir"; $removed = 1 }
        # Drop bindir from the User PATH if present.
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $entries = @($userPath -split ';' | Where-Object { $_ -ne '' })
        if ($entries -contains $bindir) {
            [Environment]::SetEnvironmentVariable('Path', (($entries | Where-Object { $_ -ne $bindir }) -join ';'), 'User')
            Write-Host "==> Removed $bindir from User PATH."
            $removed = 1
        }
        if ($removed -eq 0) { Write-Host "    Nothing to remove under $bindir" }
    }
    { $_ -in 'init', 'start', 'status', 'stop', 'attach', 'approve' } {
        & (Join-Path $RepoDir 'charm.ps1') $cmd @rest
        exit $LASTEXITCODE
    }
    default {
        @"
Usage: .\frieren.ps1 <command>

Project lifecycle:
  setup                      bun install
  dev cli|daemon|mcp|console  Run one component from TS source (default: console)
  build                      Compile native .exe binaries to dist\
  typecheck                  tsc --noEmit
  test [args...]             Typecheck, then bun test
  clean [deep]               Remove dist\ ('deep' also drops node_modules\)
  install [--prefix DIR]     Build, then install charm + siblings to PATH (default: %LOCALAPPDATA%\charm\bin)
  uninstall [--prefix DIR]   Remove the installed charm binaries, templates, and PATH entry

Runtime (delegates to charm.ps1):
  init | start | status | stop | attach | approve
"@ | Write-Host
    }
}
