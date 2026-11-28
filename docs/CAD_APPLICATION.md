# Shared CAD, run and batch application services

`packages/core/src/application/cad` owns the strict TypeScript use cases. Its
barrel has no Node, filesystem, configuration, stdout, Fusion SDK or CLI-parser
dependency. The retained `src/cad.js`, `run.js`, `batch.js`, `batch-atomic.js` and
`cad-input.js` compose the existing specialist services and Node effects; they
are compatibility entrypoints, not a second implementation of the workflows.
The existing catalog worker and MCP dispatch reach the same CAD service without
calling the CLI parser. Catalog declarations and specialist validators remain
the single validation source; this extraction introduces no operation registry.

## Preparation and one SDK turn

- `planCadScript` builds the wrapper/request/profile without loading sources or
  bundling them. The adapter performs curve/data-import preparation and host path
  mapping, then passes the plan to the existing prepared-artifact bundler. The
  lightweight document-status profile and explicit-component full profile remain.
- `executeCad` receives a typed `CadContext`, data, and explicit `CadServices`.
  It validates, dispatches specialist/local/coordinator workflows or produces the
  unchanged offline preview, then prepares and executes **one** artifact. Result
  marker parsing, unsuccessful result semantics and promoted CAD evidence fields
  live in this shared use case.
- `CadExecutionPort.execute({operation, context, artifact, readOnly})` accepts a
  complete immutable `PreparedPythonArtifact`, not argv or a raw script string.
  Atomic turns use the same request and an optional deadline argument so the
  adapter can enforce the native-finalize reserve. Execution-pipeline composition
  can bind this port without introducing a scheduler or calling a CLI parser.
  An exception or missing marker is not permission to replay a mutation.
- `prepareRun` consumes a source snapshot, explicit request/identity and a
  preparation port. `executeRun` composes preparation with that same artifact
  execution port. The adapter still pins the hash of the original accepted input
  bytes **before** decoding/injection, recording invocation provenance and
  verifying worker input bytes. Embedded user units, literal `compile`, target
  activation/identity checks, trusted-code semantics and `cad-v1` facade terminal
  behavior are retained. Output publication remains the caller's responsibility.
- `planCadInput` and `decodeCadInput` separate option/JSON validation from file
  access. The Node facade reads a selected file once, verifies those exact bytes,
  and decodes that snapshot. No core planner opens a file or writes output.

## Batch and atomic lifecycle

`validateBatch` and `expandDefinition` are pure services. Scoped definitions,
recursive uses, lexical repeat/forEach bindings, stable flat IDs, whole-value
references, recipe regeneration completeness and expansion byte/node/depth limits
remain offline. Provenance uses canonical JSON and the existing host-independent
SHA-256; UTF-8 copied-JSON budget accounting no longer requires `Buffer`.

`runBatchEntry` defaults to atomic unless `atomic:false` is explicit. Unsupported
backends and nontransactional/external/local operations reject before report
creation or RPC. There is **no** per-step fallback on atomic failure. Explicit
non-atomic execution uses `runBatch` with injected execution/local-computation,
clock, redaction and `BatchJournal` ports. The Node journal adapter retains
exclusive locks, contiguous numbered snapshots and immutable publication.

Each non-atomic step persists its running request/mutation intent before RPC,
resolves references from successful outputs, retains actual partial outputs and
stops on failed/unknown results. Successful exact replay requires matching
request/context hashes and `onExisting:reuse`; unfinished/unknown history never
retries. Time-budget exhaustion stops scheduling, not the remote operation.

`runAtomicBatch`, `reconcileAtomicBatch` and `finalizeAtomicBatch` own orchestration
in core, with preparation/execution, journals, nonce, time and wait ports. Durable
identity-resolution and submission intent still precede their RPCs. Unknown send,
poll or finalize outcomes are journaled without replay; resolved document/session
identity remains bound across the history. The Node receipt reader retains
sequence/hash/identity validation. Reconcile only observes matching read handlers;
finalize requires destroyed/idle/exact identity and never submits `atomic_start`.
An acknowledged finalization returns locally without any SDK preparation/turn.

