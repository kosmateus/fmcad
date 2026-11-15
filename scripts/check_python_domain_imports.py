"""Enforce the extracted Python package layering and domain import contracts."""
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    env = os.environ.copy()
    runtime = str(ROOT / "runtime" / "python")
    env["PYTHONPATH"] = os.pathsep.join(
        value for value in (runtime, env.get("PYTHONPATH", "")) if value
    )
    try:
        result = subprocess.run(
            ["lint-imports", "--config", str(ROOT / "tests" / "python-importlinter.ini")],
            cwd=ROOT,
            env=env,
            check=False,
        )
    except FileNotFoundError:
        print(
            "lint-imports is unavailable; install tests/python-domain-import-requirements.txt",
            file=sys.stderr,
        )
        return 127
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
