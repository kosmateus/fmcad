# One-time atomic broker-owner migration

This is the explicitly approved external migration boundary for `fmcad-6bz`, not
an idle reload, a general reclaim, a Fusion restart, a fixture replay or a way to
resolve an unknown native outcome. The original authenticated Fasteners CLI owner
must run it with existing credentials. It cannot mint a client, accept `--client`,
steal another owner's job or reuse an MCP identity as the CLI owner.

## Preconditions

- Approved source includes the scoped observer, owner CLI, Containment and the
  **production** Python checker/certificate composition.
- A separately qualified packaged runtime, its actual build fingerprint, the
  admission module digest and a qualification receipt are approved together.
- `migrationAdmissionPreflight(prepared)` runs the real production checker on the
  final receipt-wrapped `atomic_status` artifact. It creates no queue job and
  sends no SDK request. Its certificate is **not** reused by the real observer.
- The original job/request/report/command/session/document pins still match;
  there is exactly one unresolved job, zero active physical operations, no lease,
  no competing reset/startup and no other unfinished jobs.
- A raw CLI origin is projected only from the original broker-written typed
  worker input envelope. Its accepted raw request/hash is never edited; the
  envelope digest and original input-file pins remain part of the escrow/fences.
  Current mutable `--file` bytes are not replayed or used to reconstruct input.
- Original worker death and every original physical turn's bound terminal
  **transport** receipt are verified. This does not establish native termination,
  lack of mutation, rollback or CAD/model acceptance.
- Linux pidfd operations are available. PID-only signals and SIGKILL are not used.

All process identities and queue fences are read again. Historical PID numbers,
an old status response, an exception string or a known worker death are not stop
authorization.

## Approval and invocation

An operator prepares a private approval JSON file from actual qualification
results, never from assumed passes:

```json
{
  "version": 1,
  "sourceCommit": "APPROVED_40_HEX_SOURCE_COMMIT",
  "buildHash": "APPROVED_64_HEX_RUNTIME_FINGERPRINT",
  "candidateRoot": "/absolute/qualified/candidate/dist",
  "installRoot": "/absolute/canonical/installation/dist",
  "admissionModuleSha256": "SHA256_OF_CANDIDATE_SRC_QUEUE_ADMISSION_JS",
  "checkerFingerprint": "REAL_CANDIDATE_ADMISSION_RESOURCE_FINGERPRINT",
  "qualification": {
    "path": "/absolute/private/qualification.json",
    "sha256": "SHA256_OF_ACTUAL_QUALIFICATION_RECEIPT"
  }
}
```

The qualification receipt must bind `sourceCommit`, `buildHash`,
`productionAdmission: true` and `passed: true` to documented real checks.
The approved module must export `migrationAdmissionPreflight(prepared)` with a
successful descriptor binding the same build, checker resources and final
artifact. Missing, incomplete or refused admission fails **before pause/stop**.
The installed-site checker's content inventory must also match the qualified
candidate. The context-sensitive certificate/resource fingerprint is deliberately
not reused across runtime locations or across dispatches.

Run the CLI from that exact approved candidate runtime in the original owner
environment and project directory. First use read-only mode:

```sh
node "$CANDIDATE_ROOT/bin/fmcad.js" queue migrate-atomic \
  --job 5fbcd38b-8e8a-4cd7-8eab-353e8b025b9a \
  --request-id measured-fasteners-owner-migration-20261028-v1 \
  --migration-approval "$APPROVAL_FILE" --preflight true
```

`readyToPause: true` is **not** permission to stop without the remaining escrow
steps. Apply the same approved intent with `--confirm-ownership true` instead of
`--preflight true`. Do not use a different request ID after a lost acknowledgement.
Concrete candidate/approval paths are supplied only after qualification; the above
is a template, not a ready-to-run instruction for the legacy broker.

## Durable stages and retained evidence

1. Authenticate against the original owned request and actual credential. Publish
   one immutable intent and nonce-bound migration/recovery guards.
