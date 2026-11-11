# Retained assertion audit and required profiles

This document records a historical source/test snapshot. Its counts and local
results are not current task status; remaining work and dependencies are tracked
in Beads.

Source baseline: main `0b84454`; original archive commit
`a26222ff617b0e9597b2a91b50474bdca8d0a0ce`. The archive's Git objects were
read separately from the source checkout. No archive metadata is published.

`tests/live-assertion-inventory.json` records 3,707 static sites in all 36
inventory files plus three live helpers. Each site has its source line, stable
expression digest and occurrence, expression and kind. It preserves duplicate
assertions, parameterized helper calls and embedded Python fragments. The latter
retain complete fragments because multiline assertions and template substitutions
cannot safely be treated as individual JavaScript calls. Static sites are not
runtime assertion counts. Dynamically constructed code requires separate semantic review.

The 20 source files present at the historical baseline contain 1,334 detected sites.
1,333 remain unchanged. The sole changed historical site is the MCP stdio server
name (`autodesk-fusion-mcp` to `fmcad`); current source additionally asserts help
exit status, help usage and the `fmcad_execute` tool. Invocation assertions remain.
The ledger retains the changed expression rather than silently dropping it.

The scenario-unit gate compares the AST inventory and whole-source hashes to this
snapshot. Changes require reviewing individual additions/removals; refreshing
hashes alone is not evidence of equivalent behavior. Later live files are present
in full but require semantic, not merely textual, comparison.

## Required profile manifest

`tests/live-required-profiles.json` separates eighteen registered shared model families,
required retained native obligations and diagnostic helpers/external fixtures.
`node tests/run-live.js --list-profiles` lists it without contacting Fusion.
Native commands are qualification entrypoints with explicit lifecycle and
fixture prerequisites. Targeted local checks may run against the matching build
and configured shared broker. Never adopt user fixtures or count a blocked,
unsupported, or not-run required case as a pass. A helper or fixed external
diagnostic cannot replace a required case.

Legacy registered suites now execute behind exclusive barriers. A failed exclusive
suite blocks later work with failing `not-run` records because restoration is not
established. These barriers sequence exclusive cases within one runner; they are not
interprocess locks. Independent runners share the broker, which serializes physical
SDK turns and must preserve owner/document isolation. Do not impose a manual
Fusion reservation. Global-state safety still requires broker-level support and
actual live validation. Shared model/Fusion scenario concurrency continues to
default to at most two/ten respectively.

## Remaining semantic work

This inventory is an anti-omission aid, not runtime coverage. Each assertion needs
an explicit shared-case/capability mapping or a justified native-only obligation;
machine-readable dispositions live with the test manifests. Existing native
assertions are intact, and no unsupported operation is relabeled as passing.

Validation: 19 inventory/scheduling/live-broker tests passed before adding the
manifest registration check. The entire scenario unit gate and full CI are required
before merge. Native Fusion was not executed.

## Local assertion helper correction

The original 1,588-site count omitted call-site values behind local wrappers such
as `check`, `equal`, `cameraEqual`, `closeNumbers`, and wrappers of those helpers.
The scanner now follows local function declarations and function-valued variables
transitively to assertion calls. This adds 2,119 call sites while retaining every
previously frozen site and its stable ID. These are static assertion-bearing call
sites, not 3,707 independent runtime assertions or a completion percentage.
Wrapper entrypoints and their contained assertions both appear intentionally;
dispositions must describe what each call actually covers. Dynamic dispatch,
imported aliases and computed helper names still require semantic review.

The archive baseline was read again with the corrected scanner. It has 1,334
sites, 1,333 retained; the only removed/changed baseline assertion remains the
explicit MCP server-name change. All later source files retain their complete
source hashes. No shared/native coverage was inferred from finding more sites.
The 40 existing semantic mappings remain valid IDs; newly found sites remain
open until individually reviewed. Four focused inventory/disposition tests pass.

## Immediate source predecessors

`tests/live-assertion-predecessors.json` now records the latest exact archived
version of each of the 39 current sources and its first parent. All 39 current
files match archive bytes exactly. For the data-import, fixed data-import and
sketch TypeScript ports, explicit JavaScript predecessor paths prevent treating
ported assertions as newly introduced. Reproduce against the separately recovered
archive with:

```sh
node dist/tests/scenarios/assertion-history.js /absolute/archive/.git /absolute/output.json
```

The comparison retains 421 removed/changed static sites with their exact old
expressions and 1,197 added-site IDs referencing the current frozen ledger.
These are textual changes, not 421 lost runtime checks: 396 are in the three
TypeScript ports and include formatting, wrappers and type-related access syntax.
Their individual semantic review remains open. This comparison covers the latest
source change, not every earlier intermediate revision across archive branches.

Reviewed non-port changes:

- Animation adds frame/video validation and an explicit optional-encoder blocked
  path; success checks become conditional only for that declared path. The camera
  manifest checks remain unchanged. Native frame validity remains unqualified.
- Component hierarchy adds a linked occurrence and changes the later parts count
  from one to two, with exact definition-token and 50 mm placement checks.
- CAD moves the active-document assertion to the guarded owner. Extended CAD and
  motion snapshots filter through the old broker visibility helper; this is not
  evidence that unrelated user documents were independently audited. Shared runner
  snapshots enumerate all documents and do not inherit that filter.
