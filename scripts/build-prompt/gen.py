#!/usr/bin/env python3
"""Generate docs/BUILD-PROMPT.md from template.md by embedding repo files verbatim.

Run after changing the SQL, the core contracts, ARCHITECTURE.md or any package.json:
    python3 scripts/build-prompt/gen.py
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
TEMPLATE = HERE / "template.md"
OUT = REPO / "docs" / "BUILD-PROMPT.md"

TOKEN = re.compile(r"<<<FILE:([^>]+)>>>")

def main() -> int:
    text = TEMPLATE.read_text(encoding="utf-8")
    missing = []
    embedded = []

    def sub(m: re.Match) -> str:
        rel = m.group(1)
        p = REPO / rel
        if not p.is_file():
            missing.append(rel)
            return m.group(0)
        body = p.read_text(encoding="utf-8")
        if body.endswith("\n"):
            body = body[:-1]
        embedded.append((rel, body.count("\n") + 1))
        return body

    out = TOKEN.sub(sub, text)
    if missing:
        print("missing files:", missing, file=sys.stderr)
        return 1
    OUT.write_text(out, encoding="utf-8")
    total = out.count("\n") + 1
    print(f"wrote {OUT} ({total} lines)")
    for rel, n in embedded:
        print(f"  embedded {rel}: {n} lines")
    # sanity: no leftover tokens, fences balanced
    assert "<<<FILE:" not in out
    return 0

if __name__ == "__main__":
    sys.exit(main())
