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

Linux CI run `42524020203` executed 34 cases: 33 passed and the document
scenario failed with `LOCAL_PHASE_TIMEOUT` during real Python preparation.
Its legacy two-second submitted command budget now also bounds the local worker
(`phased-workers.ts`, `localRemaining: job.timeoutMs`). This scenario does not
assert a deadline: it verifies A/B/A document ownership and no fourth execution.
The fixture submits 60 seconds and observes both local and SDK budgets; physical
backend timeout and every production deadline remain unchanged.

## A2 delivery record — typed admission and evidence fences

`queue-admission.ts` and `queue-fixed-fixture-admission.ts` are now the canonical
implementations. The build emits the original module paths, including the actual
implementation used for `sourceModuleHash`; there is no facade hash standing in
for executable code. Admission declarations resolve through the staged runtime
providers. The broker imports the real admission type, including optional local
cancellation, rather than a handwritten duplicate method inventory.

The admission source in archive commit `843ce0d` is byte-identical to the immediate
predecessor `270096c`. Its frozen fixture and the predecessor fixed-fixture source
are recorded in the historical manifest. The paired scenarios use the same
prepared artifacts, real installed Python checker, steps and assertions. Valid
Python and wire bytes stay unchanged. Explicit historical defect cases establish
these intended differences:

- The old observer accepted equal-value object replacements during asynchronous
  analysis. It also accepted a changed receipt path or dispatch timeout. The
  typed implementation binds object identity and the entire retained record
  before analysis, checks them afterwards and checks them again before dispatch.
- The old observer accepted a changed `jobId`, `requestHash` or an extra receipt
  binding field even though the prepared artifact retained the original binding.
  Admission now requires exact canonical equality with that retained binding.
  A certificate for one request cannot authorize evidence for another request.
- The old recovery preflight could return a changed source hash after checking
  the original source. Audit preflight now binds its original record, artifact,
  request and build across asynchronous checking. It retains canonical reader
  reconstruction and never interprets an old transactional result as a new one.

These defects predate this TypeScript conversion, but they are **not attributed
to the original pre-refactor broker**. `a26222f` does not contain this admission
module. Archive ancestry places its addition at `8aa30bf940c1799318f9e395b2400b665b5d43ad`
(29 October), after both `a26222f` and toolchain migration `8b0be07`; the original
observer already has the incomplete checks shown above. Recovery preflight was
added at `ce72485`. Executable paired evidence establishes the defects in retained
`843ce0d` (31 October) and the immediate predecessor; it does not establish their
manifestation in a real pre-refactor Fusion run. These are defects in mechanisms
added during earlier refactor work. Historical cases deliberately record the old
acceptance and require the new implementation to refuse it before any execution.
No mutation is replayed.

The expanded `test:broker-regressions` also runs the new admission comparisons,
fixed-source scope comparisons and existing seven production observer cases.
Coverage includes foreign identities/builds/source receipts, artifact metadata,
unknown binding fields, certificate object replacement, real cancellation,
changed typing-resource fingerprints, source-module identity, current-only audit
preflight and offline installed-package admission. Fixed program grants retain
source hashes, exact arguments, policy argv and owned document/process pins.

The shared offline observer fixture uses the supported receipt path adapter.
Its installed-package case packs the already built artifact with `--ignore-scripts`:
CI builds first, and the scenario checks the installed bytes and real checker,
not a second nested build inside a 15-second pack deadline. It still installs with
`--offline`, executes valid and invalid Python checks, and asserts zero receipts.

Local evidence: 81 paired/admission cases passed, followed by both added resource
fingerprint cases; strict API/test typing, lint and formatting pass. Six retained
production observer cases pass. The offline npm consumer cannot resolve cached
`basedpyright` metadata in this host, even after cache preparation, and remains a
required Linux CI check. Process-identity broker cases also remain required on
Linux. No host limitation changes a production guard or test assertion.

A3 (recovery/epoch/control migration) and A4 (concurrency and integration) remain
assigned to A. Native Fusion qualification remains with B/G after offline
integration. This delivery must not be marked complete until its full CI matrix
passes on the final merge head.