- Extended CAD makes the failed-check batch explicitly non-atomic, preserving its
  per-step output contract. Atomic rollback remains a separate open obligation.
- Legacy removes `assert.equal(state.active, name)` without a replacement at the
  same point. The shared creation receipt now restores that immediate observation
  before guarded target selection, with a mapping to the exact predecessor commit;
  unchanged current-source hashes alone could not certify this history.
- Motion removes the `--after-styles` precondition while keeping explicit `--run`.
  The new exclusive barrier prevents overlap but does not establish this historical
  ordering prerequisite or prove native state restoration.
- GM07 changes fixed build equality to installed-package self-consistency and an
  optional expected candidate. This is a changed qualification prerequisite;
  native registration requires an explicit offline-qualified build pin.
- MCP changes the advertised server name and adds help/tool checks, as previously
  recorded. Multidocument adds SDK interval/count checks and fixes null-to-None
  rendering for active-document restoration; previous numeric assertions remain.

These findings do not increase the 79 shared semantic mappings or close B1.
No old source, expected geometry, ownership guard or runtime failure was removed
by this audit. No native execution or complete per-assertion disposition is
established by this snapshot.


## Historical style-disposition snapshot

This snapshot recorded 157 reviewed mappings: 138 shared assertion sites,
18 explicitly blocked native-solid sites and one removed predecessor assertion.
Twelve appearance metadata and thirteen explicit body-assignment checks preserve
individual historical expressions. The 3,551 remaining current static sites still
need semantic disposition; wrapper sites overlap and these are not runtime coverage
percentages. Required-model registration contains 18 families, with transactions
still blocked by the production settlement contract. Texture, inherited styles,
physical mass and complete style-suite wrapper/cleanup equivalence are not
established by this snapshot.

## Historical syntax-only review of the JavaScript-to-TypeScript ports

`tests/live-assertion-port-review.json` partitions all 396 removed static sites in
the three ports. One-to-one pairs must match the parsed expression after only
formatting/quote spelling, literal property-access spelling, parentheses and erased
TypeScript assertions are normalized. Regex bytes/flags, raw templates, values,
operators, optional access, comma operators and array holes remain significant.
Ambiguous matches remain unpaired; replacement IDs cannot be reused. Source/predecessor
commits and both frozen source hashes remain attached to each partition.

| Source | Syntax-only pairs | Still open |
| --- | ---: | ---: |
| live-data-import-fixed.ts | 55 | 33 |
| live-data-import.ts | 75 | 61 |
| live-sketch-operations.ts | 8 | 164 |
| Total | 138 | 258 |

This is evidence about individual expression syntax only. It does not prove helper
implementations, call order, asynchronous transport behavior, fixture ownership or
native execution equivalent, and adds no shared/native migration dispositions.
The 258 unpaired port sites, other historical changes and intermediate revisions
were not semantically qualified by this syntax-only review. Eight focused
inventory/history/disposition tests passed for that snapshot.

Reproduce without consulting live Fusion:

```sh
node dist/tests/scenarios/assertion-port-review.js /absolute/output.json
```

## Attribute transition assertions

Thirteen historical `live-entity-attributes.js` checks now point individually to
literal assertions in `attribute-cases.ts`: first-write changed/null predecessor,
body owner kind/token, update changed/previous/current value, same-value no-op,
and exact/group count/name/value. The owner suffix on first/second values makes
cross-document leakage observable; it does not change the transition contract.
The same scenario body is used for both backends; this review is not native
qualification.
The original unsaved-file guard, legacy CLI envelope and invocation-count helpers
are deliberately not represented by these mappings: saved owned fixtures and the
public transport need their own explicit disposition, not a claim of identity.
The inventory test rejects disappearance of each assertion anchor.

Runtime compilation and all ten focused tests pass, including MCP/addin at
concurrency 1/2/10, assertion cleanup, foreign-token rejection/readback, and the
same sequence against archived a262 attribute handlers and current handlers.
This adds thirteen reviewed sites, not completion of the full assertion audit.

## Thread catalog input mismatch predates migration

The first extracted thread recipe run failed at the original live query
`M10x1.5`: the curated catalog accepts nominal names such as `M10`, while installed
Fusion ThreadInfo uses the full designation. Baseline `a26222f` in
`assets/cad/thread.py` has the same nominal-key table and exact query filter as the
current adapter. The later live test commit `b45f4f2` introduced the full-designation
query into `tests/live-thread-method.js`. This is evidence of an existing test/input
contract mismatch, not evidence of a refactor regression or native Fusion success.

The shared recipe scenario therefore separately verifies the supported `M10`
query (one entry, 1.5 mm pitch and two-start 3 mm lead) and exact rejection of
`M10x1.5`, with independent geometry/timeline readback after the rejection. It
leaves the frozen live test unchanged and does not map its positive catalog query
as migrated. The expected rejection follows the baseline's explicit nominal-name
lookup; changing the public catalog to accept aliases would be a separate API
extension. A hash-bound extracted historical function/table fixture runs both
queries against baseline and current handlers on owned documents.

Nine custom-profile and pair-fit assertions retain their original input quantities,
expected results and 1e-9 tolerances. These are analytic recipe calculations, not
native cosmetic-thread features or helical geometry. They now have individual
source-ID mappings and literal shared assertion evidence. These recipes do not
qualify native thread features, selection, BRep or runtime invocation behavior.
