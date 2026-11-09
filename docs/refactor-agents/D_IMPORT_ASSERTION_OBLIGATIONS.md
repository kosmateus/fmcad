# Retained import assertions and native handoff

The frozen inventory contains 482 sites: 166 fixed import, 285 ordinary import,
and 31 receipt helpers. `tests/scenarios/assertion-dispositions-import.json`
accounts for each original ID and expression. It does not change the inventory.

139 sites now point to the same pure validation bodies used by the native
callers: fixed fixture/runtime/result parsing, all ordinary import operation
result families, local CLI outcome checks, public worker receipt parsing and
document baseline comparison. `tests/live-import-contracts.test.ts` and
`tests/live-import-receipt.test.ts` exercise nonempty valid inputs, malformed
fields, wrong identities/outcomes and actual local catalog/placement commands.
The current pure boundary run passed **13/13 tests, 0 skipped**, covering the
139 mapped contract sites, real local CLI commands, original-request durable
intent/recovery and child-owner/process uncertainty fences.

343 sites retain specific native or installed-owner obligations. The mapping
separates fixed-source identity, creation, parameter effects, catalog occurrence
identity, measured placement, STEP/COTS replacement, failed-worker/readback
evidence, request pins and final cleanup. An installed-runtime precondition is
listed in its native invocation context; this does not imply that file hashing
or DTO validation intrinsically requires Fusion. Native qualification is
**NOT RUN**.

Ordinary import uses `nativeImportScenarios()` and the existing ScenarioSession.
The parent durably creates the exclusive unsaved fixture before launching the
compiled retained runner. The child validates the lease against the original
creation receipt and coordinator inventory; every installed CLI command gets a
durable request intent, exact name/creationId pins and PID/birth evidence before
admission. Observations use that same command path. The former unjournaled raw
backend path is refused under an owned lease. No synthetic CLI exit status is
introduced: creation checks read the actual parent broker execution and all CAD
checks retain actual installed CLI and independent original worker results.

Twelve lifecycle sites moved with their semantics. The mapping records each
relocation explicitly: backend initialization becomes owned-lease validation;
raw creation becomes inspection of the original parent creation; closing moves
to the shared idempotent lifecycle. The retained post-close absence, protected
document comparison and active-document restoration assertions run against a
new observation after shared cleanup. Missing child completion, active or
unverifiable child processes, unknown original requests, or an explicit child
uncertainty disposition defer cleanup. Recovery never submits another mutation.

Fixed import preserves its externally prepared exact scratch and fixed-source
grant; it never closes that caller-owned document. The shared receipt module
fsyncs an exclusive per-request intent before spawn, including client, document,
runtime/build, fixture and source/manifest hashes, exact command digest and
driver PID/birth.
An exclusive claim in the stable invocation directory binds each fixture and
creationId before the per-request intent; a restarted process or new requestId
cannot replay the same pristine-fixture program. Recovery never releases it.
A CLI terminal is only `terminal-observed`. Independent
recovery requires the original driver to be dead and reads the exact original
worker request and an explicit `execution.sdkSettled === true` before marking
`settled`; a terminal public job alone is insufficient. It has no submit or close
capability.
GM07/GM12 reuse this helper rather than adding another admission architecture.

Required native run: both MCP and addin protocols, configured concurrency grid
1/2/10 (default 10), exact final installed build and source pins, and exclusive
instance ownership for the ordinary import inventory assertions. Preserve the
four original negative cases (invalid parameter dependency, duplicate catalog,
duplicate placement path, wrong COTS revision), each with its own failed worker
receipt plus an independent unchanged native readback. Capture real STEP file
existence/volume, occurrence replacement and datum preservation, explicit COTS
material unknown, all owner pins, before/after inventory, restored active
document, and original-request recovery/deferred cleanup evidence. Fixed import
still does not replace those four native negative cases.

Narrow strict compilation and lint pass for the handoff delta and all related
typed consumers. The 482 mapping entries resolve to current literal evidence.
Pending offline gates: actual owned child execution proof and the existing D
runtime recheck queue. Durable intent, SDK settlement, unsaved-lease faults and
pure contract/local CLI tests passed in the 13-case run. Neither a
typed file nor a registered native factory is reported as native execution.

Historical correction: the retained ordinary import expected CLI exit 1 for a
completed local placement check with no observed poses. Accepted predecessor
`a26222f` reports local `success: true`, `status: unknown` and CLI exit 0; the
current standalone data-import regression already records this completion
contract. The shared local assertion is corrected to exit 0. It still requires
explicit unknown, no document identity, no model validation and no mutation.
The separate native unknown-mutation assertions still require exit 1 and
`success: false`; no production behavior changed.


The extraction review keeps the original 482 IDs, source lines and expressions
in the frozen inventory. Three named snapshots come from public repository
commit `dce47c5`, with hashes identical to that inventory. Before the inventory
uses them, its existing loader verifies `tests/live-import-extraction-review.json`:
all seven current caller/contract/lifecycle evidence sources must match their
complete hashes and 536 current assertion sites, and all 482 original semantic
dispositions must still resolve to current literal evidence. Added current
receipt guards are therefore tracked separately from retained obligations.
Changed snapshots, current guards, extracted assertions and missing dispositions
have explicit rejection tests. This source review does not claim runtime or
native execution; the new guard tests await the central build and pure-test slot.
