# Retained modeling assertion obligations

This supplement accounts for 962 frozen static assertion/helper sites in four
retained live sources: 959 rows in
`tests/scenarios/assertion-dispositions-modeling.json` plus the three existing
camera mappings in `assertion-dispositions.json`. It does not record native
execution. Source hashes and assertion IDs remain anchored to the frozen
`a32c49e705bd403c247caefa1007ad82d6d200d1` inventory. No live source or historical
assertion was changed.

The new rows contain 46 precise shared invariant mappings, 45 installed sketch
preflight mappings, and 868 retained native-context obligations. The installed
consumer now executes the existing compiled `live-sketch-operations --check`
against the actual packed/installed runtime. That gate is pending the stable
integrated build; it cannot qualify native sketch geometry. Every native row
retains its exact original expression, source location, specific capability
requirements and observation, with `qualification: not-run`. Capability names
describe requirements; they do not advertise simulator support.

## Runner readiness is a separate unresolved prerequisite

These sources are preserved evidence, not approved concurrent native runners.
Before native execution, move their listed steps and assertions into the existing
`ScenarioSession` lifecycle, preserving ordered dependencies and numeric values:

- `live-cad.js` shares one identity, report, timeline and generated report path;
  its CLI selection uses the document name. It lacks a complete uncertain-result
  stop across groups and cleanup. Each native sequence needs an immutable owner,
  exact identity pin and deferred cleanup on unknown execution.
- `live-extended.js` shares one design timeline and name-based CLI routing across
  groups. Preserve its stop latch, component independence, camera restoration
  and exact path/symlink cleanup checks while assigning per-scenario ownership.
  Camera/render work requires exclusive instance scope.
- `live-thicken-slot-pattern.js` already pins doc-id and defers cleanup on an
  unknown result, but still mutates process environment and shares suite/report
  globals. Port the dependent seed/thicken/pattern readbacks together, retaining
  the exact body token-set difference and volume tolerances.
- `live-sketch-operations.ts` already uses installed generated CLI routes and
  bound typed queue receipts. Its suite identity/report and active-document
  close remain outside `ScenarioSession`. Preserve exact request/job/client
  receipt checks, explicit installed runtime fingerprint, original active-state
  restoration and no replay after uncertainty when moving the ordered sketches.

The installed `--check` path sends no Fusion request. Its coverage is limited to
the executed installed-path, fingerprint, contract and route assertions. Generic
JSON guards executed by that path are mapped as shared preflight, not as solver
evidence. Shared lifecycle mappings cover only the stated identity or cleanup
invariant; they do not qualify the surrounding retained geometric workflow.

## Required native observations

The machine-readable rows distinguish every static site, including nested
helper invocations and embedded Python assertions. The following groups explain
why each remaining case needs its specific native observation. No prior invocation,
compilation, simulation or skipped capability is acceptance evidence.

### tests/live-cad.js

