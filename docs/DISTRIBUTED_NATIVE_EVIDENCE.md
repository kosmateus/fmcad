# Distributed native evidence review

`scripts/assemble-native-evidence.cjs` reviews existing explicit evidence files
offline. It never calls Fusion, a broker, a native runner, or a subprocess. It
does not replace the integrated runner or rerun geometric acceptance validators.

```sh
node scripts/assemble-native-evidence.cjs --index /absolute/private/index.json --out /absolute/private/new-report.json
```

The output must be a new file; existing reports and proof files are not
overwritten. The index has `schemaVersion: 1`, explicit absolute `evidenceRoots`,
and an `entries` array. Each entry supplies:

- `featureId`, original `sourceCommit` and original `buildHash`;
- `proof`, `cleanup` and `qualification`, each `{ "path": "/absolute/file.json", "sha256": "..." }`.

References must be regular files without symlinks under the explicit roots.
The assembler verifies hashes, known proof status, source/build against installed
qualification, exact epoch/document, and owner closed-epoch cleanup/restore.
It follows known evidence-envelope references, including original failures and
correction provenance, without scanning directories or interpreting arbitrary
SDK paths as files. Only the current unsaved-scratch receipt shapes are supported.

## Meaning of the result

- `ACCEPTED_AT_RECORDED_VERSION`: an accepted independent attestation whose
  envelope, recorded identity, evidence hashes and cleanup were reviewed.
- `ACCEPTED_GRID_ONLY`: MotionLink creation and sampled coupling on the explicitly
  qualified degree grid, not arbitrary-angle precision or physical dynamics.
- `PARTIAL_GRID_ONLY`: parent Drive evidence still lacks its live restore-failure
  acceptance case, even though normal restores and grid coupling passed.
- `DIAGNOSTIC_ONLY`: stage-separated coordinate observations, never precision PASS.
- `NOT_IMPORTED`: no supported evidence envelope supplied; this is not a claim
  that the feature was never tested.

Every imported entry retains the unmodified `recordedEvidence` and its original
version. Verified later cleanup is separate, so an original proof's historical
`cleanup: not_performed` is not rewritten. Negative and unknown readings,
sampled/partial coverage, and correction lineage remain evidence, not fabricated
success. Historical source versions are never promoted to a newer candidate.

The aggregate always has `nativeQualified: false` and
`currentCandidateQualified: false`. There is no invented common run ID,
sequence ID, protected inventory hash, or migration completion claim. An index
and its selected independent attestations are explicit review inputs, not a
cryptographic authority or permission to dispatch CAD operations.
