# Repair the checker while preserving an existing isolated scratch epoch

This is a distinct owner-authenticated runtime transaction, not replay of the
completed original-history migration, an admission override or manual queue edits.
The exact two failed local smoke jobs remain failed and their ledgers unchanged.
No Fusion restart, model mutation or SDK call is part of this transaction.

The checker runs inside the broker's final physical boundary. An old public
client cannot supply a replacement certificate or correct this defect itself.
Consequently both the broker runtime and subsequently loaded public client must
use the same new qualified build. A new client with the old broker is rejected.

## Preconditions

Only existing private credentials of the epoch's original owner may run the
installed `scripts/upgrade-epoch-checker.cjs`. There is no client override.
The approval purpose is `quiescent-isolated-epoch-checker-upgrade-v1` and pins:

- Candidate source/build, canonical roots, exact adapter SHA and installed real
  checker/startup qualification (`epochRuntimeUpgradeQualified: true`).
- Previous build and its already immutable qualified runtime witness.
- Exact current epoch/document/pointer hash and current process tuple.
- The two explicit rejected job IDs, independent SDK0 outcomes, dead workers,
  no physical journals, and original smoke-ledger references and hashes.

The approval also explicitly binds the existing supported queue lease budgets:
180 seconds idle and a 30 minute total exclusive lease. Final-byte aggregate
analysis is local preparation and can exceed the default 60 second idle interval;
the six-op exclusive smoke must not lose its reservation solely while performing
its mandatory checker work. These are bounded operational budgets, not a model,
document, retry or unknown-work permission; per-job deadlines and all fences
remain enforced. No global default is changed and an active lease is never edited.

The broker must be live and quiescent: no active work, lease, pending durability
marker, unknown job, cleanup intent, saved/foreign target or competing lifecycle.
Root historical snapshot/identity and all new-scratch/grant proof bytes must
match. All other clients are instructed not to submit during this narrow repair.
Any race which creates another job changes the fenced state and refuses install.

## Small escrow and supported stop

1. Authenticate locally, qualify the immutable candidate, observe the exact epoch
   and publish immutable intent/initial plus an exclusive adapter process claim.
2. Use the EXISTING authenticated public `pause` lifecycle command and re-observe.
   Already durably closed current pause is adopted truthfully, not fabricated as
   another public RPC. Preserve the job map/grants/pointer/evidence unchanged.
3. Escrow the small current state/identity and immutable full-history/scratch/old
   ledger hash references. The accepted original migration escrow is not recopied
   or re-certified. Old runtime bytes are preserved by directory rename at swap;
   an independent immutable previous-build witness is verified too.
4. Publish startup-only `recovery.lock`, then invoke the old broker's supported
   authenticated `stop` with its own stable control key and exact generation.
   Frozen f708 permits this cooperative stop while that startup guard exists.
   No signal is sent. Wait for exact PID/birth death AND cooperative broker marker
   release; uncertainty retains evidence and refuses install, not a second stop.
5. Fence the paused small state and all immutable history/proof references again.

There is NO `atomic-migration.lock` before the public stop (it would self-block
the old public lifecycle command). The startup guard prevents another autostart.
Ordinary paused submissions cannot acquire an SDK turn; any accepted new local
work changes the snapshot and fails the subsequent fence. No public gate opens.

## Install, identity and metadata-only startup

Stage only the new runtime, verify full build/checker bytes, journal install intent,
and preserve the old installed directory. Atomically swap the runtime only after
the old broker has cooperatively released itself. This does not rebuild or modify
the immutable qualified artifact, source master or unrelated worktrees.

The epoch's old identity bytes remain in escrow. The authenticated transaction
updates **only** that epoch identity's `buildHash`; same process tuple/config and
same document are retained. Root historical identity/state, pointer, grants,
all old jobs and ledgers are untouched. This is an explicit guarded transition,
not permission to edit `instance.json` manually.

Before startup, both own guard markers bind the transaction nonce/audit/client.
The new worker wins an exclusive process claim before calling `serve`. A private
startup option can claim only with the exact journal, preserved state/identity,
unchanged grant/evidence hashes, original owner credential hash, dead old broker
and the same live selected Fusion. Public CLI users cannot supply that option.
Restored epoch startup is metadata-only: no initialization/probe/SDK traffic.

The owner verifies ready/worker/new broker, exact paused state, pointer/root
history, identity, grants, process and candidate build. Only then is complete
published and the transaction's OWN guards released. The epoch stays PAUSED.
No modeling, new document, grant broadening or old-history reconciliation results.

## Resume and explicitly renewed model attempt

After actual complete, the original owner uses ordinary qualified `queue resume`.
Its normal gated read-only current-instance/idle check must succeed; this is a
separate control observation, not counted as SDK0 deployment or geometry proof.
Do not bypass its checker/process/unknown guards. Then load the new qualified
public client for the SAME registered native client/session and verify its new
build plus exact existing epoch/document/grant. Old cached clients fail closed.

Only after actual deployed/ready/resume/public-status proof does the coordinator
issue a separate explicitly identified corrected six-operation attempt with new
stable IDs and a new exclusive ledger, backed by BOTH old terminal SDK0 failures.
No old request or ledger is resubmitted/reset, and no unlimited retry flag exists.
Another failed/unknown operation halts and is investigated; no automatic loop.
The native runner must validate the exact actual runtime-upgrade receipt/new build,
not relabel the old f708 constants or accept arbitrary builds. The original owner
callback and reserved close ID remain for known six-op success/240 mm³ only.

## Interruptions

- Active/unknown adapter worker cannot be replaced; only proven-dead claims may
  be archived under exclusive retirement evidence.
- Immutable stages and escrow are compared, not overwritten. Partial small runtime
  copy resumes only from identical bytes; mid-swap uses journaled paths.
- Stop intent without observed death never signals/retries blindly. Inspect the
  original public lifecycle receipt and process state for a supported decision.
- A launch intent without a worker receipt fails closed; a known live worker is
  observed, never duplicated. A late ready receipt may complete the same journal.
- No startup can pass with changed history/grant/source/nonce/owner/process proof.

## Scope after the repair

This transition fixes admission interpretation only and preserves the current
one-scratch grant. It is not renewal of a closed scratch, broad native-suite access,
saved DataFile authority or a global release. Repeatable new project/document and
specific 11-group capabilities require explicit proof-backed successor authorities
and exact per-document grants; that work follows the first actual corrected model.