| Obligation group | Required observation |
| --- | --- |
| `cad-command-envelope` | Run the generated CLI and require the original exit status, rejection regex and exactly parsed LIVE_CAD response; a submitted command is not geometry evidence. |
| `cad-owner-guard` | Read the real document inventory before mutation; require one name match, the recorded creationId and an unsaved owned document. |
| `cad-dispatch-and-failure-audit` | Bind each catalog operation to the owned target, preserve success/document envelope assertions and retain the read-only audit after a failed group. |
| `cad-owned-close` | Close only the unique name-and-creationId match after checking it remains unsaved, then prove that exact document disappeared. |
| `cad-physical-measurement` | Read actual bounds in mm and volume in mm 3 with 0.001 mm and max(0.001,volume*1 e-5) volume tolerance; require finite values and exact entity counts. |
| `cad-recompute` | Require the real design recompute to report healthy; no empty or merely invoked response qualifies. |
| `cad-document-creation` | Create exactly one new owned document from the baseline inventory, require its intended name and active identity, and verify zero body definitions. |
| `cad-parametric-datum` | Create a 5 mm offset datum, read z=0.5 cm, update its expression to 8 mm and require recomputed z=0.8 cm within 1 e-7 with one plane. |
| `cad-primitive-regeneration` | Build box/tube/cylinder/cone using named parameters; verify their analytic bounds, volume, circular radii and one-body count both before and after all dimension changes. |
| `cad-circle-extrude-regeneration` | Dimension a radius 8 mm circle, extrude 12 mm, then change radius/height to 9/15 mm; retain one profile/body and both analytic bounds and volumes. |
| `cad-revolve-alias` | Use explicit dimensioned rectangle/profile/Y-axis refs through the bare revolve alias; verify one body,8 x 10 x 8 mm bounds and pi*16*10 mm 3 volume. |
| `cad-hole-circular-pattern` | Cut a 4 mm seed hole in a 40 x 5 mm cylinder, pattern four holes, recompute and require the two analytic volumes, four cylindrical hole faces and one body. |
| `cad-fillet` | Resolve the unique top circular edge of the regenerated radius 12 mm cylinder; a 1 mm fillet must remove positive volume below 5 percent while preserving 24 x 24 x 25 mm bounds. |
| `cad-linked-occurrence` | Add a linked occurrence translated 100 mm in X; preserve body/component definition counts and definition token, add exactly one occurrence and read translated proxy bounds/volume. |
| `cad-rejection-readback` | Reject an unknown shape field and angular cylinder radius with their exact historical errors, then compare both entity counts and component inventories before/after. |
| `cad-body-alias-ambiguity` | Create distinct bodies, alias the first to the second name, require exact alias readback and ambiguous-name rejection, unchanged inventories and exactly two bodies. |
| `cad-final-history-audit` | Recompute the accumulated fixture and require a healthy timeline plus an empty audit issue list. |
| `cad-local-native-export` | Verify destination absence, then create checkpoint/native f 3 d outputs and require nonzero actual bytes, checkpoint inspection and unchanged owned document identity. |
| `cad-native-reimport` | Opt-in native reimport must preserve bounds/volume/definition-history counts, create a fresh owned identity and close only temporary imported documents; original document inventory must match. |
| `cad-final-accounting` | Account for all owned documents after close and compare the complete baseline foreign document inventory without editing user documents. |

### tests/live-extended.js

