# Saved fixtures on the test backend

Stage 2b adds saved-file scenarios to the existing runner. The same programs and
assertions are used by the model and the future native Fusion run. Only the
configured project/folder identifiers and path mapping differ.

## Lifecycle

The runner creates its own document and local export, writes a request-bound save
intent, submits `saveAs` once and observes the exact file until `isComplete` is
true. It records project, folder, file ID and version. Scenario operations retain
the document guard and additionally check the saved file identity.

Cleanup closes the owned document, checks the exact file/version, submits deletion
and observes absence in the configured folder. It refuses changed versions,
read-only files, foreign receipts and foreign absence proofs. Other documents and
folder files are compared before and after each run. Historical unsaved/export
cases remain a separate foundation suite.

Save/close/delete acceptance and completion evidence are separate. A lost reply
leaves cleanup deferred. Recovery rereads the original backend result and never
repeats an accepted save, close or delete. New read-only observations are allowed.
A settled failure is checked against the current owned state before cleanup
continues. Operation/assertion errors remain separate from cleanup errors.

Normal and recovered cleanup now use the same implementation. After every created
scenario has cleaned up, recovery checks the original document/file inventories
and restores the original active document. The run manifest is written before
launching scenarios so an interrupted run retains its coordinator inventory.
Recovery reconstructs runner state from disk while the original backend remains
available; a new simulator process cannot recover another process's documents.

## Model boundaries

The model implements the pinned Autodesk save/file interfaces and checks their
call shapes against the repository API snapshot. Save acceptance initially leaves
a file incomplete. Cloud processing and deletion visibility advance between SDK
requests. This intentionally tests delayed observation without claiming to model
native cloud timings.

An unchanged save is successful without a new version. A modified save keeps the
file ID and creates a new version. Open, incomplete or read-only files cannot be
deleted. Model controls and operation counters are used only in unit/fault tests;
shared scenarios use the Autodesk interface. Exports remain explicitly marked
JSON test state, not genuine F3D bytes.

## Coverage

The runner suite has 54 cases. New cases cover both protocols, loss of save/status/
close/delete replies, partial save failure, refused operations, assertion and
operation failures, cancellation after save acceptance, polling timeout, foreign
receipts/proofs, changed versions, read-only files, and ten saved owners alongside
duplicate-named foreign files. Recovery verifies that each mutating lifecycle
operation was submitted only once after a lost reply.

Two historical recovery assertions now allow additional read-only inventory
requests. Their previous total SDK-call counts would reject the newly required
final audit. The tests still prohibit a second close or replay of the original
scenario mutation. Expected document effects and scenario failure status do not
change.

The CLI defaults to `--suite all`; `foundation` and `saved` select either group.
The model uses a dedicated configured folder. A native saved run requires explicit
`--project-id` and `--folder-id`; no live folder is selected or created implicitly.
At the time of this historical stage, native runs were deferred. Targeted local
Fusion checks may run during development against the matching installed build and
shared broker; final qualification remains a separate evidence-backed gate.

CI runs both suites through the real broker over MCP and addin. The foundation
matrix retains ten parameter owners; the saved matrix uses two parameter owners
plus a lifecycle case. Unit tests separately interleave ten saved owners. All
profiles retain production Python admission and process guards.

CI exposed another existing browser-test race: the initial heading rendered
before project/task data arrived. The test now waits for the API-backed rows and
freshness state. Similar filter assertions wait for the requested row count or
removal of excluded rows. All existing expected values and assertions remain.

## Final native qualification

Verify save acceptance/dataFile visibility, creationId lifetime through save,
version publication, delayed folder visibility, close/delete errors and recovery
against the installed Fusion build. Also verify folder access failures, references
that prevent deletion, and runner/broker process termination with the original
Fusion instance still alive. Reopen/import and geometric behavior remain later
contract families. These assumptions do not block the remaining mock-backed
refactor and are not counted as native passes.
