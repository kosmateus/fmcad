# GM25–37 retained assertion extraction

The eleven retained integration sources contain 89 cases. Their live guard did
not distinguish declared calculations from SDK behavior. `gmDeclarationScenarios`
extracts 83 cases into the existing saved, owned `ScenarioSession`; the same
functions can run with the simulator or the Fusion queue backend. No second test
runner or synthetic process exit is introduced. Inputs, tolerances, expected
values and negative outcomes remain those of the retained cases, apart from the
explicit historical reconciliation of G37-04/06 below.

| Retained family | Shared cases | What is exercised offline | Native obligations |
| --- | --- | --- | --- |
| GM25 routing | 01–08 | Spatial numeric route, transport frames/tangents, declared bend limits, PAN×TILT states, cut length/tail arithmetic and explicit native-dependent state | Native route geometry and physical cable behavior are not asserted or qualified by these declared recipes. |
| GM26 FPC/PCB | 01–12 | Neutral-axis fold/flatten, datum offsets, both-side zones, ports, mating/poka-yoke rejection, cavity fit and keepout checks | Native ECAD/flex remains an explicit limitation. G26-07 also retains a real CLI exit-code assertion. |
| GM27 assembly | 01–06 | Dependency order, disconnections, service prerequisites, declared 2D withdrawal/tool/fixture clearance and trapped fasteners | Native assembly collision, real access and actual tools are not inferred from declared outlines. |
| GM28 optics | 01–06 | Declared basis/frustum clipping, sampled coverage, baffle/window rays, alignment and forbidden zones | Native scene occlusion, optical material response and RF/magnetic behavior remain unqualified. |
| GM29 appearance | 01–12 | Local resource copy/rename and ownership, blocked property branches, root attributes, assignment reports, typed descriptors and real deterministic PNG bytes | Native library/property availability, visual rendering, texture/projection persistence and physical material properties remain unqualified. G29-10 retains its real CLI refusal/diagnostic assertion. |
| GM30 presentation | 05, 06, 08 | Real handler refusal of orientation+eye; sketch visibility, supported graph recompute and healthy timeline | 01/02 require real section analysis/orientation/hatch/flip; 03 requires screenshot bytes plus camera/visibility restoration; 04 requires actual ViewCube orientation and fit; 07/09 require section bulbs/active-component restoration and real shot output. G30-05 retains its real CLI exit assertion. |
| GM31 DFM | 01–07 | Declared protected zones, signed draft, undercut and wall samples, void continuity, thin-wall flags, honest native-sampling refusal | Native BRep sampling, material continuity and manufacturing feasibility are not implied by declared samples. |
| GM32 sheet metal | 01–06 | Neutral bend allowance/K factor, developed/formed lengths, no scaling, native-flat-pattern refusal and missing-allowance error | Native sheet metal authoring and associativity remain explicitly blocked. G32-04 retains real CLI exit/diagnostic assertions. |
| GM34 markings | 01–05 | Verbatim annotations, gated emboss/engrave recipes, liquid-level/flow derivation and protected zones | Actual emboss/engrave geometry and native manufacturing acceptance remain unqualified. |
| GM36 explode/animation | 01–08 | Occurrence-based pose schedules, interpolation/easing, transform restoration, manifest tracks, capability gates and absent-encoder refusal | Native storyboard/video authoring and rendering are not claimed. G36-06 retains a real nonzero CLI exit assertion; the shared refusal creates only the original PNG-signature inputs in its owned directory and verifies that no film exists. |
| GM37 checks/evidence | 01–10 | Scalar/vector/count/boolean predicates, distinct missing/stale/fail/error/dependent outcomes, required evidence, acceptance and empty-checklist refusal | Declared evidence is not proof that a native model or file passed qualification. Real CLI exit assertions remain for 03, 04, 06, 08, 09 and 10. |

