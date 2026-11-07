# Authenticated stage owner adapter

`src/composition/stage-dependencies.js` exports the ready internal adapter
`createAuthenticatedStageDependencies(verifiedWorkerInputs)`. It composes real
document-save, batch and helper receipt readers around the lower-level
`packages/node-adapters/src/persistence/stage-owner.ts` binder. It reads the
existing queue snapshot, job request, admission manifest, retained accepted bytes
and per-job RPC/native/preflight/postflight receipts; it adds no state, lease or
scheduler. Reads fail closed while `queue-state.pending.json` exists.

## Worker integration port

`packages/node-adapters/src/execution/worker.ts` passes the `verified` envelope
to `src/composition/execution-worker.js` only after the existing worker
capability/build/input checks. That trusted composition invokes the adapter before
CAD service dispatch. The existing broker-capability backend remains the only
physical route:

```js
const stageDependencies = await createAuthenticatedStageDependencies(verified);
return cadService.execute(request, backend, onOutcome, {}, { stageDependencies });
```

The adapter derives scope from the hash-verified queue job and retained admission
bytes. The document-save reader validates the existing immutable numbered save
journal; the batch reader validates the existing numbered batch report or atomic
history; the helper reader validates the terminal `FMCAD_RESULT` in the broker's
owned stdout artifact. All use the same queue job's verified terminal RPC/native
and postflight receipts. Pins are derived from accepted payload/source bytes and
checked physical preflight, never from public `CadContext`, mutable paths or
caller-provided scope. Path-valued owner receipts are derived under the project
scope; arbitrary receipt paths are not accepted.

The actual consumers receive `document.stages` in `document-publication.execute`,
`batch.beforeRun` around mutating batches, and `helper` around `cad-v1` run
artifacts. For helpers, `FMCAD.stage()`, `FMCAD.journalInspect()` and
`FMCAD.resumePlan()` read a snapshot injected by the verified worker context and
accept no owner/scope arguments. External callers use the public read-only
`FmcadServices.stage(jobId)`, `journalInspect(jobId)` and `resumePlan(jobId)`;
they first authenticate the job through the existing result action, then derive
scope from that job. None accepts a public document context as authority.

The adapter itself re-reads `queue-state.json` read-only and verifies the selected
job's request hash, private `jobs/<id>/request.json`, `instance.json`, original
admission identity and each content-addressed original input. Its scope derives
owner/client/project/job/sequence/request/build from those records. Document
scope is resolved only by the trusted operation-owner callback and checked
against the broker's physical preflight plus postflight identity. RPC receipts
must be terminal and bound to the original job/build/instance. Script receipts
are checked with the existing `createNativeReceipts` validator; successful
physical workflow completion additionally requires native termination and the
broker's successful postflight. The owner-specific reader sees those validated
receipts in `lifecycle()` before deciding the original operation's completion.
Overall `valid` status additionally requires the durable queue job to be
`succeeded`; a stage receipt that proves completion while the broker job remains
`needs_reconciliation` is reported as completed evidence with required
reconciliation, and never offers a next stage.

An application-level acknowledgement may be lost even when immutable owner and
broker receipts prove completion. The adapter does not require a successful
transport response or a success-shaped worker return to promote such a stage;
the owner-specific receipt reader must independently prove the actual operation.
Without native/terminal/postflight/owner proof, inspection remains unknown and
offers no next stage. The adapter never probes, reconciles by mutation, sends SDK
requests, or replays. If a broker job is still in an active unknown state, the
existing broker receipt lifecycle is incomplete and the stage stays unknown.

## Ownership boundaries

The minimal worker entrypoint to coordinate with Astra is
`src/composition/execution-worker.js:execute(request, backend, onOutcome,
verifiedWorkerInputs)`. It runs after existing capability/build/input checks and
now wires the owner adapter into document, batch and helper services. No changes
were made to `src/queue-worker.js`, broker admission, physical dispatch, or CLI/MCP
request adapters. Public stage inspection accepts only the owning `jobId`; the
client ID, project, request, document, sequence, build and accepted-input scope
are read from authenticated broker records.

## Tests

`tests/stage-owner.test.js` builds real local `QueueState` jobs and retained
accepted-input artifacts, exercises `document-publication`, non-atomic batch,
typed helper execution and public `FmcadServices.stage`, and restarts child
processes to inspect original receipts. It covers lost save acknowledgement
followed by read-only observe, changed source paths with the original bytes
preserved, broker RPC/native/postflight evidence, helper terminal markers, foreign
owners, changed build, missing/corrupt evidence and unknown denial. These are
offline filesystem/process tests, not Fusion or physical CAD qualification.
