# Partial Fusion test model

Model version 15 implements document identity/lifecycle, numeric user-parameter CRUD,
saved-file identity and deletion, and a **test state export**. The exported `.f3d` fixture contains a JSON marker
`nativeF3d: false`; it is not a native Fusion archive and must not be imported into Fusion.
Native export/import assertions require `native-f3d`, which this model does not advertise.

The Python process persists one Application shared by all scenarios, so cross-document
routing faults remain observable. It executes the submitted source, never precomputed
answers selected by test name. Unsupported members fail; no generic mock returns success.

Signatures are checked against the verified Autodesk snapshot selected by
`runtime/python/typing/current.json` (initially commit
`07814d19ac63bb3ff0d55e3d35517cf3a71bad8c`). Types specify interface, not behavior.
Parameter units and owner isolation follow `tests/live-normal-multidocument.ts`;
the unsaved-document export precondition still requires live qualification.

The saved-file model has one configured project/root folder. Save acceptance,
completion and deletion visibility are separate states. Progress advances between
SDK requests, independently of scenario names. An unmodified save is a no-op;
modified saves retain the file ID and increment the version. Open, incomplete or
read-only files cannot be deleted. Delayed visibility is a conservative test
assumption, not a claim about measured Fusion cloud timing.

Model controls such as `advance_model`, `save_delay_steps`, `delete_delay_steps`
and operation counters are used only by model/fault tests. Shared scenarios use
only the pinned Autodesk interface. The model has no network cloud service,
general geometry kernel, general feature/constraint solver or UI event simulation.
Bounded rectangular regeneration and explicit camera snapshots are described below.
It is test-only and excluded from the published package.

Numeric parameters support explicit length/angle units, scalar values, bounded
arithmetic and parameter references. Updates reject cycles and incompatible
dimensions before changing the observed state. Rename updates references; delete
deliberately retains a referenced parameter while returning true, exercising the
bug documented in the pinned API reference. The production command must verify
absence. Text parameters, implicit display units and other Fusion expression
syntax remain unsupported. Shared scenarios and historical comparisons are in
`tests/scenarios/parameter-cases.ts` and `parameters.test.ts`.

Simple construction planes support explicit offsets, parallel midplanes and angles
around origin axes. Components support identity placement and nested occurrence
trees. Display units and empty/end timeline markers are implemented. Component
identities stay stable within the process, and conservative content revisions let
the real broker detect modeled edits without activating the document. Revision
strings are model state hashes, not simulated Autodesk revision identifiers.

Nonparallel midplanes, parameter-driven plane regeneration, referenced-plane
cascading deletion, nonidentity component transforms and general feature rollback are
explicitly unsupported. The bounded design graph now persists to an isolated in-memory file snapshot.
Opening the latest complete version creates a fresh document identity and restores
modeled geometry, parameters, attributes, units and timeline state. Opening an
already-open version returns that document; foreign, incomplete, deleting, deleted
and superseded versions are rejected before document creation. Historical-version
opening and native F3D import/export remain unsupported. This is a model capability;
shared saved-reopen lifecycle migration still requires receipt-bound identity handoff.

Cloud inventory adds project/folder/file enumeration, parent-folder paths and file
extension/read-only metadata for the configured fixture project. It does not model
project administration, file moves or personal-license quotas. Those adapters are
covered by retained SDK fault fixtures and real Python admission, not by claims of
cloud simulation. Cloud visibility and permission semantics need final live checks.

Rectangular XY sketches support literal two-point rectangles and one-sided,
untapered new-body extrusion. Bounds and volume are calculated from the rectangle
and extent; there is no geometry selected by scenario name. Timeline rollback
hides/restores the extruded body. Other profile types, booleans, taper, constraints,
cross-component creation, edits behind the timeline marker and general regeneration
remain unsupported. Saves preserve the supported graph without retaining subsequent live edits.
Unsupported geometry creation still fails at the operation boundary.

The deprecated `setDistanceExtent` method exists only to run the frozen historical
box fixture. Shipped code uses the pinned `DistanceExtentDefinition` and
`setOneSideExtent` interfaces, which are included in the API shape checks.

Body attributes support namespaced string creation/update and exact/group lookup.
Body/component tokens resolve only within their owning open design. Attribute
writes affect document dirty state and conservative body/component revisions.
The shared scenarios retain the later live suite's write/update/readback assertions;
paired handler tests also compare the frozen pre-refactor implementation.
Attributes persist with modeled bodies. Tokens are retained by this in-memory
model across reopen, but proxies, split/merged topology and native token lifetime
remain unqualified. The modeled 2 MiB limit counts UTF-8 bytes; native
encoding and boundary failure behavior still require qualification.

