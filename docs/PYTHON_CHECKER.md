# Offline Python checker

`packages/node-adapters/src/python/checker.ts` implements the core `PythonChecker`
port in `packages/core/src/domain/python-checker.ts`. It consumes a verified,
immutable prepared artifact. The in-progress [admission integration](PYTHON_ADMISSION.md)
now consumes this port at the broker boundary. Candidate `impl/python-admission`
`6bb4518` completed full helper analysis within the existing checker limits. This
is branch-candidate evidence, not a master integration or deployment claim. A
successful report is not evidence of geometric correctness, live Fusion
execution, or complete upstream annotations.

## Engine selection (real comparison, 2026-10-25)

Both engines were actually run on the identical committed
`tests/fixtures/python-checker/{errors,unknown}.py` and synthetic annotated
`adsk/core.py`, using strict mode and Python 3.11:

| Engine | Pinned version | Exit | Diagnostics | One local elapsed run |
| --- | --- | --- | --- | --- |
| basedpyright | 1.40.2 | 1 | 6 errors | 367 ms |
| Pyright | 1.1.414 | 1 | 6 errors | 328 ms |

Both reported bad arguments (line 3), Optional member access (line 4), unknown
member plus missing attribute (line 6), and missing import plus unknown member
in `unknown.py` (lines 1–2). Timing is an observation, not a benchmark. Choose
**basedpyright 1.40.2**: same required diagnostics, plus explicit `reportAny` and
`reportExplicitAny` controls. It is the sole runtime checker dependency, pinned
in root package/lock; no global checker, pip, npx, installer or runtime download.
The engine carries its own typeshed; the adapter never imports `adsk` in Python.
Its upstream MIT license is retained by the installed npm dependency.

Reproduce with preinstalled engines (the script never installs either):

```sh
node scripts/compare-python-checkers.cjs /path/to/pyright/index.js
```

A full build also refreshed the actual Autodesk commit
`07814d19ac63bb3ff0d55e3d35517cf3a71bad8c` (May 2026 Major). The same argument,
Optional and missing-member errors were observed using those definitions; a
guarded `Point3D.create(0, 0, 0)` example passed. Distribution policy remains the
already accepted decision in [ADSK_DEFINITIONS.md](ADSK_DEFINITIONS.md); there is
no new licensing investigation or legal-clearance claim.

## Report policy

- `passed`: every inventoried unit was analyzed, no errors/warnings/coverage gaps.
- `failed`: a definite source error (syntax, assignment, API argument/member,
  Optional access, unavailable variable, premature facade use). Unknown gaps may
  coexist; they remain in `reasons`. Failed never means complete analysis.
- `incomplete`: unknown/Any/untyped imports or declarations, absent or corrupted
  SDK producer, warnings, unresolved dynamic exec/compile/eval, unsupported
  `no_type_check` use, or neutralized checker directives, without a definite error.
- `tool_error`: missing/wrong checker or Python tool, invalid artifact identity,
  malformed output, version/exit/summary/inventory disagreement, timeout, excessive
  diagnostics/output/memory, or another local analysis failure.

Missing imports are explicit error diagnostics, not `Any` shims. No blanket
missing-import ignore, no `noCheck`, no unchecked fallback, no synthesized
catch-all members. Comment directives (`pyright`, `basedpyright`, `type: ignore`)
are blanked in the analysis copy, preserving source positions; their occurrence
also records an incomplete reason. Submitted code remains unchanged.

## Namespaces and literal source maps

Callers explicitly provide `raw`, `run`, `bundle` or `cad-v1` context, plus actual
`app`/`ui` availability and `deferredFacade`. A label alone grants no globals.
Embedded source defaults to `raw` and does not inherit wrapper globals. Supply
per-unit contexts by prepared unit ID when the runtime actually injects them.

`entrypoint: "run"` declares an actual `run(stringContext)` invocation. The
checker emits a typed callable assignment after the unit and maps its errors
back to that source. Receipt admission supplies this for the embedded script
namespace as well as the official outer entrypoint. A merely callable value or
a typed function with the wrong parameters is not a valid entrypoint contract.
`run-if-present` models the conditional invocation used by the run wrapper;
unresolved dynamic construction of that binding remains incomplete. Caller
requests are snapshotted before asynchronous analysis so late mutation cannot
change either the source or the namespace behind the report's provenance.

Only concatenated units share the wire namespace. All prepared embedded units,
even unused ones, are analyzed. An isolated AST-only helper also recursively
inventories literal `exec`, `compile` and `eval`, including the generated
`__import__('json').loads(...)` string form, without evaluating it. Conflicting
filenames fail closed. Dynamic sources and aliases of exec/compile/eval are
explicit gaps; this is not a sandbox or a whole-program dynamic-code proof.

The context overlay is a narrow, typed description of actual injected values.
It deliberately does not pretend to know opaque producer return types:
`resolve`/measurement outputs remain `object`, requiring narrowing before use.
The facade covers real helper methods; it is not a new runtime implementation.
Facade access at module initialization (including defaults/decorators) fails
because cad-v1 injects the instance only after top-level execution. Any other
top-level calls in that context record an incomplete lifecycle gap: static types
alone cannot prove they do not invoke a deferred facade indirectly. Wrapper code
with broad dynamic dispatch stays incomplete
until its real declarations are supplied; it cannot silently pass.

Generated imports follow a docstring and all future imports. Only the generated
typing-only `fmcad_injected` import's `reportMissingModuleSource` is exempted;
the rule remains enabled on every submitted line. All other generated errors
fail closed. One-based line/column diagnostics map back to source-map units or
the original literal filename, not a temporary file or the wrapper alone.

