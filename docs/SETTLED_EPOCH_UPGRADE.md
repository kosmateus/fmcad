# Qualified runtime handoff after successful SDK work

`quiescent-settled-isolated-epoch-upgrade-v1` is a separate owner-approved
contract, not an extension of the historical two-rejection SDK0 repair. It
preserves one live, unsaved scratch and its model while replacing only its
cooperatively released broker with a separately installed qualified release.
It sends no SDK requests and never restarts or signals Fusion.

The existing `scripts/upgrade-epoch-checker.cjs` selects this variant only by
the exact approval purpose. The old purpose retains its SDK0 restrictions and
original installation behavior. For the settled variant:

- `settledJobIds` is an exact nonempty set of successful typed CAD jobs, with
  `sdkSettled: true`, no active sequence identity, and exact epoch/document/build
  pins. `rejectedJobIds` is forbidden.
- `settledEvidenceHash` is SHA-256 of `JSON.stringify(settledEpochEvidence(...))`.
  The independent reader checks published worker outcomes, proven-dead local
  workers, every terminal RPC, checker status, and successful bound physical
  receipts. Native starts require their own matching successful completion.
  It rejects extra/unaccounted physical receipts, unknown/failed jobs and raw
  scripts rather than inferring settlement from a queue status label.
  Each job retains its original source build, including after an earlier
  handoff. The approval pins all those evidence hashes; receipts are never
  relabeled to the departing runtime's build.

Successful registered fixed programs may also be carried without replaying
their model construction. They require the original credential/document-bound
fixed grant, exact original installed runtime fingerprint, source/manifest hash,
bounded invocation and terminal successful worker/checker/physical evidence.
Unregistered raw scripts and failed or unknown executions remain refused. A
feature report can fail validation even when its SDK execution succeeded; that
report is retained unchanged, not promoted to a feature PASS by the handoff.
The fixed grant is not upgraded to the new build or broadened. Subsequent
read-only correction uses only an independently authorized typed owner scope.
- The original owner credentials, grant hashes, pointer, historical evidence,
  selected process and zero-active/no-lease conditions remain mandatory.
- `candidateRoot` is the canonical new immutable installed runtime;
  `installRoot` and `previousQualifiedRuntime` retain the departing immutable
  release. Neither tree is copied, renamed or edited.
- The installed qualification must additionally prove
  `settledEpochRuntimeUpgradeQualified: true` using the real packaged broker
  on an explicit synthetic settled fixture. Run the existing installed checker
  qualification with `--settled true --fixture /absolute/settled-epoch-upgrade.cjs`.
  This checks production final bytes and metadata-only startup, not live model
  validity.
- `stateOptions` explicitly pins the standard `idleMs: 60000` and
  `leaseMs: 600000`. No unlimited or extended exclusive hold is introduced.

The transaction pauses first, preserves evidence in escrow, and requests
`console-stop`. Pause and console stop use the same stable
`<requestId>:pause-stop` control key, so the stop does not change the captured
paused snapshot. Its separate console action journal still records the actual
stop. Acknowledgement alone is insufficient: the exact old broker must be dead,
its marker released, and `console-release` must report terminal `released` for
that owner/build/request. Claim rechecks this hashed proof and all settled
evidence before publishing the new owner marker.

The new receipt kind is `quiescent-settled-isolated-epoch-runtime-upgrade`.
It reports the carried `settledJobIds`/evidence hash, SDK0 and unchanged grant
scope; it never labels these jobs as local rejections. The gate remains closed.
Resume is a **separate normal owner operation with its own receipt**; its live
probe is not part of the SDK0 handoff claim. Subsequently inspect the preserved
model through the shared public API before treating the live upgrade as tested.

On uncertain stop, launch or readiness, observe the original journal only.
Do not retry an intended stop, launch another worker, remove guards or reuse
this contract to settle historical unknowns. Test fixtures labeled FAKE are
synthetic evidence and must never be written to a live queue.
