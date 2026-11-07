# Bounded inspection packs

**Status: integrated in `integration/generated-python-types`; official checker
passes `entity.list` and `inspect.pack` with zero diagnostics.** The direct strict
replay of the complete prepared pack also reports zero diagnostics. These are
checker-only results: no CAD/SDK request was dispatched, so they do not establish
native Fusion behavior or physical acceptance. The bounded ticket stays open for
any required master/admission integration. See [checker diagnosis](INSPECTION_CHECKER_DIAGNOSIS.md)
and the exact [strict replay](inspection-strict-report.json) /
[official checker report](inspection-official-check.json). An optional check of
the `document.status` light profile is recorded separately because its 20 helper
diagnostics are unrelated to Inspection: [light-profile report](inspection-light-profile-check.json).

`inspect.pack` is a standalone readonly CAD operation composed by the normal
CAD service, prepared-artifact graph and broker. It creates no scheduler,
executor, registry or second bundler. Use the same `--doc`, `--doc-id` and
`--doc-file-id` pins as for individual reads:

```sh
fmcad inspect pack --doc Scratch --doc-id DISCOVER_CREATION_ID --data '{"reads":[{"id":"bodies","operation":"entity.list","data":{"kind":"body"},"fields":["entities"]}],"maxItems":20,"maxBytes":65536}'
```

This example was not run in Fusion. Inspect the actual document identity before
executing it. Do not substitute an unrelated user document for a test scratch.

## One inventory, explicit eligibility

The **existing catalog** owns the `inspectionSafe:true` opt-in. The planner
projects only public, readonly Python contracts with this marker; the runtime
still dispatches through `CadContext.call` and its existing `CAD_HANDLERS`.
Initially eligible: `entity.list`, `entity.inspect`, `entity.find`,
`entity.stats`, `selection.inspect`. This deliberately does not infer purity
from `readOnlyRequested`: some readonly operations have viewport/file effects.
Unregistered, non-opted-in, mutating, Node-only and recursive operations return
`unsupported` without dispatch. Every supported read reuses the existing
catalog/specialist preflight: malformed pack shape, unknown keys, missing
required keys and specialist validation failures reject locally before
preparation or any SDK turn. This does not invent stricter nested schemas for
legacy handlers. Handler-only validation and unresolved native references are
individual read errors inside the readonly turn. Opaque or cyclic inputs cannot
enter the JSON artifact.

The adapter shares one invocation-local entity inventory by entity kind and
exact component/occurrence wrapper identity. It returns copies to existing
callers and restores the context's original `_entities` method in `finally`.
It does not cache tokens, query results, SDK handles or inventory across turns.
Equivalent scope wrappers that are distinct Python objects may miss this cache;
there is no guess that names or transient tokens imply identical contexts.

`document.status` stays on its independent lightweight bundle profile. It is not
added to the pack inventory by this task. Packs are not nested batch steps or
raw run-helper inputs: ordinary CAD preparation supplies the validated plan and
inventory. `batchAllowed:false` rejects accidental batch use before effects.

## Bounds and evidence

| Input            |              Default | Allowed                               |
| ---------------- | -------------------: | ------------------------------------- |
| `reads`          |             required | 1..100, distinct 1..64 character IDs  |
| `reads[].fields` | all top-level fields | 1..32 distinct top-level names        |
| `maxItems`       |                  100 | 1..1000 entries per object/array      |
| `maxDepth`       |                    8 | 1..16 result levels                   |
| `maxStringBytes` |                 2048 | 16..8192 UTF-8 bytes                  |
| `maxBytes`       |                65536 | 1024..1048576 serialized result bytes |

The complete planned request is capped at 262144 UTF-8 bytes. `maxBytes` applies
to the result object, **not** the outer CAD envelope or transport framing. Byte
accounting uses the runtime's actual JSON encoding, including Unicode escapes.
Projection never invents a missing field; `missingFields`, `maxItems`,
`maxDepth`, `maxStringBytes` and `maxBytes` are explicit partial reasons.
Oversized rows omit their result; a tiny budget may omit status rows with an
explicit `omittedReads` count. Result projection charges a shared byte and node
budget during traversal too, so a deeply branching DTO or many long strings do
not create an unbounded projected copy before the final size check.

An individual read error returns `error` and later reads continue. Unsupported,
error, truncation and nested nonpassing evidence make the pack `partial`.
`pass` means a complete read/projection, **not** model acceptance, physical
correctness or precision qualification. Existing result DTOs, refs, units and
nonpassing statuses are retained unless the caller explicitly projects/truncates
them. `modelValidation` is always `not-performed`.

