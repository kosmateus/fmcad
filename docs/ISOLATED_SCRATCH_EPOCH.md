# Qualified fresh-scratch admission with immutable unknown history

This contract admits a **new independently created unsaved scratch**, not an old,
active or recovered user document. It never resolves historical native work.
The original queue snapshot and Fusion identity remain byte-identical, paused,
and permanently readable as historical unknown work. `rollbackVerification` and
historical `modelValidation` remain `not_performed`.

## Authority and runtime transition

The separate migration purpose is `isolated-scratch-epoch-upgrade-v1`. Its approval
must pin the exact candidate source/build, real production checker and immutable
qualification, including `isolatedEpochQualified: true`. It additionally pins:

- The actual completed preceding process-loss migration.
- The owner current audit's `intent.json`, `start.json`, `wire.json`, `result.json`
  and exact remote terminal receipt.

Public health, successful submission or a `pending` receipt is not sufficient.
The actual audit must have passed its checker, verified the selected current
process, returned idle UI/no surviving original holder or command definition, and
retained historical outcome `unknown`. All pinned bytes, original scope, original
owner and the two historical unresolved jobs are revalidated. Current and original
PID/birth/version fences remain independent; an old process's death is not rollback.

The future runtime transition uses the existing escrow/owner migration, not a
parallel SDK operator. This purpose explicitly adopts the inherited authenticated
closed pause and records that no new public pause was sent. Backup/stop/install/
launch/final handoff still use the original guarded migration state machine.
Installing this runtime alone does **not** create a document or release modeling.
Never edit the running `843`/successor artifacts or their approvals in place.

## One-shot document qualification

Only the original authenticated CLI owner, with existing credentials, can request:

```sh
fmcad queue create-isolated-scratch --job TARGET_JOB --observation-job PRIOR_OBSERVER_JOB --request-id STABLE_CREATION_REQUEST
```

No client, process, document, source or outcome override is accepted. The broker
derives a random epoch ID, reserved scratch name and exclusive proof paths. The
request uses the same physical queue, actual checker, complete source-origin
manifest, final-byte/resource fences and process-guarded receipt wrapper as audit.
The only authorized lifecycle effect is this exact script's `documents.add`.

The SDK source records all pre-existing creation IDs and rejects duplicate IDs,
an existing reserved name, a returned pre-existing or historical creation ID,
anything other than exactly one additional document, saved/data-file state and
nonempty design/timeline/reference counts. It never renames an old returned
document. Exclusive `.started`/`.created`/qualified proof files retain uncertainty.
No transport failure, lost acknowledgement or missing local result can cause a
second `documents.add`. Another request ID is rejected, not treated as a new try.

The broker requires the successful bound remote receipt **and** the exact durable
SDK proof before creating the new admission store. An uncertain creation leaves
the old queue blocked, retains evidence and does not trigger automatic cleanup.

## Durable publication and historical quarantine

The new files live under `admission-epochs/UUID/`:

- `initialization.json` binds the creation intent.
- `queue-state.json` contains only new epoch work, with new generation/context.
- `instance.json` binds the same qualified live current process and new runtime.
- Explicit token-hash-bound `access-*.json` grants and final `closed.json` evidence.

`isolated-admission-epoch.json` is published **last**. The old root
`queue-state.json` and `instance.json` are not replaced, cleared or rebound.
Interrupted local publication can finish only from exact immutable qualification
evidence; it never reruns the SDK script. Concurrent result polls join one
publication callback. Re-reading an existing creation receipt cannot reset an
active/unknown current job, clear a hold or reopen a closed epoch.

Historical request IDs cannot be reused. Historical cancel, reconciliation,
acceptance, replay and cleanup remain refused. Owner `find-request`, job status
and result reads retain the original job and mark its historical quarantine.
Queue totals distinguish current nonterminal jobs from `historicalUnknownJobCount`.
The two historical unknown jobs do not silently disappear or become aborted.

## MCP/library registration and precise grants

After actual scratch qualification, a **newly loaded qualified client** can call
`fmcad_execute` with `action: status`. This is metadata-only registration/status,
not modeling or a grant. Epoch-aware library compatibility selects the new
identity/store read-only instead of interpreting the old identity as current.
Status supplies its own public `clientId` and exact `isolatedScratch` identity.
No private token is returned. An already-loaded older client may fail closed on
its legacy build/identity fence; do not hot-patch its cache or mistake it for ready.
Coordinate client loading with the runtime transition and active owner operations.

The original CLI owner grants only this exact already registered client:

```sh
fmcad queue grant-isolated-scratch --epoch-id QUALIFIED_EPOCH --grant-client REGISTERED_CLIENT_ID
```

The broker binds the current token hash, epoch and exact proven-new document.
Another owner, token, epoch or document cannot reuse the grant. It is not broker
administration, historical access or arbitrary Python permission.

All modeling requests must be validated typed CAD invocations, pinned by both
qualified name and creation ID, with no saved file/project pin. Their argv must
be the exact standard typed policy projection, never executable argv fallback.
The broker authors the persisted epoch binding itself. Admission and final SDK
dispatch recheck process, pointer, history, qualification, grant, bytes and epoch.
The SDK wrapper verifies the actual endpoint process before running model code.

The deliberately narrow operation vocabulary is:

- `sketch.create`, `sketch.geometry`, `sketch.inspect`, `sketch.check`,
  `sketch.profile-query`.
- `model.extrude`.
- `entity.list`, `entity.inspect`, `measure.volume`, `document.status`.

Raw RPC/Python, `run`, batches/native old workflows, imports, exports, saved-document
publication, broad document clear and other operations remain denied. A new
uncertain operation blocks this epoch too; isolation is never a replay permit.