Native commit remains **committed** if local export/report publication fails. The
report records publication failure and retains the no-replay lock. A later
finalize inspects the existing holder/receipt instead of repeating the mutation.
Rollback measurements, aborted versus unknown outcomes, fault-injection gates and
external-effect operation journals retain their original contracts.

## Offline verification

### Typed worker composition API

`src/cad-service.js` exposes `execute(request, backend, onOutcome, io?)` with the
execution worker's service signature and `Promise<number>` result. `request`
contains a **typed payload**; optional `argv` must equal the broker-guard
projection exactly. It is never parsed for execution. The service has no CLI
import or argv fallback. Backend is the worker's broker-capability backend, not a
new physical SDK transport. Optional `io` supplies stdout/stderr sinks; the
composition default uses process streams, outside core.

Accepted DTOs are `CatalogInvocation` (`kind:cad`, retained MCP contract),
`CadCommandInvocation` (`kind:cad-command`, catalog invocation plus CLI output
format preferences), and `RunInvocation` (`kind:run`, explicit `RunRequest`,
purpose and output path/format/pretty). Types, strict envelope decoder,
`cadWorkerPolicyArguments` and run execution/publication orchestration live in
`packages/core/src/application/cad/worker-command.ts`. Nested CAD validation uses
the existing catalog validator; CAD and batch still execute the common service.
Run uses the same source-byte verification, prepared-artifact execution port,
preflight output checks and immutable publication as the retained command.

The **client boundary**, after its existing parser, calls
`fromParsedCommand(command, options?)` from `src/cad-service.js`. It returns
`{payload, argv}` to include in queue admission. Input is the exported
`ParsedCadWorkerCommand` union, not raw command words:

```js
const admission = fromParsedCommand({
  kind: 'cad', operation: 'batch.run', data, context,
  json: true, summary: false, purpose,
});
const runAdmission = fromParsedCommand({
  kind: 'run',
  request: { name, args, hasArgs, doc, identity, helperVersion },
  output: { path: outputPath, format: 'json', pretty: true },
});
```

The converter pins run's source path, fills the read-only helper inventory from
the shared catalog if absent, and resolves an output path. Argument-file bytes
are decoded by the existing caller before constructing this DTO; original input
files/hashes remain on the queue envelope for worker/admission verification.
The converter does not introduce a second option parser or CAD validator.
Missing/unsupported payloads reject explicitly; consumers must convert supported
CAD/run calls before admission rather than shipping argv for worker fallback.
Legacy non-CAD families retain their own service migration responsibility.

Worker wiring remains owned by execution-pipeline composition; this task does
not edit its queue/composition worker files. Regression tests block CLI imports
while dispatching real CAD read/mutation wrappers, dependent multi-turn batches,
and run/helper/output cases through this concrete service.

```sh
npm run build:code
npm run typecheck:tests
npm run lint
node --test tests/cad-application.test.js tests/cad-worker-service.test.js tests/batch*.test.js tests/definition*.test.js tests/run-*.test.js
node --test tests/cad.test.js tests/python-artifact.test.js tests/helpers.test.js tests/catalog-worker.test.js tests/mcp-catalog.test.js dist/tests/registry.test.js
```

The new fake-port tests run actual generated read/mutation Python wrappers with a
small fake CAD context, check immutable artifact/identity propagation, exercise
multi-turn dependent batches and no-replay unknown outcomes, and distinguish
committed native outcome from failed publication. Negative TypeScript fixtures
reject argv/client/raw-script substitutes at the typed boundary. Existing batch,
definition, run, Python and catalog-worker fixtures are compatibility baselines.
The exhaustive CAD test compiles every retained catalog wrapper and is expensive;
allow enough time rather than interpreting a harness timeout as CAD failure.

These checks are offline. They do not establish live Fusion execution, native
rollback correctness, geometry quality, physical fit or manufacturing safety.
