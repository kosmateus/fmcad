# Prepared Python artifacts

`packages/core/src/domain/python-artifact.ts` defines the immutable version-1
artifact: source units (including embedded user scripts), context/request JSON,
cad-v1 runtime version, source map, SHA-256 of each unit, exact UTF-8 bytes and
wire hash. A separate artifact hash binds the metadata, map and unit inventory.
The Node implementation is in `packages/node-adapters/src/python`; preparation
does not call Fusion and does not create another SDK executor.

`pythonValue` retains the existing JSON policy: Unicode travels as ASCII escapes,
booleans/null round-trip through `json.loads`, nonfinite JS numbers become JSON
null, absent object fields disappear, and cyclic values/BigInt fail locally.
Top-level undefined fails explicitly. Never interpolate raw JSON as Python code.

`cadBundleManifest` is the explicit inventory and initialization dependency graph.
Preparation rejects missing/unlisted files, duplicate module IDs or paths,
missing dependencies and cycles, including invalid unused modules. The light
document-status profile includes only values, the value adapter, core, identity
and document snapshot; it does not transmit modeling families.

Assembly/geometry standalone compatibility facades retain their manifest IDs and
source-map entries. During Fusion preparation, `python/compatibility.ts` requires
the reviewed bootstrap digest and its canonical runtime dependency, then emits
an explicit initialization assertion in place of the filesystem/exec fallback.
All canonical handler source units remain present and checked; this is not a
unit exclusion or checker exception. The standalone asset files are unchanged.
An edited facade (including newly appended Python) rejects preparation until its
contents and preparation rule are reviewed. Registry owner names are emitted as
string literals with the same values, without introducing a dynamic JSON type.

`runtime/python/fmcad/domain/values.py` imports without `adsk`. It owns JSON-only
DTO projection, field/direction validators and collision-detecting handler
registry. The Fusion projection lives in `adapters/fusion/values.py`; SDK entity
resolution, UnitsManager, app/document/design and native callbacks stay in the
existing adapter implementation. `assets/cad/core.py` remains the standalone
compatibility source for old offline fixtures. Bundle preparation substitutes
its three pure/value implementations with aliases to the extracted units and
installs the strict registry. The bundled runtime does not execute both copies.
Only the manifest-declared legacy `shape.helix` and `model.thread` ownership
transfers may overwrite handlers; sketch retains its existing checked pop/replace.

The canonical catalog also composes the retained assembly, geometry and
[document/evidence/I/O families](PYTHON_DOCUMENT_IO.md). Document/I/O units use
`compatibilityPath` solely to account for a retained standalone asset during
inventory validation; the prepared artifact reads the unit's canonical runtime
`path`, not that compatibility source. Missing or duplicate compatibility
inventory entries still fail locally. A runtime unit's `owner` supplies the
original family registration prefix. Rule and use-case units do not register
handlers or take ownership. The full default bundle executes without a checkout,
family preloads or runtime filesystem loading; legacy standalone consumers are
separate compatibility entrypoints, never a second copy inside that bundle.

Positions are one-based. `<fmcad-artifact>` locations map across concatenation
separators to prepared source-unit filenames/lines. Literal `compile` user code
is an independent `user` source unit with its original filename, not merely a
string in an analyzed wrapper. Maps describe **prepared** source (including
compatibility rewriting), not unmodified asset bytes. Consumers must check every
unit, including embedded units, and preserve `artifact.sha256` through admission.
Transport instance/receipt metadata must not rewrite an already checked script.

## Offline checks

`tests/python-artifact.test.js` covers deterministic units/bytes/maps, immutable
metadata, tamper rejection, embedded source positions, manifest failures, full
bundle import against an SDK stub, strict registration and single dispatch.
`tests/python_values_test.py` checks real clean import without adsk and rejects
opaque/nonfinite DTO values. These checks do not prove live SDK execution,
native transaction rollback or physical CAD correctness.

## Wrapper and transport integration

The transitional `src/python.js` loads the staged Python adapter at
`src/dist/python`. The build stages that adapter and runtime Python
sources into the installed dist; consumers keep the shared runtime-path resolver
and run's original accepted-input byte hash. CAD, cad-v1 run, legacy operations,
atomic and internal CAD wrappers use prepared artifacts. Existing string-returning
builder APIs remain compatibility facades.

The private broker binds receipt path, RPC/instance identity and transport-specific
wrappers **before** preparing final wire bytes. Its AST-only local Python process
(`entrypoints/source_units.py`) recursively extracts literal `compile` sources,
including user code nested beneath both run and receipt wrappers. It never imports
the SDK or executes a script. Invalid syntax hidden inside literal compile calls
fails before physical dispatch. Dynamic/evaluated compile inputs are not resolved;
this extraction is not a sandbox or a replacement typechecker.

RPC journals retain final wire/artifact hashes and per-unit hashes/maps; the receipt
binding includes the pre-receipt source hash. The final artifact is verified before
dispatch, and no later code rewriting occurs. Receipt/native completion matching
checks the source hash when present while preserving older records without it.
Preparation failures do not mark an RPC as dispatched. SDK budget is rechecked
after local preparation. No unknown outcome is replayed, and the public transport
clients remain discovery-only. This is a preparation boundary for the separate
offline-checker/admission work, not a claim that typechecking is already enforced.