| Obligation group | Required observation |
| --- | --- |
| `extended-command-envelope` | Keep indeterminate transport/malformed-result mutation stop, exit codes, unambiguous marker and exact CLI envelope checks. |
| `extended-owner-guard` | Preserve foreign name/saved/modified inventory and require one owned name, original creationId, unsaved status and active ownership before mutation. |
| `extended-cad-dispatch` | Preserve operation/document/success envelope checks, expected failures, forbidden imports/reimports and unknown batch-step stop; each group owns a distinct component but shares timeline state. |
| `extended-measurement-helpers` | Retain finite analytic volumes and bounds in declared units, exact body/profile/path counts, explicit generated names and healthy recompute for every dependent feature case. |
| `extended-document-creation` | Recheck the complete baseline creationId set inside native creation, reject a duplicate name, and record a new active unsaved creationId with zero body definitions. |
| `extended-section-thickness-restore` | Require four section edges/perimeter 64 mm, parallel-plane thickness 10 mm and measured 2400 mm 3; both passing/failing parameter sweeps must restore expression/value/health and 2400 mm 3 geometry. |
| `extended-sweep` | Sweep a radius 3 mm YZ circle 20 mm along X; require pi*9*20 mm 3,20 x 6 x 6 mm bounds at[0,-3,-3] and one body. |
| `extended-loft` | Loft radii 8/4 mm separated 15 mm; retain analytic frustum volume,16 x 16 x 15 mm bounds at[-8,-8,0] and one body. |
| `extended-shell` | Shell the top face of 20 x 12 x 10 mm box inward 2 mm; require 2400-16*8*8 mm 3, original bounds and one body. |
| `extended-chamfer` | Chamfer four top edges 1 mm and verify the integrated inset-rectangle volume, unchanged 20 x 12 x 10 mm bounds and one body. |
| `extended-feature-edit-suppress` | Discover extrusion distance by retained expression, edit it to 2*height, read 4800 mm 3/20 mm height, suppress to zero bodies and safely unsuppress to identical restored geometry. |
| `extended-combine` | Join/cut/intersect overlapping 10 mm boxes with keepTools=false; require exactly one body and operation-specific 1500/500 mm 3 volume plus exact bounds/minima. |
| `extended-split` | Split a 20 x 12 x 10 mm box at z 4 mm; require two bodies with 4/6 mm heights, correct minima and corresponding analytic volumes. |
| `extended-draft` | Draft exactly one planar side 5 degrees; derive signed slope from the measured normal, then check inclination, integrated volume, extrema and one body. |
| `extended-rectangular-pattern` | For spacing and extent variants generate six 2 x 3 x 4 mm bodies at the explicit 3 x 2 grid, total 144 mm 3 and 22 x 15 x 4 mm envelope. |
| `extended-path-pattern` | For spacing and extent variants generate three 2 x 3 x 4 mm bodies at X 0/10/20 mm along the native path, with total 72 mm 3. |
| `extended-mirror` | Mirror a 2 x 3 x 4 mm body about the offset YZ plane; require two 24 mm 3 bodies with X minima 0/8 mm and 10 x 3 x 4 mm aggregate bounds. |
| `extended-slot-regeneration` | Preserve symmetric slot analytic volume/bounds before and after length,width,height,XYZ and 90 degree rotation parameter changes; read two regenerated radius 4 mm cap faces. |
| `extended-bolt-circle-regeneration` | Regenerate four diameter 4 mm holes on pitch 20 into six diameter 6 mm holes on pitch 30 at 30 degrees; require exact cylinder counts, axis positions, diameters and material volume. |
| `extended-asbuilt-joints` | Rigid/revolute as-built creation must preserve placement; verify motion types, rename, suppression restoration and grounded state.90 degree revolute drive must rotate actual 20 x 4 mm world bounds, preserve 160 mm 3 and restore the 0 degree pose. |
| `extended-interference-clearance` | Two 10 mm cubes initially overlap 500 mm 3 at zero distance; after moving the second to X 13 mm require 3 mm clearance, no overlap, and threshold-dependent passes without changing either volume. |
| `extended-batch-measured-gate` | Resolve the batch-created 2 x 3 x 4 mm body into a 24 mm 3 check; a subsequent 999 mm 3 failure must skip the next mutation before request creation and preserve component/features/body/volume readback. |
| `extended-camera-state` | Compare document, camera type/units, vectors/extents and optional lens angle after restore at 1 e-5 internal-unit tolerance. |
| `extended-visibility` | Hide/show/isolate two bodies, restore their exact saved visibility vector in finally and verify both remain 24 mm 3. |
| `extended-style-library` | Read appearance/material items and libraries with nonempty ids/string names; selected library id must round-trip with an item list. |
| `extended-camera-shot-pack` | Set the exact 40 degree perspective pose, render two 640 x 480 PNGs to absent paths, verify path/byte length/signature/IHDR/dimensions, restore changed then original camera and preserve 2400 mm 3 body volume. |
| `extended-final-audit` | Require the accumulated fixture timeline healthy and no final audit issues. |
| `extended-image-cleanup` | Remove only an existing regular non-symlink file under the exact native temp directory and random fixture prefix, after identity/active/unsaved checks; confirm absent afterward. |
| `extended-document-cleanup` | Close only the unique owned creationId/name if unsaved and active, preserving the identity in the close response. |
| `extended-final-accounting` | After stop, perform only read-only inventory accounting; preserve all foreign documents, require no owned leftovers, and retain local batch evidence whenever mutation outcome is uncertain. |

### tests/live-sketch-operations.ts

