# Broker execution pipeline

`packages/core/src/application/execution.ts` owns the phase ordering through
explicit ports. `dispatchPrepared` prepares locally, awaits the offline checker
seam, asks for admission and invokes the final synchronous fence and physical
send in the same JavaScript turn. The checker seam is before admission; this
ticket does not implement Python typechecking or Python-admission policy.

The broker composition binds the original RPC, build, instance, source and final
Python artifact before admission. It rechecks reset access, original ownership,
context epoch, executable build, accepted input hashes and remaining budget at
the actual send boundary. Journaling and dispatch marking are synchronous and
durable before send. An exception after send becomes unknown and retains the
hold; there is no implicit retry, rollback, remote cancellation or replay.
Administrative recovery uses existing bound receipts, not another execution of
the user's request. Broker probes remain gated too; their administrative scope
does not bypass physical activity accounting.

The broker document probe composes canonical helpers once through
`src/dist/python/document-probe.queueDocumentSnapshotSource(resolver.runtime)`.
This source already includes identity and queue-document helpers. The broker
does not prepend `assets/cad/identity.py` or read `assets/queue_document.py`.
Its wrapper still injects selector JSON, calls `_qd_capture(app, selector)` and
publishes the unchanged `documentState` DTO. Receipt binding and final Python
artifact preparation/verification occur only after that composition. This uses
the document-I/O runtime contract without introducing another source loader.

`completeSdkTurn` orders native settlement, required postflight, release and
local finalization. A failed/incomplete postflight suppresses release. A native
command remains active until its correlated terminal lifecycle receipt exists;
the synchronous script receipt alone is not termination proof. A matching native
failure is terminal but **failed**, even if transport and script receipts report
success. Both live settlement and receipt-based reconciliation use this rule.
Cloud save processing is not an active native command after its SDK turn settles.

## Local workers

The worker application in `application/execution-worker.ts` consumes an immutable
request and a typed service port, and publishes workflow evidence before terminal
local results. The Node adapter verifies the capability, executable build and input
bytes and provides only a broker-capability backend. It cannot create a physical
Fusion client. `execution/phased-workers.ts` owns child processes, local budgets
and filesystem integration. Up to four local workers prepare/finalize fairly
across clients, independently of the single SDK executor. A pending SDK request
freezes its local budget. Local worker death cannot cancel or release physical
ownership. Restart never reconstructs an abandoned prepared request for replay.

The CommonJS queue gate, phased-worker and native-receipt files are temporary
composition facades over strict TypeScript adapters. `src/queue-worker.js` is a
process entrypoint composed with `src/composition/execution-worker.js`. CAD, run
and batch DTOs execute through the shared `cad-service.execute` port. There is no
worker `cli.main` fallback. `execution-request.js` is the broker's compatibility
edge for older clients submitting argv: it uses the existing entrypoint parser
and shared CAD input plan/decoder before spawning the worker. It preserves the
original durable job request and input SHA inventory; only the local worker
envelope receives the typed payload and canonical guard argv. Thus `--file` and
`--args-file` evidence cannot disappear when guard metadata is projected, and
idempotent retries do not re-read edited files to invent new input. Existing
non-CAD routes use a parsed-command compatibility service, never the CLI parser
inside the worker. The phased process regression forbids importing CLI in every
worker, including run, publication, timeout and multi-turn cases.

Outcome records retain `mayHaveMutated`, SDK settlement and a separate publication
assessment. Failed local publication does not mean that a committed mutation
was rolled back. An unavailable local result cannot become a success merely
because a receipt proves that remote execution ended.

## Broker SDK probe port

The production worker adapter exposes `backend.brokerSdkProbePort` with
`boundary: "fmcad-broker"`, `kind: "sdk-probe"` and `probe(request)`. It is
created only by the queue-worker composition with a prepared-script port and
executes exclusively through the existing job-token IPC backend. There is no
public physical client, second scheduler or direct `callTool` fallback. The
accepted envelope must itself be `capabilities.probe`; capability ID, selected
backend and every document pin must match that immutable envelope before any
script is prepared or submitted. Caller input is snapshotted before awaiting.

The prepared read-only script uses shared document identity assertions, observes
the actual Fusion `app.version` and checks presence in the loaded runtime
`CAD_HANDLERS`. It does **not** invoke the requested handler or activate the
document. It obtains one normal SDK turn, with the same preparation, final-byte
fences, native receipts, required postflight and no-replay behavior as other
worker backend requests. A response lost after dispatch remains subject to the
original broker's unknown hold; the probe port has no retry loop.

This generic native observation reports `partial` with `precision: "unknown"`
when the handler is present, or `unsupported` when absent. It never upgrades
registry presence to behavioral execution, geometry/physical validation or
cloud permission. `identity: "verified"` applies only to the requested document
pins. The result marker is `FMCAD_SDK_PROBE`; exactly one correlated observation
with a native build and matching pins is required. Ordinary discovery/direct
backends do not receive this port. Capability-specific behavioral probes require
their own evidence; they are not implied by this minimal compatibility port.

## Offline verification

Build/stage once before starting a test run; do not refresh runtime identity while
workers/tests are executing. Focused suites:

```sh
node --test tests/execution-pipeline.test.js tests/phased-queue.test.js \
  dist/tests/console-pause.test.js tests/queue-native-receipt.test.js \
  tests/fusion-reset.test.ts tests/queue-probe-recovery.test.js
```

`tests/sdk-probe-port.test.js` additionally executes the actual production worker
probe port through real broker IPC, preparation/admission, receipt journals and
postflight with a fake physical backend. It checks that foreign operation,
backend/pins, missing handlers, malformed evidence and lost observation never
produce a passing capability or a replay. The independent capabilities catalog
integration uses this port; this fixture's explicit service does not replace its
own real catalog-dispatch regression.

These use explicit application ports, real local child processes/IPC and fake
physical transport. They cover read/mutation phase ordering, grant/send adjacency,
checker refusal, pause/reset/input fences, parallel local work, separate project
outputs, one SDK executor, worker kills, lost acknowledgement, restart with
unresolved ownership, native failure after positive transport and local finalize
after release. They do not contact Fusion, prove SDK geometry, validate a physical
model, or constitute live publication verification.
