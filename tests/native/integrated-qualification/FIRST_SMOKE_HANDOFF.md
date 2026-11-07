# f708 first-smoke handoff

This is an executable public-API entrypoint, not an `fmcad run` script:

```js
const { createRequire } = require("node:module");
const requireQualified = createRequire(
  "/tmp/opencode/fmcad-audit-response-qualified-f708256/consumer/package.json",
);
const { createFmcad } = requireQualified("fmcad/api");
const { executeFirstSmoke } = require(
  "/home/kamil/.config/opencode/plugins/fmcad/tests/native/integrated-qualification/executor.js",
);
```

The same qualified MCP surface is `tools/call` name `fmcad_execute` with
arguments `{operation, data, context}`; the queue metadata is carried in
`params._meta.fmcad` (`requestId`, `sequence`, `expectedRevision`,
`queueTimeoutMs`, `sessionId`). The bridge uses the exported `FmcadServices`
API instead of implementing a second MCP framing/client. In the library API,
the first invocation carries `sequence: {action:"begin", mode:"exclusive"}`;
the stdio MCP form must first obtain its sequence with `fmcad_queue_begin` and
then use `continue`/`end` metadata.

Do not run this during the current owner APPLY/recovery. Once the original owner
has produced actual complete facts, separate facts approval, exact scratch
creation receipt and registered-client grant, coordinate the single live test
with Sol. Do not build/install/switch the runtime: use the already-qualified
f708 package and its public `fmcad/api` export.

## Client and owner bindings

- Construct `createFmcad` only from the approved existing add-in/queue config;
  keep `backend: "addin"`, `routing: "queue"`, and `queue.autoStart: false`.
- Set `FmcadOptions.context.clientId` to the exact `clientId` in the actual
  `grant-isolated-scratch` receipt. Set `projectDirectory` to the approved
  private project directory; no `projectId`/DataFile pin is used for the
  unsaved first-smoke scratch.
- Start the *client* explicitly only after authorization with
  `await services.start()`. The qualified API registers with `autoStart:false`;
  `executeFirstSmoke` itself never calls `start()` or `dispose()`.
- Supply `ownerCleanup` as a callback bound to the original facts-owner session
  and `clientId`. The modeling process must not run the owner CLI, add
  `--client`, or use the owner's token.

## Required call

```js
const report = await executeFirstSmoke({
  confirmFirstSmoke: true,
  services,                         // started public FmcadServices
  authority: {
    runtime: { sourceCommit, buildHash },
    ownerJobs: { targetJobId, observationJobId },
    facts: actualDerivedCurrentAuditFacts,
    approval: actualAuthorizeIsolatedScratchReceipt,
    creation: actualCreateIsolatedScratchReceipt,
    grant: actualGrantIsolatedScratchReceipt,
  },
  ownerCleanup: {
    clientId: "<original facts-owner clientId>",
    closeIsolatedScratch: originalOwnerReceiptCallback,
  },
  evidenceDir: "/tmp/opencode/<private-run>/evidence",
  runId: "<stable-run-id>",
  sessionId: "<actual-MCP-session-id>",
  fixturePrefix: "NQ<8-24-uppercase-alphanumeric>",
  requestIds: {
    sketchCreate: "<distinct-stable-id>",
    sketchGeometry: "<distinct-stable-id>",
    sketchInspect: "<distinct-stable-id>",
    extrude: "<distinct-stable-id>",
    bodyInspect: "<distinct-stable-id>",
    volume: "<distinct-stable-id>",
  },
  cleanupRequestId: "<distinct-owner-close-id>",
  queueTimeoutMs: 30000,
  // Optional, only when supplied by a fresh supported revision observation.
  // expectedRevision: <nonnegative integer>,
});
```

`authority.facts` must be the actual `derived-current-audit-facts-v1` result,
including the hash-pinned capture intent/start/wire/result/SDK/remote evidence;
the frozen `303ae42` or offline qualification JSON is not authority.
`approval` is the actual owner `authorize-isolated-scratch` response. `creation`
is the completed owner receipt including its exact `activation` epoch/document;
`grant` is the exact `{epochId, clientId, document, scope}` grant response.
The runner re-reads public API status and verifies the live build, granted client,
epoch, unsaved `fileId:null` document and exact `creationId` before any execute.

Each call is a version-1 typed `kind:"cad"` invocation with `doc` and `docId`
set to that receipt's scratch identity; no `run`, Python, `docFileId`, saved
project, raw RPC, active-document resolution, or operation override is present.
The six exact operations are `sketch.create` → `sketch.geometry` →
`sketch.inspect` → `model.extrude` → `entity.inspect` → `measure.volume`.
The rectangle is 10 × 6 mm, extruded 4 mm; PASS requires one native profile,
one healthy solid, 10 × 6 × 4 mm native bounds, 240 mm³ measured volume,
successful owner-only close, and a public closed-epoch status readback. The
owner callback receives exactly `{targetJobId, observationJobId, requestId,
epochId, document}` and must return the original owner's actual complete
`isolated-scratch-close` receipt with `sdkRequestsSent: 1`, matching activation
and `admission:"closed"`. The owner runs only the supported command in their
original cwd/credentials, with no `--client`:

```sh
fmcad queue close-isolated-scratch --job TARGET_JOB --observation-job OBSERVER_JOB --request-id EXACT_CLEANUP_REQUEST_ID
```

Do not treat pending as complete. If the callback cannot return the exact
terminal receipt, the smoke remains NOTRUN; this process never retries cleanup.
The f708 close proof itself enforces that only the exact scratch is unsaved and
unlinked.

The first `execute` begins an exclusive sequence; later calls continue its exact
`sequenceId`; `measure.volume` ends it. Each intended call has a distinct
stable `requestId`. A lost execute ACK reads `query.request` once with the same
ID. Nonterminal jobs are read through `query.result(jobId)`; after one lost result
read, the bridge allows one more read of the same owned job ID. Unknown never
resubmits, cancels, reconciles, starts later operations, or closes the scratch.
The private ledger is exclusive and blocks replay after process loss. Owner
cleanup is delegated to the original owner only with the same target/observer
jobs and stable close ID sent before modeling. The owner may observe an existing
pending close only with that same ID; a lost acknowledgement stays unknown.

This smoke is not a run of the eleven native feature suites and cannot close
`fmcad-dru` by itself.
