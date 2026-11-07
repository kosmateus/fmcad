# Public library API

Import JavaScript and TypeScript declarations from **`fmcad/api`**. Repository
paths and private workspace packages are not supported imports. The root name
`fmcad` is reserved for the separate OpenCode dual-plugin entrypoint; it is not
the library API. See [OPENCODE_PLUGIN.md](OPENCODE_PLUGIN.md) for its host adapters.

```ts
import { createFmcad } from "fmcad/api";
import type { FmcadOptions } from "fmcad/api";

// Supplied by the caller, not discovered from an OpenCode installation.
const options: FmcadOptions = {
  version: 1,
  config: {
    backend: "addin",
    url: "http://127.0.0.1:8765/mcp",
    headers: {},
    timeoutMs: 180000,
    tool: "execute_python",
    transport: "node",
    protocolVersion: "2025-06-18",
    routing: "queue",
    queue: { autoStart: false },
    controlCenter: { port: 4748 },
  },
  context: {
    clientId: "my-application",
    instanceId: "my-process-instance",
    source: "system",
    projectDirectory: "/absolute/project",
  },
};

const services = createFmcad(options);
console.log(services.query.catalog()); // local metadata, no Fusion required
try {
  // Connect only: the broker must already be running for this configuration.
  await services.start();
  const accepted = await services.execute(
    {
      version: 1,
      kind: "cad",
      operation: "document.status",
      data: {},
      doc: "Model",
      docId: "creation-id",
      docFileId: "file-id",
    },
    { requestId: "stable-request-id" },
  );
  if (accepted.jobId) console.log(await services.query.result(accepted.jobId));
} finally {
  await services.dispose();
}
```

## Lifecycle and execution

Import and construction do not read configuration, connect to Fusion, create
credentials, start a broker/panel, install process hooks or import a host SDK.
Configuration is normalized by the same pure core validator as the standalone
application. Construction snapshots configuration and invocation identity.
If supplied, `projectDirectory` must be absolute. It is optional for local/preview
operations and required before broker operations; it is never inferred from the
process or installation working directory. Runtime user-state paths follow the
existing standalone fmcad platform policy, not OpenCode's installation paths.

`query.catalog()` returns a detached public catalog, excluding internal primitives.
`query.validate()` uses the same catalog/specialist validation as CAD, CLI and MCP.
Known local/preview CAD operations can execute without `start()`; they use the
shared application invocation, never a subprocess. Local success is not proof of
physical execution or model quality. The returned `OperationResult` preserves
unknown/partial evidence instead of synthesizing physical success.

`start()` is explicit and idempotent. It checks the existing broker's compatibility
before credentials/registration, then connects without auto-start, recovery or
direct fallback. Await it before SDK execute, status/result or control calls.
`dispose()` is idempotent and terminal: it cleans up local observation resources,
not the shared broker, accepted job or Fusion activity. Disposing during start
waits for that local connection attempt to settle and cleans it up.

`execute()` accepts the shared `CadWorkerInvocation` union: catalog CAD, CAD with
output preferences, and typed run requests. Run source paths must be absolute;
source bytes are hashed before admission and verified by the existing pipeline.
Accepted SDK calls return an `ExecutionReceipt`, **not** a fabricated completed
result. Use `query.result(jobId)` to observe completion, including owned output
artifacts. Run text output remains text; CAD structured output remains JSON.

`ExecuteOptions` additionally accepts `sequence: { action, id?, mode? }`,
`expectedRevision` and `queueTimeoutMs`, mapped to the existing broker controls.
Use `begin` without an ID, or `continue`/`end` with the returned sequence ID;
mode is `automatic` or `exclusive`. Revision is a nonnegative integer and queue
timeout a positive integer, both at most `2147483647`. Local/preview operations
reject these controls. The invocation's `purpose` is preserved in the typed
payload and submitted queue description. This additive API does not alter
scheduler ownership, leases, admission or the meaning of unknown outcomes.
Only public receipt/outcome fields and application output are returned, never
worker authorization, runtime objects or arbitrary broker filesystem paths.
CLI adapters may include absolute `inputFiles` with SHA-256 hashes of the exact
original file bytes they parsed; the same service verifies those snapshots
before admission. Completed `query.result()` receipts also expose exact
`output.stdout` and `output.stderr` strings. Large streams are read only through
validated broker-owned artifacts; SDK diagnostics are not translated or
normalized.