Public rectangular-sketch scenarios add `Sketches.addWithoutEdges` on owned XY
construction planes, stable in-process sketch/edge/point tokens, and coordinate
readback in centimetres. The original rectangle corners are copied; mutating an
input Point3D cannot edit an existing profile. The bounded expression evaluator
backs UnitsManager length/angle/scalar validation and parameter lookup. This does
not implement the full Fusion expression grammar or implicit display units.

Shared scenarios assert four ordered edge references and one closed profile,
preserving the rectangle setup used before the refactor. Health is modeled only
for empty sketches and these nondegenerate rectangles. Fixed/construction edits,
multiple loops, general curves, projected edges and constraint solving explicitly
remain unsupported. Shared-point token lookup is deduplicated within its design;
foreign or closed document tokens never resolve. Native edge order, health and
expression behavior remain final Fusion qualification assumptions.

Coordinate proof supports the root component's builtin XY plane only. Sketch to
model conversion, its inverse, and endpoint worldGeometry return independent
Point3D copies. The public coordinate-check scenario checks all three frames,
roundtrips and native endpoint world readback, then deliberately supplies a wrong
coordinate and requires a failed proof with unchanged geometry. Child-component,
offset-plane and occurrence transforms are explicitly unsupported by this model;
no identity transform is silently substituted for those cases. Native orientation
and world-coordinate behavior still need final Fusion qualification.

The snapshot is a deep copy of modeled state with its document edge explicitly
rebound on open. It never copies the application or other documents. This is not a
Fusion serializer, disk durability guarantee or evidence of STEP/F3D validity.
Native qualification must verify reopened creation identity, token resolution,
active-document behavior, saved versions and delayed cloud visibility.

## Bounded dimensioned rectangles

The model supports the production `shape.box` recipe on the root XY plane:
one positive-quadrant rectangle, its first point coincident with the sketch
origin, and one driving aligned/horizontal width and aligned/vertical depth.
Parameters and extrusion distance use the existing dimensional expression
interpreter. Bounds and volume regenerate analytically from the retained
expressions, including after saved-file reopen. Dimensions have owned tokens;
foreign endpoints, repeated dimensions, driven dimensions, incompatible
orientations, nonpositive dimensions and surface extrusions are rejected.

This is not a general geometric constraint solver. Native orientation conventions,
Fusion recomputation timing, constraint health and topology remain native-only
qualification assumptions. Parameter deletion/rename dependency rewriting and
arbitrary direct point editing are outside this bounded capability.

## Definition and batch component path

Shared transaction scenarios call the production Node CAD coordinator. Component
profiles preserve prepared artifact provenance through the production checker;
broker profiles submit the normal pinned `cad` command. The simulator supplies
only SDK results. Definition substitution, report hashing, replay and negative
step scheduling are not reimplemented in the scenario backend. Command inputs
are copied at the component boundary, matching the serialized broker boundary.

The analytical model additionally supplies exact rectangular-prism precise bounds
and volume for the production measurement handlers, numeric parameter attributes,
and explicit squared/cubed length literals. Native physical accuracy, general
BRep topology, audit completeness and atomic command-event rollback remain separate
qualification obligations. This family retains the historical non-atomic
`onExisting: reuse` definition flow and explicitly non-atomic negative check.

### Explicit camera state (model v13)

Camera snapshots are detached values, and each document owns a viewport. The
model supports explicit pose and perspective lens values, square orthographic
extents, exact document-bound restore, and rejection without changing the view.
The shared case retains the historical 40-degree lens and 80/60/50 mm eye with
0.00001 internal-unit tolerance. Its coordinator scope is exclusive-instance.
The API verifier checks the added method and property accessor shapes against the
same pinned Autodesk snapshot; unit tests independently check copy semantics,
cross-document state and refusal after document closure.

Native-only assumptions: projection/FOV application may move the eye, so the
production handler's two-stage apply still needs live verification; restoring
captured extents depends on the actual viewport aspect ratio. The model's square
viewport and initial pose are test inputs, not claimed Fusion defaults. Camera
persistence across save/reopen is not implemented or claimed. Fit, ViewCube
orientations, smooth transitions, rendered images, PNG bytes and shot packs are
unsupported; no placeholder pixels qualify those historical assertions. Unknown
camera writes are never replayed. Recovery can close the original owned document
from settled receipts, but does not certify camera restoration or run later cases.

### Pose manifest and body visibility (model v14)

