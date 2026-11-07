# Audit response loss: preserve old receipts, observe fresh facts explicitly

## Exact defect in frozen `843` (also inherited by `303`)

The frozen real add-in/MCP client prepares a tool call with caller ID **2**.
The audit controller replaces its physical JSON-RPC ID with `fmcad:RPC_UUID` and
correctly matches that unique ID against the response. Unlike ordinary broker
dispatch, it then returned the wire response unchanged. The enclosing real
`BrokerMcpClient.prepareWireCall` expects `id === 2` and throws `EPROTO` on an
otherwise valid response. Fake backends which skipped that outer client did not
exercise this boundary. Scratch creation/close shared the same controller.

The repair verifies the unique wire reply/physical receipt first, persists a new
`response.json`, and returns a response with the original caller ID restored.
Wrong wire IDs, error responses, invalid facts and byte/resource drift remain
refused. This is not relaxed protocol validation or a replay permit.

The real add-in also adds a random generic UI-guard prefix to ordinary mutating
script calls, which cannot equal a fixed administrative grant. Scratch creation
and close therefore use its existing **broker-private guarded-script** port with
their complete origin manifest. These exact qualified SDK sources enforce idle
UI immediately before their sole add/close themselves. Mutation is still declared
`readOnly: false`; no caller can select this port, provide script bytes or disable
either SDK UI predicate. The unbound generic mutation route is rejected before
physical send. This is separately exercised with the real add-in client, not a
fake `callTool` that omits its transformations.

The original v2 physical RPC is `507a4078-c334-4262-87a4-fc2a747a8ea3`. Its actual
wire/start/origin/checker bytes reconstruct exactly from the immutable qualified
`843` producer, including caller ID 2 and unique wire ID. Its terminal receipt
proves the expected process guard passed and the synchronous read body completed.
It does **not** contain the dynamic audit summary. Frozen `result.json` records
`failed/EPROTO` without that summary and there is no original response ledger.

Because the error message/raw response were not retained, the old generic EPROTO
code alone cannot exclude an earlier transport-framing error. The real frozen
client regression proves the deterministic ID defect; a modeled response is not
the original response or actual current facts. Do not promote the old result to
success, infer absent definitions/modules, or manufacture endpoint/facts fields.

## File-only postmortem

`scripts/read-audit-response-proof.cjs` authenticates existing original-owner
credentials locally (no register, IPC, HTTP or SDK), verifies the seven original
manifest files and exact frozen producer, then writes a NEW derived proof outside
the protected queue/runtime. No original receipt, intent, result or migration
history is edited. It reports:

- Original failed status and `endpointVerified: false`, unchanged.
- Separately proven expected-process/guard/body execution.
- `facts.available: false`, `summary: null`, `epochEligible: false`.
- Historical outcome unknown and rollback/model validation not performed.

Its original evidence is the completed v2 migration **intent and complete**, plus
audit **intent, start, wire, result and exact remote receipt**. No full escrow
verification or broker installation/launch is repeated.

## Narrow explicit next read — not an audit retry

If no authentic original response/facts artifact exists, a file reader cannot
recreate dynamic facts. The new purpose
`atomic-audit-facts-recovery-upgrade-v1` permits only an explicitly confirmed,
one-shot **new read-only current-facts observation** linked to the existing failed
audit key/RPC/evidence hash. The old audit and target work are never resent.

This requires a separately qualified guarded runtime transition from the actual
completed v2 owner/build. Its approval pins `auditResponseRecovery`, the exact
seven original file hashes. The original/current process identities and owner
cannot be silently changed. Qualification must include `auditFactsCaptureQualified`
and the existing isolated-epoch qualification. Original closed history remains;
the same authenticated inherited pause is adopted, with no public gate release.

After the actual authorized handoff, only the original credential-bound owner:

```text
fmcad queue capture-audit-facts --job ORIGINAL_TARGET --observation-job ORIGINAL_OBSERVER --request-id ORIGINAL_FAILED_AUDIT_REQUEST --confirm-read-only true
```

