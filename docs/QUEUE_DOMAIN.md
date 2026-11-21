# Queue domain boundary

`packages/core/src/domain/queue*.ts` contains the existing scheduler's transitions,
eligibility, limits, sequence leases, pause accounting, restart recovery and public
allowlist projections. This is a move of the broker policy, not a second scheduler.
There are no Node, filesystem, socket, SDK, timer or implicit clock imports in core.

## Composition and persistence seam

`QueueDomain` receives `now`, `newId`, `hash`, an optional restored v1 `snapshot`
and a synchronous `commit(snapshot)` callback. The callback must durably persist
the proposed snapshot **before returning**. Only then does the domain publish its
new state and waiting index. A thrown commit poisons the instance: reopen and
reconcile rather than continuing on uncertain storage. Restoring a snapshot marks
unfinished SDK ownership as reconciliation-required and interrupts abandoned local
workers; it never dispatches or replays them.

`src/queue-state.js` is the transitional Node composition. Its small `SnapshotStore`
retains the original exclusive-temp-file, fsync, rename and directory-fsync writes
and v1 bytes. The execution-store migration can replace this local adapter by
supplying its restored snapshot and commit callback without changing queue rules.
Do not put filesystem policy back into the domain. The `recover: false` option is
only for continuing a live, already-validated in-memory snapshot, not opening a
durable snapshot after restart.

`transitionQueue(snapshot, action, {time, ids, hash, ...limits})` provides a pure
evaluation entry for fixtures and policy consumers. IDs are an explicit immutable
list, and hashing must be deterministic. It returns the next snapshot, detached
result and ordered persistence intents; it does not execute those intents. This
entry is not an alternative broker loop or permission to replay physical SDK
calls. The running broker keeps one `QueueDomain` and its cached waiting index:
an idle `next()` does not clone, serialize or enumerate terminal history.

Local preparing/processing/finalize never holds the SDK slot. Automatic sequences
yield after each settled SDK turn; explicit exclusive leases retain their existing
semantics. Unknown ownership remains fenced until explicit proven recovery.
Request IDs still bind the canonical immutable request through the injected hash;
the Node composition retains SHA-256. Descriptions are excluded from identity.

## Documents and controls

`document.ts` accepts parsed command intent, not argv or SDK objects. The legacy
`queue-document.js` facade only parses flags/command classification and delegates
selection and comparison. Fingerprints cover the selected document and its
dependencies; queue revision or changes to another unrelated document are not
document drift. Stale/changed baselines remain refusals before the guarded SDK
operation, with the existing broker returning fresh context.

`queue-control.ts` holds pure gate phases, control eligibility/idempotency and
pause-budget transitions. Async waiting, AsyncLocalStorage, physical readiness
checks and timers remain in the existing Node facades. Stale timer generations
cannot expire a frozen/resumed budget. Resume still requires drain and recovery;
pause does not cancel active SDK work.

## Offline verification

- `node --test tests/queue-domain.test.js`: pure fixtures; no fs, sleep, real clock,
  process, socket or Fusion. Covers deterministic snapshots/effect intents,
  changed immutable bytes, limits, multiple turns, exact expiry, future clocks,
  unknown/no replay, commit failure fencing, document scope and control/budget.
- `tests/queue-scheduling.test.js`: scheduling fixtures now use `QueueDomain`,
  explicit time/IDs and in-memory snapshots. Its separate controlled IPC scenarios
  remain integration tests, not claimed as pure fixtures.
- Existing phased/document/pause, queue durability and upstream regressions test
  the unchanged Node facades and fake broker transports.
- `node --test tests/contracts/refactor-baseline.test.ts` and baseline capture /
  compare verify frozen behavior and generated request bytes.
- `node scripts/benchmark-queue-idle.js` retains the 3,500-job idle measurement;
  transaction count must remain zero. The pure test additionally traps any attempt
  to enumerate terminal history on idle ticks.

These checks do not validate live Fusion execution, SDK geometry or physical CAD
quality. No shared service restart or live Fusion operation is required.

### Migration verification (2026-10-24)

- `npm run build:code`, `npm run typecheck:tests`, `npm run lint`: pass.
- Final domain/scheduling/pause/document/recovery/snapshot selection: 34 pass;
  phased/document selection: 69 pass; domain/pause/upstream selection: 205 pass.
  These selections overlap and must not be added into a unique-test count.
- Baseline harness: 12 pass. Fresh capture compared to the frozen contract
  without allowances: pass, zero regressions or intentional changes. The existing
  checkout allowance is stale for this capture and is not required or applied.
- Idle benchmark: 3,500 historical jobs, 15,058,576-byte snapshot, 30 checks,
  **zero transactions**, 0.228673 ms total, 0.007622 ms/check, 0.266 ms CPU.
  These are local samples, not a hardware-independent performance promise.
- Python discovery: 1,256 tests, `OK (skipped=105)`. The log also contains an
  uncaught background-thread `FileNotFoundError` from the existing diagnostics
  test observing an already-removed `active.json`; unittest still exits zero.
- `npm test` at the initial 120-second outer limit: **timeout, not pass**. A
  separately bounded full Node regression run (`node --test --test-timeout=90000
  tests/*.test.js`, outer limit 600 seconds): **2,005 pass, 4 skipped, zero
  failures/cancellations**, 464.33 seconds. Python was run separately as above.
- Root `format:check`: fails on 26 untouched checkout files (CRLF formatting).
  Prettier check of every changed/new core TypeScript file: pass. Unrelated files
  and the coordinator's `.gitignore` are not reformatted or changed here.

### Integration with portable configuration

Integrated `master` at `cb3fbea` without reverting the required `queue` routing
default. Build, test typecheck and lint pass. The frozen baseline now reports
one mismatch, `cli.help.dto`, following the changed configuration help from
portable-config (`tests/contracts/refactor-baseline.test.ts`: 11 pass, 1 fail).
No frozen evidence or allowances were changed. This follow-up is tracked in
`fmcad-config-queue-regressions`; all other captured observations still match.
The repeated idle benchmark remains at zero transactions for 3,500 retained
jobs / 30 checks (0.223112 ms total), and all six document Python policy tests
pass. Final integrated Node-suite results are recorded in the task notes.

The completed full integrated Node run reports **1,929 pass, 90 fail, 4 skipped,
zero cancellations** (440.07 seconds). Failures are located in
`tests/legacy.test.ts` (87), `tests/live-broker.test.js` (1), and the scheduling
test imported twice (2). The scheduling fixture was fixed locally to pass an
explicit isolated configuration instead of reading the user's obsolete config.
After that fix, the integrated domain/scheduling/document/pause/phased/recovery/
snapshot/upstream selection passes **258/258**. The other two file families are
tracked in `fmcad-config-queue-regressions`, not hidden by test exclusions or a
reverted routing default. The full suite was not rerun after this fixture-only
fix; the targeted final code result is not a claim of a fully green repository.

The offline `tests/live-broker.test.js` fixture subsequently received an explicit
injected configuration loader through `tests/helpers/live-broker.js`. It asserts
that broker-suite configuration requests `routing: "queue"`, uses a fake queue
and backend, and no longer reads the user's config. The helper's existing direct
branch remains available only through the explicit live-suite direct opt-in;
this does not change the product's queue default. Together with the already
isolated scheduling fixture, the live-helper/scheduling/domain/upstream selection
passes **225/225**, with build, test typecheck and lint passing. The known legacy
fixture corrections remain owned by `fmcad-config-queue-regressions`.
