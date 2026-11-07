# Document application workflows

`packages/core/src/application/documents` contains the strict TypeScript
application entrypoints. They import no Node, filesystem, transport, SDK,
configuration, CLI parser or terminal module. Their explicit service contracts
are also exported by that directory's barrel; the public library composition root
selects adapters separately.

## Responsibilities and consumers

| Application | Effects supplied by ports |
| --- | --- |
| `save.ts` | Scoped status, one native save, immutable journal, submission ownership, clock and bounded waiting |
| `references.ts` | Audit/plan/apply/inspect dispatch, request replay checks, immutable plan publication and read-phase receipts |
| `references-apply.ts` | Preflight, one SDK/native update, UI inspection/watcher, save, explicitly authorized cold verification, final graph and journal |
| `externalization.ts` | Phase scheduling, intent/receipt, reconciliation, budgets, original copy futures and nested reference refresh |
| `data-import.ts` | Import preparation envelope, ownership/revision policy and offline historical-evidence checks; file snapshots and specialist record rules are supplied |
| `commands.ts` | Typed legacy document queries/commands and returned output; SDK calls and native script builders are supplied |

The existing specialist validators/planners and normalized record rules remain
single-source providers in `src/references-refresh.js`, `externalization.js` and
`data-import.js` during the staged migration. The application calls those rules;
it does not keep a second catalog or weaker copy of the validation. The old
save, reference apply and externalization coordinators have been removed rather
than left as fallback pipelines.

The existing CAD application specialist dispatch used by the CLI, catalog worker
and MCP still calls these facades and therefore executes the same application.
No worker invokes a CLI parser to execute this family. `src/docops.js` also
exports `createDocumentService(client, toWindowsPath?)`, whose
`execute(DocumentCommand)` returns `{code, stdout, stderr}` without writing to
process streams. Its legacy CLI functions only map their already parsed options
and render the result. This factory does not construct a backend or change queue
admission, SDK-turn ownership or secrets handling.

Screenshot capture is owned by review: `docops.shotCmd` is an exact forwarding
export of `src/shot.js`. There is no second screenshot implementation in the
document application. Public API/worker composition is owned by the corresponding
integration task, not duplicated in this directory.

## Durability and recovery

`document.save.once` requires matching document name, creation ID, file ID,
project ID and baseline version. The request/context are snapshotted before the
first await. Unsaved documents are blocked; clean documents record a no-op.
Changed documents must already be cloud-complete and writable. The native save
request has exactly one submission site, preceded by durable `submit_uncertain`
intent under exclusive request ownership. Native acceptance is not cloud
completion. Completion requires a newer same-lineage version, saved/unmodified
document state and cloud completion.

Repeated once requests read the receipt, including unresolved intent; they do
not send another save. `save.observe` reads the original journal and status only.
Missing/corrupt receipts, active/interrupted submission locks, identity drift and
ambiguous publication attribution stay explicit. Old name-bound receipts retain
their original persisted binding while a later display-name change does not
authorize a new save. A failed publication after native acceptance returns
`status: unknown, accepted: true, changed: true`; successful cloud readback may
also remain in the returned evidence. `receipt: null` means that result was not
acknowledged as a durable receipt. Inspect the original request; never infer that
a failed local write means the native operation did not run.

Node adapters under `packages/node-adapters/src/persistence` retain the existing
document-save layout, reference request/plan JSON, externalization manifest,
sequence numbers, hashes, nonce, source/destination and document identity.
They use the existing immutable `publishComplete`/operation journal codecs.
The unchanged publish adapter creates only its own private temporary file,
flushes complete bytes, publishes exclusively and syncs the directory; conflicts
never overwrite existing evidence. A post-publication directory-sync failure
does not delete the published file. This task introduces no second store,
arbitrary-path reader, cleanup sweep or receipt migration.

References preserve exact plan-time scope, edge pins, dependency ordering,
source parameters, ownership, metadata and post-update evidence. Unknown update
outcomes stop before fallback/save/cold verification. A native UI route still
requires the request-bound lease, exact owned editor, qualified idle host and
one-shot watcher. Watcher setup time is charged to its bounded observation window;
unknown commands keep their original watcher for reconciliation. Cold close/reopen
is only the pre-existing explicitly selected `openOwned`/`cold` operation, never
an automatic recovery action or permission inherited from the planning audit.

Externalization retains its original manifest and copy nonce, item/check limits,
phase prerequisites, durable cursors, partial artifacts and original pending
copy/refresh evidence. Inspection never resumes a producer mutation. Failed or
unknown effects cannot silently become a second migration; explicit unsupported
states remain unsupported. A completed copy does not imply a completed migration.

Import source/model reads remain on the CLI host through `DataImportFiles`.
Snapshot hashes, model file pins, physical/purchase/contents separation, ownership,
revision and unresolved evidence are unchanged. Historical supplied observations
are not live evidence. Native import/export execution still uses the existing
prepared CAD artifact/SDK turn and canonical Python document-I/O families; this
module neither bundles another runtime nor adds an export/save fallback.

All cloud operations still need Fusion, network access, an Autodesk account and
the necessary permissions. Extracting the use cases does not make them offline.
There is no new retry, rollback, save, close, reopen, lock theft or cancellation
as a response to transport/storage failure.

## Authenticated stage journal composition

The optional `SaveServices.stages` port is composed with
`createDocumentSaveStages(existingOperationDirectory, authenticatedOwner, evidence)`
from `src/document-stages.js`. It uses the existing stage-journal modules, not a
copied journal or another scheduler. `authenticatedOwner.scope` is the full
owning-job `StageScope`; `pinnedDocument` is its exact saved target and must match
the serialized scope document. Production worker composition obtains both from
`createAuthenticatedStageDependencies(verifiedWorkerInputs)` after the existing
worker capability/build/input checks. That adapter derives the scope from the
authenticated queue job and retained accepted bytes, and verifies the document
pin against the physical preflight; it supplies the original save-journal reader
and broker terminal/native/postflight evidence. Neither `CadContext` nor inspection
arguments can set owner scope.

After target preflight, the application records the immutable save stage plan,
then the original save intent, then the stage's started receipt-binding reference,
and only then calls native save. Returned/persisted evidence retains the stage
head. Replay of an existing save receipt does not recreate a plan or started
record. Existing stage history cannot authorize a new save if original save
history is missing. Inspect/resume/revalidate are read-only advice; unknown stage
evidence is not replay permission. Unscoped legacy callers do not synthesize
authenticated identity from their inputs. The optional stage port is internal to
verified worker composition and is not enabled by a user flag.

## Offline verification

```sh
npm run build:code
npm run typecheck:tests
npm run lint
node --test tests/document-application.test.js tests/document-persistence-faults.test.js tests/document-commands.test.js
node --test tests/document-publication.test.js tests/references-refresh.test.js tests/externalization.test.js tests/data_import.test.js tests/publish.test.js
node --test tests/review*.test.js tests/shot.test.js tests/backend-cli.test.js tests/manual-legacy.test.js tests/registry.test.js
```

New fake SDK/journal/FS tests cover pre-save failures, lost acknowledgement,
post-save readback/publication errors, exclusive destination conflicts, wrong
document/project, cloud timeout, cleanup errors, immutable input/context and
no repeated save on once/observe recovery. Negative TypeScript fixtures reject
argv substitutes, missing explicit close authorization and incomplete ports.
The retained reference/externalization/import suites exercise the real specialist
facades, persistence and nested CAD dispatch, not a separate toy implementation.
These tests are offline, not evidence of live execution, geometry correctness,
physical fit, cloud availability or manufacturing safety.