| Obligation group | Required observation |
| --- | --- |
| `sketch-queue-receipts` | Require exactly one request/job/result set, matching request/job/client identity, terminal typed result and no unknown/partial outcome; uncertainty must prohibit replay. |
| `sketch-installed-command` | Invoke only the selected installed generated CLI through queue with the exact client; require settled consistent typed execution outcomes and preserve no-retry behavior for uncertain mutation. |
| `sketch-document-inventory` | Parse a successful receipted native document list, retain stable foreign-document fields and require at most one identifiable active document. |
| `sketch-idle-precondition` | Require no interactive command except SelectCommand before fixture mutation or close; preserve native receipt and CLI status evidence. |
| `sketch-cad-dispatch` | Require Python SDK document scope/read-only contract, exact owned document pin, successful bound terminal receipt and matching operation/document response before accepting any native method result. |
| `sketch-numeric-evidence` | Keep structural equality, finite numeric tolerances, invocation-before-validation and explicit failed/blocked/unknown group evidence; no call count alone qualifies geometry. |
| `sketch-fixture-geometry` | Create the specifically named native sketches and primitive counts, retain nonempty entity tokens and require exactly one independently inspected curve for each selected token. |
| `sketch-coordinate-proof` | Require overall/geometry/entity/check status pass, exact expectation count and nonempty coordinate checks for sketch/model/world frames and model-to-sketch roundtrip. |
| `sketch-dimension-plan-apply` | Recognize circle+ellipse with three size proposals without changing curves/points/dimensions; accept exactly the reviewed circle radius, read a driving dimension/expression, replan without duplicate radius and preserve ellipse 8/4 mm radii plus frame coordinates. |
| `sketch-mirror` | Reflect the radius 2 mm circle at[5,15] to[-5,15], require exactly one mirrored primitive and native symmetry constraint, and independently inspect Circle 3 D/radius within 0.001 mm. |
| `sketch-offset` | Offset the upward line 2 mm to its positive right side; require one native Line 3 D child/constraint and endpoints[22,10,0],[22,20,0] within 0.001 mm. |
| `sketch-pattern` | Read both circular/rectangular native constraints and exactly seven radius 1 mm circles at the explicit expected centers; require one-to-one matching and no extra instance. |
| `sketch-linked-project` | Project the linked radius 3 mm circle into the target sketch, require one entity, Circle 3 D and exact center[-30,-25,0] in sketch/world frames with 0.001 mm radius tolerance. |
| `sketch-transform` | Rotate 90 degrees then translate[-5,5,0]; require successful changed before/after points and independently read radius 2 mm circle center[-15,90,0] in sketch/model frames within 0.001 mm. |
| `sketch-solver-health` | Read pass status, healthy solver state 0, exactly ten closed profiles and the disclosed underconstrained-point list after all native operations. |
| `sketch-observation-shape` | Keep exact XYZ tuple shape and mm conversion for native geometry; inventory hashes must preserve stable document fields and the active document. |
| `sketch-document-creation` | Require absent random name, idle Fusion, one receipted new active document, canonical UUID creationId, exact name, unsaved/unmodified state and no cloud file. |
| `sketch-owner-guard` | Before work/close, read document.status with the immutable pin; require exact name/creationId, unsaved/no-file state, unique active fixture and preservation of all baseline foreign documents. |
| `sketch-native-fixture` | Create four isolated named sketches with the retained circle,ellipse,line,point fixture coordinates and dimensions used by subsequent solver/readback obligations. |
| `sketch-owned-cleanup` | After certainty and idle checks close the exact unsaved fixture, require a successful receipt, zero remaining owned rows, preserved foreign documents and restored original active inventory hash. |
| `sketch-sequence-accounting` | Run each retained method sequence only while execution is known/unblocked; record failure before cleanup and require every method readback plus owned cleanup before declaring suite success. |
| `sketch-entry-preconditions` | Offline --check validates only installed declarations. Native entry requires explicit --run, client identity and absent unique report path; never overwrite evidence or restart an uncertain mutation. |

### tests/live-thicken-slot-pattern.js

| Obligation group | Required observation |
| --- | --- |
| `thicken-command-envelope` | Preserve process/transport uncertainty stop, epoch pre-dispatch blockers, exactly one parsed marker, successful exit and recursive unknown/pending detection. |
| `thicken-owner-guard` | Compare foreign-document state and require exactly one active owned name/creationId, unsaved status and null cloud file before mutation. |
| `thicken-cad-dispatch` | Validate the canonical operation, pin doc-id and accept only a successful matching operation/document envelope with a nonempty native result and no nested uncertainty. |
| `thicken-readback-evidence` | Require each labeled comparison to pass with its exact equality/tolerance and at least one original native invocation before marking an operation validated. |
| `thicken-owned-close` | Defer close on uncertainty; otherwise match exact name/creationId, reject saved/cloud fixture, close once and retain the exact close identity. |
| `thicken-solid-measurement` | Independently inspect isSolid, XYZ bounds within 0.001 mm and volume within max(0.001,volume*1 e-5) for the returned thickened body. |
| `thicken-document-creation` | Create one absent random-name unsaved document, require one newly observed creationId/name with no cloud file, and retain its baseline inventory. |
| `thicken-top-face` | Select exactly one planar top face of 10 x 8 x 2 mm box and thicken 1 mm as a new body; require one solid 10 x 8 x 1 mm body of 80 mm 3. |
| `slot-feature-pattern` | Create a positive-volume 10 x 4 x 2 mm slot seed, pattern its feature twice at 20 mm spacing, read exactly two new isolated body tokens and equal seed/native volumes within 0.001 mm 3. |
| `thicken-final-accounting` | Record native failures/unknown outcomes distinctly; close only on certainty, verify no owned leftovers and original active-document restoration, and require validated results plus cleanup before a pass. |

