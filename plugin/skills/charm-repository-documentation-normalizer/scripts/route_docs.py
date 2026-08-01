#!/usr/bin/env python3
"""Route a task through hierarchical manifests to the smallest documentation set."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from charm_docs_common import frontmatter, manifest, path_matches, task_matches


def values(data: dict[str, object], key: str) -> list[str]:
    value = data.get(key, [])
    return [str(item) for item in value] if isinstance(value, list) else []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--paths", nargs="*", default=[])
    parser.add_argument("--budget", type=int, default=2500)
    args = parser.parse_args()
    root = args.root.resolve()
    docs_root = root / "docs/repository"
    root_manifest = docs_root / "manifest.yaml"
    if not root_manifest.is_file():
        print(json.dumps({"required": [], "recommended": [], "reason": "normalized documentation is not installed"}, indent=2))
        return 0

    candidates: dict[str, dict[str, object]] = {}
    manifests_used: set[str] = set()
    for manifest_path in sorted(docs_root.rglob("manifest.yaml")):
        parsed = manifest(manifest_path)
        manifest_relative = manifest_path.relative_to(root).as_posix()
        for raw_entry in parsed.get("documents", []):
            if not isinstance(raw_entry, dict) or not raw_entry.get("path"):
                continue
            entry = dict(raw_entry)
            document_path = root / str(entry["path"])
            metadata = frontmatter(document_path) if document_path.is_file() else {}
            patterns = values(entry, "scope") + values(entry, "source_paths") + values(metadata, "scope") + values(metadata, "source_paths")
            path_hit = any(path_matches(pattern, changed) for pattern in patterns for changed in args.paths)
            task_hit = task_matches(entry.get("load_when", []), args.task)
            name_hit = any(word in args.task.lower() for word in document_path.stem.replace("-", " ").split() if len(word) > 2)
            skip_hit = task_matches(entry.get("skip_when", []), args.task) and not path_hit
            if not (path_hit or task_hit or name_hit) or skip_hit:
                continue
            doc_id = str(entry.get("id") or metadata.get("id") or document_path.stem)
            kind = str(entry.get("kind") or metadata.get("kind") or "document")
            reasons = []
            if path_hit:
                reasons.append("path match")
            if task_hit:
                reasons.append("load trigger")
            if name_hit and not reasons:
                reasons.append("task term match")
            candidates[doc_id] = {
                "path": str(entry["path"]),
                "id": doc_id,
                "kind": kind,
                "reason": ", ".join(reasons),
                "manifest": manifest_relative,
            }
            manifests_used.add(manifest_relative)

    ordered = sorted(candidates.values(), key=lambda item: (item["kind"] not in {"contract", "flow"}, str(item["path"])))
    required = [item for item in ordered if item["kind"] == "contract"]
    recommended = [item for item in ordered if item["kind"] != "contract"][:8]
    estimate = 350 * (len(required) + len(recommended))
    over_budget = estimate > args.budget
    print(
        json.dumps(
            {
                "required": required,
                "recommended": recommended,
                "manifests_consulted": sorted(manifests_used),
                "estimated_tokens": estimate,
                "budget_tokens": args.budget,
                "over_budget": over_budget,
                "reason": "hierarchical manifest, task-trigger, and source-scope matching; confirm critical claims in current code",
            },
            indent=2,
        )
    )
    return 2 if over_budget else 0


if __name__ == "__main__":
    raise SystemExit(main())