2. Apply the existing authenticated pause control with generation/instance fences.
   Preserve the original job/history and verify the durable closed gate.
3. Copy queue history, credentials/receipts, exact report directory and old runtime
   into private read-only escrow. Hash every file and publish the manifest digest.
   Only the socket, mutable console diagnostic snapshot and `.log` diagnostics are
   excluded from queue evidence; original log files are not removed.
4. Recheck holder/state/report/receipts/build/instance/guards and zero active work.
   Publish stop intent before signalling. The local helper opens a pidfd after
   exact birth verification. The legacy first TERM may refuse cooperative close;
   the authorized external operation may then TERM the **same pidfd** again.
   This is recorded as external termination, never as successful graceful close.
5. Prove old owner death. Retain the entire old runtime and install only the
   approved verified candidate by directory renames, never by overlaying unknown
   files. Original `.gitignore` and top-level `server.mjs` are untouched.
6. The new worker atomically publishes its one-time process claim before creating
   a broker. Startup accepts only the bound nonce, dead-owner proof and exact
   escrow snapshot. It skips no admission checker and sends no startup SDK probe.
   The original broker marker is archived, not silently discarded.
7. Verify the new live PID/birth/nonce/build, unchanged original Fusion identity,
   byte-equivalent queue snapshot, original report and backups. Until the handoff
   receipt is committed, the new broker permits metadata only, not probe/submit,
   lifecycle mutation or outcome acceptance. Archive the guards after completion.

The handoff receipt still says `unresolved: true`, `nativeOutcome: unknown`, and
rollback/model validation `not_performed`. It does not resume the global queue.

## Crash and lost-acknowledgement handling

Use the **same** owner, approval and request ID. Conflicting immutable receipts or
changed backups are never overwritten.

- Pause acknowledgement loss is observed through its original bound lifecycle
  receipt and durable `controlRequests` record, not a repeated resume/probe.
- A partial backup is completed only if existing copied files match the exact
  source digests. Any mismatch retains the original owner and closed admission.
- Interrupted TERM intents remain in history. Retry rechecks all fences and opens
  a fresh pidfd for the same original birth; it does not assume an intent means a
  delivered signal. A dead original is observed without another signal. Refusal
  after two completed TERM attempts is an explicit retained/inspection case.
- Interrupted runtime swaps recognize the retained original and staged/installed
  directories by their exact manifests. Unknown files are never replaced.
- An interrupted worker launch may re-enter its **idempotent process claim**.
  Only one candidate can win `worker.json`; duplicates exit before `serve`, SDK
  access or outcome publication. This is not replay of a CAD operation.
- A proven-dead migration worker may be archived and replaced only under the same
  intent, unchanged escrow and metadata-only guard. Its broker marker requires a
  matching immutable retirement receipt. A live or unknown worker is never killed
  or stolen. All earlier worker/owner evidence is retained.
- After a completion receipt is durable, retry only returns it and finishes any
  remaining archival of that intent's guards.

Changed identity/state, corrupt receipts, unknown process liveness or an unproven
owner stop remains fail-closed with explicit receipts for continuation. No path
edits job terminal state, reports rollback, activates documents or replays work.

## Native observation remains separate

Only after the new public status and handoff receipt are ready may Fasteners run
the owner `queue observe-atomic` command documented in
[ATOMIC_HOLDER_OBSERVATION.md](ATOMIC_HOLDER_OBSERVATION.md). The real dispatch
checks its own final bytes/certificate again. Outcome acceptance requires its
actual exact terminal proof and the original owner's acknowledgment. An unknown
readback stays unknown; neither migration nor transport success opens the gate.

## Separately authorized second window: current-state recovery audit

The first permission and receipt cannot be reused to stop the replacement. The
following purpose is preparation for a **new explicit user-authorized window**,
not permission granted by the presence of an approval file or successful tests.
Until that authorization, do not execute even the prepared owner commands.

