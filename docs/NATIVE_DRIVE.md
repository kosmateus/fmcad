# Driver-only native motion experiment

`mechanism.drive-test` distinguishes declared math from native measurements. The
implementation is in dedicated `domain/native_drive.py`,
`application/native_drive.py`, and `adapters/fusion/native_drive.py` units. Runtime
registration is described by `native-drive-manifest.ts` and
`application/native_drive_handlers.py`, then composed into the canonical Python
bundle. `src/catalog/mechanism.json` supplies the public contract; the ordinary
catalog projection exposes the CLI and MCP routes. A dedicated test also executes
the real `PreparedPythonArtifact` with filesystem reads blocked and checks the
driver-only adapter dispatch.

The isolated graph is `native-drive-domain`, `native-drive-application` (depends
on domain), `native-drive-fusion` (depends on application, `core`, and `assembly`
for the real `joint.drive` setter and capture helpers), and `native-drive-handlers`
(owns `mechanism.drive-test` and `mechanism.motion-link.create`). The graph is composed once into the canonical
bundle; `src/catalog/native-drive.js` performs pre-dispatch validation and the
manual/catalog entries describe each mutating confirmed operation. No
compatibility asset loader is needed. Root CLI and MCP use their existing typed
catalog routes; the public TypeScript facade exports typed drive-test and
MotionLink-creation invocations.

## Input contract

All quantities are finite numeric native units: driver rotation and angular phase
in radians, slide phase in centimetres, slide ratio in cm/rad. There is exactly one
rotational driver and 1–32 distinct native joint followers. No tracks are supplied
for followers. Each follower declares its expected relationship:
`actual = ratio * driver + phase` (nonzero ratio, positive tolerance).

```json
{
  "schemaVersion": 1,
  "confirm": true,
  "driver": {"token": "DRIVER"},
  "waypoints": [0, 0.1, 0.2, 0.3],
  "followers": [{
    "joint": {"token": "FOLLOWER"},
    "coordinate": "rotation",
    "ratio": -2,
    "phase": 0,
    "tolerance": 0.000001
  }],
  "budgetSeconds": 10,
  "driverTolerance": 0.0000001,
  "restoreTolerance": 0.0000001
}
```

There are 2–240 waypoints. Adjacent requested driver and declared angular follower
steps must be strictly less than π/2; the first waypoint must also be near the
captured driver angle. Driver and expected follower excursions must exceed twice
their respective tolerances, so an effectively stationary experiment cannot pass
as engagement evidence. Driver limits,
ownership, active document, workspace and command are checked before motion.
External joints, occurrence-proxy joints and suppressed joints are refused.

`commandedMathTrack` is the entire intended track, even when sampling aborts.
`actualSolver.samples` contains fresh direct joint readbacks, all exposed rotation
and slide coordinates, occurrence `transform2` matrices, measured unwrapped phases
and residuals. Setter returns are deliberately ignored. The only write target,
including restoration, is the driver. No follower is set to an expected value.
No transform is assigned.

Large typed MCP responses use the existing job/project-bound owned response
artifact path; the operation's accepted job identity is propagated to the writer
so callers can retrieve the complete result without trusting an advertised path.

Measured phase is lifted from adjacent **measured** angles; expected phase is
never used to choose a winding. Initial winding is unknown: the native initial
angle anchors the measured phase. Measured steps at least π/2 are rejected as
ambiguous. Aliased whole turns between samples remain fundamentally unobservable;
bounded sampling is not continuous-motion verification. Transforms are observed
and compared during restore, not promoted to a geometry or contact proof merely
because scalar joint residuals agree.

## Cleanup and status

Before any write a complete independent pose is captured. A `finally` cleanup
attempts one driver restore, then one separate full readback regardless of setter
success. Every captured coordinate and matrix entry must match within
`restoreTolerance`. Restore is `pass`, `fail` (readback differs or setter failed),
or `unknown` (readback unavailable). A changing document/command prevents unsafe
cleanup writes and is reported, not silently bypassed. No fallback follower or
transform writes hide restore failures. Unobserved assembly state and document
dirty/history state are not restored; this is not rollback.

Sample budget is cooperative, defaults to 10 seconds and is capped at 30 seconds.
It is checked before and after SDK work, including the final sample. Cleanup has
a separate bounded **operation count** (one write, one read), not a hard wall-clock
timeout: a synchronous native call cannot be remotely interrupted safely. Local
ports can provide a cancellation callback. The normal Fusion handler does not
pretend the broker supports in-turn remote cancellation; the default callback is
absent. Both cancellation and budget aborts still restore/read back and cannot
return success.

