# Agent A — broker correctness, admission and recovery

Status: **in progress — current coordinating agent**. A1 restores the missing
broker gates; A2–A4 remain assigned here. Start at current `main` and preserve
other agents' deliveries. The original audit reference is `3c7dc83`.
Read [the shared plan](../REFACTOR_PARALLEL_PLAN.md) for source links and rules.

## Outcome and ownership

Finish the broker's remaining runtime migration while preserving actual process,
request, document, file and receipt ownership. Concurrent offline preparation
must not occupy Fusion's single physical execution lane. Unknown outcomes remain
recoverable without duplicate mutations.

Own `src/queue-*.js` runtime/control modules, `src/atomic-*.js`,
`src/atomic-workflow-observation.js`, `src/fusion-reset.js`, broker composition,
execution request/stage dependencies, execution worker adapters, broker IPC,
queue domain/application policies, stage/operation journals and Python admission.
Include corresponding broker, queue, native-receipt and recovery non-live tests.
Existing typed implementations need review as well as remaining JavaScript.

Exceptions: E owns public CLI/MCP entrypoints and help; F owns console rendering;
B owns shared scenarios and live suites; D owns document publication and file
workflow orchestration. Keep their public contracts stable. Queue control APIs
consumed by F remain A's responsibility. G owns cross-package configuration, with
the explicit first-delivery gate exception below.

## A1 — restore the missing broker regression gates

Add a named CI selection for these six existing files and make its registration
testable: `queue-scheduling`, `queue-cloud-save`, `queue-document`,
`queue-native-receipt`, `queue-probe-recovery`, `queue-snapshot-size`.
Do not claim that a large regression count covers files not invoked by CI.
Use dedicated Linux jobs or a measured existing job budget; preserve Node 22.13
and 24 coverage where these are supported. This delivery may edit `package.json`
and `.github/workflows/ci.yml`; communicate the final commands to G.

Reproduce old/new scheduling, document and receipt assertions before fixing
fixtures. Preserve sequence ownership, not-started/unknown distinctions, exact
RPC counts, timeout restoration, cloud acceptance versus cloud completion and
large-history readability. Use the existing explicit path adapter or narrowly
scoped WSL fixture only for fake physical backends. Run process-identity tests on
real Linux; do not stub `/proc` or weaken production ownership.

Audit evidence on the original main: the three sequence/pause cases pass on
`a26222f` and current source. The six-file selection has 27 cases, with 20 local
passes and 7 host-dependent failures (five `/proc`, two WSL path prerequisites).
The Python metadata probe also fails in the historical checkout; its generated
identity program reads `/proc`. This is not evidence of a new Fusion regression.
The broader regression command completed with 1,189/1,200 passing locally:
three failures require opened-file evidence through `/proc`, and eight fail
selected-interpreter preflight in the host-tool fixtures before their intended
assertion. The latter need E's fixture investigation; this audit does not prove
their underlying cause. All 1,200 passed in the recorded Linux CI runs. Do not
turn local failures into waived assertions. A writable `TMPDIR` is necessary for
legacy tests here.

Exit: every one of the six files executes in CI, all retained assertions pass,
each fixture correction is explained, no broker guard is bypassed, and a fresh
head has the entire CI matrix green.

## A2 — type admission and certificate composition

Migrate `src/queue-admission.js` and relevant fixed-fixture admission boundaries
into typed ports/adapters/composition. Keep final-byte certificates, retained
origin maps, ABI units, request hashes, resource fingerprints, build identity and
TOCTOU fences. Compare retained source at `843ce0d` and the immediate current
predecessor; the module was introduced after `a26222f`.

Test mutation of each bound field before/after asynchronous checking, missing or
foreign source receipts, stale checker/build fingerprints, unknown fields,
prepared-object replacement and cancellation. Expected valid outputs and actual
submitted Python remain equal except explicitly justified source provenance
changes. Do not replace unknown values with casts or `any` to pass strict typing.
Review changes to source-module hashes as part of the receipt contract.

## A3 — migrate recovery, epochs and physical instance control

Group remaining modules into bounded deliveries: original result/atomic audit;
epoch succession and runtime/checker upgrade; saved-fixture control/readiness;
instance identity/reset and liveness. Cover `queue-atomic-migration-runtime`,
`queue-atomic-recovery-audit`, `atomic-workflow-observation`, `queue-epoch-*`,
`queue-saved-*`, `queue-instance` and `fusion-reset` without merging them all in
one PR. Reuse existing core/adapter implementations rather than duplicate them.

Exercise restart while preparing, after admission, during native execution,
after receipt publication and during cleanup. Distinguish caller timeout,
native command destruction, cloud processing and completed model outcomes.
Foreign job/run/document/file/version/ABI evidence must never release or complete
the wrong operation. Recovery reads original evidence and preserves report bytes.
Late terminal results must unblock other clients only after settlement is proved.

## A4 — concurrency and integration

Retain `phased-queue` evidence: two projects prepare concurrently, independent
outputs remain private, and maximum SDK concurrency is one. Add deterministic
pause/cancel/worker-death/reply-loss interleavings as needed. Coordinate with B
for the same scenarios on owned saved fixtures over MCP and addin at limits 1/2/10.
Do not change production deadlines to hide slow test observations. Preserve logs
for the historical intermittent native-action timeout; its attribution remains
unresolved until matched failing receipts exist.

Verify installed package paths and declarations, real authenticated snapshots,
stage ownership, migration/restart and process identity in Linux CI. Expose
stable recovery/control contracts to D/E/F and document any required coordinated
change for G. Facade retirement waits for public consumers and final integration.

## Completion checklist

- All broker families are typed or explicitly justified platform shims with no
  duplicate implementation; strict checker/admission is still used.
- Historical defects versus migration defects have paired evidence and explicit
  expected outcomes; no new pass-through exception masks a behavior change.
- Offline overlap, one SDK lane, cancellation, restart, exact ownership and
  no-replay invariants pass both transport profiles and installed-package checks.
- Missing gate inventory is closed; all full CI jobs pass on each merge head.
- B/G receive native assumptions and outstanding performance/timeout evidence.
- Append PR/SHA/checks/remaining work here after each delivery; continue through
  A1–A4 rather than treating the first six-file repair as the whole assignment.

## A1 delivery record

The named `test:broker-regressions` command executes all six retained files,
its registration check and compiled historical queue comparisons. Two dedicated
Linux CI jobs cover Node 22.13 and 24. The retained queue implementation is frozen
verbatim from `a26222f`, with a manifest hash, so shallow checkouts can compare
the same owner/release, dependent sequence and administrative-pause scenarios.

Fixture changes retain the original behavioral assertions. Linux receipt tests
use the supported path adapter rather than editing the generated wrapper after
preparation. The document fixture understands the typed selector expression and
physical RPC envelope, records bound receipts and verifies three successful
operations before refusing changed A without a fourth operation. Its observer
allows the separate local preparation budget; production deadlines are unchanged.
Recovery fixtures register cleanup before assertions.

Local compiled historical/registration checks pass. The full broker selection
requires real Linux `/proc` identity; no process or artifact guard is replaced
to make this host pass. Full CI and final integration evidence will be recorded
before this delivery is marked complete.
