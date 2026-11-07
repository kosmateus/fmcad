# Reusable test-design content clearing

> Restored from the preserved 2026-10-20 diagnostic source snapshot. Historical
> SDK verification below refers to its cited build, not a new live verification.

`document clear` (`document.clear`) empties supported local parametric design
contents in an **existing saved cloud file**. It never deletes the cloud file,
saves, makes a copy, resets version history, retries, or rolls back.

## Exact usage

Discover the current exact open name and `result.fileId` using:

```sh
fmcad document status --doc 'Reusable_Test_example' --json
```

Replace `EXACT_DATAFILE_ID_FROM_STATUS` below with that actual `DataFile.id` in
both positions. The example document name must also be replaced with the exact
open name. These are placeholders, not a selected live document.

```sh
fmcad document clear --doc 'Reusable_Test_example' \
  --doc-file-id 'EXACT_DATAFILE_ID_FROM_STATUS' \
  --file-id 'EXACT_DATAFILE_ID_FROM_STATUS' --confirm true --dry-run true --json

fmcad document clear --doc 'Reusable_Test_example' \
  --doc-file-id 'EXACT_DATAFILE_ID_FROM_STATUS' \
  --file-id 'EXACT_DATAFILE_ID_FROM_STATUS' --confirm true --json
```

Equivalent operation data is
`{"fileId":"EXACT_DATAFILE_ID_FROM_STATUS","confirm":true,"dryRun":true}`;
`--doc` and `--doc-file-id` are invocation context, not payload fields.
`dryRun` defaults to false. Both boolean fields are strict; confirmation is
required even for dry-run. No name-prefix restriction: this is a generic,
explicitly authorized command, not a hard-coded test-file cleanup script.

`dryRun:true` actually reads Fusion under the transport's read-only guard and
returns audited counts. It never activates the document or moves the timeline.
`--preview` retains its existing outer-input-only behavior and is not an audit.
Modeling batches reject this operation.

## Supported empty-content contract

Preflight requires a valid, previously saved, complete, writable DataFile with
the exact requested ID and required matching context pin. It allows current
unsaved modifications: confirmation authorizes destroying those test contents.
Root invocation scope and root edit target are required. It audits the entire
Design, not just the active component.

Deletion is: marker zero, `Timeline.deleteAllAfterMarker()` once, surviving
canvases/custom graphics, user parameters in dependent-first order, then all
entity attributes plus attributes on the Design and Document. Child component
objects disappear with their timeline history; survivors are re-enumerated.
Aliases, frames, parameter metadata, run markers and third-party custom
attributes are included. Existing parameter expressions are never rewritten.
User dependencies on model parameters are unsupported; model parameters must
be owned by an audited timeline entity or its sketch dimension. Current
`isDeletable` is checked again before each user-parameter deletion.

The timeline must be unsuppressed and at its end, with valid public entities.
Single-level groups are audited through TimelineGroup.item without expanding the
UI or reading unavailable collapsed leaf indices. Empty/nested groups or an
inconsistent group inventory refuse. Timeline counts remain top-level counts.
The explicit supported timeline entity types are:

- Occurrence, Sketch, Canvas, ConstructionPlane, ConstructionAxis,
  ConstructionPoint.
- ExtrudeFeature, RevolveFeature, SweepFeature, LoftFeature, FilletFeature,
  ChamferFeature, ShellFeature, DraftFeature, HoleFeature, CombineFeature,
  MirrorFeature, RectangularPatternFeature, CircularPatternFeature,
  PathPatternFeature, MoveFeature, ScaleFeature, SplitBodyFeature,
  SplitFaceFeature, DeleteFaceFeature, RemoveFeature, OffsetFeature,
  ThickenFeature, StitchFeature, UnstitchFeature, PatchFeature, ExtendFeature,
  TrimFeature, CutPasteBody.
- Joint, AsBuiltJoint, JointOrigin, RigidGroup, Snapshot.
- Standalone local BaseFeature containing only non-derived B-Rep source bodies.
  Base-feature sketches, construction geometry, meshes or linked features refuse;
  source arrays are audited explicitly. The root edit-target guard still applies.

Removed occurrences retained in native history can raise the specific
`InternalValidationError : occPath.valid()` from isDerived. Only absent-current
occurrences with a valid local definition and isReferencedComponent=false take
the historical-definition audit path. Their definitions and descendants receive
the same complete content audit; current or otherwise unreadable provenance
still refuses. Counts include these history-only definitions. A local parametric
RemoveFeature may bind through its canonical timeline Occurrence, rather than
through itself; that binding is checked without the rollback-only itemToRemove
getter. No timeline marker movement is needed for this audit.

