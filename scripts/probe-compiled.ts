// Probe what a compiled Bun binary actually reports on Windows, so isCompiled()
// can key off something reliable. Build: bun build scripts/probe-compiled.ts --compile --outfile dist/probe
// then run dist/probe.exe; also run via `bun run scripts/probe-compiled.ts` to compare.
import { basename } from "node:path";
console.log("import.meta.url      =", JSON.stringify(import.meta.url));
console.log("import.meta.dir      =", JSON.stringify((import.meta as any).dir));
console.log("process.execPath     =", JSON.stringify(process.execPath));
console.log("execPath basename    =", JSON.stringify(basename(process.execPath)));
console.log("url has /~BUN/       =", import.meta.url.includes("/~BUN/"));
console.log("url has \\~BUN\\     =", import.meta.url.includes("\\~BUN\\"));
console.log("url has /$bunfs/     =", import.meta.url.includes("/$bunfs/"));
console.log("regex [\\\\/](~BUN|$bunfs)[\\\\/] =", /[\\/](\$bunfs|~BUN)[\\/]/.test(import.meta.url));