`gmCommands` calls the real Node CAD orchestration through `session.cad`; its
negative result port exposes envelopes, not invented exit codes. Heightmap
creation also checks the real public success envelope. Encoder refusal and
expected handler exceptions use the existing
`cadCommand` helper on the same owned session. Their retained CLI assertions remain
separate obligations: a missing broker also exits nonzero, so an offline process
failure cannot prove a CAD rejection. A trial of the camera, allowance and empty
checklist cases confirmed this distinction; their validation lives in the Python
handler, after backend routing.

Fresh GM29 documents arrange source resources by copying an available library
item into their own design before the original nonempty-source/copy assertions.
They never borrow retained resources from a shared document. PNG/frame paths live
under the session directory and use the backend's host-path mapping. Lifecycle
cleanup, original request lookup and deferred cleanup on uncertain effects remain
owned by `ScenarioSession`. GM30 uses the existing exclusive-instance scope. The
simulator continues to reject ViewCube fitting instead of approximating a native
solver to satisfy G30-04.

G29-11 additionally requires at least one descriptor and checks its name, so the
original descriptor loop cannot pass vacuously. The model's sole synthetic
`model:test-property` is immutable ID/name/parent metadata, with no physical or
visual value. A focused model check verifies exact lookup identity, detached
copies, parent rebinding and closed-document refusal. Native descriptor values,
availability and editing remain separate obligations.

The retained conditional branches also remain explicit: G29-02's successful
texture connection (`changed` contains `image`, empty image readback) and
G29-03's successful installed projection setter (`status:pass`, `changed:true`)
require a supporting native SDK. The model exercises their honest blocked paths;
those successful branches are preserved in the common functions but are not
counted as executed offline assertions. G29-06/07 assert root assignment report
shape and zero mismatches only, and G29-08 permits an empty style/density report;
these cases do not establish nonempty assignments, density or duplicate detection.
The existing explicit body-style scenarios cover modeled nonempty assignments.

G37-04/06 predate the accepted baseline's conservative public outcome policy. At
their introduction (`f2a07a8`) the generated wrapper did not reject unknown result
status. The accepted predecessor (`2521600`, retained at `a26222f`) already did;
both `src/cad.js` and `src/outcome.js` rejected unknown/missing/stale. The current
wrapper and `failedOutcome` preserve that policy. The original missing/stale
counts and outcomes remain unchanged. These two cases now explicitly require
outer `success:false` and a nonzero real CLI exit while also preserving the
informational `result.success:true` supplied by the check/evidence handler. The
shared case asserts both layers. `deliver` continues to require actual passing
acceptance. No production code, receipt or uncertain-outcome policy was relaxed.
Only the public source/history comparison is recorded here; private archive
contents are not copied into the repository.

The retained JavaScript sources preserve the CLI and six GM30 obligations, with
the two stale GM37 expectations reconciled as described above. Their old
helper/guard is not evidence of safe native
execution. Native qualification requires the separately reviewed owned fixture,
global-state isolation, exact build and receipt evidence; no native run has been
performed here.

An AST comparison with the retained pre-extraction sources accounts for every
old assertion. The extracted scalar assertions retain their operands, thresholds
and expected values. Adaptations are limited to checked JSON access, helper-local
variable renaming, unwrapping handler results for host-file refusals, and the two
documented GM37 corrections. G29's unused `createMaterial` helper is not copied;
its three assertions remain in the retained source and the exercised G29-04
material copy/rename assertions remain in the shared case. Real process exit and
diagnostic assertions and the six native GM30 cases remain in the retained source
with the obligations above. G29 positive heightmap calls still assert the actual
public success envelope; handler refusal checks add an explicit null result.

Validation is in progress. The initial 72-case MCP extraction exposed the camera
fit boundary and missing sketch visibility/recompute model methods. The latter
are bounded additions to the existing model and require their own checks; the
initial run is not a passing final qualification. Final protocol counts and
exact-commit CI evidence belong in the integration ledger after execution.
The current extracted TypeScript passes strict compilation and ESLint. The
upstream API verifier passes 76 method and 78 property-accessor shape checks
against pinned snapshot `83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179`.
These static checks do not replace the pending 83-case run for each protocol,
the focused model behavior checks, the broker concurrency grid or native Fusion.
