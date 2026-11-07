# Shared contract model

`packages/core/src` owns host-independent identity, request/result DTOs, effect
ports and timeout policies. The barrel has no startup effects or Node imports.
`src/outcome.js` is a transitional CommonJS facade. The existing CLI/MCP CAD
paths retain their exit-code policy through this facade; queue public jobs now
also contain the additive `operationResult` DTO, which console readers preserve
through the same strict decoder. Existing public fields and persisted bytes are
not renamed or migrated.

## Semantics

- Acceptance, execution, possible mutation and validation are independent. An
  accepted request can be unstarted. An acknowledged transport is not physical
  execution proof. Successful execution does not imply validated model quality.
- `unknown` execution is not `not_started`; `mayHaveMutated: null` means unknown.
  Validation can be absent, partial, failed, unavailable or unknown. Geometry
  quantities carry explicit units, including null measurements.
- Identities are branded by family. Project/document/instance IDs are opaque
  references, not process objects, filesystem paths or bearer credentials.
- Deadlines are per queue/SDK/pause/prepare/finalize phase. Stopping observation
  of an SDK operation does not cancel Fusion. `interruption` describes only a
  confirmed local stop; if SDK activity remains possible, reconciliation is
  required. No retry, remote cancellation or rollback is implied.

## Compatibility and security

`decodeResult` and `decodeRequestContext` require exact version-1 fields and
reject unknown versions, extra properties, malformed values and nonfinite
measurements. `encodeResult` validates before serialization. They are deliberately
small allowlists, not sanitizers for arbitrary runtime objects.

`decodePublicResult` explicitly projects existing unversioned workflow output;
its `success` flag alone remains unknown physical execution. Unknown versioned
formats never fall back to legacy decoding. `decodePersistedJob(job, 1)` reads
the existing queue-v1 format, honoring explicit execution/mutation evidence over
state. An unfinished job is unresolved, not failed-before-start. The existing
unversioned remote receipt decoder distinguishes nonterminal from terminal
success/failure; receipt validation/binding remains the broker's responsibility.
These projections expose only DTO fields, never copied request arguments, worker
capabilities, receipt paths, credentials or runtime objects. Free text supplied in
allowed fields must still be redacted by the producing adapter; a DTO codec is
not a detector of secrets embedded in prose or opaque IDs.

Ports use artifact IDs and JSON data instead of handles, environment objects or
host SDK objects. Concrete store/dispatch/checker implementations and migrations
of individual command families remain in their respective tasks.

## Observation ports

The host-independent observation DTOs and policies live alongside the request
contracts. `InvocationContext` keeps transport client, request/job, project,
document, OpenCode session/turn, and process-instance identities explicit.
`EventSink` and `Presence` are separate ports from `ExecutionStore`: their
best-effort failures cannot determine admission or execution outcome, while
receipts remain authoritative. Node adapters own heartbeat files, PID/birth
checks, event delivery, and resource disposal. See
[`OBSERVATION_PORTS.md`](OBSERVATION_PORTS.md) for freshness and retention
semantics.

## Toolchain

The strict compiler options remain enabled. `verbatimModuleSyntax` is disabled
so TypeScript can emit CommonJS from standard TS import/export syntax; leaving
it enabled in a CommonJS package prevented the first value exports from building.
The root build stages the compiler-produced core under `src/dist/core` for the
transitional facade. Existing source-tree launchers and offline runtime-copy
fixtures therefore remain self-contained without private workspace resolution.
The root package explicitly includes this generated boundary.

Verification: `npm test`, `npm run lint`, `npm run format:check`; dedicated
runtime tests are `tests/contract-model.test.js`, with negative compilation cases
in `tests/contract-model.types.ts`. Tests are offline and do not validate Fusion
execution or physical CAD quality.
