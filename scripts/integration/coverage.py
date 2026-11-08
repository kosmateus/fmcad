#!/usr/bin/env python3
"""Audit CI registration, never execute discovered test or runtime files.

This is registration evidence, not assertion execution or test-result evidence.
Only Node --test, Python unittest discovery and literal test-wrapper imports are
recognized. Unknown command forms stay gaps; typechecking is never execution.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import posixpath
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEST = re.compile(r"(?:\.test\.(?:[cm]?[jt]s)|_test\.py)$")
NPM = re.compile(r"\bnpm run ([\w:-]+)")
IMPORT = re.compile(r"(?:require\(\s*|(?:import|from)\s*)['\"]([^'\"]+)['\"]")


def tracked(root: Path) -> list[str]:
    return subprocess.check_output(
        ["git", "ls-files", "-z"], cwd=root, text=True
    ).rstrip("\0").split("\0")


def workflow_commands(text: str) -> list[str]:
    """Read run scalars/blocks, excluding comments and non-command YAML fields."""
    commands = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        match = re.match(r"^(\s*)(?:-\s+)?run:\s*(.*?)\s*$", lines[i])
        i += 1
        if not match:
            continue
        value = match[2]
        if value in ("|", ">", "|-", ">-"):
            block = []
            indent = len(match[1])
            while i < len(lines) and (
                not lines[i].strip() or len(lines[i]) - len(lines[i].lstrip()) > indent
            ):
                block.append(lines[i].strip())
                i += 1
            value = "\n".join(block)
        elif value[:1] in ("'", '"') and value[-1:] == value[:1]:
            value = value[1:-1]
        commands.append(value)
    return commands


def expand(command: str, scripts: dict[str, str], stack: tuple[str, ...] = ()):
    yield command
    for name in NPM.findall(command):
        if name in stack:
            raise ValueError(f"Cyclic npm script: {' -> '.join((*stack, name))}")
        if name not in scripts:
            raise ValueError(f"Missing npm script: {name}")
        # npm run invokes the pre/post lifecycle scripts too.
        for key in ("pre" + name, name, "post" + name):
            if key in scripts:
                yield from expand(scripts[key], scripts, (*stack, name))


def match_path(path: str, pattern: str) -> bool:
    # Shell * does not cross a directory boundary.
    return len(path.split('/')) == len(pattern.split('/')) and all(
        fnmatch.fnmatchcase(part, glob)
        for part, glob in zip(path.split('/'), pattern.split('/'))
    )


def runtime_paths(source: str) -> list[str]:
    paths = [source]
    if source.endswith(('.ts', '.mts', '.cts')):
        stem, ext = source.rsplit('.', 1)
        paths.append('dist/' + stem + {"ts": ".js", "mts": ".mjs", "cts": ".cjs"}[ext])
    return paths


def selected(command: str, tests: list[str], files: set[str]) -> set[str]:
    result = set()
    # Examine each shell segment separately: a test filename in a later echo,
    # compiler command or documentation generator must not count as execution.
    for segment in re.split(r"&&|\|\||;|\n", command):
        if re.search(r"\bnode\s+.*?(?<!\S)--test(?:\s|$)", segment) and not re.search(r"--test-(?:name|skip)-pattern\b", segment):
            patterns = re.findall(r"(?:dist/)?tests/[\w./*?\[\]-]+", segment)
            for source in tests:
                if any(match_path(path, pattern) for path in runtime_paths(source) for pattern in patterns):
                    result.add(source)
        if re.search(r"\bpython(?:3)?\s+.*?-m\s+unittest\s+discover\b", segment):
            start = re.search(r"(?:^|\s)-s\s+['\"]?([\w/.-]+)", segment)
            pattern = re.search(r"(?:^|\s)-p\s+['\"]?([\w.*?-]+)", segment)
            if not start or not pattern:
                raise ValueError('unittest discovery requires explicit -s and -p')
            for source in tests:
                p = Path(source)
                if not source.startswith(start[1] + '/') or not fnmatch.fnmatchcase(p.name, pattern[1]):
                    continue
                # unittest only recurses into importable subpackages.
                parent = p.parent
                while parent.as_posix() != start[1]:
                    if (parent / '__init__.py').as_posix() not in files:
                        break
                    parent = parent.parent
                else:
                    result.add(source)
    return result


def audit(root: Path, files: list[str]) -> dict:
    tests = sorted(p for p in files if p.startswith('tests/') and TEST.search(p))
    scripts = json.loads((root / 'package.json').read_text())['scripts']
    reached: dict[str, set[str]] = {p: set() for p in tests}
    commands = {}
    for workflow in sorted(p for p in files if p.startswith('.github/workflows/') and p.endswith(('.yml', '.yaml'))):
        commands[workflow] = []
        for command in workflow_commands((root / workflow).read_text()):
            for expanded in expand(command, scripts):
                commands[workflow].append(expanded)
                for source in selected(expanded, tests, set(files)):
                    reached[source].add(workflow)
    # Follow only literal imports into other recognized test files. This maps
    # thin compatibility wrappers to TS sources without treating imports of
    # ordinary production modules as test execution.
    aliases = {path: source for source in tests for path in runtime_paths(source)}
    changed = True
    while changed:
        changed = False
        for source in tests:
            if not reached[source]:
                continue
            for relative in IMPORT.findall((root / source).read_text()):
                if not relative.startswith('.'):
                    continue
                target = posixpath.normpath(posixpath.join(posixpath.dirname(source), relative))
                imported = aliases.get(target)
                if imported and not reached[source] <= reached[imported]:
                    reached[imported].update(reached[source])
                    changed = True
    return {
        'schemaVersion': 1,
        'evidenceKind': 'static-ci-registration-not-test-results',
        'tests': [{'path': p, 'workflows': sorted(reached[p])} for p in tests],
        'gaps': [p for p in tests if not reached[p]],
        'expandedCommands': commands,
    }


def violations(report: dict, baseline: dict) -> list[str]:
    allowed = baseline['gaps']
    errors = []
    for path in report['gaps']:
        entry = allowed.get(path)
        if not entry:
            errors.append('New orphan test: ' + path)
        elif entry.get('owner') not in tuple('ABCDEFG') or not entry.get('reason') or not entry.get('nextAction'):
            errors.append('Incomplete gap disposition: ' + path)
    paths = {r['path'] for r in report['tests']}
    for path in allowed:
        if path not in paths:
            errors.append('Removed test needs explicit disposition update: ' + path)
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    report = audit(ROOT, tracked(ROOT))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + '\n')
    if args.check:
        baseline = json.loads((ROOT / 'docs/integration/ci-registration-gaps.json').read_text())
        errors = violations(report, baseline)
        for error in errors:
            print(error)
        if errors:
            return 1
    print(json.dumps({'testSources': len(report['tests']), 'registered': len(report['tests']) - len(report['gaps']), 'gaps': len(report['gaps'])}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
