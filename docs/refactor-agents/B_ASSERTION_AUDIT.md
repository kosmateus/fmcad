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

`tests/live-required-profiles.json` separates thirteen registered shared model families,
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