The model adds owned component attributes and body light-bulb state. Actual
production pose handlers store revisioned manifests in those attributes and
perform apply/evaluate/restore/delete. Fill, spring, route and service fields stay
manifest-carried declarations; no mass, force, configuration-table or joint solver
behavior is inferred from them. Root-body visibility readback follows its bulb and
active timeline state. Ancestor/occurrence visibility and direct isVisible writes
remain unsupported. The pinned verifier includes the added accessor shapes.

The shared pose case preserves the historical manifest and visibility checks on a
saved fixture. It uses the exact body token returned by shape.box: the historical
fixture searched for a body named PoseBody, while both current and archived
geometry handlers assign that name to the feature and return the body's own ref.
No body-rename behavior is fabricated in the simulator. Native renderer visibility
and inherited visibility rules remain qualification obligations; no native run has
been performed.

## Design-local material metadata (v15)

A single explicitly synthetic, immutable library fixture supplies metadata only.
`Materials.addByCopy`, local ID/name lookup, name/description edits and design
ownership are modeled. Copies detach metadata; closed documents and library writes
are refused. IDs are model-generated, not Autodesk IDs or a guarantee of global
native-ID uniqueness. The supported design graph deep-copies these resources into
saved revisions and rebinds the document when reopened.

The fixture exposes no physical or visual property values. Its material property
collection is empty; this means no such fixture data is modeled, not that a real
library material has no properties. Density/mass, assignments/inheritance, visual appearance properties, textures, rendering,
cloud material catalogs and property editing remain unsupported. The shared material
case chooses an exact available library item, as the historical test did, and uses
production list/create/edit handlers; expected IDs and names follow that selection.
Actual native copy/rename/persistence behavior remains a qualification assumption.

## Design-local appearance metadata (v16)

Appearance/Appearances mirror the pinned API for ID, name, parent, property lookup
and detached addByCopy. A synthetic immutable library appearance exposes one
read-only descriptor, `model:test-property`, with only ID/name/parent metadata and
no value. Copies detach the descriptor and bind its parent to the target resource;
descriptor getters reject closed documents. The descriptor is not an Autodesk
library property or a visual/physical value. This makes descriptor enumeration
checks nonempty without claiming property editing support. Reading projection
therefore returns null for this fixture; no texture,
projection algorithm, rendered image, assignment or inheritance is simulated.
Local resources persist in the supported saved graph and rebind to the reopened
document. Library writes and writes through a closed document are refused.
Native copy/rename/projection/persistence remain explicitly unqualified.

## Explicit root-body styles (v17)

Root bodies accept exact design-local Appearance and Material resources. Their
independent getters retain these references across supported saved revisions.
The initial null getters mean no modeled assignment, not a claim that native
Fusion has no default physical material. No density/mass or inherited visual state
is supplied. Foreign/library resource setters, closed or rolled-back targets,
nonroot bodies and override clearing are refused. Empty allOccurrences is valid
only for an actually empty assembly; nonempty context enumeration is unsupported.
The pinned BaseComponent accessor supplies the inherited API shape. Actual native
resource/getter/persistence behavior is still a qualification assumption.

## Analytic thread recipes

The `thread-recipes` scenario exercises production curated-catalog, custom-profile
and pair-fit arithmetic against saved owned fixtures. It adds no SDK geometry
implementation: the pre-existing rectangular body is independently read before and
after the recipe operations. Native ThreadInfo tables, cosmetic feature creation,
helical teeth and arbitrary BRep stay unsupported. Curated catalog names are nominal
(e.g. `M10`); full installed designations (e.g. `M10x1.5`) are rejected by both the
historical and current catalog. This is documented in B_ASSERTION_AUDIT.md.

## Declared engineering calculations

`engineering-declarations` adds no SDK model API. It runs the production cam,
assembly dependency, sampled withdrawal and conservative envelope calculations
against the existing document/unit/frame boundaries. The historical numeric
assertions and explicit unresolved/blocked fields remain unchanged; each owned
saved fixture has independent box-state readback. Cam contact, follower forces,
continuous collision, native joint solving and BRep motion remain unsupported.
Production audit readback in the definition family now also observes the supported
design graph and catches parameter changes that do not affect the box dimensions.
That comparison is not a claim of native full-topology or timeline-health fidelity.

The audit's face/edge cardinalities are derived from the eight corners of a
nondegenerate axis-aligned rectangular prism: coplanar groups of four corners form
its six faces, and vertex pairs differing along exactly one axis form its twelve
edges. This extends the existing rectangular extrusion model only. Collection
indexing/enumeration deliberately refuses unsupported native face/edge objects;
there are no synthetic topology identities, general BRep or surface algorithms.
The pinned API check includes the two BRepBody collection getter shapes.