No new audit request ID, source/document override or acceptance flag is permitted.
This is a new observation at its own recorded time, not recovery or replay of the
old summary. The shared broker/gate/physical queue and actual checker still own
every SDK request. No direct transport or Fusion restart is used.

The fixed SDK source creates an exclusive started marker, runs the existing
bounded read-only audit, and fsyncs `sdk-facts.json` **before** printing a network
response. The outer qualified wrapper checks actual PID/birth/version before this
body. There is no model/document activation, mutation, new document or cleanup.

## Durable derived facts even after response loss

The new namespace is `jobs/TARGET/atomic-audit-facts-capture/`; the original
`atomic-recovery-audit/` remains untouched. Re-reading the same capture request
never sends another SDK call. If its response is lost, metadata-only derivation
requires all of:

- Exact original failed-audit evidence and request/owner binding.
- Exact new qualified producer, full origin/final-wire reconstruction and checker.
- A terminal successful physical receipt from the expected process.
- The exact SDK-produced facts envelope with binding/original RPC/time and summary.

It publishes a separate immutable `derived-facts.json`, retaining the transport's
actual failed/complete status, the original failed audit and unknown history.
`endpointVerified: true` in this NEW observation is justified by those physical
and SDK facts, never copied from the old transport-success row. Missing, malformed,
forged, failed or incomplete evidence cannot authorize modeling and never triggers
another send. A later receipt can be inspected under the same request, not replayed.

## Separate actual-facts approval before scratch permission

Capture success is **not** epoch approval, scratch creation or modeling release.
SDK-file facts recovered after a lost response remain genuine new-observation
facts, but `epochEligible` stays false while the new transport result is failed.
Do not infer transport readiness or authorize modeling from that recovery alone.
After reviewing actual `derived-facts.json`, prepare a separate approval:

```json
{
  "version": 1,
  "purpose": "isolated-scratch-current-facts-approval-v1",
  "auditRequestId": "ORIGINAL_FAILED_AUDIT_REQUEST",
  "sourceCommit": "QUALIFIED_RECOVERY_SOURCE_SHA",
  "buildHash": "QUALIFIED_RECOVERY_BUILD_HASH",
  "qualification": {"path": "SAME_QUALIFICATION_AS_RECOVERY_MIGRATION", "sha256": "SHA256"},
  "derivedFacts": {"path": "ACTUAL_DERIVED_FACTS_PATH", "sha256": "ACTUAL_SHA256"},
  "currentInstance": {"pid": 1, "birth": "ACTUAL_BIRTH", "version": "ACTUAL_VERSION"}
}
```

Do not create a runnable approval before actual facts exist. The runtime requires
idle/no original module or definition, the exact qualified build/qualification,
actual derived file hash, owner credential, broker lifetime and unchanged evidence:

```text
fmcad queue authorize-isolated-scratch --request-id ORIGINAL_FAILED_AUDIT_REQUEST --facts-approval ACTUAL_APPROVAL_PATH --confirm-current-facts true
```

This metadata-only operation publishes an immutable, owner/build/facts-bound
permission for **one proven-new document**. It is not a HOLD-off flag and does not
alter the old queue/identity/jobs or create geometry. Only then can the original
`303` isolated-scratch contract proceed through explicit new creation, exact
client grant, typed sketch/solid/geometry qualification and scratch-only close.
Use the repaired successor artifact, not the frozen `303` transport controller.
# Testy zgodności z historycznym producentem

Testy odtwarzające dokładne receipts producenta `843ce0d` wymagają rzeczywistego,
zachowanego kwalifikowanego runtime. Przekaż jego bezwzględną ścieżkę przez
`FMCAD_TEST_LEGACY_843_RUNTIME`. Bez tego testy historycznego runtime są jawnie
pomijane, zamiast odwoływać się do dawnego, nieistniejącego katalogu `/tmp`.
Walidator nadal sprawdza dokładny historyczny fingerprint; nie zastępuje się go
bieżącym buildem ani syntetycznym manifestem.

Porównania samego kontraktu odpowiedzi i poprawki przesunięcia linii checkera
korzystają z przypiętych historycznych źródeł Git oraz bieżących zależności.
Nie są przedstawiane jako kwalifikacja zainstalowanego historycznego runtime.