`nativeCapability.status` remains `unknown` and `qualified` remains false even
when sampled residuals pass: the response alone does not prove which native
solver/coupling mechanism caused it. `motionLinkCreation` is
`separate-operation-not-run`; `drive-test` never creates a link.
`mechanism.motion-link.create` is a separate, mutating operation that uses the
documented `MotionLinks.createInput/add` API for two explicitly referenced native
revolute joints and reads back the created link. It does not move the joints or
qualify solver behavior; a successful creation response is not a `drive-test`
PASS. `mechanism.couple` only evaluates math and refuses `representation:native`.
Neither API presence nor declared motion values prove solver coupling.

## Offline verification

```sh
npm run build:code
npm run typecheck:tests
node --test tests/native-drive-bundle.test.js
python3 -B tests/native_drive_test.py
```

The bundle test uses the isolated family manifest to build a real
`PreparedPythonArtifact`, executes it from outside the checkout with file reads
blocked, and dispatches the registered handler against a deterministic fake
solver. It asserts the handler's only joint setter target is the driver, restore
is independently read back, setter echoes are ignored, native capability remains
unknown, and an injected local cancel callback still runs cleanup. This validates
artifact composition and driver-only handler behavior, not Fusion solver behavior.

Tests cover coupled, disconnected, wrong ratio/phase with identical mathematical
tracks; actual multi-turn phase; slide followers; setter error after mutation;
cancel and time budget before/during/after sampling; failed restore and failed
independent readback; transform-only restore mismatch; document change; and
adapter readback rather than setter echoes. These are fake tests, not Fusion
solver, native geometry, or physical validation.

## Live scratch qualification — pending coordinated deployment and broker release

Live qualification is consent-authorized but still requires a coordinated runtime
deployment and a safe public broker status/release. Use a pinned document
(`--doc-id`/`--doc-file-id`/`--doc`) for each operation. Do not replay an
active/unknown queue operation. `scripts/qualify_native_drive.py` is a callable, import-inert helper,
not a default test or automatic remote runner. It assumes the three production
units and production CAD context are already loaded, and accepts only an active,
unsaved `FMCAD_NATIVE_DRIVE_…` scratch document. It never saves/closes documents.
Prepare an empty owned scratch manually after consent; record its creationId.

`prepare_native_drive_scratch(ctx, consent=True)` builds two **independent**
revolute joints sharing a grounded occurrence. This is only the disconnected
control. It does not create a native coupling or pretend to qualify one. After
the fixture exists, use the separate pinned `mechanism.motion-link.create`
operation to add a real link; it requires an explicit confirmation and two native
revolute joint refs. Its result is creation/readback evidence only; run
`mechanism.drive-test` separately and restore/read back the driver pose.
`qualify_native_drive_case(...)` records one case against pinned joint refs.
The prepared fixture intentionally has no production bodies; add simple visible
asymmetric rotor bodies to the owned components before geometry qualification.

Required live evidence before ticket completion:

1. **True positive:** create a real native coupling in the owned scratch with
   `mechanism.motion-link.create` or use an explicitly authorized known native
   fixture. Record the exact refs, returned native link/readback, measured ratio
   and phase, app build and unit hashes. If the handler is unavailable, report
   `blocked/unknown`; introspection is not a substitute.
2. **Disconnected:** run the independent control with a nonzero mathematical
   ratio. Expected track remains valid, measured response must fail.
3. **Wrong ratio and phase:** retain the real coupling but supply separately
   incorrect expected ratio and phase to `mechanism.drive-test`. Both must fail
   without follower writes. Establish expected values from native measurements;
   do not infer an equation from the API value fields alone.
4. **Restore:** independently capture/read native coordinates, transforms and
   asymmetric body proxy vertices before/after each case; save evidence and
   overview/detail screenshots. Confirm only the driver was commanded.
5. **Restore negative:** after separate agreement on safe fault injection in the
   disposable scratch, prevent the native driver from restoring (for example an
   instrumented port refusing its final driver write while still performing real
   native readback). Require explicit fail/unknown and preserve the scratch for
   inspection; an offline fake or setter exception alone is not native proof.
6. Exercise cancellation/budget with cleanup on scratch, recording bounded
   operation counts and any synchronous overrun, not a claimed hard deadline.

The helper does not automate creation/suppression of an unknown native coupling,
geometric fixture, transport, or fault injection; those require the authorized
environment and supported native path. Offline completion leaves the ticket open
for integration and the above qualification. Even qualified native kinematics
does not establish real-world physical performance.
