"""Shared parsers for the normalizer's intentionally small YAML subset."""
from __future__ import annotations

import fnmatch
import re
from pathlib import Path


def scalar(text: str) -> str:
    return text.strip().strip("\"'")


def path_matches(pattern: str, path: str) -> bool:
    normalized = path.lstrip("./")
    candidate = pattern.lstrip("./")
    return fnmatch.fnmatch(normalized, candidate) or normalized.startswith(candidate.rstrip("*").rstrip("/"))


def frontmatter(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8", errors="replace")
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    if end < 0:
        return {"_error": "unclosed frontmatter"}
    lines = text[4:end].splitlines()
    result: dict[str, object] = {}
    parent = ""
    active_list = ""
    for raw in lines:
        indent = len(raw) - len(raw.lstrip(" "))
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if indent == 0 and ":" in stripped:
            key, value = stripped.split(":", 1)
            parent = key
            active_list = ""
            value = value.strip()
            if value == "[]":
                result[key] = []
            elif value:
                result[key] = scalar(value)
            else:
                result.setdefault(key, [])
                active_list = key
        elif indent == 2 and stripped.startswith("- ") and active_list:
            cast = result.setdefault(active_list, [])
            if isinstance(cast, list):
                cast.append(scalar(stripped[2:]))
        elif indent == 2 and ":" in stripped:
            key, value = stripped.split(":", 1)
            active_list = f"{parent}.{key}"
            value = value.strip()
            if value == "[]":
                result[active_list] = []
            elif value:
                result[active_list] = scalar(value)
            else:
                result.setdefault(active_list, [])
        elif indent == 4 and stripped.startswith("- ") and active_list:
            cast = result.setdefault(active_list, [])
            if isinstance(cast, list):
                cast.append(scalar(stripped[2:]))
    result["_body"] = text[end + 4 :]
    return result


def manifest(path: Path) -> dict[str, object]:
    """Parse the documented manifest schema without requiring PyYAML."""
    result: dict[str, object] = {"documents": [], "workspaces": [], "path": path}
    section = ""
    current: dict[str, object] | None = None
    active_list = ""
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        indent = len(raw) - len(raw.lstrip(" "))
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if indent == 0 and ":" in stripped:
            key, value = stripped.split(":", 1)
            if key in {"documents", "workspaces"}:
                section = key
                current = None
                continue
            result[key] = scalar(value)
            section = ""
            continue
        if section not in {"documents", "workspaces"}:
            continue
        if indent == 2 and stripped.startswith("- "):
            current = {}
            cast = result[section]
            if isinstance(cast, list):
                cast.append(current)
            active_list = ""
            remainder = stripped[2:]
            if ":" in remainder:
                key, value = remainder.split(":", 1)
                current[key] = scalar(value)
            continue
        if current is None:
            continue
        if indent == 4 and ":" in stripped:
            key, value = stripped.split(":", 1)
            value = value.strip()
            active_list = key
            if value == "[]":
                current[key] = []
            elif value:
                current[key] = scalar(value)
                active_list = ""
            else:
                current[key] = []
            continue
        if indent == 6 and stripped.startswith("- ") and active_list:
            cast = current.setdefault(active_list, [])
            if isinstance(cast, list):
                cast.append(scalar(stripped[2:]))
    return result


def task_matches(phrases: object, task: str) -> bool:
    if not isinstance(phrases, list):
        return False
    task_words = set(re.findall(r"[a-z0-9]+", task.lower()))
    for phrase in phrases:
        phrase_words = set(re.findall(r"[a-z0-9]+", str(phrase).lower()))
        meaningful = {word for word in phrase_words if len(word) > 2}
        if meaningful and meaningful.issubset(task_words):
            return True
    return False