## Complete helper analysis in bounded groups

Large flattened helpers are planned from their original, hash-bound source
inventory. The plan records every source unit's ID, filename, role and SHA-256,
the source maps, and a full function-body inventory. It also preserves the
namespace/order dependencies needed for cross-unit declarations and class-use
evidence.

Each bounded checker pass checks the full bodies assigned to its group. Bodies
that cannot safely be projected remain intact; eligible bodies assigned to
other groups may be replaced only in that pass's temporary analysis copy. Such
a projection is never itself a `passed` result. Aggregation verifies that the
expected groups and body hashes are covered against the original inventory, and
returns `passed` only if every pass succeeds. A missing or duplicate unit/body,
changed source hash/map/context, diagnostic, timeout, OOM or incomplete subreport
prevents acceptance. Original wire/source bytes remain unchanged, and report
caching remains disabled.

The original body plan is derived and verified once by the parent check. Each
bounded group gets a fresh AST inventory of the prepared wire and independently
revalidates the shared plan's complete unit hashes, body hashes, groups and
class-use witnesses against that inventory. It does not rerun the expensive
full-origin body scan in a separate Python process for every group. This reuses
only the already verified plan; group analysis, source verification and final
aggregation still run for every required unit/body.

On candidate `impl/python-admission` `6bb4518`, basedpyright `1.40.2` analyzed
the complete 152-unit helper with 151 origin-map entries and contexts
`raw/run` plus `cad-v1/deferredFacade/run-if-present`: aggregate status `passed`,
zero diagnostics. It completed in `161 684 ms` with command-level peak RSS
`733 048 KiB`; the V8 heap cap stayed at `512 MiB` and the RSS limit at
`768 MiB`. This qualifies static helper admission for that source candidate; it
does not qualify Fusion execution or model geometry.

After removing repeated per-group plan scans, an instrumented public
`document.save_as` broker run checked its exact 151-unit/151-map operation
source (2,310,193 bytes) with real basedpyright: five bounded groups, 0 final
diagnostics, certificate `passed`. The source hash was
`d542a9298baa75c6f62002359bacfb3b3759b1d9ec54f46194cc1963ca48992e`; the
final receipt artifact/wire hashes were
`4900c3cd7c72e71a7a1d1d499ab32f0df9afaf390e168121e77b38f76f0eb92f` /
`fd270197dde6be5b76f3713c8ae0a9c2aed719ed3b78aa1e39b3bfbd64c6f7c6`. The
local worker exited successfully in `77.4 s` of its unchanged `180 s` budget.
This operation has no separate user-script unit, so its 151-unit inventory is
not conflated with the independent 152-unit installed `cad-v1` helper proof.

## Isolation, limits and provenance

The checker defaults to a Linux target for existing offline consumers. Admission
explicitly selects the supported Windows Fusion host through `pythonPlatform`;
it does not infer the SDK platform from the Linux/WSL checker process. This target
is part of the hashed strict configuration, not a blanket platform-error ignore.

Each call uses a new private temporary directory, explicit config path, explicit
Python target (3.10/3.11/3.12, default 3.11), strict config, empty host interpreter
path, copied hash-verified definitions, bundled context stubs and the engine's
typeshed. Original filenames never become filesystem paths. Cwd/project configs,
`PYTHONPATH`, `NODE_OPTIONS`, virtualenvs and host site-packages are not inherited.
The AST helper uses `python3 -I -S`; it parses only, never executes input modules.
No runtime path refreshes definitions, performs network requests or installs
dependencies. The checker is not an execution sandbox.

Default limits: 30 seconds per subprocess, 2 MiB combined stdout/stderr, 768 MiB
sampled RSS and a 512 MiB V8 heap cap, 8 MiB input wire, 16 MiB cumulative
declared-unit source, 256 units and 2000 diagnostics. Expanded analyzed source is
also bounded to 16 MiB. The AST helper returns a compact inventory and writes hash-verified
source files outside the analyzed import root, avoiding redundant source text in
stdout. Mapped diagnostics/reasons are bounded independently; exceeding the
output budget yields `tool_error`, never a truncated successful check.

Linux/WSL2 RSS sampling (25 ms) is a practical resource guard, not a hard
cgroup/process-tree memory guarantee. Input/source extraction also uses
the subprocess deadline/output/RSS controls. Temporary files are removed after
success or failure. Checker config, typings and source are local only.

Reports bind artifact/wire hashes, complete context/request/per-unit contexts,
definitions manifest (which binds source hashes, overlay/generator and upstream
commit), context/AST helper/generated declarations, strict config, engine version
and bytes including its entire typeshed, Python target and actual interpreter
version, transformed inventory and limits in `analysisHash`. **Report caching is
disabled**; that hash is provenance, not a cache hit or execution authorization.

## Verification

```sh
npm run build:code
node --test tests/python-checker.test.js tests/python-checker-completeness.test.js
npm run build
FMCAD_TEST_CHECKER_TARBALL=1 node --test tests/python-checker-packaging.test.js
node --test tests/python-admission.test.js tests/python-admission-transport.test.js
node --test tests/library-api-broker.test.js
node --test tests/python-admission-packaging.test.js
```

The last test installs the real tarball offline with lifecycle scripts disabled,
runs outside checkout, checks the actual distributed SDK definitions and bundled
engine, detects argument/Optional/member errors and verifies that a file-write
statement was not executed. Ordinary tests use synthetic immutable definitions
and need no network. The admission packaging test has separate installed raw,
installed helper, and installed transport/API profiles so a single test phase
does not combine multiple real checker passes into one timeout budget. A full
build, unlike runtime checking, refreshes definitions under the existing
producer policy.