Every native run must retain the exact final installed commit/build fingerprint,
bound request/job/client receipts, owned document/file identities, the original
assertion values and tolerances, unchanged foreign inventory and certainty-aware
cleanup evidence. On unknown mutation outcome, report the original request and
leave cleanup deferred; never resubmit the uncertain mutation.

## Additional feature-mode and hierarchy accounting

The second supplement, `assertion-dispositions-modeling-features.json`, accounts
for all 266 frozen sites in `live-feature-modes.js` (161) and
`live-component-hierarchy.js` (105): ten precise shared invariants and 256
retained native-context obligations, all marked not-run. Source hashes and
individual evidence literals remain unchanged.

`live-feature-modes.js` still selects a hard-coded addin endpoint and concatenates
legacy CAD assets. Its report, component and document state are shared across
feature groups. Before native qualification, use the existing prepared CAD path
and ScenarioSession with the same mode steps/readbacks on both supported
backends. Preserve the historical XZ direction and hole extent hypotheses, the
explicit getter-inspection gaps, original tolerances and indeterminate-result
stop. `live-component-hierarchy.js` already pins doc-id and honors broker blocks,
but needs its environment/report globals and cleanup moved into the common
owner lifecycle. Neither retained source is labeled native-ready.

### tests/live-feature-modes.js

| Obligation group | Required observation |
| --- | --- |
| `feature-mode-script-envelope` | Preserve exact bundled-handler provenance, unique result marker and in-script name/creationId/active/unsaved/foreign-inventory guards. Any indeterminate call or malformed result must latch a stop including cleanup. |
| `feature-mode-measurement` | Require finite measured volume in mm3 and bounds in mm with the retained 0.001 mm and max(0.001,abs(volume)*1e-5) tolerances; retain named datum and parameter setup for the dependent feature modes. |
| `feature-mode-profile-fixture` | Build the retained point/rectangle/circle section on its exact supplied plane and require exactly one closed profile for non-point geometry. |
| `feature-mode-xz-line` | Build the XZ line with negated local Y, optional fixed-start/vertical/driving dimension, then independently verify world endpoints [x,0,0] and [x,0,height] within 0.001 mm. |
| `feature-mode-native-inspection` | Read native feature token/type/health and mode-specific extent/start definitions, hole direction/type/cylinders, sweep orientation/scaling or loft guide properties. Require health 0; do not force a timeline rollback to read unsupported rail/orientation getters. |
| `feature-mode-recompute-isolation` | Require actual recompute and healthy result; each named component owns its mode fixture, and failed modes retain read-only history inspection without retrying mutations after uncertainty. |
| `feature-mode-document-creation` | Require explicit --run, a matching pre-creation inventory and absent random name, then record a new exact name/creationId and unsaved state. |
| `extrude-through-all-participants` | Cut a 5x5 mm through profile only from the designated 20x20 mm stock at heights 10/16/10; require stock volume 375*height, untouched other-body volume 1600 and both exact bounds plus native ThroughAll extent. |
| `extrude-to-entity-offsets` | Extrude a 4x3 mm profile from +2 mm to a parametrized target minus1 mm at heights20/26/20; read volume12*(height-3), exact bounds, ToEntity/OffsetStart native types and retained offset expressions. |
| `hole-through-all-to-entity` | For throughAll/toEntity holes, preserve native input direction diagnostics and participant selection; at stock heights10/17/10 require analytic (400-pi*4)*height volume, unchanged stock envelope and healthy native hole readback. |
| `hole-reverse-types` | For simple/counterbore/countersink reverse-through holes, retain extra removal volumes, regenerate10/17/10 mm stock, require native defaultDirection false and actual +Z unit direction within1e-6. |
| `sweep-straight-orientation` | Parallel and perpendicular 4x2 mm straight sweeps must regenerate lengths20/25/20 with volume8*length, exact bounds and native orientation enum matching the requested mode. |
| `sweep-bent-orientation` | On the45degree radius20 mm XZ arc, preserve distinct parallel/perpendicular analytic volumes and extrema, then compare the native sweep orientation enum. No replacement of the original trigonometric bounds. |
| `sweep-guide-rail` | Regenerate straight route/parallel rail at lengths20/25/20; require volume8*length, exact4x2 mm envelope and native scale enum. Preserve the explicit getter-inspection gap without timeline mutation. |
| `sweep-guide-rail-scaling` | Independently perturb only the driving rail spread1/2/1 mm; require scale=1+spread/2, integrated frustum volume8*20*(1+s+s^2)/3, exact scaled extrema and native profile-scaling enum. |
| `loft-rails-centerline` | For one rail and one centerline variants, regenerate profile separation20/26/20; require pi*16*height volume, radius4 mm bounds, guideCount1 and the exact isCenterLine mode. |
| `feature-mode-owned-cleanup` | Close only the guarded owned unsaved document after known completion and require the complete original document inventory afterward. Unknown execution retains the exact owned identity and blocks cleanup/replay. |

