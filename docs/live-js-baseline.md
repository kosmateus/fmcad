# Historical JS live comparison baseline

Recorded 2026-11-18. **Comparison baseline, not a certified all-live-PASS release:**
`e4994e96d6dbf4fdb975bf66dba3e45c05b33a93` (2026-11-06 20:12:01 UTC),
in the read-only history repository `/home/kamil/.config/opencode/plugins/fmcad`.
It is exactly `77099167c07102a07dd99e820a9e8f3856f92275^`, immediately before
the response-recovery/owned-epoch migration. Broker/client and the relevant
live runners are handwritten JS there; queue IPC already uses a TS adapter.
This is a precise boundary for these contracts, not a wholly pre-TypeScript
repository. History HEAD `19f96b1` is not evidence of a last-good release.

## Actual historical Fusion evidence and limits

The history repository retains `tests/live-rpc-recovery-report.json`:

- ADDIN, `realFusion: true`, 2026-10-23 05:02:49.259–05:03:02.628 UTC,
  overall `passed`; both lost physical RPC reply/automatic continuation and
  disconnected caller/owned job/next client tests passed. Document snapshots
  before and after match; no model mutations or automatic replay requested.
- Four recorded jobs: `bfb892aa-5fdb-4920-8b6e-a7ed4b7d6c7d`,
  `8621c71f-88e6-4d4e-94bb-8cc08e555292`,
  `96458452-9ace-402b-aed4-98cb25ba7f8d`,
  `092eea88-ba4b-4a77-b0b8-e61211255bd4`.
- SHA-256: `3a9c8393897ece09a5cb642353ef34f9c31bbe8c62c435ddb9b6f7ef8ea2bb44`.
  **No source SHA or build fingerprint is recorded.** This proves historical
  execution of that scope, not execution of the chosen `e4994e96` snapshot.

Conversely, `tests/live-backend-adapter-report.json` from 2026-10-23 22:36:31 UTC
is **failed**, with only 2/450 markers and SIGTERM; before/document-list stages
passed. SHA-256:
`686aeec490faafba83f01f624ea3b295a0b4d93d62f96d0442600c0d93743610`.
Other retained reports include running/incomplete suites. Source introduction
commit `2ae4bfdece1af4cb5800ee3833067df224c33158` explicitly says the historical
live scripts were source only and were not executed for that snapshot.
Beads `fmcad-e61.11` comments dated November 11 confirm the `e4994e96` boundary
and offline differential recovery checks, explicitly **not** live execution.
No inspected evidence establishes one exact SHA passing all live suites.

## Two current failures: source comparison and next checks

Comparison target: `84b977d7e7be1cbaf8843b12e7e936d83e627629` driver;
the failed runs used runtime source `62d0e951d21d658c5c27cbff7e87a6c87725ad67`,
build `2d910abc332a1ada92c1a0be90c6cc33ebd33bcd42909246bdb4eea076c30907`.
Artifact root: `/tmp/opencode/fmcad-c93-live-scenarios.hZ3jxTAu` (its name does
not override the actual runtime pin).

| Failure | Historical contract | Concrete consequence |
| --- | --- | --- |
| B stdio: `ad506f20-6dd5-4ac1-b0f9-1ed4c0bc3fb5/native-mcp-stdio-0/report.json`, `MCP smoke timeout` | `tests/live-mcp-stdio.js:34` already imposed 20 seconds per JSON-RPC request; lines 52–69 handled accepted execution and polled its original job every 250 ms. Current `tests/scenarios/native-mcp-stdio-cases.ts:157–158` retains 20 seconds. | Inherited runner deadline, not proof of a newly introduced SDK regression. Owner `.46` must verify delayed replies/accepted-job completion without cancellation or resubmission. |
| Adapter: `4aeb6386-5550-413b-b15a-a7f633ddb55f/native-backend-adapter-0/report.json`, IPC timeout after 324 verified markers | `tests/live-backend-adapter.js:88` bypasses the whole-call `Promise.race` on queue routing; lines 155–164 require all 450 markers. `src/queue-client.js:237–245` waits until terminal, polling at 250 ms; lines 155–165 retry only result/identity observations, at most three attempts. `src/entrypoints/queue-connection.ts:67` has a separate 30-second IPC default. | Recover observation of the original request; do not increase the SDK deadline or replay execution. Full 450-marker completion remains required. |

The adapter's `original-request-328-readback.json` establishes original job
`b38d5945-6846-4eee-b639-048a42d73e31` **succeeded**, `sdkSettled: true`,
`publicationOutcome: published`, HTTP 200, `isError: false`, stdout
`ADAPTER_PROBE_325`. Its execution lasted 5.251 seconds. Thus SDK execution
succeeded while the runner failed to obtain the response; this is not evidence
of a 60-second SDK execution timeout. It does not make the interrupted suite pass.

Current counterparts are `src/queue-client.ts`,
`packages/node-adapters/src/broker-ipc/response-recovery.ts`,
`src/entrypoints/queue-connection.ts`, and
`tests/scenarios/native-backend-adapter-cases.ts`. Preserve owner/request identity,
receipt recovery and the separation between execution and observation deadlines.
The missing live regression is delayed/lost observation under concurrent load
followed by retrieval of the same terminal receipt, with no second mutation.
Implementation belongs to existing owners via ROOT, not this document's author.

## Reproduce the comparison without touching Fusion

Use `git -C /home/kamil/.config/opencode/plugins/fmcad show <SHA>:<path>` for
the historical paths above and compare with the pinned driver target. Read the
named JSON reports and verify their hashes; do not execute historical runners,
install their runtime, probe physical MCP, or replay recorded request IDs.
The current runner mapping is historical `live-mcp-stdio.js` →
`native-mcp-stdio`, and `live-backend-adapter.js` → `native-backend-adapter`.
Existing A/B/C and report owners run fresh qualified tests through ADDIN 8765;
their current results are `.test-artifacts/live/current-results.md/json` in the
main project. Historical evidence neither blocks their start nor substitutes
for current results, full CI, or whole-catalog qualification.