Observed receipts also expose optional `pythonChecks: readonly PythonCheckReport[]`.
These are the broker's owner-only reports for the actual prepared Python artifacts,
copied unchanged rather than recomputed by the API. Initial receipts can omit the
field; result queries return an empty list until reports are available. A `passed`
typecheck does not mean SDK execution, geometry validation or physical correctness;
always read `outcome` independently. Rejected Python retains `not_started` when no
SDK turn ran, and prior completed turns remain distinct from a later refusal.
Diagnostic filenames are source labels, not filesystem-access capabilities.
Reports are absent from global queue status and cannot be read through another
client's result query. CLI and MCP expose the same owned report content.

Keep `requestId` stable across a lost acknowledgement. Use
`query.request(requestId)` to recover the existing job for this client without
resubmission; `null` is only a snapshot of the observed broker history, not
permission to retry an uncertain send. The library never automatically resubmits. A lost
reply is not evidence of rejection or remote cancellation. `control()` supports
versioned `cancel` (queued/local cancellation subject to broker policy) and
`reconcile` (observe existing receipts); neither bypasses the broker's ownership
or replays SDK work. Broker pause/reset and process lifecycle remain separate
administrative interfaces, not physical transport constructors in the library.

The API also exports `RegionalGeometryInvocation`, a narrowed `execute()` input
for `geometry.delta` and `geometry.compare-region`. It only types the existing
catalog CAD DTO; both operations retain ordinary validation, document pins,
broker admission, read-only request flags and result observation. It introduces
no dedicated SDK or persistence path.

`stage(jobId)` first reads that job through this client's authenticated broker
ownership, then returns the job's read-only stage facade. `journalInspect(jobId)`
and `resumePlan(jobId)` are shortcuts to the same facade; `revalidate(plan)` checks
the exact observed journal head and receipt evidence. Callers cannot pass an owner,
project, request, document, sequence, build or accepted-input scope. A `nextStage`
is advice only: `automaticResume` and replay are always disabled, and jobs still in
broker reconciliation do not receive a next stage.

## Composition and adapter integration

`src/composition/library.ts` is the root factory; `library-queue.ts` privately
binds the existing queue client. There is no second scheduler, transport factory,
argv execution or CLI subprocess. SDK requests carry the shared typed payload;
the argv projection is only the existing broker route/document guard metadata.
Workers execute the same `cad-service`/core application services used by existing
entrypoints. Local catalog execution calls the same `catalog/execute` service.

`createCatalogServices()` supplies configuration-independent discovery,
`validateData`, versioned `validate`, MCP `tools/fromMcp`, and local-route metadata.
CLI validation and MCP discovery/envelope conversion already consume this public
factory. The root build stages the same compiled API beside the core for both
source-tree compatibility launchers and installed entrypoints, avoiding duplicate
catalog instances or a dependency from adapters into repository TS sources.

CLI/MCP/plugin final lifecycle adaptation belongs to their adapter tasks. They
must use this public factory/DTO boundary instead of importing private services
or duplicating validation. Existing workers and retained adapters still share
the same core CAD use case; this library task does not replace their streaming
or host lifecycle policies. A thin adapter can preserve its framing, streaming,
accepted-receipt and owned-result policies; the library does not dictate stdout
or OpenCode events. No inactive OpenCode SDK is needed for either API or types.

### Explicit review application composition

`createReviewServices({ version: 1, ports })` exposes the extracted review use
case without importing the CLI, parsing argv or copying the capture algorithm.
The exported `ReviewRequest`, `ReviewRunPorts` and `ReviewRunResult` are the same
strict contracts used by the standalone review adapter. Constructing this
factory has no effects; `execute({ version: 1, kind: 'review', request })`
snapshots the request and delegates once to core's `executeReview`.

