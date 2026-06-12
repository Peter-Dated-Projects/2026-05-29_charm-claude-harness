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
bun run build             # → dist/charm-claude, dist/charmd, dist/charm-mcp, dist/charm-console
```

Run `dist/charm-claude --help` to verify.

The fastest path to a working global install is `./frieren.sh install`, which
runs this build and copies the binaries (plus the prompt/kb templates) onto your
PATH. The rest of this doc covers the manual and cross-compile cases.

## Cross-compile for Mac (both architectures)

Bun supports cross-arch and cross-OS compilation via `--target`. For shareable
Mac builds you want both Apple Silicon and Intel:

```sh
# Apple Silicon (M1/M2/M3/M4)
bun build src/cli.ts          --compile --target=bun-darwin-arm64 --outfile dist/arm64/charm-claude
bun build src/daemon/index.ts --compile --target=bun-darwin-arm64 --outfile dist/arm64/charmd
bun build src/mcp/server.ts   --compile --target=bun-darwin-arm64 --outfile dist/arm64/charm-mcp
bun build src/console/app.tsx --compile --target=bun-darwin-arm64 --outfile dist/arm64/charm-console --external react-devtools-core

# Intel Macs
bun build src/cli.ts          --compile --target=bun-darwin-x64   --outfile dist/x64/charm-claude
bun build src/daemon/index.ts --compile --target=bun-darwin-x64   --outfile dist/x64/charmd
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
for name in charm-claude charmd charm-mcp charm-console; do
  lipo -create -output dist/universal/$name dist/arm64/$name dist/x64/$name
done
file dist/universal/charm-claude   # should print "Mach-O universal binary with 2 architectures"
```

## Packaging for distribution

The four binaries are independent and must be co-located on the user's PATH:
`charm-claude start` spawns `charmd` and `charm-console` by looking next to its
own executable, and every spawned `claude` process resolves `charm-mcp` by name.
The prompt/kb templates also have to ship — `charm init`/`start` read them from a
`share/charm/templates` dir a level above the bin dir (i.e. `<bindir>/../share/charm`).

```sh
tar -C dist/universal -czf charm-macos-universal.tar.gz \
    charm-claude charmd charm-mcp charm-console
tar -C . -czf charm-templates.tar.gz templates
```

Install instructions for the recipient (binaries to a bin dir, templates one
level up under `share/charm`):

```sh
tar -xzf charm-macos-universal.tar.gz -C /usr/local/bin
mkdir -p /usr/local/share/charm
tar -xzf charm-templates.tar.gz -C /usr/local/share/charm   # → /usr/local/share/charm/templates/
# or anywhere on PATH; keep the same bin ↔ share/charm relationship
xattr -d com.apple.quarantine /usr/local/bin/charm* 2>/dev/null || true
charm-claude init && charm-claude start "your goal"
```

For a local install from the repo, `./frieren.sh install` does all of the above
(build + place binaries + copy templates) onto `~/.local/bin` automatically.

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

## How compiled `charm start` spawns its children

`charm start` launches the daemon and console as subprocesses. When running
from TS source it runs them via `bun run <path>`; when running as a compiled
binary it execs the sibling `charmd` and `charm-console` binaries that live next
to its own executable (resolved from `process.execPath`, not `import.meta.url`,
which inside a compiled binary points into Bun's embedded bundle rather than the
real filesystem). The `claude` agents it drives reach the daemon through
`charm-mcp`, resolved by name on PATH. This is why all four binaries must be
co-located on PATH (see the resolver `resolveChild` in `src/cli.ts`).

The earlier limitation — where a compiled `charm start` couldn't spawn its
children because the spawn path was derived from `import.meta.url` — is fixed by
that sibling-binary resolution. Dev mode (`bun run dev:*`) and a `frieren.sh
install`ed binary both work.
