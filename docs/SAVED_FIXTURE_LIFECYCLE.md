# Bounded new saved-file lifecycle

This path authorizes only a new qualification file in a separately approved
private destination. It does not adopt a user/recovered file or grant general
saved modeling authority. Runtime/checker qualification and an actual native
flow are separate obligations; help or a metadata grant alone is not PASS.

## Separate operations

1. Create/qualify a genuinely new empty unsaved document through the existing
   owner lifecycle. Keep its original creation receipt and exact restore target.
2. Run `queue probe-saved-destination` with the actual owner readiness job,
   `--authority-file`, `--folder-proof-file`, exact epoch/request and explicit
   `--confirm-ownership true`. This reads native project/hub IDs and the approved
   folder ID without hub switching, file creation or activation.
3. Run `queue grant-saved-first-save` for a separate registered client, with
   `--save-request-id` identifying the one future save. Original approval and the
   native probe must agree. An existing grant is never broadened in place.
4. Submit that exact typed `document.save_as` invocation through `fmcad/api`:
   original name/creationId, original generated filename, approved project name
   and folder path, observed `expectedProjectId`, exact `expectedFolderId`, and
   strict `confirm: true`. No extra inputs, output overrides, batches or arbitrary
   scripts are permitted. The SDK boundary rechecks unsaved, unmodified, active
   and idle origin before any body executes. Save is never submitted twice.
5. Run `queue observe-saved-first-save` with the original save job and its own
   stable observation request. It independently reads publication, not another
   save. Multiple explicit bounded reads can observe an accepted/pending upload;
   each has its own receipt. A missing, foreign or changed file never grants
   modeling authority.
6. Run `queue retain-saved-fixture` only after a separately recorded complete
   publication. This closes the exact unmodified complete owned UI document
   without saving or deleting its cloud DataFile. It restores the captured
   pre-fixture active document, or preserves a different user-selected active
   document. Dirty/incomplete/version-drifted states refuse before close.

All owner actions require exact `--epoch-id`, `--request-id`, explicit ownership
and existing original credentials. Probe/observe/retain require their genuine
parent `--job`; no prior-observation job ID is invented. Foreign flags and client
overrides are rejected before credentials or dispatch.

## State and evidence

First-save scope narrows ordinary admission. `qualified-first-save-only` allows
only its registered client's one exact request. Once attempted,
`saved-publication-or-retention-only` blocks ordinary modeling while permitting
owner publication/retention actions. These are not general modeling readiness.
`document.save.once` remains an existing-saved-file version operation, not a
first-save fallback.

The original unsaved admission pointer/creation receipt remain immutable origin
evidence. Actual SDK project IDs are observed, never inferred from Manufacturing
Data workspace IDs. Accepted acknowledgments, partial/null upload metadata,
complete publication and getter errors remain distinct. A known first-save
file lineage cannot silently change after observation.

Publication records retain the original save worker/output, source/build,
pre/postflight and physical receipts plus the independent observation proof.
Retained disposition adds its own source-bound SDK/physical close/restore proof.
The old unsaved close action is forbidden in a first-save namespace.

An immutable retention intent pins one request before the sole UI close. Unknown
or failed outcome is not permission to repeat close under another ID. Original
intent/start/result evidence stays intact for diagnosis. The cloud file is kept
for user inspection; deletion and existing-data/permission changes are outside
this authority. Completion never issues a saved modeling grant automatically.
