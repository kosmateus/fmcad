# Owner-authenticated succession after a lost Fusion process

An isolated scratch grant belongs to exactly one Fusion PID/birth/version and
one proven-new document. It cannot be copied to another process, applied to a
recovered document, or renewed by deleting the epoch pointer. The old epoch and
every historical unknown remain immutable.

This route starts a **metadata-only broker** from a separately installed,
qualified runtime. It does not replace the canonical checkout, restart Fusion,
signal a live owner, adopt a document, or release ordinary modeling admission.

## Preconditions and owner approval

Use the existing private credentials of the original CLI owner. The approval
must pin all of the following to actual current evidence:

- `version: 1`, `purpose: dead-isolated-epoch-successor-v1`, a new stable
  `requestId` and the exact original `clientId`;
- `previousOwner` (the entire original broker marker), `predecessorEpochId`,
  `previousBuildHash`, and SHA-256 `pointerHash`, `stateHash`, `rootStateHash`,
  `rootIdentityHash`;
- the canonical installed `candidateRoot`, full `sourceCommit`, actual
  `buildHash`, and a `{path, sha256}` reference to its installed production
  checker qualification, including `deadEpochSuccessorReadQualified: true` and
  `deadEpochSuccessorRestoreQualified: true`;
- `expectedProcess: {pid, birth}` from fresh host process metadata. The first
  fixed read-only observation verifies that endpoint and obtains its actual
  Fusion version from the bound physical receipt before any scratch creation.

The prior broker lifecycle must match its marker, configuration and build. Both
the predecessor Fusion process and its original historical process must be
proven dead; the selected new process must be proven alive. A missing or
uncertain process proof, foreign startup/recovery guard, pending snapshot write,
changed credential, changed history or unconsumed successor authority fails
closed. A qualification file is evidence, not a replacement for owner
authentication.

Run these commands from the qualified installed package; use actual IDs and
proof paths, not historical examples or invented success receipts:

```text
fmcad queue successor-epoch --succession-approval /private/approval.json --request-id OWNER_REQUEST --preflight true
fmcad queue successor-epoch --succession-approval /private/approval.json --request-id OWNER_REQUEST --confirm-ownership true
```

Preflight is file/process-metadata only. Apply preserves the predecessor pointer
byte-for-byte in a new `epoch-successions/<request-hash>` journal, snapshots its
unchanged state/identity/grants/evidence, preserves the installed qualification
in that durable journal, and retires only the exact dead supervisor marker. One
durable launch intent starts one guarded metadata worker. Repeating the same
owner command observes that intent/ready receipt; it never launches a second
worker or sends SDK traffic. Startup sends **zero SDK requests**.

An active, unconsumed succession record fences other request IDs even after
process loss. A missing worker ACK, lost SDK reply or unknown scratch creation
does not authorize a new transaction to bypass the prior attempt.

## Current observation, new scratch and grant

Read the metadata-ready receipt and fresh broker status. Only the original
credential-bound owner may perform these two fixed operations:

```text
fmcad queue observe-successor --job ORIGINAL_HOLDER --observation-job ORIGINAL_OBSERVER --request-id OWNER_REQUEST:observe
fmcad queue create-isolated-scratch --job ORIGINAL_HOLDER --observation-job ORIGINAL_OBSERVER --request-id OWNER_REQUEST:create
```

The observation uses the existing source-bound recovery reader, production
Python checker, endpoint receipt, broker gate and transport. Its PID/birth guard
executes before the read-only body; its terminal receipt supplies the actual
version and confirms an idle current instance without the original holder or
definition. Its derived proof does **not** establish a historical outcome or
model validation.

Creation is unavailable before that known current-facts proof. It reuses the
fixed qualified scratch source and its stronger complete PID/birth/version
guard. `documents.add` executes once, followed by independent/empty/unsaved
checks against the complete before/after document identity set. A new epoch is
published only after both the terminal physical receipt and durable SDK proof
agree. The old stores, pending states and request IDs remain read-only and
quarantined. New control generations advance from the immediate predecessor,
not from the original historical root.

The current pointer is the last atomic publication. A publication-only retry
may finish that same known creation without repeating SDK. Grant files are
**not copied**. Register the actual new modeling client through ordinary
metadata, then use the existing owner-only `grant-isolated-scratch` command for
the exact newly returned epoch/document/client. Typed modeling remains bounded
by the existing scratch operation allowlist; raw Python, old documents, cloud
effects and broader native-qualification capabilities are not implied.

Each successor captures the previously active document ID before creation and
keeps its own creation and cleanup namespace. Closing a new
scratch cannot consume an old close request or make an old uncertain close
appear successful. Cleanup restores only that captured active document; if the
user selected a different document in the meantime, that selection is preserved
instead. The fixed source checks the actual active identity after cleanup and
never substitutes another document if the captured target disappeared. This is
UI restoration only, not modeling authority over the previous document.
Old request lookup still returns the original job with a
quarantine label; cancel, resolve and replay against retired jobs are refused.

## Failure and qualification

Keep the original journal on every timeout, failure or lost response. Poll only
the same owner/request receipt. Do not remove guards, reset the queue, adopt a
recovered document, restart a worker with a preserved launch intent or retry
creation under a new ID. Generic lifecycle controls remain unavailable in the
lost-epoch metadata mode.

Unit tests explicitly labeled **FAKE** exercise authority, lineage, crash/ACK,
exactly-once publication and no-grant-copy semantics without Fusion. Production
checker qualification is a separate installed-artifact gate. Neither is a live
modeling PASS: the actual new document, measured geometry, cleanup and restore
must still be verified through the shared broker and public MCP/API.