## Minimal first-model qualification

Use one registered/granted native qualifier session, and pass the document pins
from the actual creation receipt to **every** `fmcad_execute` invocation. Example
typed operations (not a claim that these have run live):

1. `sketch.create`: `{ "name": "EpochSection", "plane": "XY" }`.
2. `sketch.geometry`: rectangle in `EpochSection`, from `["0 mm","0 mm","0 mm"]`
   to `["10 mm","6 mm","0 mm"]`.
3. Inspect the exact sketch and require one profile before choosing profile index 0.
4. `model.extrude`: that exact profile, distance `"4 mm"`, `operation: "newBody"`.
5. Read bodies/geometry in the same scratch; use the returned body ref, not a
   guessed name. With `measure.volume` and `units: "mm3"`, the intended prism is
   240 mm³. Require actual geometry/count/health evidence before reporting PASS.

Use a distinct stable request ID per intended operation. Query the existing
request/result after uncertainty; never resubmit it under another ID. This is
model validation of the new test scratch only, not physical manufacturing
validation or recovery of the historical model.

## Scratch-only cleanup

Only the original owner may request the separate one-shot operation:

```sh
fmcad queue close-isolated-scratch --job TARGET_JOB --observation-job PRIOR_OBSERVER_JOB --request-id STABLE_CLOSE_REQUEST
```

The epoch must be quiescent with no active, leased or unknown current work. The
fixed SDK script resolves exactly the qualified creation ID/name, requires an
unsaved unlinked document, and calls `close(False)` only on that scratch. Saved,
renamed, absent, ambiguous or linked documents are not discarded. The observed
document-ID set must lose exactly that one ID. No old document is saved or closed.

A cleanup intent immediately denies further modeling/grants. A lost or failed
close reply remains pending/unknown; it cannot be replayed or treated as rollback.
Only a successful physical receipt and durable exact SDK close proof publish
`closed.json`. Closing is terminal for this epoch; creation cannot be repeated.

## Qualification boundaries

Offline tests exercise actual broker IPC/state/persistence and production
basedpyright/final-byte certificates with explicit fake physical backends or SDK
doubles. Those results are not live SDK geometry results. Installed qualification
must verify the actual packaged artifact and no direct fallback. Actual current
audit facts, serialized runtime/client deployment and the native new-scratch
qualification remain live prerequisites. There is no global HOLD-off flag.
# Utrata procesu przypisanego do epoki

Broker może odtworzyć wyłącznie warstwę metadanych, jeśli dowody izolowanej
epoki, jej build i tożsamość są poprawne, ale nie da się potwierdzić tego samego
żywego procesu. Status zgłasza wtedy `blocked-process-unavailable` i wyraźny
powód `held`. Istniejący uwierzytelnieni klienci mogą odczytać status, żądania
i wyniki. Nie wykonuje się probe ani SDK; scheduler, nowe rejestracje,
sterowanie lifecycle, reconciliation oraz tworzenie, grant i zamknięcie scratcha
pozostają zablokowane. Uszkodzone dowody nie uprawniają nawet do tego trybu.

To nie odnawia epoki i nie jest zgodą na adopcję dokumentu odzyskanego przez
nowy proces Fusion. Dotychczasowe dowody i historia pozostają niezmienione.
# Returning to ordinary shared-broker admission

An owner can finish recovery isolation as part of the existing exact scratch
cleanup, selecting `--admission-mode normal-multidocument --confirm-ownership true`
on `fmcad queue close-isolated-scratch`. Keep the original target/observation IDs
and a single new cleanup request ID. A pending or lost response is observed under
that same ID; it never authorizes a second close.

The mode is bound into the original owner-authenticated cleanup intent. Ordinary
admission starts only after verified SDK close/active-document restore and an
independent successful terminal physical receipt. A `closed.json` label alone is
insufficient. Omitting the option preserves the existing terminal closed mode.

The same current queue and scheduler then serve registered clients and separate
documents. Existing process, build, document and current-unknown fences remain.
Historical and retired request IDs remain read-only and cannot be replayed;
their unknown outcomes are not relabeled. Neither the epoch pointer nor old
queue snapshots are deleted or replaced. Test clients create new unsaved
documents and close only their own documents, restoring the captured active one.

## Lost client responses are not unknown SDK execution

Queue response recovery never dispatches a mutation again. After an admission
ACK is lost, the client observes the same authenticated `requestId` and requires
the broker to match its immutable original input before returning the original
job. A legacy broker without that proof, a missing record, or an uncertain
observation preserves the error and stable identity. A mismatched input is
reported as `REQUEST_CONFLICT`, not a recovered success.

Only `result` and `find-request` transport reads receive bounded retry: at most
three observations, with short backoff. Cancellation, reconciliation, native SDK
dispatch and administrative writes are not retried by this mechanism. The
existing explicit `BUILD_CHANGED`/`notStarted` CLI handoff remains separate;
public typed admission does not acquire automatic startup or build replacement.

A durable terminal job/SDK receipt, output publication and engineering validation
are different facts. For example, a successful recipe can legitimately contain
a domain check with `status: unknown`. Conversely, a successful socket exchange
does not settle a missing native end receipt. `needs_reconciliation` remains
uncertain execution evidence and is never promoted to PASS by response recovery.

The opt-in native regression programs are TypeScript sources compiled to
`dist/tests`. `test:native:multidocument` exercises two new owned documents;
`test:native:response-recovery` drops only its own client response after a proven
single mutation, recovers the original job and independently checks one parameter.
Use `FMCAD_LIVE_RUNTIME` to select the exact qualified installed runtime. These
fault probes are deliberately outside the generic live-suite matrix.
