# Agent B assertion audit and required profiles

Source baseline: main `0b84454`; original archive commit
`a26222ff617b0e9597b2a91b50474bdca8d0a0ce`. The archive's Git objects were
read separately from the source checkout. No archive metadata is published.

`tests/live-assertion-inventory.json` records 3,707 static sites in all 36
inventory files plus three live helpers. Each site has its source line, stable
expression digest and occurrence, expression and kind. It preserves duplicate
assertions, parameterized helper calls and embedded Python fragments. The latter
retain complete fragments because multiline assertions and template substitutions
cannot safely be treated as individual JavaScript calls. Static sites are not
runtime assertion counts. Dynamically constructed code still needs semantic review.

The 20 source files present at the historical baseline contain 1,334 detected sites.
1,333 remain unchanged. The sole changed historical site is the MCP stdio server
name (`autodesk-fusion-mcp` to `fmcad`); current source additionally asserts help
exit status, help usage and the `fmcad_execute` tool. Invocation assertions remain.
The ledger retains the changed expression rather than silently dropping it.

The scenario-unit gate compares the current AST inventory and whole-source hashes
to this ledger. Changes require reviewing individual additions/removals; refreshing
hashes alone is not evidence of equivalent behavior. Later live files are present
in full but their immediate-predecessor semantic comparisons remain outstanding.

## Required profile manifest

`tests/live-required-profiles.json` separates eighteen registered shared model families,
required retained native obligations and diagnostic helpers/external fixtures.
`node tests/run-live.js --list-profiles` lists it without contacting Fusion.
Native commands are qualification entrypoints, not authorization to run unconverted
fixtures: their lifecycle prerequisites and pending migration state are explicit.
G must keep pending, unsupported, blocked and not-run required cases failing final
qualification. A helper or a fixed external diagnostic cannot replace a required case.

Legacy registered suites now execute behind exclusive barriers. A failed exclusive
suite blocks later work with failing `not-run` records because restoration is not
established. This is conservative scheduling within one coordinator, not an
interprocess Fusion lock or proof that historical UI cleanup is complete. Run only
one coordinator per Fusion instance. Shared model/Fusion scenario concurrency
continues to default to at most two/ten respectively.

## Remaining semantic work

This audit is an anti-omission gate, not completion of B1 or B4. Every assertion
still needs an explicit shared case/capability mapping or justified native-only
obligation. Transactional/file migration, shared reopen identity handoff, broader
analytical geometry, and global-state setup/restoration remain open. Existing native
assertions are intact; no unsupported operation was relabeled as passing.

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
  final native registration still needs an explicit offline-qualified build pin.
- MCP changes the advertised server name and adds help/tool checks, as previously
  recorded. Multidocument adds SDK interval/count checks and fixes null-to-None
  rendering for active-document restoration; previous numeric assertions remain.

These findings do not increase the 79 shared semantic mappings or close B1.
No old source, expected geometry, ownership guard or runtime failure was removed
by this audit. Native execution and complete per-assertion disposition remain open.


## Current disposition checkpoint — local styles

The ledger now has 157 reviewed mappings: 138 current shared assertion sites,
18 explicitly blocked native-solid sites and one removed predecessor assertion.
Twelve appearance metadata and thirteen explicit body-assignment checks preserve
individual historical expressions. The 3,551 remaining current static sites still
need semantic disposition; wrapper sites overlap and these are not runtime coverage
percentages. Required-model registration contains 18 families, with transactions
still blocked by the production settlement contract. Texture, inherited styles,
physical mass and complete style-suite wrapper/cleanup equivalence remain open.