Review ports are explicit: prepared-artifact execution through an existing
broker gateway, Python preparation, artifact storage and hashing. This advanced
factory does **not** construct a physical backend or expose broker authorization;
the embedding composition supplies its already-owned ports. Port resources
remain caller-owned. `dispose()` prevents new calls but does not cancel remote
capture or dispose externally supplied resources. Normal `createFmcad.execute`
continues to accept the existing CAD/run DTO union; review does not pretend to
be a catalog CAD operation. For example:

```ts
import { createReviewServices } from "fmcad/api";
import type { ReviewRequest, ReviewRunPorts } from "fmcad/api";

declare const ports: ReviewRunPorts; // explicit existing broker/application ports
declare const request: ReviewRequest; // includes pins and both output mappings
const review = createReviewServices({ version: 1, ports });
try {
  const result = await review.execute({ version: 1, kind: "review", request });
  console.log(result.transport, result.artifacts, result.cadAcceptance);
} finally {
  await review.dispose();
}
```

Review preserves partial images/reports and uses `readOnly: false` because
capture changes viewport state. Even complete artifacts retain
`cadAcceptance: 'not-evaluated'`. The factory never retries capture or upgrades
image evidence to physical/model acceptance. See `REVIEW_APPLICATION.md`.

## Independent version boundaries

| Boundary                  | Supported major | Meaning                                                                  |
| ------------------------- | --------------- | ------------------------------------------------------------------------ |
| Public library API        | `1`             | Factory options, service surface and lifecycle                           |
| Public DTO                | `1`             | Catalog requests and operation outcomes                                  |
| Broker IPC                | `2`             | Existing durable `broker.lock.protocol`                                  |
| Persisted scheduler state | `1`             | Existing `queue-state.json.version`                                      |
| Python prepared envelope  | `1`             | `PreparedPythonArtifact.version`, runtime `cad-v1`                       |
| Public control API        | `1`             | Library control requests; not a claim about a future panel HTTP protocol |

`contractVersions` exposes this manifest. `assertCompatibility()` checks every
required major and permits additive manifest metadata; missing/unknown majors
throw `CompatibilityError` (`FMCAD_INCOMPATIBLE_CONTRACT`). An optional field or
new operation is compatible only when old clients can safely ignore it. Renamed
or removed required fields, changed semantics, different admission ownership,
new required enum alternatives or incompatible persistent bytes require a major
change. Package semver and MCP's dated transport protocol are separate versions.

Before registration and every SDK/control mutation, the concrete composition
checks the protocol marker, persisted-state version, exact normalized service
configuration and executable build
identity. The broker's own submitted `buildHash` fence also runs before admission.
Different builds are rejected conservatively, even when they advertise the same
major: no negotiated cross-build capability contract exists yet. The exact build
also binds the Python prepared-envelope implementation. Existing artifact/store
decoders remain authoritative; the manifest does not migrate their bytes.

On a compatibility error, do not delete state or replay an unresolved operation.
Restore the original matching build to observe/reconcile its receipts. Upgrade
client and broker together only after the old instance is quiescent, using the
explicit existing maintenance lifecycle. A new persisted major needs a separately
implemented, validated migration; no implicit migration/fallback is supplied.

## Offline verification

```sh
npm run build:code
npm run typecheck:tests
npm run lint
node --test tests/library-api.test.js tests/library-api-broker.test.js
```

Tests cover effect-free import/construction, shared catalog/local validation,
unsupported majors before credentials/admission, no implicit retry/start, public
JS and `.d.ts` from an actual built npm tarball in an external consumer without
repository source or OpenCode SDK,
and the production broker/IPC/phased worker with a fake physical backend. These
checks do not contact Fusion, validate physical CAD quality or authorize live use.
Full portable npm publication is verified by its separate packaging task.
