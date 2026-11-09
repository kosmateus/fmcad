# Agent A — broker correctness, admission and recovery

Status: **in progress — current coordinating agent**. A1 is merged in PR #42.
A2 (PR #51) and A3.1/A4.1 (PR #56) await their remaining full CI checks;
the rest of A3–A4 remains assigned here. Start at current `main` and preserve
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
to make this host pass. Full CI run
[`42525055817`](https://github.com/kosmateus/fmcad/actions/runs/42525055817)
passed all 24 jobs on `709741a4c083d59430479d00aa0b43c7abd17314`.
PR #42 merged as `171c972c1de8845aa300371798dcb6be5fd5416a`.
Before merge, the candidate with main `0d6f757` built successfully. The preceding
main candidate passed all 124 scenario tests; all 12 affected inventory, history
and registration checks passed after the latest main update. A1 is complete.

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

Linux update: Node 24 broker job `128871346225` in run `42526553187` passed on
`bed43003745b67d4d6795e600fc40af85fb1daa1`, including real Python checking and
the offline installed-consumer test. The host cache limitation is therefore
resolved by CI evidence; the remainder of the full matrix is still required.

A3 (recovery/epoch/control migration) and A4 (concurrency and integration) remain
assigned to A. Native Fusion qualification remains with B/G after offline
integration. This delivery must not be marked complete until its full CI matrix
passes on the final merge head.

## A3.1 delivery record — process observations and authenticated epoch evidence

This bounded recovery delivery depends on A2 (PR #51); A1 is PR #42. Canonical
`queue-instance-liveness.ts` and `queue-epoch-lineage.ts` replace their handwritten
JavaScript. The build stages exact emitted runtime bytes and portable declarations
at both existing runtime paths. Broker process observations use the emitted
module's actual type. Structural evidence checks reject malformed JSON before
using it as authority; they do not reinterpret historical operation outcomes.

The frozen immediate predecessor is `bed43003745b67d4d6795e600fc40af85fb1daa1`.
The 54 paired cases cover owner/build/qualification bindings, preserved running
and unknown histories, immutable pointer archives, changed grants, cycles,
process death/liveness/unknown observations and point-in-time observations.
Three deterministic filesystem races reproduce prior defects:

- A failed installed-qualification record was hashed, then a separately reopened
  record with `passed: true` was accepted. The repaired verifier hashes and parses
  one bounded byte buffer obtained through the existing opened-descriptor guard.
- After authenticating the predecessor identity, the old return path reopened it
  without verification. A third read could return a foreign build. The verifier
  now returns the same authenticated identity object it used for comparison.
- The old authority reader derived the journal from an unverified first request
  ID, then accepted a different authenticated request ID under that journal.
  The repaired reader derives the namespace from the authenticated record only.

Historical cases explicitly assert the old acceptance; typed cases assert the
required refusal or unchanged authenticated identity. This is a justified
expectation change: a digest authorizes exact bytes, and a request's authority
must reside in that same request's journal. No test makes an old unknown outcome
successful or permits a new model command. File replacement is injected at real
open/close boundaries; real hashing, file reads and directory/descriptor guards
remain active.

These are defects in mechanisms added during earlier refactor work, not proven
regressions against original Fusion behavior. The original lineage module was
added in archive commit `649c9d0cc7c27edeaf6df622ee0f3f6177f311bb` (4 November);
source inspection confirms all three separate-read patterns there. Process-loss
liveness was added at `843ce0d` (31 October). Neither module exists in the original
`a26222f`. The executable comparisons establish the defects in the immediate
predecessor. No native Fusion evidence is needed to demonstrate these file races;
native process and recovery qualification remains a separate B/G obligation.

The broker gate also restores three retained integration suites:
`dead-epoch-successor`, `closed-epoch-successor`, `instance-loss-recovery`.
Their expected outcomes are unchanged. Fixtures allocate owned temporary roots
and restore the scoped Windows-path spelling adapter; the endpoint receipt test
uses the supported path adapter instead of changing already generated Python.
The real audit preflight checks the original endpoint binding and leaves its
owned output directory empty. No SDK traffic is issued in these offline fixtures.

Local evidence: full `build:code`, lint, format and test typing passed; all five
staging/declaration/registration checks passed; four retained process/audit checks
passed with the real Python checker. The complete paired run reports 37/54 pass;
all 17 typed lineage cases stop at `STORAGE_UNAVAILABLE` because this host lacks
Linux `/proc/self/fd`. They remain mandatory, unskipped Linux CI cases. Do not
substitute a fake path/identity verifier. All retained successor integration
checks and the whole CI matrix must pass before merge; no native qualification
is claimed by this record.

Remaining A3 packages: atomic original-result/audit reconstruction; owner-bound
epoch succession and runtime/checker upgrade controllers; saved-fixture control;
physical instance identity/reset. A4 concurrency/restart interleavings and final
cross-agent integration remain assigned to A. A3.1 is not the completion of A3.

## A4.1 delivery record — isolate concurrent recovery publication

The A3.1 recovery-evidence delivery also closes a cross-job publication defect.
`createRecoveryAudit` held one pending publication promise for the whole
controller. If owner A's completed result was awaiting local publication, a poll
for owner B's different completed result could receive A's activation; A's
publication failure could also reject B's otherwise valid result. Both request
owners had passed validation, so a foreign-caller rejection test alone missed it.

A strict typed `createReceiptPublication` policy in core execution now joins only
polls for the same authenticated result receipt. Different receipts publish
independently. The existing recovery controller validates owner, immutable request
key and retained summary before entering this policy. Failed local publication
may retry the same original evidence, but it never prepares or dispatches another
SDK operation. Full controller/reader migration remains in A3; only this concurrency
policy has moved in this delivery.

Ten paired scenarios use frozen `5102259` and the current real controller over
owned temporary stores. Before the fix the current implementation failed both
cross-owner scenarios (8/10); after the fix all 10 pass. Assertions cover eight
polls sharing one receipt, ten alternating polls across two owners, failure
isolation, retry after local publication failure, and refusal of foreign callers.
Original intent/result bytes are unchanged and the inspect/dispatch path is
forbidden by the fixture. The historical branch deliberately records the wrong
activation and coupled rejection; the new expectation follows per-job ownership.

Archive source inspection traces the shared promise to `303ae42af273069dbe661b9a5eb1dec2dd2caf85`
(31 October). The controller itself was introduced at `24eebce` (30 October),
after the original `a26222f`; this is another defect in earlier refactor work,
not an established native pre-refactor Fusion failure.

The ten retained `queue-atomic-recovery-audit` tests are restored to the broker CI
gate. All ten pass locally, including real-checker acceptance/rejection, source
drift, final-byte tamper, untrusted remote outcome, same-receipt publication and
lost scratch reply/no replay. Fixtures use owned temporary paths and the scoped
WSL spelling adapter for their synthetic ports, without changing assertions.

Existing `phased-queue` tests already cover concurrent project preparation,
separate outputs, exactly one physical lane, worker death before/during execution,
pause between checking and grant, late native destruction, reply loss, private
results, context change between turns and restart without replay. They remain in
`test:contracts` and must pass on the combined head. B/G still own qualification
of the same saved-file scenarios on real Fusion at concurrency 1/2/10; offline
broker and publication evidence is not a substitute for that run.

## Primitive input rejection settlement (continuation)

The strict scenario command-result check exposed an existing ambiguity: an invalid
primitive dimension throws before geometry creation, yet absence of a terminal
native result correctly leaves the caller uncertain. C now returns a narrowly
versioned `cad-input-rejection` for `ValueError` from field/dimension validation
only. Plane/entity resolution, SDK calls and later exceptions still propagate.
The native wrapper asserts the pinned document before calling the handler, and
its checked final-byte artifact and physical receipt bind the operation, data,
context, process and request. A failed transport is never converted to rejection.

The batch reader accepts this witness only for the five primitive operations,
with exact operation and proof keys, `success: false`, and empty created/affected
collections. It records `failed`/`not_started`, retains the redacted original
`INVALID_INPUT` message and skips the remaining steps. Foreign operation proofs,
extra keys, reported creations and plain exceptions cannot claim `not_started`.
Failed/unknown journal replay remains forbidden. The expected no-eval result is
unchanged: reject the literal, skip the next box, and independently observe no
geometry changes; this only makes the pre-mutation refusal explicitly observable.

Local core/batch/result checks: 22/22 pass. Full build passed. Native receipt and
same-scenario MCP/addin qualification remain mandatory integration checks; this
is not a claim that all recovery controllers have been migrated.

## A3.2 — recovery result reader and immutable evidence adapter

The recovery audit result validator now lives in strict core TypeScript, and the
migration inventory/hash/backup/exclusive-receipt implementation lives in the
Node persistence adapter. Existing module paths delegate to these canonical
implementations. The outer recovery controller remains JavaScript; this bounded
delivery does not relabel it as migrated.

Paired reader checks use frozen `5102259`: accepted facts and malformed identity,
counts, status, errors and fingerprints retain their outcomes. The predecessor
accepted the first of multiple terminal markers or text result bodies, ignoring
conflicting later evidence. The typed reader requires exactly one body and
marker. This expectation change follows evidence uniqueness; a read-only audit
still cannot assert historical success, rollback or model validation. The defect
is demonstrated in the post-migration predecessor, not attributed to a historical
live Fusion failure without matching evidence.

The filesystem adapter is frozen against `330849f` and retains exact inventory
hashes, immutable receipt semantics, exclusion rules, symlink rejection, backup
verification and conflict refusal. Paired real filesystem checks cover successful
and repeated backup, tampered backup, symlink files/directories and unchanged
existing receipt bytes. No process identity or opened-file guard is bypassed.

Local results: all 21 recovery/publication tests pass with the real checker and
pinned Autodesk typing snapshot; both added reader/adapter comparisons pass.
The fresh worktree initially lacked the build's typing snapshot and correctly
failed admission. Copying the same content-addressed pinned snapshot used by the
main build and restaging identity restored the real checker; no assertion or
production deadline changed. Remaining A3 controllers, physical identity/reset,
saved-fixture migration and A4 combined CI/native qualification remain open.

## A3.3 — typed owner migration state machine

The migration orchestrator and held-owner fence now live in strict core
TypeScript with named snapshot, stage, approval and effect ports. The Node path
only supplies the existing observation/upgrade validators. All durable stage
ordering, request binding, pause/backup checks, PID-owner proof calls, one-time
stop/launch and unknown native outcome semantics are preserved.

Frozen `330849f` comparisons execute both implementations through the same
fixture. They compare complete reports, every retained stage, queue state and
effect counts after uninterrupted execution, crashes at all eight durable stages,
and seven authority/admission/backup/fence refusals. All 12 selected migration
checks pass locally, including the unchanged two-holder upgrade and crash-after-
signal tests. Real process termination and legacy installed-runtime qualification
remain required Linux integration work; they are not simulated away by this
pure state-machine comparison.

## A3.4 — typed recovery controller

The complete recovery request/intent/dispatch/settlement/publication controller
now lives in the Node execution adapter with explicit message, reader, wire,
certificate, scope, preparation and runtime ports. The old Node path only composes
its existing Python preparation and final-byte wire builder into this controller.
It has no independent SDK, lifecycle or process authority. Canonical core dispatch
and per-receipt publication policies remain shared; checker/source-byte fences,
durable start-before-send, original caller reply ID, owner-bound recovery and
no-replay behavior are unchanged.

Malformed stored non-object evidence and a null matched reply now fail with an
explicit audit error rather than an incidental property access error. Neither
case yields successful historical evidence or another physical send. All 22
recovery/publication/immutable-reader checks pass locally, including real-checker
accept/reject, source drift, final-byte tampering, bad physical receipt outcome,
lost scratch reply, concurrent owners and publication retry without SDK replay.

## A3.5 — typed recovery Python and wire preparation

The remaining recovery source preparation, final-byte receipt binding and
capability/build-gated client control moved to the typed execution adapter.
The historical module path is now composition only: it injects the existing
process-bound receipt wrapper from instance control. Frozen predecessor checks
prove identical Python units, source map, request/context provenance, hashes and
complete wire records, including Unicode identity and explicit process/document
pins. Inputs remain unchanged. All 22 recovery checks plus the added byte-parity
case pass. Non-JSON identity values or a missing Python body now refuse before
preparation instead of generating unusable source; valid behavior is unchanged.

## A3.6 — typed checker/settled epoch handoff policy

The two distinct epoch handoff state machines and their owner/history/process
fences moved to strict core TypeScript. Typed stage ports retain cooperative
stop, exact PID death observation, escrow, install/identity publication, one-time
launch and unchanged grants. Process comparison remains injected from the
canonical instance adapter. The process-start claim filesystem adapter remains
separate and must still validate original durable evidence.

All 25 retained pure handoff/refusal checks pass. A paired frozen `330849f` test
also compares full reports, snapshots, stage records and ordered effects for both
checker-rejection and successful-settled purposes across uninterrupted execution
and seven durable crash stages. Neither purpose acquires the other's authority;
unknown historical outcomes and zero SDK requests remain explicit.

## A3.7 — typed atomic observer wire binding

Canonical semantic observation identity checks moved to core; final prepared
artifact verification and receipt-wrapped observer wire construction moved to the
Node execution adapter. The legacy paths compose those implementations with the
canonical physical receipt wrapper. Semantic hashes remain the exact existing
canonical JSON function; final Python hashes remain raw-byte hashes.

All four observer binding tests pass, including frozen `330849f` comparisons of
complete wire records and artifact bytes with/without an RPC ID, unchanged caller
input, changed ABI proof rejection, independently pinned identity rejection and
actual wire/manifest tampering refusal. No physical send or publication authority
was added to preparation.

## A3.8 — typed owner observation control

Owner observation request derivation and the capability/build-gated client route
are now strict core policies. The broker composition supplies the existing
original-invocation/candidate readers; callers still cannot override identity,
source argv, report path or control generation. Frozen predecessor comparisons
preserve complete derived requests and rejection codes/messages for foreign
owners/documents/builds, changed/extra fences, terminal holders and payload
injection. Six selected control checks pass locally. A disappearing original
projection fails explicitly before submission rather than dereferencing null;
there is still no automatic retry after a lost control acknowledgement.

## A3.9 — typed epoch process-start claim adapter

The startup claim reader now resides in the Node execution adapter. It requires
object-shaped bounded JSON records, original guard/intent, exact paused state and
identity, credential and grant hashes, cooperative release, immutable candidate
root, settled physical evidence and independent process liveness. Only after all
checks does it exclusively publish the broker claim. The facade supplies the
canonical process observer, settled-evidence reader and installed-root resolver.

Paired frozen predecessor guard-refusal checks pass without publishing a claim.
The four retained process-backed startup cases now allocate owned temporary
roots instead of requiring a pre-existing `/tmp/opencode`; here they stop at
missing `/proc/<pid>/stat` in the original fixture. They remain required Linux CI
cases, with no fake process observer or waived assertion. Strict adapter typing
and lint pass. This local host limitation is not native qualification evidence.

## Typed composition registration handoff

Seven source compositions now have strict TypeScript sources: atomic control,
owner migration, migration files, recovery audit, observer wire, observation
binding and epoch runtime upgrade. They import canonical policy/adapter types;
no duplicate implementation or untyped data cast supplies authority. The epoch
startup composition uses an explicit persisted-record schema validator before
entering the typed settled policy. Valid settled history and malformed job,
owner, active-ID and settlement fields have dedicated boundary checks.

The seven sources pass strict API compilation and lint. G must register emitted
same-path runtime/declaration staging and remove their tracked JavaScript
composition sources atomically; the temporary coexistence is not final facade
retirement. Existing generated runtime paths must remain usable by packaged
consumers and declaration imports must resolve without workspace source paths.

## Successor fixture platform failure (gap05)

CI job 129357072987 failed the nominal observation before sending any SDK
request; consequently unsafe-fact cases returned a failed local preparation,
not a successful unsafe authority. Receipt preparation now requires actual WSL
path capability. The synthetic controller fixture had supplied fake transport
and checker ports but no synthetic platform spelling. The metadata child failed
separately at the production platform guard. The 330849f baseline already has
the strict mapping, so this is not caused by the typed recovery migration.

The controller now installs the existing scoped fake-WSL fixture with restoration.
The bootstrap fixture scopes a child spawn wrapper to the successor module and
prepends that same fixture to its metadata-only worker. Production capability
checks, child environment allowlists, receipt validation and all unsafe-fact
assertions remain unchanged. Temporary roots respect TMPDIR. Local execution
reaches the original /proc/<pid>/stat requirement and fails because this host
has no proc filesystem; real-process Linux CI remains required. No fabricated
process metadata or test expectation change was used. Syntax checks pass.

## Typed prerequisite and inherited pause reader

The immutable current-audit prerequisite and inherited closed-pause reader now
live in a strict Node adapter. Persisted records enter through object/field and
canonical Python-manifest boundaries. A frozen 330849f reader produces the same
valid audit proof and inherited-pause adoption; both reject six rehashed unsafe
audit changes and four owner/history/generation/active-operation changes. This
pure evidence test does not replace or emulate production process liveness.
Adapter compilation, lint and the paired test pass. G must stage the new
queue-epoch-prerequisite.ts composition and retire its temporary JS delegate.

## Offline gap13/gap15 fixture completion

Three broker tests with explicit fake physical backends now install and restore
the existing fake WSL path fixture. Production admission is unchanged. The
settled-worker fixture used `synthetic-dead-worker`, which both the predecessor
and typed process observer interpret as a Windows FILETIME because it lacks the
Linux birth separator. It now uses `synthetic:dead-worker`; the real Linux
observer still must prove that exact absent PID dead. No observer is mocked.
The retained live-worker refusal still obtains the real current process birth.
Locally 38 selected settled evidence cases pass; that live-worker case stops at
missing /proc/<pid>/stat. Linux CI must execute it unchanged.

## File-only qualification reader source

read-audit-response-proof.cts now types the deliberately narrow historical
runtime ports and validates persisted object records before owner checks. The
exact frozen-843 fingerprint, original owner credentials, target/observer IDs,
external output restriction, exclusive publication and zero-network boundary
remain intact. Strict compilation/lint and four predecessor/current argument
refusal comparisons pass. The frozen runtime is still required for full CLI
qualification; no synthetic proof is reported as a real historical run. G must
register emitted same-path .cjs staging and retire its original handwritten file.

## Installed checker qualification source

qualify-epoch-checker.cts now uses canonical artifact/manifest/checker-report
types, explicit installed-runtime ports, and validated JSON envelope fields.
The exact accepted invocation, UI-guard check, original byte and origin-tamper
refusals, zero-send metadata startup, immutable history comparison and optional
settled evidence remain the qualification criteria. Strict compile/lint and
four predecessor/current CLI refusal comparisons pass. Full installed checker
plus real-process startup remains required on Linux; this source migration is
not itself a successful qualification run. G must register same-path .cjs emit
and retire the handwritten source after integration.

## Isolated qualification and child source

qualify-isolated-epoch.cts types the installed read/audit/scratch/fixed-program
qualification ports and canonical artifacts/reports. Its closed-successor child
is now a separate strict qualify-closed-successor-worker.cts rather than an
untyped program embedded in a string. The child keeps original self-PID/birth,
canonical synthetic-directory, owner marker, zero-SDK, dispatch idempotency and
history-byte assertions. No production path receives a synthetic backend.

Both sources compile strictly and pass lint. Four original/current CLI refusal
cases match. Full checker and subprocess execution still requires the original
supported Linux process environment; this conversion does not qualify real
Fusion or historical outcomes. G must stage both same-directory .cjs entries
and retire only the old outer handwritten file.

## Typed exclusive startup workers

The atomic migration, epoch runtime and successor workers now have strict
TypeScript sources. They retain their canonical emitted .js entry paths, bounded
input where already required, exclusive first claims, exact nonce/build startup
checks, ready/error publication and signal behavior. Broker loading remains
lazy until the winning claim passes; malformed input is rejected at an object
boundary. No process liveness implementation is substituted.

Nine hash-verified predecessor/current composition tests compare successful
startup, host rejection and losing an exclusive claim for all three workers.
They pass with explicitly synthetic effect ports; real process startup remains
covered by the unchanged Linux integration cases. Strict compilation/lint pass.
G must register API emission/staging and retire three old handwritten workers.

## Typed second-window audit authority

The second-window audit-upgrade reader is now a strict adapter with named proof
and effect contracts plus a typed lazy composition. Exact historical request,
observer, first escrow, receipt and unresolved-job constraints remain. Five
retained tests pass, including the real checker preflight with final-byte
certification and no SDK send; two new frozen-source tests also pass.

The comparison found one pre-existing unsafe case: deleting the departing build
from completion, observer proof/binding and physical receipt, then rehashing the
references, let the predecessor accept matching undefined fields. The typed
reader rejects a missing/empty departing build. This deliberate expected-result
change follows the handoff's requirement to identify the exact departing
runtime; equal missing values cannot authorize replacement. The frozen test
proves old acceptance and new refusal. Valid proofs compare exactly.

Existing tests now use TMPDIR and scoped fake-WSL paths for their fake physical
ports. G must register the typed composition and two new typed contract tests,
retiring the temporary handwritten JS delegate.

## Typed pidfd stop adapter

The Node pidfd-stop composition now delegates to a strict adapter. Its Python
helper bytes, pinned descriptor behavior, two-TERM bound, no-SIGKILL policy,
exclusive intent/sent/refusal evidence, input and deadlines match the frozen
predecessor exactly. Parsed helper output must explicitly prove originalDead
and an integer signal count in 0..2; malformed output stays a failure and is
never retried by this adapter.

Two tests pass: exact captured predecessor/current helper invocation parity and
four malformed-response refusals after one invocation. Real local read-only
preflight also passes (open/close this helper's own pidfd, no signal sent).
Strict source/test compilation and lint pass. G must register same-path
queue-atomic-migration-stop.ts emission and typed test compilation.

## Persisted operator schema boundary

The operational upgrade script can now consume named, checked approval,
pointer/state/snapshot, intent, identity, process/owner, credential/grant,
reference/escrow and journal-stage readers. They preserve valid persisted
records and original extra fields without treating deserialization as proof.
Stage decoding uses a typed decoder map, not a generic unchecked JSON cast.
Core state/snapshot/approval schema guards and stage types are exported without
changing handoff policy. Typed schema acceptance alone does not authorize an
operation: the original owner, digest, purpose and process fences still apply.

Two boundary tests and all 28 existing epoch handoff/crash-recovery tests pass;
strict compile/lint pass. The older idle-budget test now respects TMPDIR.
These schemas are the dependency for B's remaining operational upgrade script.

## Scratch, native fixture and operational upgrade continuation

The canonical scratch qualification and native fixture grant sources are now
strict TypeScript. Unknown file/message records are checked before they provide
paths, identifiers or authority. Final generated Python, artifact provenance,
captured active-document restoration, exact native operation/source scopes and
exclusive grant publication retain the immediate `dce47c5` predecessor behavior.
Five paired cases execute those paths and check complete artifacts and immutable
files; they pass without a native process. The retained real checker and Linux
process suites remain required separately.

A paired historical counterexample identifies one inherited defect: the old
fixture validator accepted an otherwise valid manifest when both the grant and
the supplied identity omitted build/source pins. The new validator requires an
actual 64-character build hash and 40-character source commit. Matching absent
values cannot authorize native execution; valid pinned grants remain equal.

The operational checker-upgrade script now consumes the existing checked
operator evidence schema and canonical handoff ports. Three paired predecessor
cases pass: argument refusal before effects; a retained launch intent prevents
any second child launch after uncertainty; and identical identity publication
can resume while changed identity or foreign guards remain rejected. These are
synthetic effect-port tests, not process/Fusion qualification. The complete
existing handoff/crash-recovery and Linux process suites still apply.

Strict standalone source/test compilation and focused lint pass. The emitted
atomic-wire declaration now names the canonical return type rather than retaining
an unused runtime binding; this repairs the current declaration lint CI failure.
G must register the two new test files, canonical runtime sources and operator
CTS launcher, and run the final integrated matrix. Remaining A work includes
the audit response/facts/ABI and settled-evidence readers, closed succession,
platform launchers, and the project-history activity fence shared with F.

## Project activity and archival fence

New broker acceptance and both presence writers now use the registered project's
existing SQLite activity transaction. Registry enrollment also holds its existing
exclusive write lock so registering a project cannot race an unfenced admission.
An archived or disabled project rejects new work before acceptance; looking up an
already accepted request still returns the original job and cannot replay it.
Registered client heartbeats publish under the canonical project even when cwd
contains a nested `.cad`; OpenCode snapshots bind their exact session scopes and
carry process/database/project identity proof. A legacy or unknown producer is
not certified by these markers. Closing presence remains permitted after archive.

Twelve activity/client-presence tests pass with zero skips, including real broker
IPC, actual Control Center archive/read-fresh-state composition, both lifecycle
updates, original receipt lookup, rejected new submit, canonical nested presence,
SQLite writer exclusion and a registration race. Strict API/adapter/test compile
and focused lint pass. F's separate seven-case reader matrix also executes a real
competing child admission: archive refuses the busy registry without deadlock,
releases SQLite, and only then may the child accept; retry archive succeeds and a
subsequent child is refused. Registry acquisition is fail-fast, while SQLite waits
are bounded; transient contention is an explicit refusal, never inferred idleness.

## Full-CI fixture corrections (Node 24)

The failing offline A groups now explicitly install the existing test-only WSL
path adapter, including synthetic spawned audit/observer workers. The metadata
successor test keeps its scoped spawn override active through the actual launch
(the emitted TypeScript import reads the live spawn property). Production
platform detection and child environment allowlists are unchanged. A synthetic
local worker birth now uses the Linux `synthetic:...` form; the previous colonless
value selected Windows process lookup and could not prove death on CI Linux.
The settled handoff fixture now carries its original qualification evidence hash,
and the canonical epoch runtime entry exports the existing checked persisted
record validator.

Observed reruns execute 27 prerequisite cases, six first-save evidence cases and
all first-save/control metadata assertions successfully. The persisted-schema
export test and 27 other epoch handoff cases pass. Final integrated qualification
is still required: a concurrent build invalidated identity-pinned startup/audit
runs, and several real checker cases timed out during parallel local load. Those
runs are not accepted as final evidence; assertions and guard timeouts were not
weakened. The metadata worker also honestly refuses this local Debian 13 host at
the existing Ubuntu-only Python capability boundary; GitHub's Ubuntu job remains
required. Exact archived 843 runtime bytes have been located privately and their
fingerprint verified for the remaining historical response/facts regressions.

## Remaining recovery host composition and retained queue tests

The nine remaining A host decisions now have canonical strict TypeScript sources:
`atomic-runtime-abi`, `fusion-reset`, `queue-audit-facts-capture`,
`queue-audit-response-proof`, `queue-closed-epoch-successor`, `queue-document`,
`queue-phased`, `queue-settled-epoch-evidence`, and `queue-state`. Frozen public
`dce47c5` sources and hashes retain their immediate predecessor. File read bounds,
exact original Python/wire bytes, owner/receipt identity, unknown-outcome refusal,
exclusive authority publication, snapshot escrow and lazy host composition remain
unchanged. The reset declaration names its adapter return type; staging rewrites
workspace type paths into installed runtime paths.

Eight retained queue suites are now strict TypeScript: domain, document, summary,
scheduling, version transition, config identity, local fence outcome and idle
build refresh. Their 231 original assertion calls and 37 executed case definitions
(including the automatic/exclusive loop) remain, with four added boundary type
assertions. Existing transport-loss lookup counts and parent fixture corrections
are preserved. Strict compilation with repository safety flags and focused lint
pass. The 17 pure domain/configuration/idle-client cases pass without skips; real
broker/checker cases await the stable central build. `recovery-host-migration`
registers the original retained effects/refusal suites against both the frozen
host module and its typed replacement; registration alone is not qualification.

## Portable audit-response proof: complete thirteen-case parity

`audit-response-portable.test.ts` executes every case from the formerly gated
`audit-response-proof.test.js` on both the immediate predecessor and typed proof
reader. It uses the public frozen 843 audit producer and public Python source;
the explicit synthetic host identity port is only a fixture. Public Git LF bytes
are deterministically packaged as CRLF, matching the original producer packaging.
The public fixture manifest records the original Git source hash. No archived
private runtime, credentials, ledger or environment files are included.

| Original retained case | Portable executed case |
| --- | --- |
| Successful source/process-bound execution | `portable843: successful source/process-bound execution…` retains all ten assertions, compares the complete old/new proof, and checks immutable-file invalidation. |
| Forged current instance | `portable843: even rehashed original evidence rejects forged current instance` |
| Wrong source hash | `portable843: even rehashed original evidence rejects wrong source hash` |
| Nonterminal receipt | `portable843: even rehashed original evidence rejects nonterminal receipt` |
| Failed Python body | `portable843: even rehashed original evidence rejects failed Python body` |
| Different original caller | `portable843: even rehashed original evidence rejects different original caller` |
| Stripped endpoint guard | `portable843: even rehashed original evidence rejects stripped endpoint guard` |
| Changed checked wire | `portable843: even rehashed original evidence rejects changed checked wire` |
| Wrong wire identity | `portable843: even rehashed original evidence rejects wrong wire identity` |
| Forged summary | `portable843: even rehashed original evidence rejects forged summary` |
| Fabricated endpoint verification | `portable843: even rehashed original evidence rejects fabricated endpoint verification` |
| Wrong owner | `portable843: even rehashed original evidence rejects wrong owner` |
| Checker not passed | `portable843: even rehashed original evidence rejects checker not passed` |

All thirteen portable cases pass with zero skips. Each negative case recomputes
the changed file reference, requires both readers to reject, and verifies that
reading did not repair or overwrite the forged bytes. Three additional paired
migration cases pass for full facts-preparation artifacts, manifest scope and
CLI capability/build refusal. These do not stand in for the thirteen cases.

The privately recovered exact 843 installation separately passes all thirteen
original retained cases with zero skips (verified historical fingerprint
`14aca04a4c37e5a3142d2493fc9e559987864779bad0b25dee41d166bcd3960d`).
This is a pre-final diagnostic with the current staged reader. The same retained
suite must rerun after final staging and on the exact final commit; neither this
run nor the portable fixture qualifies real Fusion.

Seven additional retained recovery suites now have canonical strict TypeScript
sources: audit-response proof/CLI, atomic runtime ABI, closed epoch successor,
first-save evidence, physical reset and large queue snapshot. All 126 original
assertion calls and 45 cases (including parameterized cases) are retained, with
two additional explicit boundary assertions. Malformed persisted-input tests keep
their deliberately incomplete inputs; no invented approval fields were added to
make types pass. The reset fixture now restores its synthetic WSL path adapter
after each case. Strict compilation and focused lint pass. Execution of this new
emitted batch remains required after the current integration staging; historical
runtime-dependent cases require the private fixture in addition to the thirteen
public portable cases described above.

## Checker concurrency diagnostic, unchanged baseline

A production metadata probe was prepared through the existing `prepareProbe`
port, reconstructed with exactly the same artifact hash, and admitted by the real
checker without calling the returned SDK sender. Fresh Node processes used the
same immutable baseline, source, definitions and default 30-second engine limit;
checker caching remained disabled. Sampling recorded engine process count/RSS and
cgroup CPU use on the four-CPU, 16-GiB local environment.

| Concurrent checks | Whole admission | Engine wall time | Result |
| --- | --- | --- | --- |
| 1, while source-tool launchers were active | 34.93 s | 30.56 s | timeout |
| 2, all team tools paused | 8.45 s | 6.40–7.14 s | 2/2 passed |
| 4, all team tools paused | 15.82 s | 11.57–13.27 s | 4/4 passed |
| 1, repeated with all team tools paused | 4.86 s | 4.04 s | passed |

The admission parent used 22.72 CPU-seconds in the first run versus 1.20 in the
quiet repeated single-checker run; the latter had no cgroup throttling. Quiet
engines peaked around 387–432 MiB each. Source-tool contention and warm filesystem
caches were not independently controlled, so this diagnoses environment-sensitive
performance rather than proving one exclusive cause. It does not justify changing
admission deadlines, assertions or scheduler limits. The existing four-worker
preparation, parallel offline work, single SDK queue and configurable scenario
concurrency (Fusion default 10) remain unchanged. Final installed/exact-commit CI
and the actual concurrency-10 profile remain required; this probe measurement is
not an end-to-end scenario or native qualification.


## Retained evidence regressions: strict source continuation

The existing atomic-observation-binding, audit-response-protocol,
audit-facts-capture, closed-epoch-proof, settled-epoch-evidence and
epoch-dead-process suites now have canonical strict TypeScript sources. Their
81 original assertion ASTs and 21 test declarations are preserved exactly after
erasing types and normalizing equivalent property access; two additional
assertions narrow an existing string ID and fixed-program fixture variant.
Embedded subprocess code remains unchanged. The deliberately missing CLI ports
and malformed persisted records remain missing/malformed at the tested boundary.

Strict compilation and focused lint pass. Runtime execution of this emitted
batch remains pending in the integration queue. The earlier eight/seven source
batches also now place value imports before CommonJS initializers: TypeScript
acceptance alone did not detect that emitted `createRequire(path.join(...))`
could previously run before the `path` import. Their emitted executions must be
rerun; previous runs of retained JavaScript prove behavior but do not qualify
these new emitted entrypoints.


## Retained successor and grant regressions

Ten further strict sources replace native-fixture-grant, closed-epoch-broker,
dead-epoch-successor/control/bootstrap, epoch-prerequisite,
epoch-runtime-startup/upgrade, settled-epoch-startup and successor-process-guard.
All 225 original assertion ASTs and 51 test declarations are preserved; three
additional branch assertions narrow the actual bootstrap result variants. The
existing synthetic fixtures now have shared type declarations only: their bytes,
process ownership checks, scoped WSL adapter, evidence guards and cleanup remain
unchanged. Existing malformed and deliberately partial inputs remain intact.

The isolated-epoch proxy declaration now includes its already implemented
`installEpoch`, `lookup`, historical snapshot and extended summary. This corrects
the typed host interface without changing execution. Strict compilation and lint
pass for all migrated sources. Actual emitted execution, pinned historical runs
and complete final-commit CI remain pending; no native qualification is claimed.
