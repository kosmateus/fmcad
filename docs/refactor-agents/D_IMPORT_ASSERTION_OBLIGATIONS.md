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
Their latest runtime result is **pending**, so this is source coverage only.

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
worker request before marking `settled`; it has no submit or close capability.
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
Pending offline gates: durable intent and unsaved-lease fault tests; actual
owned child execution proof; pure
contract/local CLI tests; and the existing D runtime recheck queue. Neither a
typed file nor a registered native factory is reported as native execution.
