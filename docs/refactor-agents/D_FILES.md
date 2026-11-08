# Agent D — files, import/export, references and publication

Status: **claimed by Agent D** (8 November 2026), starting from `0b84454`. Read
[the shared plan](../REFACTOR_PARALLEL_PLAN.md).

## Outcome and ownership

Complete file-dependent modeling workflows with exact source/destination identity,
version lineage, durable results and safe recovery. A successful transport reply
must never be confused with cloud completion or successful native file content.

Own `src/data-import.js`, `references-refresh.js`, `externalization.js`,
`drawing-package.js`, `drawing-export.js`, `drawing-check.js`, relevant document
publication composition, document/reference/import application services,
family-specific persistence/Python adapters, and non-live tests. Python scope
includes data_import, references, externalization, io, document/file operations
and corresponding domain/application modules and compatibility loaders.

Exceptions: A owns authenticated stage/operation journal primitives, broker
saved-fixture control and recovery/epoch infrastructure; B owns shared scenarios,
simulator and all live files; C owns geometric/assembly behavior; E owns public
registration/help and host image/reference-image tools. G owns shared build/CI
configuration. Use existing publication and stage APIs rather than redesign them.

## D1 — source and evidence inventory

Compare each path with `a26222f` where present and its immediate pre-extraction
revision. Reuse already migrated document publication and journal behavior;
PRs/stages 4g, 4h, 4l and 4r are delivered foundations. Keep acceptance/publication
separation, source pins, receipt-only replay and exact version ownership.

Inventory import source modes, replacement/lineage, reference policies, cold
open/close, derived dependencies, externalization ownership, drawing/export
formats and artifact publication. Map every branch to a test or explicit native
requirement. Check installed paths and foreign/incomplete/malformed results.

## D2 — migrate import and reference workflows

Move remaining Node orchestration to strict typed composition/ports/adapters.
Preserve synchronous input pinning and file hashes before asynchronous work.
Test source replacement during checking, duplicate/ambiguous file names,
changed document/file/version, target read-only state and foreign owner receipts.

For reference refresh, retain preserve/latest semantics, plan-time version pins,
mixed-parent and self-reference guards, graph/health checks and immutable plans.
Unknown updates never escalate to a second native command, save, close or replay.
Keep qualified fallback behavior, watcher lifetime and poststate evidence.
For imports, preserve replacement/lineage and deterministic errors without
silently creating duplicates. Compare expected call counts before and after.

## D3 — externalization, save and artifact lifecycle

Separate pure planning from Fusion mutation in large Python reference and
externalization modules. Keep strict checker coverage for generated paths and
the pinned Autodesk interfaces. Test partial success, failed save, accepted but
processing save, version increment, readback, reopen identity and cleanup failure.
Read original evidence after response loss; do not resubmit a possible mutation.

Review file artifact staging, atomic publication, manifest ownership, path and
descriptor validation, output overwrite rules and packaging. Genuine missing
files must remain distinct from failed inode/path verification. Preserve original
artifacts on parse/validation failure and never silently present fabricated bytes
as successful export. Changes to A's journal primitives need an explicit handoff.

## D4 — drawing/export and shared fixture integration

Finish drawing package/export/check service migration and file verification
contracts. Include path mappings, supported format options, error propagation,
partial output cleanup and publication boundaries. Geometry/rendering validity
belongs to native qualification; file existence alone is insufficient.

Provide B fixtures for saved versions/reopen, imports, references, roundtrip and
exports, including every supported positive/negative historical assertion.
Model files are marked JSON; their semantics can test identity/version/state but
cannot qualify F3D/STEP/STL/PNG. Keep native format/physical property assertions in
the common scenario inventory. Fixed original assets require owned test copies.

## Completion and checks

Run family-specific paired historical tests, real Python admission, strict
build/types/lint, fault injection at save/import/publish/delete boundaries,
immutable plan/journal tests and installed public CLI/SDK consumers. Coordinate
both transport profiles with A/B and require full CI on every merge head.

Exit when assigned Node services have one typed implementation, Python family
boundaries are verified, source/destination/version and ownership are enforced,
all known partial/unknown outcomes retain evidence without replay, and B/G have
shared scenario contracts plus native format/async-cloud assumptions. Preserve
existing behavior while separating new feature requests from refactor work.
Append PR/SHA, checks and remaining work after each group; the whole assignment
includes imports, references, externalization, save/publication and drawings.

## Execution ledger

- Claimed after reading the shared plan and D1–D4 and checking merged PRs
  through #35. PR #34 is the latest behavioral foundation; PR #36 claims B.
- Preserve A-owned journal/stage APIs, B-owned shared/live tests and E-owned
  registration. Record proposed integration contracts here and in each PR.
- Native Fusion and genuine native-format qualification remain pending.
- D1–D4 are in progress; this claim is not implementation completion.
