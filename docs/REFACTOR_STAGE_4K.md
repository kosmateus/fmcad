# Stage 4k — bind atomic completion to its owner

A self-consistent atomic journal could certify completion of an unrelated job.
The reader checked the current stage reference and the journal's internal hashes,
but never compared the journal's request or resolved document with that owner.
This matters when receipts are copied, misplaced or routed to another scenario.

## Historical evidence

The pre-refactor baseline `a26222ff617b0e9597b2a91b50474bdca8d0a0ce`
does not contain `src/composition/stage-dependencies.js`. The defect is present in
its introduction at `42fe75cf484df4808592fc35c9a6c5cf0abdbeef`, a descendant of
that baseline, and remains at `b50f2280217759894534e8dab61abc58a2fbe138`.
Both complete sources are frozen with SHA-256 entries in the historical manifest.
This attributes the receipt-reader defect to work after the baseline; it does not
claim that Fusion itself misrouted a request or that an actual native run was lost.

`atomic-receipt-owner.test.ts` executes those readers and the current reader with
the same submitted payload, stage reference, numbered journal and native receipt
metadata. The harness substitutes filesystem reads; lifecycle authentication,
OS descriptor checks and RPC/native proof validation are separate integration
responsibilities. Historical readers use today's history validator, so this is a
comparison of receipt ownership checks, not a full historical broker replay.

| Case | Earlier readers | Required result |
| --- | --- | --- |
| Own committed receipt | Completed | Completed, same receipt digest |
| Foreign run, step payload, document, file, project or component | Completed | Corrupt: receipt does not prove this request |
| Foreign expected or resolved document identity | Completed | Corrupt: receipt does not prove this document |
| Two owners exchange otherwise valid journals | Completed for both | Corrupt for both; each own journal still completes |
| Committed receipt without resolved identity | Completed | Corrupt: the mutated document is unproved |
| Own failed/running/unknown receipt | Unknown | Unknown; no automatic retry |
| Missing native proof or invalid history | Unknown/corrupt | Preserve refusal |

The changed expectations follow the existing stage-evidence contract: an owning
receipt must validate its original document/request binding. A valid checksum is
not evidence that the receipt belongs to the requesting scenario.

## Change

A pure strict-TypeScript validator compares the entire request and context,
run ID, expected selectors and resolved creation/file identity with the accepted
job and pinned document. The existing composition calls it before accepting an
atomic terminal receipt. The runner stores `atomic: true` even when the caller
omits the default; this exact normalization is allowed. An explicit false mode is
rejected. No selector normalization or historical null-selector compatibility is
introduced here. No journal is rewritten, and no operation is submitted or retried.

Both first-generation manually constructed receipt fixtures and current writer
receipts are supported: a present name must match; creation/file pins are always
checked. Name omission in these older fixtures does not replace identity checks.

## Validation and remaining work

- 28 ownership tests, including frozen-reader comparisons and immutable inputs.
- 49 existing atomic adapter/batch regressions.
- Full build with the pinned Autodesk API, strict type checks, lint and formatting.
- The installed artifact contract requires the new validator and its declaration.
- CI now explicitly runs the 18 existing stage-owner integration tests as part of
  `test:contracts` on both Node versions. These were absent from that CI command.

Local tests do not replace those integration results: this environment lacks the
`/proc` evidence needed by authenticated storage and broker checks. PR CI must
pass before merge. Final Fusion qualification still checks actual document and
native receipt identity. The legacy null-selector replay gap from stage 4j,
remaining service migrations and additional mock geometry families remain open.
# Offline fixture setup

Enabling the retained stage-owner suite in CI exposed two fixture preconditions:
its temporary parent directory did not exist on a clean runner, and its offline
receipt-wrapper case assumed WSL path conversion. CI now creates the parent;
that one case uses the existing reversible fake WSL path fixture. The production
platform guard, checker, authenticated owner and assertions are unchanged.
The first complete Node 24 run passed 201 cases and failed only at that path
conversion, before reaching the checker. Native qualification remains deferred.