An audit-upgrade approval has the same source/runtime/admission/qualification
bindings above and adds:

```json
{
  "purpose": "atomic-recovery-audit-upgrade-v1",
  "auditUpgrade": {
    "observationJobId": "3627db2e-0b9d-4e4f-927f-20cb45deae74",
    "previousComplete": { "path": "EXACT_FIRST_AUDIT_DIR/complete.json", "sha256": "ACTUAL_HASH" },
    "observationProof": { "path": "EXACT_OBSERVER_JOB_DIR/atomic-observation-proof.json", "sha256": "ACTUAL_HASH" }
  }
}
```

The first audit directory is derived from
`measured-fasteners-owner-migration-20261029-v2`, not chosen by a caller. Its
complete and escrow-manifest digests, original/observer builds, exact original
job and unavailable observer/terminal transport bindings must match. The owner
must own BOTH jobs. Exactly those two jobs may remain unresolved; active must
still identify the observer and blocked must identify the original batch.

The original instance/job build (`1ef9b72…`) remains separate from the departing
broker build (`2e1b3b7b…`). Existing closed generation/context and full job history
are preserved, without rewriting either job or its native unknown outcome.
The already-paused authenticated pause is idempotent, not a resume/pause cycle.

The same real private admission checks the complete final receipt-wrapped
current-state audit program. This is not a transaction-state ABI interpreter or
an exemption for the old atomic source. Its request-bound preflight RPC identity
and descriptor are deterministic across continuation; the certificate is never
reused by the later live audit.

After the new user authorization, the original owner uses the candidate's public
`queue migrate-atomic`, a NEW stable request ID and `--preflight true`. Only after
that actual successful preflight may the SAME ID proceed with
`--confirm-ownership true`. The stages remain owner proof → closed pause proof →
new immutable escrow → fresh zero-active/PID/birth/nonce/chain fences → bounded
pidfd stop → retained runtime swap → claimed metadata-only startup → complete.
`audit-atomic` remains blocked until completion guards are released. Startup and
migration send zero SDK requests and do not restart Fusion.

Only after actual public handoff health may the owner execute the separately
scoped current-state audit. Its facts do not recover historical outcome, accept
risk, terminalize either job, prove rollback, or resume global modeling.

### Original process terminated after preflight

A preflight is a point-in-time observation, not a process reservation. Apply must
repeat the original PID/birth check. A process death after successful preflight
is therefore a correct apply refusal. New preflight receipts include explicit
historical/current process observations and UTC observation times. Unknown
liveness is distinct from confirmed death and cannot satisfy either expectation.

The existing live-original purpose remains strict. A separately qualified
`atomic-recovery-process-loss-audit-upgrade-v1` approval may instead bind an exact
`currentInstance: {pid,birth,version}` and requires:

- Proven termination of the original PID/birth, not an unavailable observation.
- A distinct selected current PID/birth that is currently live.
- All existing owner/history/receipt/escrow/zero-active/broker stop fences.
- Metadata-only startup retaining the ORIGINAL instance.json and both unknown
  jobs. This is **not** a current admission epoch rebind.

This purpose creates an owner-nonce-bound current-audit scope. The subsequent
read-only audit's receipt wrapper verifies the actual SDK process PID/birth and
version BEFORE executing any audit body/document getter. A foreign or stale
endpoint is refused, not used to inspect a different model. The output separates
the terminated historical instance from current facts, always retaining unknown
historical outcome and blocked modeling admission.

No existing reclaim/resume/version-transition can use this as an unknown override.
Unblocking modeling requires a separately supported disposition: for example a
new, explicitly isolated epoch restricted to a newly created qualification scratch,
with the historical unknown jobs still quarantined and readable. Such a scratch
or quarantine/admission transition is NOT implemented or authorized by this audit.
Alternatively the user may choose recovery/preservation of a particular old model;
the original unsaved state cannot be inferred from process death or equal versions.
