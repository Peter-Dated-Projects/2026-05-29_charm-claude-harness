# Build

The charm compiles to standalone native binaries via `bun build --compile`.
Each output embeds the Bun runtime, so users don't need Bun, Node, or any
toolchain installed — just a compatible OS/arch and `tmux` on PATH.

## Prerequisites

- **Bun** ≥ 1.1 on the build machine (`bun --version`)
- **tmux** on the *user's* machine at runtime (not needed to build)
- Nothing else — no Rust, no Xcode, no Node

## Quick build (host architecture only)

```sh
bun install               # one-time, fetches deps into node_modules/
bun run build             # → dist/charm, dist/charm-mcp, dist/charm-console
```

Run `dist/charm --help` to verify.

## Cross-compile for Mac (both architectures)

Bun supports cross-arch and cross-OS compilation via `--target`. For shareable
Mac builds you want both Apple Silicon and Intel:

```sh
# Apple Silicon (M1/M2/M3/M4)
bun build src/cli.ts          --compile --target=bun-darwin-arm64 --outfile dist/arm64/charm
bun build src/mcp/server.ts   --compile --target=bun-darwin-arm64 --outfile dist/arm64/charm-mcp
bun build src/console/app.tsx --compile --target=bun-darwin-arm64 --outfile dist/arm64/charm-console --external react-devtools-core

# Intel Macs
bun build src/cli.ts          --compile --target=bun-darwin-x64   --outfile dist/x64/charm
bun build src/mcp/server.ts   --compile --target=bun-darwin-x64   --outfile dist/x64/charm-mcp
bun build src/console/app.tsx --compile --target=bun-darwin-x64   --outfile dist/x64/charm-console --external react-devtools-core
```

Other targets Bun accepts: `bun-linux-x64`, `bun-linux-arm64`,
`bun-windows-x64`. Omit `--target` to build for the host.

## Universal binary (one file, both Mac archs)

Combine the per-arch builds with Apple's `lipo` (ships with macOS — no Xcode
needed for this command alone):

```sh
mkdir -p dist/universal
for name in charm charm-mcp charm-console; do
  lipo -create -output dist/universal/$name dist/arm64/$name dist/x64/$name
done
file dist/universal/charm   # should print "Mach-O universal binary with 2 architectures"
```

## Packaging for distribution

The three binaries are independent and must be co-located on the user's PATH
(the daemon and console are spawned by name from `charm start`). Ship them
as a tarball:

```sh
tar -C dist/universal -czf charm-macos-universal.tar.gz \
    charm charm-mcp charm-console
```

Install instructions for the recipient:

```sh
tar -xzf charm-macos-universal.tar.gz -C /usr/local/bin
# or anywhere on PATH
xattr -d com.apple.quarantine /usr/local/bin/charm* 2>/dev/null || true
charm init && charm start "your goal"
```

## Gatekeeper / quarantine

Unsigned binaries downloaded via browser get a `com.apple.quarantine`
extended attribute; first launch shows the "cannot verify developer" dialog.
Options, cheapest to fanciest:

1. **Strip the attribute** after download — `xattr -d com.apple.quarantine
   path/to/charm*`. Fine for internal/dev sharing.
2. **Ad-hoc signing** — `codesign --force --deep --sign - dist/universal/*`.
   Removes the dialog but still triggers Gatekeeper on download.
3. **Developer ID + notarization** — requires an Apple Developer account
   ($99/yr), `codesign` with the Developer ID cert, then `xcrun notarytool
   submit … --wait` and `xcrun stapler staple`. Only worth it for public
   distribution.

## Reproducibility & size

Compiled outputs are ~50–90 MB each (Bun runtime + bundle). They're not
deterministic across Bun versions; pin Bun in CI if you need reproducible
builds. Add `--minify` to shrink slightly, `--sourcemap` if you want
stacktraces from production crashes.

## Dev mode (skip the build)

```sh
bun run dev:cli         # bun run src/cli.ts
bun run dev:daemon      # bun run src/daemon/index.ts
bun run dev:mcp         # bun run src/mcp/server.ts
bun run dev:console     # bun run src/console/app.tsx
bun run typecheck       # tsc --noEmit
```

## Known limitation: compiled `charm start` can't spawn its children

`charm start` launches the daemon and console as subprocesses via
`bun run <path>` where `<path>` is derived from `import.meta.url`
([src/cli.ts:89-90, 117-118](src/cli.ts#L89-L118)). Inside a compiled binary
that URL points into Bun's embedded bundle, not the user's filesystem, so the
spawn fails.

Two fixes (pick one before shipping):

1. **Sibling binaries on PATH** — change `resolveBinary`
   ([src/cli.ts:190-194](src/cli.ts#L190-L194)) to look for `charmd` and
   `charm-console` next to `argv[0]`, then `spawn` those directly. Keep
   shipping three files.
2. **Single fat binary** — fold all three entry points into `charm` and
   dispatch via hidden subcommands (`charm __daemon`, `charm __console`),
   invoked through `process.execPath`. One binary to ship, no PATH
   coordination, smaller total size.

Dev mode (`bun run dev:*`) works today — the limitation only bites compiled
output.
