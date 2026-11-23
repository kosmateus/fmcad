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


def execute(request: dict[str, object]) -> dict[str, object]:
    stdout, stderr = io.StringIO(), io.StringIO()
    success = True
    error = ""
    namespace: dict[str, object] = {"__name__": "__fmcad_scenario__"}
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            from adsk.core import Application
            app = Application.get()
            operation = request.get("operation")
            if operation is not None:
                if operation != "doc-list":
                    raise ValueError("Unsupported simulator operation")
                results: list[dict[str, object]] = []
                for document in app.documents:
                    row: dict[str, object] = {
                        "creationId": document.creationId,
                        "name": document.name,
                        "isActive": document is app.activeDocument,
                        "isSaved": document.isSaved,
                        "isModified": document.isModified,
                    }
                    try:
                        data_file = document.dataFile
                    except Exception as exc:
                        row["dataFileError"] = str(exc)
                    else:
                        if data_file is not None:
                            row["id"] = data_file.id
                    results.append(row)
                stdout.write(json.dumps({"success": True, "results": results}))
            else:
                app.data.advance_model()
                source, entrypoint = request.get("source"), request.get("entrypoint")
                if not isinstance(source, str) or not isinstance(entrypoint, bool):
                    raise ValueError("Expected source and entrypoint flag")
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
        print(json.dumps(execute(request)), flush=True)


if __name__ == "__main__":
    main()
