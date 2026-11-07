"""Local test-only Python executor. Persistent application, fresh script namespace.

It executes actual source; it never identifies tests or synthesizes expected results.
The parent supplies trusted test programs. This is not a security sandbox.
"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import traceback
from typing import Callable, cast


def execute(source: str, entrypoint: bool) -> dict[str, object]:
    stdout, stderr = io.StringIO(), io.StringIO()
    success = True
    error = ""
    namespace: dict[str, object] = {"__name__": "__fmcad_scenario__"}
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            exec(compile(source, "scenario.py", "exec"), namespace, namespace)
            if entrypoint:
                run = namespace.get("run")
                if not callable(run):
                    raise ValueError("Missing run entrypoint")
                cast(Callable[[str], None], run)("")
        except Exception:
            success = False
            error = traceback.format_exc()
    return {"success": success, "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "error": error}


def main() -> None:
    for line in sys.stdin:
        raw = cast(object, json.loads(line))
        if not isinstance(raw, dict):
            raise ValueError("Expected request object")
        request = cast(dict[str, object], raw)
        source, entrypoint = request.get("source"), request.get("entrypoint")
        if not isinstance(source, str) or not isinstance(entrypoint, bool):
            raise ValueError("Expected source and entrypoint flag")
        print(json.dumps(execute(source, entrypoint)), flush=True)


if __name__ == "__main__":
    main()