These limits bound output, not the original native traversal or the work of
existing inspection handlers. A large native inventory may still be expensive;
there is no promise that a projection avoids that SDK cost.

## Shared source cache and unchanged admission

The existing `cadBundleUnits` loader has a bounded, four-entry immutable source
unit cache, keyed by installation, selected graph/profile, full manifest,
current source bytes and `runtime-build.json` bytes when present. Every call
still validates the entire inventory and dependency graph and reads/hashes the
current selected source bytes. Changed, missing or unlisted sources cannot be
hidden behind an old entry. There is no independent inspection loader.

Only transformations such as prepared-core substitution and source-unit
allocation are reused. Every artifact is rebuilt and hashed with its own exact
wrapper, request and context; source maps, embedded units and identity checks
remain intact. Checker/admission is not cached or skipped. The checker retains
its own build/source/context provenance and its existing `cache:disabled`
policy. A cache hit is never permission to dispatch a nonpassing artifact.
The two Inspection sources are canonicalized to LF only in their prepared unit
text so `core.autocrlf` cannot change their wire hashes. The cache key still binds
the exact raw text read from disk, graph, manifest and build identity.

## Current type/checker evidence

Approved generated-Python types and the static compatibility-loader fix are
integrated into `integration/generated-python-types` at
`dc50a7909a6ce329a2f0513104bb15a0346543ba`. On the complete prepared 20-read
`inspect.pack` artifact, basedpyright `1.40.2` in `bundle` context reports zero
strict diagnostics across all 123 runtime units and the wrapper (124 source
units and source maps). The verified Autodesk definitions snapshot is
`83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179`.

The official distributed checker from the admission build also returns
`passed`, with zero diagnostics, for both the single `entity.list` request and
the complete 20-read pack. Pack wire SHA-256 is
`86d2ab942d1ed0bd0c142eb628fb7b11457ea1df55c32c86addc4de353ddabb7`, artifact
hash `6e97e24a7785cf3a78bb514c6fd2ec6e95bca3c79cfa424ea2c2d2bbbaee35cc`, and
exact prepared size 2,064,965 B. The official report is checker-only and records
`sdkDispatched:false`; no native dispatch or Fusion execution is claimed. Full
source IDs, map entries, hashes and checker provenance are in
`inspection-strict-report.json` and `inspection-official-check.json`.

## Reproducible offline comparison

```sh
npm run build:code
npm run typecheck:tests
node --test tests/inspection.test.js tests/python-artifact.test.js
python3 -B -m unittest discover -s tests -p inspection_test.py
# Requires the verified full-build definitions snapshot in dist/runtime/python/typing.
# SourceRoot points at the integrated target worktree; outputs go under /tmp/opencode.
node tests/inspection/strict-report.cjs /tmp/opencode/inspection-strict /tmp/opencode/fmcad-backlog/types-integration
# Use the current distributed checker build, not an older workspace checker.
FMCAD_INSPECTION_CHECKER_ROOT=/tmp/opencode/fmcad-backlog/python-admission/dist node tests/inspection/official-check.cjs /tmp/opencode/inspection-official-check.json /tmp/opencode/fmcad-backlog/types-integration
# Requires a verified SDK producer snapshot from the authorized full build.
# build:code alone intentionally does not fetch or fabricate SDK definitions.
FMCAD_INSPECTION_CHECKER_ROOT=/tmp/opencode/fmcad-backlog/python-admission/dist node --experimental-strip-types tests/inspection/benchmark.ts /tmp/opencode/inspection-benchmark.json /tmp/opencode/fmcad-backlog/types-integration
```

`strict-report.cjs` first verifies the full bundle source inventory and byte
hashes inside the actual prepared `inspect.pack` artifact (all runtime units plus
the wrapper), then runs basedpyright with strict rules and the verified SDK
snapshot. It exits nonzero if either inspection unit has any diagnostic. It is a
direct source-typing replay, not a production checker certificate.
`official-check.cjs` submits the same complete hashed artifact/context to the
actual bounded checker implementation, never dispatches an SDK request, and
records non-passing output as `incomplete` rather than manufacturing a pass.
The final source root canonicalizes only the newly added Inspection source units
to LF before artifact hashing; the source-cache key still binds the exact raw
source bytes. This keeps prepared maps and SHA-256s reproducible across checkout
line-ending settings without editing the shared compatibility loaders.

