# Partial Fusion test model

Model version 8 implements document identity/lifecycle, numeric user-parameter CRUD,
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
explicitly unsupported. Geometry persistence/reopen and native F3D export are not
implemented; saved fixtures exercise cloud ownership and cleanup, not geometry
roundtrips. The shared document scenarios test geometry before closing the fixture.

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
remain unsupported. Saves with geometry now fail explicitly before creating a file,
rather than silently dropping geometry from parameter-only state persistence.

The deprecated `setDistanceExtent` method exists only to run the frozen historical
box fixture. Shipped code uses the pinned `DistanceExtentDefinition` and
`setOneSideExtent` interfaces, which are included in the API shape checks.

Body attributes support namespaced string creation/update and exact/group lookup.
Body/component tokens resolve only within their owning open design. Attribute
writes affect document dirty state and conservative body/component revisions.
The shared scenarios retain the later live suite's write/update/readback assertions;
paired handler tests also compare the frozen pre-refactor implementation.
Attribute persistence, proxies, split/merged topology and token lifetime after
reopen remain unsupported. The modeled 2 MiB limit counts UTF-8 bytes; native
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