Unsupported content **refuses before mutation**, including any other product
(even an empty CAM/manufacturing product), document/external occurrence
references, configured designs/configurations, direct designs, unaudited base/derived
bodies, mesh, unknown/custom history, flat patterns, decals, PMI, custom
coordinate systems, selection/contact sets, analyses and named views. Missing,
null, invalid or throwing audit APIs are errors, never guessed zero counts.
PMI/custom-coordinate collections are inspected only to reject unsupported
contents; their preview APIs are not used to create or delete anything.
This deliberately restrictive scope may reject otherwise deletable designs.
Timeline-entry refusals identify the zero-based index and public entity type
(or explicitly report no public entity), rather than only a generic refusal.

`CutPasteBody` is supported only as a local parametric feature outside a base
feature. Cross-component moves may leave source sketches/extrudes and model
parameters in root while result bodies and cut/paste features belong to child
components. Preflight audits history and inventories across the entire Design;
it does not require a body's source feature to share its current component.
Existing unaudited-base/derived-body, external-reference, identity and all-zero readback
guards still apply. No new unknown feature types are implicitly accepted.

The reported compound CutPasteBody representation can also expose internal
`Feature` and `RemoveFeature` objects through a native component's `features`
collection. These are accepted only when all of the following checks succeed:

- The helper and its `timelineObject` are valid, and the binding is ungrouped
  and unsuppressed. Its `entity` identifies that helper, not necessarily the
  canonical CutPasteBody entity.
- Its index is a nonnegative in-range integer in the same `parentTimeline`.
  The canonical row at that index confirms the same index/timeline and contains
  an already audited `CutPasteBody`.
- The helper belongs to the native component being enumerated in this Design,
  has no assembly proxy context, is parametric and has no base feature.

Names are never used for admission, including localized or implementation
helper names. Arbitrary unknown top-level features are still rejected; the
top-level type allowlist does not include generic `Feature`. Multiple helpers
at one index are individually checked and counted, not collapsed into one
feature. Model parameters can reference an admitted helper as their creator.
Helpers are removed by the existing whole-timeline deletion, not individually
deleted or otherwise bypassed. Any surviving helper fails the fresh audit
because there is no remaining canonical CutPasteBody binding; all-zero counts
remain mandatory.

Successful clear re-audits every count to zero: timeline, snapshots,
descendantComponents, occurrences, bRepBodies, sketches, features,
constructionPlanes/Axes/Points, joints/asBuiltJoints/jointOrigins/rigidGroups,
canvases/customGraphicsGroups, meshBodies/decals/PMI/custom coordinate systems,
userParameters/modelParameters and attributes. Counts visit each component
definition once; multiple occurrences are counted separately, not multiplied
into body/sketch counts. Nested sketch geometry and body faces/edges belong to
their deleted parents and are not separate top-level counts.

The result also verifies the same saved complete writable cloud file. Changed
contents must leave `modified:true`. Results contain `before`, `after` (clear
only), `current`, `mutation`, `savePerformed:false`, `retained`, and
`unsavedChanges`. Dry-run status is `inspected`; verified clear is `cleared`.
Already-empty designs may report no mutation and no unsaved changes.

The caller saves separately after inspecting the result. `saved:true` means
the document has a saved cloud identity, **not** that the clear was uploaded.
False SDK deletes and SDK/readback exceptions propagate. After mutation starts,
errors can leave partial unsaved changes; neither progress output nor a true
timeline-delete boolean alone proves a successful clear. Inspect before another
attempt; there is no automatic replay, retry or rollback.

Retained: root component/origin datums; file identity, name, location, metadata
and versions; units; materials/appearances; rules; view/render settings and
preferences. This is **not a literal new-document reset**.

## SDK source audit and offline evidence

Implementation was checked against the installed SDK's documented Python stubs,
without calling Fusion:

`API/Python/packages/adsk/defs/adsk/{core,fusion}.py` in Autodesk webdeploy
build `f0877c667ada77b44502b5b3316b697a2ba18ad4` (2026-09-10).

- `fusion.Timeline.markerPosition`, `count`, `deleteAllAfterMarker`,
  `timelineGroups`; `TimelineObject.entity`, `isGroup`, `isSuppressed`.
  Marker zero means beginning; delete-all-after-marker returns a success boolean.
- `fusion.Design.designType`, `isConfiguredDesign`, `isConfiguration`,
  `activeEditObject`, `allComponents`, `allParameters`, `userParameters`,
  `snapshots`, `analyses`, `contactSets`.
- `fusion.Component`/`BaseComponent` collections, `parentDesign`, `flatPattern`;
  `Occurrence.isReferencedComponent`; `BRepBody.baseFeature/isDerived`;
  `Canvas.isDerived/deleteMe`; `CustomGraphicsEntity.deleteMe`.
