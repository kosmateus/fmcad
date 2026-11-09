# Retained global state and style obligations

This supplement accounts for 568 previously unmapped frozen sites in six sources:
85 in `live-design-styles.js`, 201 in `live-style-save.js`, 76 in
`live-motion-animation.js`, 97 in `live-animation-methods.js`, 39 in
`live-camera-probe.js`, and 70 in `live-pose-methods.js`. The earlier estimate of
524 was not used. All 78 sites already listed in the main disposition ledger are
excluded. The frozen source commit remains `a32c49e705bd403c247caefa1007ad82d6d200d1`.

The JSON supplement preserves each exact expression, line, static-site kind and
ID. A loop remains a single frozen site with its input expressions intact;
embedded Python fragments must be evaluated in their assembled source helper.
These counts describe reviewed obligations, not executed assertions or passing
native tests.

Twelve mappings point to the existing shared camera and animation-plan cases:
the explicit 40-degree camera with its 1e-5 tolerances, original-state
restoration, and the one-second/2-fps camera plan. Their qualification remains
`pending-execution` until the exact final commit runs on the required backends.
Three explicitly offline checks in `live-style-save.js` retain the document-save
mock-suite exit and the no-backend `document.save_as` preview result; they are
`offline-only`, not native obligations or proof of cloud persistence.

The remaining 553 native-context sites are separated by their actual invariant:

- Design-local material and appearance copy/rename/collision handling, actual
  loaded library identities, projection/texture properties, native body
  assignment maps and explicit unsupported texture behavior.
- Positive material density readback and SDK unit conversion, mass=density×volume,
  relative 1e-5 and original absolute bounds, physical invariance during visual
  edits, component/body/face/occurrence appearance sources, linked-instance
  isolation and atomic mixed-reference rejection.
- Local F3D export/import roundtrip with exact object provenance when copied
  creationIds are shared, color/style/source and physical-property comparison,
  and preservation of the unsaved source. No cloud destination is chosen.
- Actual revolute/slider/cylindrical/rigid joint construction, limit validation
  before any movement, sampled native transforms and moved vertices, forced
  negative checks, exact pose restoration and 640×480 or 64×64 PNG proof.
- Native Animation workspace and owned empty-storyboard behavior, rejection
  before zero-range playback, and optional ffmpeg evidence: actual MP4/ftyp after
  success or explicit blocked/no-created-file behavior when unavailable.
- All six native camera application-order experiments with immediate, settled
  and later observations. Recording an observation is not a new assertion that
  the SDK must stabilize to an invented expectation.
- Native body visibility around pose save/update/list/apply/evaluate/delete,
  exact owner identity and revisions, carried metadata, and restoration before
  document close.

Every native group retains its installed CLI/receipt, owner, foreign-document,
workspace, camera, file and cleanup preconditions in the same context as its
native measurement. Ordinary envelope validation is not declared inherently
Fusion-dependent: these rows preserve that validation as part of the still
unported native workflow and do not replace independently covered offline cases.

The legacy files still use mutable suite identity/report state and global SDK
state. Their runner status is explicitly `migration-required`. Move that fixture
plumbing into the existing `ScenarioSession` lifecycle before calling them
native-ready; use exclusive instance scope for global workspace/viewport changes,
retain configurable outer concurrency and the single SDK queue, and keep the
same steps/assertions across supported backends. Do not enable these files by
label alone or substitute simulator metadata for native rendered/physical
observations. The exact original source expression is the acceptance obligation.

Native evidence must include the final installed commit/build identity and
Fusion version; bound request/job/client/document/file identities; native
readback with the original inputs and tolerances; unchanged foreign inventory;
and successful owned cleanup or explicit deferred cleanup after uncertainty.
Never retry an uncertain mutation merely to obtain a green observation.

## Owned native source checkpoint

The camera (39), pose (70), design-style (85), animation (97) and motion (76)
families now have explicit factories under `tests/scenarios/native-*-cases.ts`.
They use the existing `ScenarioSession`, exclusive-instance barrier, durable
request receipts, exact owned unsaved identity and foreign-document guards.
The material/appearance, visibility, joint geometry/limits, native PNG/MP4 and
workspace assertions remain in the case bodies. Local output paths are reserved
inside each session directory and exact owned files are removed only after a
settled result. Missing/foreign compiled CAD envelopes defer cleanup and never
replay the original mutation. The motion profiler still observes the production
CAD request, including preflight plus five actual in-pose checks.

Original user-view capture and restoration use the production camera handlers;
style tolerances and the stricter motion absolute 1e-7 camera check are retained.
Pose/design/animation now require an active Design document before fixture setup,
so the shared lifecycle can retain a restorable user camera as well as document
and workspace identity. This is a stricter native test precondition, not a change
to production operations. The historical style test already required this.
Native script dispatch preserves its active-document guard before activation.
The public CLI keeps string component selectors; dictionary token refs use the
same production compiled-request path as the historical embedded native tests.

Strict source compilation and focused lint pass. Camera and global-state tests
cover unsupported model capabilities and lost/missing/foreign native replies;
their execution is pending central staging. The ledger therefore still says
`migration-required` until those lifecycle checks run; its `ownedHandoffSource`
field records the implemented factory without claiming Fusion qualification.
All native `qualification` values remain `not-run`. Style-save (201 sites) is
being completed by package C on the same helpers and lifecycle.
