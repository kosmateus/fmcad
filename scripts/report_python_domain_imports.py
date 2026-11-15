"""Write a pydeps DOT report for the real extracted Python domain graph."""
import argparse
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("build/reports/python-domain-imports.dot"),
        help="DOT output path (default: build/reports/python-domain-imports.dot)",
    )
    args = parser.parse_args()
    output = args.output if args.output.is_absolute() else ROOT / args.output
    output.parent.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    runtime = str(ROOT / "runtime" / "python")
    env["PYTHONPATH"] = os.pathsep.join(
        value for value in (runtime, env.get("PYTHONPATH", "")) if value
    )
    command = [
        "pydeps",
        "--show-dot",
        "--dot-output",
        str(output),
        "--max-bacon=0",
        "--no-show",
        "--no-output",
        "fmcad.domain",
    ]
    try:
        result = subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True)
    except FileNotFoundError:
        print(
            "pydeps is unavailable; install tests/python-domain-import-requirements.txt",
            file=sys.stderr,
        )
        return 127
    if result.returncode:
        sys.stderr.write(result.stdout)
        sys.stderr.write(result.stderr)
        return result.returncode
    if not output.is_file() or output.stat().st_size == 0:
        print(f"pydeps did not write a graph to {output}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
