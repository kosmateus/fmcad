# Stage journal inspection and continuation advice

`packages/core/src/application/stage-journal.ts` exports `createStageApi`,
`inspectStageJournal`, `resumeStagePlan`, `revalidateStagePlan` and
`validateStageJournal`. The filesystem adapter is the separate
`packages/node-adapters/src/persistence/stage-journal.ts` module. These are
composition ports, not new CLI commands, a workflow executor or an SDK transport.

## Authenticated owner and consumers

`src/composition/stage-dependencies.js:createAuthenticatedStageDependencies`
composes the one trusted per-job owner adapter. The typed worker invokes it from
`src/composition/execution-worker.js` only after the existing capability, build
and accepted-input verification. It supplies the real document-save stage port
to `src/document-publication.js`, batch stage hooks to `src/batch.js` and the
helper-run stage hook to the prepared Python execution service. The same owner
backs public read-only `FmcadServices.stage(jobId)`, `journalInspect(jobId)` and
`resumePlan(jobId)` methods; these first use the broker's existing authenticated
`result` action and never accept caller-supplied scope fields.

The internal adapter's real receipt readers bind document-save stages to the
existing numbered `document-save` owner journal, non-atomic batch stages to the
existing numbered batch report, atomic stages to `validateAtomicHistory`, and
`cad-v1` helper runs to the broker-owned terminal `FMCAD_RESULT` artifact. Each
also requires the independently validated job RPC/native/postflight lifecycle.
For a mutating stage, completion returns the exact owner terminal hash, physical
receipt-set hash and validated postflight hash. Missing, unknown, corrupted or
foreign evidence remains noncomplete. No read path executes a mutation or
converts `unknown` into replay permission. See `docs/STAGE_OWNER.md` for the
worker call boundary and original-receipt formats.

`assets/cad/helpers.py` still keeps its local `calls` list as helper output, but
the outer prepared helper run now has a durable Node-owned stage intent and its
terminal marker is checked against the original accepted script plus broker
receipts. The Python `FMCAD.stage()`, `journalInspect()` and `resumePlan()` views
receive a snapshot from the verified worker; they do not accept public CAD context
or arbitrary paths. No second Python or filesystem journal is introduced.

## Persistence and interpretation

The adapter writes exclusive numbered files in `stages/` beside an existing
operation journal, using the existing fsync/exclusive-publication helpers. It
creates no lock, lease, scheduler, queue state, second accepted-byte store or
keychain. Each record hashes its entire canonical body, scope, sequence and
previous hash. The first record is an immutable ordered plan; subsequent records
are single-use ordered submission intents. Record replacement is never allowed.
Appending races lose via exclusive publication; uncertainty faults the current
writer. Existing broker/workflow ownership is still mandatory.

Inspection is read-only. An intent plus matching settled successful evidence is
`completed`; a persisted plan entry without intent is `notStarted`; an intent
without matching terminal evidence is `unknown` even if the client lost its
response. A missing journal does **not** mean notStarted. Gaps, malformed/hash
conflicts, foreign scope, missing originals or unknown receipts require
reconciliation and suppress `nextStage`. Failed native work is not completed.
No API can promote an unknown mutation to replayable. `automaticResume` and
`replayAllowed` are always false. `nextStage` is only read-only advice.

Hash chains detect interior loss and changes, not an attacker rewriting all
private state or removing an unobserved tail. Retain the returned head in existing
owned result evidence and supply `expectedHead` to detect trailing loss. No new
checkpoint authority is introduced. A deleted whole journal remains missing,
never permission to reconstruct or execute it.

Accepted bytes are read from the existing admission manifest and content-addressed
accepted-input artifacts. Current source paths are never reread as substitutes.
The owner retains exact original bytes, request metadata and final prepared
artifact hashes under the existing execution-store contract. Plans revalidate
the journal head, receipt hashes, original bytes, job ownership and request,
current build and pinned document, plus normal admission/final-send fences.
`revalidateStagePlan` recomputes the read-only plan and compares exact evidence;
it is not an atomic reservation and does not replace broker fences.

## Offline verification

```sh
npm run build:code
node --test tests/stage-journal.test.js tests/execution-store.test.js
```

Dedicated tests use real child processes and the existing accepted-input adapter,
durable publication helpers and native lifecycle receipt validator. They cover
client response loss, process death after persisted intent, correct completion,
changed build/document and all foreign identity fields, missing originals,
missing journal/interior/tail records, corrupt evidence, exclusive append,
symlink refusal and stale-plan revalidation. They do not execute Fusion, validate
physical geometry, exercise final helper/batch wiring or claim live qualification.
