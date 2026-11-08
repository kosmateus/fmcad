# Partial Fusion test model

Model version 12 implements document identity/lifecycle, numeric user-parameter CRUD,
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
geometry kernel, feature/constraint regeneration, camera or UI event simulation.
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
