#!/usr/bin/env python3
"""Create a bounded, read-only inventory for documentation bootstrap."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

SKIP = {".git", "node_modules", "vendor", "dist", "build", ".next", ".turbo", "coverage", "target", "__pycache__"}
MARKERS = ("package.json", "pnpm-workspace.yaml", "turbo.json", "Cargo.toml", "pyproject.toml", "go.mod", "pom.xml", "build.gradle", "docker-compose.yml", "compose.yaml")
ENTRY_NAMES = {"main.ts", "main.tsx", "main.py", "main.go", "main.rs", "app.ts", "app.py", "server.ts", "server.py", "index.ts", "index.tsx"}


def included(path: Path) -> bool:
    return not any(part in SKIP for part in path.parts)


def rel(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-files", type=int, default=5000)
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        parser.error(f"not a directory: {root}")

    files, truncated = [], False
    for candidate in root.rglob("*"):
        if not candidate.is_file() or not included(candidate):
            continue
        if len(files) >= args.max_files:
            truncated = True
            break
        files.append(candidate)
    marker_files = [rel(root, p) for p in files if p.name in MARKERS]
    instructions = [rel(root, p) for p in files if p.name in {"AGENTS.md", "CLAUDE.md", "GEMINI.md", "README.md"}]
    workflows = [rel(root, p) for p in files if ".github/workflows" in p.parts or p.name in {"Makefile", "Justfile"}]
    tests = [rel(root, p) for p in files if any(x in p.parts for x in ("test", "tests", "__tests__")) or p.name.endswith((".test.ts", ".spec.ts", "_test.go", "_test.py"))]
    entrypoints = [rel(root, p) for p in files if p.name in ENTRY_NAMES]
    top_level = sorted(p.name for p in root.iterdir() if p.is_dir() and p.name not in SKIP)
    workspace_dirs = [d for d in ("apps", "packages", "services", "libs", "crates", "modules") if (root / d).is_dir()]
    inventory = {
        "root": str(root),
        "truncated": truncated,
        "workspace_candidates": workspace_dirs,
        "top_level_directories": top_level,
        "markers": marker_files,
        "instructions_and_readmes": instructions,
        "workflow_and_task_files": workflows,
        "test_candidates": tests[:250],
        "entrypoint_candidates": entrypoints[:250],
        "next_step": "Inspect evidence before assigning conceptual modules, flows, contracts, or ownership.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "markers": len(marker_files), "files_scanned": len(files)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