The comparator executes 20 identical readonly requests (10 entity kinds,
repeated twice) through real generated individual, batch and pack wrappers. It
checks result equality before reporting counters. The Python fake uses the
existing list handler and pack adapter, counts fake transport calls, serialized
request bytes, actual fake stdout response bytes (including wrapper progress
markers), native-inventory stand-in traversals and identity assertions.
Preparation timings include the existing artifact verification/hashes. Both
first-observed and repeated preparation are measured for each strategy in one
process. Later strategies may reuse the shared runtime source cache warmed by
the earlier strategy; order is fixed. This is not an independent cold-cache or
statistical cold/warm performance study.

**Batch scope:** this is the existing generated `atomic_start` payload, not a
claim that an entire native atomic workflow needs one RPC. The fake evaluates
its read steps but does not simulate native command creation, rollback,
identity-resolution, polling, receipts or finalize. Those extra RPCs and effects
are outside this payload comparison. Non-atomic batch scheduling is not
collapsed by this benchmark. Full native timing and broker RPC/byte counts are
`null` / not measured.

The benchmark now requires verified SDK definitions in
`dist/runtime/python/typing` (or the fixture-only
`FMCAD_INSPECTION_DEFINITIONS_ROOT` path to an existing verified producer).
It first requires the same positive guarded `Point3D.create` SDK control as the
installed checker fixture to pass. Missing definitions or a broken positive
control stop the benchmark instead of being counted as successful operation.

Every prepared artifact is also submitted to the real local checker, with
actual checker time, status, reasons and provenance retained in the report.
The fake execution is **not native admission**. Missing definitions, incomplete
type information or checker errors are reported, not silently treated as
passing. No request with a nonpassing report is dispatched to Fusion. SDK
definitions are deliberately not fabricated to make the benchmark green.

The committed [measurement report](inspection-benchmark.json) is an offline
snapshot, not a live speed guarantee. Interpret pack versus the existing batch
payload as well as versus individual calls: it may save nothing in RPCs and
can send more bytes than batch. No live Fusion, geometry, fit or manufacturing
validation was performed.

### Recorded result

Snapshot: 2026-10-27 14:52 UTC, Node `v24.15.0`, target commit
`dc50a7909a6ce329a2f0513104bb15a0346543ba`, distributed checker build
`baf37fdf801bb0805e1a5aef0ef5f5d331364709`, and verified definitions snapshot
`83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179`. The guarded
SDK control passed. The pack source inventory has 123 runtime units plus wrapper.

| Measured quantity                                |                  Individual | Atomic-start payload |          Pack |
| ------------------------------------------------ | --------------------------: | -------------------: | ------------: |
| Fake transport calls                             |                          20 |                    1 |             1 |
| Serialized fake request bytes                    |                  42,886,448 |            2,144,417 |     2,146,268 |
| Fake stdout response bytes                       |                      15,560 |               11,307 |        13,071 |
| Equivalent read-result bytes                     |                      11,280 |               11,280 |        11,280 |
| Entity inventory traversals in fake              |                          20 |                   20 |            10 |
| Identity assertions in fake                      |                          20 |                    1 |             1 |
| Prepared script bytes                            |                  41,266,908 |            2,062,879 |     2,064,993 |
| First preparation + artifact verification, ms    |                   11,454.68 |               531.86 |        596.78 |
| Repeated preparation + artifact verification, ms |                   11,521.91 |               539.93 |        572.26 |
| Real checker calls                               |                          20 |                    1 |             1 |
| Real checker elapsed, ms                         |                  446,863.76 |            22,621.66 |     23,135.39 |
| Checker status                                   | 16 `passed`, 4 `tool_error` |         `incomplete` |      `passed` |
| Checker detail                                   |       4 memory-limit errors |          `reportAny` | 0 diagnostics |
| Checker-only eligible                            |                       false |                false |          true |

All strategies have identical semantic result data in the fake. Pack sends
**1,851 more request bytes** and **1,764 more fake response bytes** than the
existing atomic-start payload, with **no additional RPC reduction**. The
invocation-local inventory halves repeated fake collection traversal in this
specific case; that is not measured native SDK savings. Warm pack preparation
is close to warm batch preparation. No statistical timing claim is made from
one sample. The official checker passes the pack artifact and the individual
`entity.list` acceptance check, but the 20-check individual loop contains four
process memory-limit failures and the batch report is `incomplete` for
`reportAny`. No SDK request was sent, so `packDelivered:false` remains correct.
