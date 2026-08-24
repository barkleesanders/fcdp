#!/usr/bin/env python3
"""Merge capability matrices without hiding runtime gaps."""

import json
import sys
from pathlib import Path


RANK = {"success": 3, "dispatched": 2, "runtime-unavailable": 1, "unavailable": 0}


def load(path):
    return json.loads(Path(path).read_text())


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: merge.py NAME=matrix.json NAME=matrix.json [...]")
    inputs = {}
    for item in sys.argv[1:]:
        if "=" not in item:
            raise SystemExit(f"matrix argument must be NAME=path: {item}")
        name, path = item.split("=", 1)
        if not name or name in inputs:
            raise SystemExit(f"invalid or duplicate transport name: {name!r}")
        inputs[name] = load(path)
    by_transport = {
        transport: {row["domain"]: row for row in matrix["results"]}
        for transport, matrix in inputs.items()
    }
    first_transport = next(iter(by_transport))
    requested = list(by_transport[first_transport])
    expected = set(requested)
    for transport, rows in by_transport.items():
        if set(rows) != expected:
            raise SystemExit(f"{transport} matrix has a different domain set")
    results = []
    for domain in requested:
        candidates = [(name, rows[domain]) for name, rows in by_transport.items()]
        transport, best = max(candidates, key=lambda item: RANK[item[1]["status"]])
        results.append(
            {
                "domain": domain,
                "status": best["status"],
                "transport": transport,
                "target": best["target"],
                "method": best["method"],
                "detail": best["detail"],
                "transportStatuses": {
                    name: rows[domain]["status"] for name, rows in by_transport.items()
                },
            }
        )
    reachable = sum(row["status"] in {"success", "dispatched"} for row in results)
    output = {
        "requested": len(results),
        "transportReachable": reachable,
        "runtimeGap": len(results) - reachable,
        "products": {name: matrix["product"] for name, matrix in inputs.items()},
        "results": results,
    }
    print(json.dumps(output, indent=2))
    return 0 if reachable == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
