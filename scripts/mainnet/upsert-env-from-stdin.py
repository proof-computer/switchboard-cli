#!/usr/bin/env python3
"""Upsert KEY=VALUE lines into deployment env files.

Input lines are tab-separated:

    group<TAB>key<TAB>value

`group` is `control`, `operator`, or `explorer`.
"""

from __future__ import annotations

import pathlib
import sys


FILES = {
    "control": pathlib.Path(".control-plane/control-plane.env"),
    "operator": pathlib.Path(".operator-host/operator.env"),
    "explorer": pathlib.Path(".explorer/explorer.env"),
}


def main() -> int:
    updates: dict[str, dict[str, str]] = {group: {} for group in FILES}
    for line_number, raw_line in enumerate(sys.stdin, start=1):
        line = raw_line.rstrip("\n")
        if not line:
            continue
        parts = line.split("\t", 2)
        if len(parts) != 3:
            raise SystemExit(f"invalid line {line_number}: expected group<TAB>key<TAB>value")
        group, key, value = parts
        if group not in FILES:
            raise SystemExit(f"invalid line {line_number}: unknown group {group!r}")
        if not key or "=" in key:
            raise SystemExit(f"invalid line {line_number}: invalid key {key!r}")
        updates[group][key] = value

    for group, group_updates in updates.items():
        if not group_updates:
            continue
        path = FILES[group]
        path.parent.mkdir(parents=True, exist_ok=True)
        existing = path.read_text(encoding="utf8").splitlines() if path.exists() else []
        seen: set[str] = set()
        next_lines: list[str] = []
        for line in existing:
            if not line or line.lstrip().startswith("#") or "=" not in line:
                next_lines.append(line)
                continue
            key = line.split("=", 1)[0]
            if key in group_updates:
                next_lines.append(f"{key}={group_updates[key]}")
                seen.add(key)
            else:
                next_lines.append(line)
        for key, value in group_updates.items():
            if key not in seen:
                next_lines.append(f"{key}={value}")
        path.write_text("\n".join(next_lines) + "\n", encoding="utf8")
        print(f"updated {group}: {len(group_updates)} keys")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