### tests/live-component-hierarchy.js

| Obligation group | Required observation |
| --- | --- |
| `hierarchy-command-envelope` | Preserve command exit, unique parsed marker, epoch blocker and recursive unknown/pending detection; a returned transport result alone cannot qualify the component method. |
| `hierarchy-owner-guard` | Read all native document identities and foreign saved/modified/name state; before mutation require one active owned name/creationId, null cloud file and unsaved status. |
| `hierarchy-cad-dispatch` | Use the declared operation and immutable doc-id/component scope, require matching successful operation/document envelope and nonempty native result, and retain any nested unknown outcome as a no-replay stop. |
| `hierarchy-readback-evidence` | Keep each exact labeled comparison and numeric tolerance; an operation is validated only after an original native invocation has corresponding readback assertions. |
| `hierarchy-owned-close` | Do not close after uncertainty or explicit broker block. Otherwise require the unique exact name/creationId, no saved cloud file and the returned closedCreationId. |
| `hierarchy-document-creation` | Create one random-name fixture absent from baseline, require exactly one added identity/name, null file and unsaved state, and bind all subsequent native work to it. |
| `hierarchy-from-bodies` | Move the explicit root10x8x4 mm BRep into a new component; require exactly one returned body and atomic=false, preserving the documented non-atomic behavior. |
| `hierarchy-rename` | Rename the moved-body component, require affectsAllInstances true and exact returned name, then independently inspect that the renamed definition still owns one native body. |
| `hierarchy-reparent` | Unground the translated child, reparent under the requested target and require worldPosePreserved plus exact nested path; independently compare min/max/size within0.001 mm and destination child ownership. |
| `hierarchy-linked-duplicate` | Duplicate the moved occurrence in linked mode at X50 mm; preserve the renamed definition token, explicit linked mode and two affected paths, then read the actual50 mm proxy-bounds displacement. |
| `hierarchy-parts` | Find all three native definitions, require linked quantity2/bodyCount1 for the renamed component and quantity1 for parent/child, retain child BRep count1 and explicit subassembly scope. |
| `hierarchy-rigid-group` | Create the requested rigid group from the moved and target occurrences without including children; require a nonempty native group token and exact requested name. |
| `hierarchy-align` | Unground the source at X30 mm, align it to the target root transform, require residual<=1e-8 and actual origin0, independently read X minimum0 within0.001 mm and unchanged body dimensions. |
| `hierarchy-final-accounting` | On known unblocked execution close the owned fixture, require no owned leftovers and restored original active document while preserving foreign inventory; blocked/unknown states must remain explicit and not be retried. |