- `fusion.Parameter.dependencyParameters/dependentParameters/isDeletable`,
  `UserParameter.deleteMe`, `ModelParameter.createdBy` (feature, construction
  geometry or sketch dimension).
- `fusion.CutPasteBody` publicly derives from `Feature`; inherited
  `isParametric`, `baseFeature` and `parentComponent` establish its supported
  local-history scope. `CutPasteBodies.add` documents moving a body into the
  collection's component; `BRepBody.moveToComponent` moves a body between
  components. `CutPasteBody.sourceBody` explicitly requires rolling the timeline
  to immediately before that feature, and may be empty after consumption.
  Preflight never reads it or rewinds history to inspect provenance. Likewise,
  a source feature's current faces/bodies need not still expose the moved body.
- `Features.item/count` expose all existing features regardless of type.
  `Feature.timelineObject`, `parentComponent`, `assemblyContext`, `isParametric`
  and `baseFeature` provide the helper's public bindings/status.
  `TimelineObject.index` is zero-based (and can be -1 for grouped objects),
  `parentTimeline` identifies its timeline, and `entity` identifies the object
  associated with that binding. The specific shared-index helper representation
  comes from the reported read-only live inspection; it is not a general SDK
  guarantee that arbitrary internal features are supported. The implementation
  admits only the bounded Feature/RemoveFeature-to-CutPasteBody pattern above.
- `core.Product.findAttributes('', '')` matches all entity attributes but
  **excludes attributes on Product and Document**; those are enumerated separately
  via `.attributes`. `Attribute.deleteMe` deletes the attribute.
- `core.Document.isSaved/isModified/dataFile/documentReferences/products`;
  `DataFile.id/isComplete/isReadOnly`; `Base.isValid`.

### Array versus collection compatibility

`Product.findAttributes` is documented as returning an **array**, not an
`Attributes` collection. The installed `API/Python/packages/adsk/core.py`
implements `AttributeVector` with `__iter__`, `__len__` and `__getitem__`, but
no `.count`/`.item`. Clear explicitly snapshots this array with `list()` in
both preflight/verification and residual attribute deletion. Null/invalid
entries and iteration failures remain errors; incomplete iteration never
produces an empty-success result.

The installed wrappers were also checked for `.count` and `.item` on every
other collection class used by clear:

- Core: Products, DocumentReferences, Attributes, NamedViews, SelectionSets.
- Fusion: Timeline, TimelineGroups, Components, Snapshots, UserParameters,
  ParameterList (allParameters and both parameter dependency directions),
  ContactSets, Analyses, Occurrences, BRepBodies, Sketches, Features,
  ConstructionPlanes/Axes/Points, Joints, AsBuiltJoints, JointOrigins,
  RigidGroups, Canvases, CustomGraphicsGroups, MeshBodies, Decals,
  PMIAnnotations, UserCoordinateSystems.

These are the native Component/Design properties used by the handler, not
similarly named occurrence/proxy properties that may return arrays. Collection
count/item read errors are not caught or reinterpreted as empty arrays.
The regression fixture now returns a non-list, non-count/item AttributeVector
stub by default, covering empty/populated dry-run, attribute deletion and
zero verification. This compatibility fix does not expand the bounded scope
or certify complete clearing of arbitrary designs or later C-stage contents.

`tests/document_clear_test.py` uses in-memory SDK stubs for identity, unsupported
scope, actual dry-run counts, cascading history, residual deletes, parameter
order, attributes, zero verification and partial failures.
The cross-component regression models 20 root sketches, 20 root extrudes,
4 local occurrences, 20 child CutPasteBody features and 1 canvas (65 timeline
entries), with 20 moved child bodies and root-owned model parameters. It checks
read-only counts, then all-zero clear readback, and rejects unsupported move
ownership/base/direct cases, invalid body provenance and residual components.
The compound regression also uses the reported canonical cut/paste indexes
41–48, 50–54, 56–57 and 59–63 with two distinct root helpers per index. It
verifies 80 actual feature objects across 65 timeline entries, a helper-owned
model parameter, zero readback, and rejection of orphan/out-of-range/non-cutpaste
indexes, foreign timeline/component ownership, proxies, invalid/suppressed/base/
nonparametric helpers, unknown top-level features and surviving helper objects.
`tests/document-clear.test.js` verifies command routing, payload flags, read-only
transport and outer-only preview; `tests/cad.test.js` covers generated dispatch.
These tests do not certify live Fusion kernel behavior or cloud durability.
No live reusable file was touched to implement or test this command.
