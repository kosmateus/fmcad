# Assembly and mechanical runtime families

The family-owned manifest is
`packages/node-adapters/src/python/assembly-manifest.ts`. It declares the pure
domain units, the sequence application unit, SDK adapters and temporary asset
compatibility entries. The real `bundle.ts` composes these units **in the existing
family positions** in the canonical `cadBundleManifest`, with no duplicate family
nodes. CAD/run wrappers, prepared artifacts, the checker and installed staging
therefore consume the same migrated sources; no test-only preload is necessary.

## Boundaries

| Family | SDK-free rules/data in `runtime/python/fmcad/domain` |
| --- | --- |
| assembly | Names, nested placement options and numerical pose deltas |
| pose | Schema/state validation, reference keys and manifest DTO construction |
| mechanism | Numeric validation and driven-value evaluation from plain coupling data |
| route3d | Centerline sampling, transport frames, arc/bend/contact/station calculations |
| sequence | Planar geometry, directions, distances and schema validation |
| spring | Quantities, helix samples, world points and engineering metrics |
| thread | Profile fields, number validation, unresolved/multi-start lead and quantity DTOs |
| fastener | Numbers, locating degrees of freedom, pressure and barb profile points |
| gear | Gear system, diameter plan, undercut, flank sampling and points |
| sheetmetal | Vector rules, rotation and formed/flat neutral-axis walks |
| definitions | Durable IDs and ordered regeneration-binding selection |

`application/sequence.py` returns a plain-data assembly/disassembly plan. It does
not execute operations or introduce a workflow language. Definitions continue to
use the existing batch runner and native feature-edit adapter; there is no second
recipe executor.

`adapters/fusion/<family>.py` contains the sole handler implementations. Expression
resolution remains in the SDK adapter at its original position relative to
validation and writes. It retains the existing shared helpers, context switches,
occurrence/root/native identity, matrix conversions, readbacks, restoration,
uncertain recipe fences and refusal behavior. No SDK entities or SDK context are
passed to the pure functions. Existing unsupported native representations remain
unsupported, not simulated as new capabilities.

The remaining `assets/cad/<family>.py` files are temporary compatibility loaders
for standalone offline fixtures launched from the repository root. They contain
no handler/helper copies. In prepared bundles the declared runtime units execute
first and the compatibility guard is a no-op: the transmitted artifact must never
read local repository files. These loaders are not an alternative runtime loader
for Fusion; the explicit bundle manifest owns that initialization.

The retained concatenated namespace intentionally preserves existing late-bound
cross-family helpers, including vector helper replacement order. This migration
does not silently isolate or rewrite those legacy bindings. Runtime registry
owners are set explicitly in the adapters; only the existing helix and thread
ownership transfers are permitted.

## Offline verification

After `npm run build:code`:

```sh
python3 -B tests/python_assembly_parity_test.py
node --test tests/python-assembly-bundle.test.js
python3 -B -m unittest discover -s tests -p '*_test.py'
```

The comparative oracle in `tests/fixtures/python-assembly-parity.json` was
captured from pre-migration commit `23cc436`. It contains no executable baseline
handlers: only the 71 family-owned operation names and hashes/counts for 167
behavioral cases across all eleven families (168,522 fake-SDK call/return events).
Ordinary verification needs no Git history. Explicit baseline recapture is a
maintenance operation, not an automatic test update:

```sh
python3 -B tests/python_assembly_parity_test.py --record-baseline 23cc436
```

The trace records ordered fake context/SDK calls, arguments and results, including
entity/native/proxy tokens, scope paths, expressions and creation methods. It
normalizes only timestamp-bearing JSON, fixture namespaces and depth-limited
opaque fixture state. Existing family tests separately assert actual outputs,
transforms, identity, native writes and refusal behavior. Both compatibility and
strict-registry runtime execution must match the same oracle. Pure-module imports
are tested with SDK imports forbidden.

The bundle test uses the canonical default manifest (without injecting units),
executes actual prepared units against an SDK stub with filesystem reads blocked,
checks every family-owned registration, tests dispatch/collision rejection and
ensures the document-status profile excludes these families.

These are offline fake-SDK checks, not live Fusion, solver/kernel verification or
physical mechanical validation. No live operation or remote push is part of this
migration.
