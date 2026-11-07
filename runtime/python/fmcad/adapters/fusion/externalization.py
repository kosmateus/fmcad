"""Native external-effect primitives. No undo, model replay or cloud deletion."""
import math as _external_math
import os as _external_os
import sys as _external_sys
import time as _external_time
import types as _external_types
from collections.abc import Iterable as _ExternalIterable
from typing import cast as _external_cast
from typing import overload as _External_overload
from typing import TypeVar as _ExternalTypeVar


_ExternalItem = _ExternalTypeVar('_ExternalItem')


@_External_overload
def _external_items(collection: "_CadItemCollection[_ExternalItem]") -> "list[_ExternalItem]": ...


@_External_overload
def _external_items(collection: "_ExternalIterable[_ExternalItem]") -> "list[_ExternalItem]": ...


def _external_items(collection: "_CadItemCollection[_ExternalItem] | _ExternalIterable[_ExternalItem]") -> "list[_ExternalItem]":
    try:
        return _cad_items(_external_cast(
            "_CadItemCollection[_ExternalItem] | list[_ExternalItem] | tuple[_ExternalItem, ...]", collection))
    except AttributeError:
        return list(_external_cast("_ExternalIterable[_ExternalItem]", collection))


def _external_project_file(app: "adsk.core.Application", project_id: str, file_id: str,
                           version: int | None = None) -> "adsk.core.DataFile":
    lookup = _external_cast(
        "Callable[[adsk.core.Application, str, str, int | None], adsk.core.DataFile]",
        _references_project_file)
    return lookup(app, project_id, file_id, version)


def _external_document_identity(doc: "adsk.core.Document") -> JsonObject:
    identity = _external_cast("Callable[[adsk.core.Document], JsonObject]", _references_document_identity)
    return identity(doc)


def _external_own_components(root: "adsk.fusion.Component") -> "list[adsk.fusion.Component]":
    components = _external_cast(
        "Callable[[adsk.fusion.Component], list[adsk.fusion.Component]]", _references_own_components)
    return components(root)


def _external_collect_graph(data: JsonObject) -> "_ExternalReferenceGraph":
    collect = _external_cast("Callable[[JsonObject], JsonObject]", _references_collect_graph)
    return _external_cast('_ExternalReferenceGraph',collect(data))


def _external_graph_lifecycle_effects(graph: "_ExternalReferenceGraph") -> "list[JsonObject]":
    return graph['lifecycleEffects']


def _external_current_edges(ctx: "CadContext") -> "list[_ExternalReferenceEdge]":
    collect = _external_cast("Callable[[CadContext], list[JsonObject]]", _references_current_edges)
    return _external_cast('list[_ExternalReferenceEdge]',collect(ctx))


def _external_file_destination(spec: "_ExternalItemSpec") -> "_ExternalFileDestination":
    if 'destination' not in spec:
        raise KeyError('destination')
    return _external_cast('_ExternalFileDestination',spec['destination'])


def _external_feature_health(ctx: "CadContext") -> JsonObject:
    inspect = _external_cast("Callable[[CadContext], JsonObject]", _references_feature_health)
    return inspect(ctx)


def _external_edge_version(doc: "adsk.core.Document", edge: "adsk.core.DocumentReference",
                           source_id: str, forward_count: int) -> JsonObject:
    inspect = _external_cast(
        "Callable[[adsk.core.Document, adsk.core.DocumentReference, str, int], JsonObject]",
        _references_edge_version)
    return inspect(doc, edge, source_id, forward_count)


def _external_metadata(design: "adsk.fusion.Design", root: "adsk.fusion.Component") -> JsonObject:
    inspect = _external_cast(
        "Callable[[adsk.fusion.Design, adsk.fusion.Component], JsonObject]", _references_metadata)
    return inspect(design, root)


def _external_parameters(design: "adsk.fusion.Design") -> "list[JsonObject]":
    inspect = _external_cast("Callable[[adsk.fusion.Design], list[JsonObject]]", _references_parameters)
    return inspect(design)


def _external_native_occurrence_token(native: "adsk.core.Base | None") -> str | None:
    identify = _external_cast("Callable[[adsk.core.Base | None], str | None]", _references_native_occurrence_token)
    return identify(native)


def _external_native_attributed(entity: "adsk.core.Base") -> "_ExternalAttributed":
    native = getattr(entity, 'nativeObject', None) or entity
    return _external_cast('_ExternalAttributed', native)


def _external_document_data_file(doc: "adsk.core.Document") -> "adsk.core.DataFile | None":
    value: object = getattr(doc, 'dataFile', None)
    return _external_cast("adsk.core.DataFile | None", value)


def _external_assembly_context(occurrence: "adsk.fusion.Occurrence") -> "adsk.fusion.Occurrence | None":
    value: object = occurrence.assemblyContext
    return _external_cast('adsk.fusion.Occurrence | None',value)


def _external_required_data_file(doc: "adsk.core.Document") -> "adsk.core.DataFile":
    value: object = getattr(doc, 'dataFile', None)
    return _external_cast("adsk.core.DataFile", value)


def _external_reference_data_file(reference: "adsk.core.DocumentReference") -> "adsk.core.DataFile | None":
    value: object = reference.dataFile
    return _external_cast("adsk.core.DataFile | None", value)


def _external_event_file(event_args: "adsk.core.DataEventArgs") -> "adsk.core.DataFile | None":
    value: object = event_args.file
    return _external_cast('adsk.core.DataFile | None',value)


def _external_future_data_file(future: "adsk.core.DataFileFuture") -> "adsk.core.DataFile | None":
    value: object = future.dataFile
    return _external_cast('adsk.core.DataFile | None',value)


def _external_find_file(app: "adsk.core.Application",file_id: str) -> "adsk.core.DataFile | None":
    value: object = app.data.findFileById(file_id)
    return _external_cast('adsk.core.DataFile | None',value)


def _external_data_event(app: "adsk.core.Application", name: str) -> "adsk.core.DataEvent":
    if name=='dataFileComplete':return app.dataFileComplete
    if name=='dataFileCopyComplete':return app.dataFileCopyComplete
    raise AttributeError(name)


def _external_new_document(documents: "adsk.core.Documents",
                           document_type: "adsk.core.DocumentTypes") -> "adsk.core.Document | None":
    value: object = documents.add(document_type)
    return _external_cast('adsk.core.Document | None',value)


def _external_nullable_joint(value: object) -> "adsk.fusion.Joint | adsk.fusion.AsBuiltJoint | None":
    return _external_cast('adsk.fusion.Joint | adsk.fusion.AsBuiltJoint | None',value)


def _external_refresh_file(file: "adsk.core.DataFile") -> None:
    refresh = _external_cast("Callable[[adsk.core.DataEventHandler | None], bool]", file.refresh)
    refresh(None)


def _external_future_upload_state(future: "adsk.core.DataFileFuture") -> int:
    return int(_external_cast('_ExternalSupportsInt',future.uploadState))


def _external_user_parameter(design: "adsk.fusion.Design", name: str) -> "adsk.fusion.UserParameter | None":
    value: object = design.userParameters.itemByName(name)
    return _external_cast("adsk.fusion.UserParameter | None", value)


def _external_required_user_parameter(design: "adsk.fusion.Design", name: str) -> "adsk.fusion.UserParameter":
    return _external_cast('adsk.fusion.UserParameter',_external_user_parameter(design,name))


def _external_parameter(design: "adsk.fusion.Design", name: str) -> "adsk.fusion.Parameter | None":
    value: object = design.allParameters.itemByName(name)
    return _external_cast("adsk.fusion.Parameter | None", value)


def _external_joint_origin(ctx: "CadContext", name: str) -> "adsk.fusion.JointOrigin | None":
    value: object = ctx.root.jointOrigins.itemByName(name)
    return _external_cast("adsk.fusion.JointOrigin | None", value)


def _external_joint_occurrence(joint: "adsk.fusion.Joint | adsk.fusion.AsBuiltJoint",
                               index: int) -> "adsk.fusion.Occurrence | None":
    value: object = joint.occurrenceOne if index==0 else joint.occurrenceTwo
    return _external_cast('adsk.fusion.Occurrence | None',value)


def _external_joint_expression(joint: "adsk.fusion.Joint | adsk.fusion.AsBuiltJoint",
                               name: str) -> "str | None":
    if not hasattr(joint,name):return None
    parameter=_external_cast('_ExternalJointParameter',getattr(joint,name))
    return parameter.expression


def _external_joint_flipped(joint: "adsk.fusion.Joint | adsk.fusion.AsBuiltJoint") -> "bool | None":
    if not hasattr(joint,'isFlipped'):return None
    return bool(_external_cast('_ExternalFlippedJoint',joint).isFlipped)


def _external_component_joint_origin(component: "adsk.fusion.Component", name: str) -> "adsk.fusion.JointOrigin | None":
    value: object = component.jointOrigins.itemByName(name)
    return _external_cast("adsk.fusion.JointOrigin | None", value)


def _external_root_occurrence(ctx: "CadContext", ref: "str | JsonObject") -> "adsk.fusion.Occurrence":
    resolve = _external_cast(
        "Callable[[CadContext, str | JsonObject], adsk.fusion.Occurrence]", _assembly_root_occurrence)
    return resolve(ctx, ref)


def _external_assembly_paths(ctx: "CadContext", component: "adsk.fusion.Component") -> "list[str]":
    paths = _external_cast(
        "Callable[[CadContext, adsk.fusion.Component], list[str]]", _assembly_paths)
    return paths(ctx, component)


def _external_assembly_matrix(ctx: "CadContext", data: "JsonObject") -> "adsk.core.Matrix3D":
    matrix = _external_cast("Callable[[CadContext, JsonObject], adsk.core.Matrix3D]", _assembly_matrix)
    return matrix(ctx, data)


def _external_entity_matrix(values: "_ExternalIterable[int | float]") -> "list[int | float]":
    create = _external_cast("Callable[[_ExternalIterable[int | float]], list[int | float]]", _entity_matrix)
    return create(values)


def _external_entity_multiply(values_a: "list[int | float]", values_b: "list[int | float]") -> "list[int | float]":
    multiply = _external_cast(
        "Callable[[list[int | float], list[int | float]], list[int | float]]", _entity_multiply)
    return multiply(values_a, values_b)


def _external_entity_inverse(values: "list[int | float]") -> "list[int | float]":
    invert = _external_cast("Callable[[list[int | float]], list[int | float]]", _entity_inverse)
    return invert(values)


def _external_entity_occurrence_matrix(ctx: "CadContext", occurrence: "adsk.fusion.Occurrence") -> "list[int | float]":
    matrix = _external_cast(
        "Callable[[CadContext, adsk.fusion.Occurrence], list[int | float]]", _entity_occurrence_matrix)
    return matrix(ctx, occurrence)


def _external_pose_delta(matrix_a: "list[int | float]", matrix_b: "list[int | float]") -> "tuple[float, float]":
    compare = _external_cast(
        "Callable[[list[int | float], list[int | float]], tuple[float, float]]", _measure_pose_delta)
    return compare(matrix_a, matrix_b)


def _external_lifecycle_effects(result: JsonObject) -> "list[JsonObject]":
    return _external_cast('list[JsonObject]', result.get('lifecycleEffects', []))


def _external_pin_json(pin: "_ExternalPin | None") -> JsonValue:
    return _external_cast('JsonValue', pin)


def _external_pin_object(pin: "_ExternalPin") -> JsonObject:
    return _external_cast('JsonObject', pin)


def _external_compensation(runtime: "_ExternalRuntime") -> JsonObject:
    return _external_cast('JsonObject', runtime['compensation'])


def _external_is_list(value: object) -> bool:
    return isinstance(value, list)


def _external_is_dict(value: object) -> bool:
    return isinstance(value, dict)


def _external_dict(value: object) -> JsonObject | None:
    if not isinstance(value,dict):return None
    return _external_cast('JsonObject',value)


def _external_is_str(value: object) -> bool:
    return isinstance(value, str)


def _external_parameter_test(ctx: "CadContext", data: "JsonObject",
                             check_case: "Callable[..., object]",
                             check_restored: "Callable[..., object]") -> JsonObject:
    run = _external_cast(
        "Callable[[CadContext, JsonObject, Callable[..., object], Callable[..., object]], JsonObject]",
        _measure_parameter_test)
    return run(ctx, data, check_case, check_restored)


if TYPE_CHECKING:
    class _ExternalTolerance(_ExternalTypedDict):
        linear: float
        angular: float
        volume: float

    class _ExternalInventory(_ExternalTypedDict):
        bodies: int
        occurrences: int
        history: int

    class _ExternalSnapshot(_ExternalTypedDict):
        inventory: _ExternalInventory
        joints: list[JsonObject]
        history: list[JsonObject]
        bodies: list[tuple[tuple[str, int] | tuple[str, int, int], adsk.fusion.BRepBody, str,
                           list[tuple[str, str, str]]]]
        attributes: list[tuple[str, str, str]]
        occurrences: list['_ExternalSnapshotOccurrence']

    class _ExternalSnapshotOccurrence(_ExternalTypedDict):
        index: int
        componentToken: str
        token: str
        nativeToken: str | None
        path: str
        pose: list[int | float]
        attrs: list[tuple[str, str, str]]
        nativeAttrs: list[tuple[str, str, str]]
        componentAttrs: list[tuple[str, str, str]]

    class _ExternalFolderDestination(_ExternalTypedDict):
        projectId: str
        folderId: str

    class _ExternalDestinationSpec(_ExternalFolderDestination, total=False):
        name: str
        fileName: str

    class _ExternalDestinationDocument(_ExternalTypedDict):
        projectId: str
        folderId: str
        name: str

    class _ExternalComposeNewManifest(_ExternalTypedDict, total=False):
        mode: _ExternalRequired[str]
        destinationDocument: _ExternalRequired[_ExternalDestinationDocument]

    class _ExternalFileDestination(_ExternalTypedDict):
        projectId: str
        folderId: str
        fileName: str

    class _ExternalPinnedItemSpec(_ExternalTypedDict, total=False):
        projectId: _ExternalRequired[str]
        dataFileId: _ExternalRequired[str]
        version: _ExternalRequired[int]
        creationId: str
        context: str

    class _ExternalOccurrenceReference(_ExternalTypedDict, total=False):
        kind: str
        token: str
        path: str
        component: JsonObject
        itemId: str

    class _ExternalProbeItemReference(_ExternalTypedDict, total=False):
        itemId: _ExternalRequired[str]
        bodyIndex: _ExternalRequired[int]
        instanceIndex: int

    class _ExternalItemSpec(_ExternalTypedDict, total=False):
        itemId: _ExternalRequired[str]
        instancePolicy: _ExternalRequired[str]
        destination: _ExternalDestinationSpec
        destinationOccurrence: str
        sharedParentPolicy: str
        placement: JsonObject
        placementSpace: str
        projectId: str
        dataFileId: str
        version: int
        creationId: str
        context: str
        source: JsonObject
        selection: _ExternalOccurrenceReference
        definitionPolicy: str
        groupId: str
        endpoints: list[JsonObject]
        parameters: list[JsonObject]
        isFlipped: bool
        name: str
        id: str
        joint: JsonObject
        consumerAlias: str
        targetItemId: str
        xAxis: str
        zAxis: str
        unit: str
        sourceParameter: str
        nativeDerivedParameter: str
        existingExpression: str
        bodyMap: 'list[_ExternalMappingRow]'
        occurrenceMap: 'list[_ExternalMappingRow]'

    class _ExternalMappingRow(_ExternalTypedDict):
        sourceIndex: int
        targetIndex: int

    class _ExternalMappings(_ExternalTypedDict, total=False):
        bodyMap: list[_ExternalMappingRow]
        occurrenceMap: list[_ExternalMappingRow]

    class _ExternalReferenceGraph(_ExternalTypedDict):
        graphComplete: bool
        edges: 'list[_ExternalReferenceEdge]'
        documents: list[JsonObject]
        lifecycleEffects: list[JsonObject]

    class _ExternalValidatedInsertRequest(_ExternalTypedDict, total=False):
        source: _ExternalRequired['_ExternalInsertSource']
        confirm: _ExternalRequired[bool]
        destination: str | _ExternalDestinationSpec
        placement: JsonObject
        placementSpace: str
        name: str
        sharedParentPolicy: str

    class _ExternalDestinationPlan(_ExternalTypedDict, total=False):
        destination: str | JsonObject
        sharedParentPolicy: str
        placement: JsonObject
        placementSpace: str | None

    class _ExternalInsertPlan(_ExternalTypedDict):
        destination: str
        parentPaths: list[str]
        sourceByParent: dict[str, int]
        matrix: list[int | float]
        expectedWorld: dict[str, list[int | float]]

    class _ExternalInsertResult(_ExternalTypedDict, total=False):
        status: _ExternalRequired[str]
        partial: bool
        occurrences: list[JsonObject]
        observedCandidates: list[JsonObject]
        paths: list[str]
        fileId: str
        version: int
        worldPoses: list[list[int | float]]
        parentLocalMatrix: list[int | float]
        nativeInsertDelta: list[int | float]
        isReferencedComponent: bool
        lifecycleEffects: list[JsonObject]
        reconciledAfterException: bool
        reason: str
        noReplay: bool
        retainedOccurrence: _ExternalOccurrenceReference

    class _ExternalCompletedInsertResult(_ExternalTypedDict):
        status: str
        occurrences: list[_ExternalOccurrenceReference]

    class _ExternalInsertObservation(_ExternalTypedDict):
        status: str
        occurrences: list[adsk.fusion.Occurrence]

    class _ExternalComparisonCheck(_ExternalTypedDict, total=False):
        checkId: _ExternalRequired[str]
        passed: bool
        differences: list[JsonObject]

    class _ExternalReplacementIndex(_ExternalTypedDict):
        byParent: dict[str | None, list[tuple[adsk.fusion.Occurrence, list[int | float]]]]
        byToken: dict[str, adsk.fusion.Occurrence]

    class _ExternalReplacementObservation(_ExternalTypedDict, total=False):
        status: _ExternalRequired[str]
        occurrence: adsk.fusion.Occurrence | JsonObject
        pathMatched: bool
        candidates: list[JsonObject]

    class _ExternalReplacedObservation(_ExternalTypedDict):
        status: str
        occurrence: adsk.fusion.Occurrence
        pathMatched: bool

    class _ExternalOriginalRetainedObservation(_ExternalTypedDict):
        status: str
        occurrence: JsonObject

    class _ExternalInsertSource(_ExternalTypedDict):
        dataFileId: str
        version: JsonValue

    class _ExternalGroupSpec(_ExternalTypedDict, total=False):
        id: _ExternalRequired[str]
        members: _ExternalRequired[list[_ExternalOccurrenceReference]]

    class _ExternalProbeSource(_ExternalTypedDict, total=False):
        projectId: str
        fileId: str
        dataFileId: str
        itemId: str
        version: int
        creationId: str
        context: str

    class _ExternalProbeSourceCreation(_ExternalTypedDict):
        projectId: str
        fileId: str
        version: int
        creationId: str

    class _ExternalExactProbeSource(_ExternalTypedDict, total=False):
        projectId: _ExternalRequired[str]
        dataFileId: _ExternalRequired[str]
        version: _ExternalRequired[int]
        creationId: str
        context: str

    class _ExternalProbeSpec(_ExternalTypedDict, total=False):
        probeId: _ExternalRequired[str]
        itemId: _ExternalRequired[str]
        scope: str
        source: _ExternalRequired[_ExternalProbeSource]
        parameter: _ExternalRequired[str]
        expression: _ExternalRequired[str]
        minimum: _ExternalRequired[str]
        maximum: _ExternalRequired[str]
        checks: _ExternalRequired[list[JsonObject]]
        refresh: JsonObject

    class _ExternalProbeWithRefresh(_ExternalTypedDict, total=False):
        refresh: _ExternalRequired['_ExternalProbeRefresh']

    class _ExternalUiTarget(_ExternalTypedDict):
        fileId: str
        creationId: str
        name: str

    class _ExternalUiLease(_ExternalTypedDict):
        target: _ExternalUiTarget

    class _ExternalProbeRefreshPlanRequest(_ExternalTypedDict):
        root: JsonObject
        reportPath: str
        planId: str
        requestId: str
        policy: str
        lifecycle: str
        durability: str
        nativeFallback: str
        parameterBindings: list[JsonObject]

    class _ExternalProbeRefresh(_ExternalTypedDict, total=False):
        nativeFallback: str
        reportPath: _ExternalRequired[str]
        driverUiLeases: dict[str, _ExternalUiLease]
        restoreUiLeases: dict[str, _ExternalUiLease]

    class _ExternalProbeRefreshWithLeases(_ExternalTypedDict):
        reportPath: str
        nativeFallback: str
        driverUiLeases: dict[str, _ExternalUiLease]
        restoreUiLeases: dict[str, _ExternalUiLease]

    class _ExternalProbeRefreshValidation(_ExternalTypedDict):
        driverUiLeases: dict[str, _ExternalUiLease]
        restoreUiLeases: dict[str, _ExternalUiLease]

    class _ExternalBoundaryEndpoint(_ExternalTypedDict, total=False):
        itemId: str
        instanceIndex: int
        memberIndex: int
        relativePath: str
        occurrence: _ExternalOccurrenceReference
        originName: str
        rootDatum: str
        componentOrigin: bool

    class _ExternalRootDatumParameter(_ExternalTypedDict, total=False):
        name: _ExternalRequired[str]
        expression: _ExternalRequired[str]
        unit: _ExternalRequired[str]
        dependsOn: _ExternalRequired[list[str]]

    class _ExternalRootDatum(_ExternalTypedDict, total=False):
        name: _ExternalRequired[str]
        offsetX: _ExternalRequired[str]
        offsetY: _ExternalRequired[str]
        offsetZ: _ExternalRequired[str]
        angle: _ExternalRequired[str]
        isFlipped: _ExternalRequired[bool]
        xAxis: _ExternalRequired[str]
        zAxis: _ExternalRequired[str]
        parameters: _ExternalRequired[list[_ExternalRootDatumParameter]]

    class _ExternalBoundarySpec(_ExternalTypedDict, total=False):
        id: _ExternalRequired[str]
        joint: _ExternalRequired[_ExternalOccurrenceReference]
        endpoints: _ExternalRequired[list[_ExternalBoundaryEndpoint]]

    class _ExternalCapturedBoundaryEndpoint(_ExternalTypedDict, total=False):
        transform: list[int | float]
        componentAttributes: list[tuple[str, str, str]]
        componentName: str
        componentOrigin: bool

    class _ExternalGroupCombineInput(_ExternalTypedDict):
        memberIndex: int
        bodyAttrs: list[tuple[str, str, str]]
        material: str

    class _ExternalGroupCombine(_ExternalTypedDict):
        memberIndex: int
        featureIndex: int
        name: str
        operation: int
        keepTools: bool
        inputs: list[_ExternalGroupCombineInput]

    class _ExternalBoundaryState(_ExternalTypedDict, total=False):
        spec: _ExternalRequired[_ExternalBoundarySpec]
        old: _ExternalRequired[adsk.fusion.Joint | adsk.fusion.AsBuiltJoint]
        token: _ExternalRequired[str]
        kind: _ExternalRequired[int]
        form: _ExternalRequired[str]
        name: _ExternalRequired[str]
        attrs: _ExternalRequired[list[tuple[str, str, str]]]
        detached: _ExternalRequired[bool]
        new: adsk.fusion.Joint | adsk.fusion.AsBuiltJoint | None
        offset: str | None
        angle: str | None
        flipped: bool | None
        endpoints: _ExternalRequired[list[_ExternalCapturedBoundaryEndpoint]]
        rotationAxis: adsk.fusion.JointDirections
        rotationValue: float
        limits: '_ExternalJointLimits'
        positionSnapshot: JsonObject
        rebuildBeforePoses: dict[str, list[int | float]]
        rebuildStepId: str

    class _ExternalJointLimits(_ExternalTypedDict):
        minimumValue: float
        maximumValue: float
        restValue: float
        isMinimumValueEnabled: bool
        isMaximumValueEnabled: bool
        isRestValueEnabled: bool

    class _ExternalRebuildJointState(_ExternalTypedDict, total=False):
        spec: _ExternalRequired[_ExternalBoundarySpec]
        form: _ExternalRequired[str]
        endpoints: _ExternalRequired[list[_ExternalCapturedBoundaryEndpoint]]
        name: _ExternalRequired[str]
        attrs: _ExternalRequired[list[tuple[str, str, str]]]
        kind: _ExternalRequired[int]
        offset: _ExternalRequired[str | None]
        angle: _ExternalRequired[str | None]
        flipped: _ExternalRequired[bool | None]
        rotationAxis: adsk.fusion.JointDirections
        rotationValue: float
        limits: _ExternalJointLimits

    class _ExternalRevoluteBoundaryState(_ExternalTypedDict):
        rotationAxis: adsk.fusion.JointDirections
        rotationValue: float
        limits: _ExternalJointLimits

    class _ExternalSupportsInt(_ExternalProtocol):
        def __int__(self) -> int: ...

    class _ExternalCutPasteBody(_ExternalProtocol):
        @property
        def sourceBodies(self) -> adsk.core.ObjectCollection: ...

    class _ExternalHealthJoint(_ExternalProtocol):
        @property
        def healthState(self) -> int: ...

    class _ExternalJointParameter(_ExternalProtocol):
        @property
        def expression(self) -> str: ...

    class _ExternalJointMotionValues(_ExternalProtocol):
        @property
        def rotationValue(self) -> float: ...

        @property
        def rotationLimits(self) -> adsk.fusion.JointLimits: ...

        @property
        def slideValue(self) -> float: ...

        @property
        def slideLimits(self) -> adsk.fusion.JointLimits: ...

    class _ExternalStatusView(_ExternalProtocol):
        @property
        def isError(self) -> bool: ...

        @property
        def isWarning(self) -> bool: ...

        @property
        def isOK(self) -> bool: ...

    class _ExternalFlippedJoint(_ExternalProtocol):
        @property
        def isFlipped(self) -> bool: ...

    class _ExternalAsBuiltJointInputFactory(_ExternalProtocol):
        def createInput(self, occurrenceOne: adsk.fusion.Occurrence,
                        occurrenceTwo: adsk.fusion.Occurrence,
                        geometry: adsk.fusion.JointGeometry | None = None) -> adsk.fusion.AsBuiltJointInput: ...

    class _ExternalNamedBoundaryJoint(_ExternalProtocol):
        @property
        def isValid(self) -> bool: ...

        @property
        def name(self) -> str: ...

        @name.setter
        def name(self, value: str) -> None: ...

    class _ExternalNamedOccurrence(_ExternalProtocol):
        @property
        def name(self) -> str: ...

        @name.setter
        def name(self, value: str) -> None: ...

    class _ExternalInsertNameOccurrence(_ExternalProtocol):
        @property
        def name(self) -> str: ...

        @name.setter
        def name(self, value: str) -> None: ...

    class _ExternalParameterBinding(_ExternalTypedDict, total=False):
        source: _ExternalRequired[_ExternalProbeSource]
        sourceParameter: _ExternalRequired[str]
        consumerAlias: _ExternalRequired[str]
        nativeDerivedParameter: str
        unit: str
        existingExpression: str
        targetItemId: str

    class _ExternalBoundDriver(_ExternalTypedDict, total=False):
        edgeId: _ExternalRequired[str]
        sourceFileId: _ExternalRequired[str]
        sourceParameter: _ExternalRequired[str]
        nativeDerivedParameter: _ExternalRequired[str]
        consumerAlias: _ExternalRequired[str]
        ownerFileId: str

    class _ExternalParameterName(_ExternalTypedDict):
        name: str

    class _ExternalDriverBindingEdge(_ExternalTypedDict, total=False):
        edgeId: _ExternalRequired[str]
        kind: _ExternalRequired[str]
        sourceFileId: _ExternalRequired[str]
        ownerFileId: str
        edgeIdentityUnique: bool
        sourceParameters: list[_ExternalParameterName]
        derivedParameters: list[_ExternalParameterName]

    class _ExternalRefreshPlanEdge(_ExternalTypedDict, total=False):
        edgeId: _ExternalRequired[str]
        kind: str
        sourceFileId: _ExternalRequired[str]
        targetVersion: _ExternalRequired[int]
        baselineVersion: int

    class _ExternalReferenceEdge(_ExternalTypedDict, total=False):
        edgeId: _ExternalRequired[str]
        sourceFileId: _ExternalRequired[str]
        kind: str
        ownerFileId: str
        baselineVersion: _ExternalRequired[int]
        latestVersion: int
        versionSource: str

    class _ExternalItemBindingPublication(_ExternalTypedDict, total=False):
        ctx: _ExternalRequired[CadContext]
        itemId: _ExternalRequired[str]
        fileId: _ExternalRequired[str]
        beforeVersion: _ExternalRequired[int]
        submitted: _ExternalRequired[bool]

    class _ExternalRequiredItemBindingPublication(_ExternalTypedDict):
        ctx: CadContext
        itemId: str
        fileId: str
        beforeVersion: int
        submitted: bool

    class _ExternalManifest(_ExternalTypedDict, total=False):
        mode: _ExternalRequired[str]
        source: _ExternalRequired[_ExternalPin]
        destinationDocument: _ExternalDestinationDocument
        items: _ExternalRequired[list[_ExternalItemSpec]]
        extractionGroups: list[_ExternalGroupSpec]
        expectedInventory: _ExternalRequired[dict[str, _ExternalInventory]]
        linearTolerance: _ExternalRequired[str]
        angularTolerance: _ExternalRequired[str]
        volumeTolerance: _ExternalRequired[str]
        probes: list[_ExternalProbeSpec]
        parameterBindings: list[_ExternalParameterBinding]
        callerNamespaces: list[JsonObject]
        rootDatums: list[_ExternalRootDatum]
        boundaries: list[_ExternalBoundarySpec]
        save: bool

    class _ExternalOperationData(_ExternalTypedDict, total=False):
        manifest: _ExternalRequired[_ExternalManifest]
        phase: _ExternalRequired[str]
        operationId: _ExternalRequired[str]
        stepId: str
        source: JsonObject
        itemId: str
        requestHash: _ExternalRequired[str]
        sessionNonce: _ExternalRequired[str]
        result: _ExternalRequired['_ExternalExecutionResult']
        name: str
        remainingMs: _ExternalRequired[float]
        outerReadOnly: bool
        copyIntent: _ExternalCopyIntent
        copyRpcBudgetMs: float
        _copyStepStartedAt: float

    class _ExternalStepData(_ExternalTypedDict, total=False):
        manifest: _ExternalRequired[_ExternalManifest]
        phase: _ExternalRequired[str]
        operationId: _ExternalRequired[str]
        stepId: _ExternalRequired[str]
        itemId: _ExternalRequired[str]
        requestHash: _ExternalRequired[str]
        sessionNonce: _ExternalRequired[str]
        result: _ExternalRequired['_ExternalExecutionResult']
        remainingMs: _ExternalRequired[float]
        source: JsonObject
        name: str
        outerReadOnly: bool
        copyIntent: _ExternalCopyIntent
        copyRpcBudgetMs: float
        _copyStepStartedAt: float

    class _ExternalProbeStepData(_ExternalTypedDict, total=False):
        manifest: _ExternalRequired[_ExternalManifest]
        phase: _ExternalRequired[str]
        itemId: _ExternalRequired[str]
        result: '_ExternalExecutionResult'

    class _ExternalInstanceMap(_ExternalTypedDict, total=False):
        source: JsonObject | None
        token: _ExternalRequired[str | None]
        definition: _ExternalRequired[str | None]
        path: _ExternalRequired[str]
        worldPose: _ExternalRequired[list[int | float]]
        parentToken: str | None
        parentWorldPose: list[float]
        callerNamespaceSpecs: list[JsonObject]
        callerNamespaces: list[JsonObject]
        fileId: str | None
        version: int | None
        grounded: _ExternalRequired[bool]
        groundToParent: _ExternalRequired[bool]
        attributes: _ExternalRequired[list[tuple[str, str, str]]]
        nativeAttributes: _ExternalRequired[list[tuple[str, str, str]]]

    class _ExternalItemState(_ExternalTypedDict, total=False):
        spec: _ExternalRequired[_ExternalItemSpec]
        component: _ExternalRequired[adsk.fusion.Component | None]
        originals: _ExternalRequired[list[adsk.fusion.Occurrence]]
        baseline: _ExternalRequired[_ExternalSnapshot | None]
        definitionOwner: _ExternalRequired[str]
        targetPin: _ExternalRequired[_ExternalPin | None]
        future: _ExternalRequired[adsk.core.DataFileFuture | None]
        futureObserver: '_ExternalCopyJob | None'
        groupParentFuture: adsk.core.DataFileFuture | None
        groupParentFutureObserver: '_ExternalCopyJob | None'
        staged: _ExternalRequired[list[adsk.fusion.Occurrence]]
        stagedRefs: list[_ExternalOccurrenceReference]
        instanceMap: _ExternalRequired[list[_ExternalInstanceMap]]
        retireMap: list[_ExternalInstanceMap]
        groupCombineInputs: list[_ExternalGroupCombine]
        groupChildDoc: adsk.core.Document | None
        targetDoc: adsk.core.Document | None
        retiredCount: int
        groupParentPin: _ExternalPin | None
        groupDoc: adsk.core.Document | None
        groupDependencyCoverage: JsonObject
        groupOccurrence: adsk.fusion.Occurrence | None
        groupMoved: list[adsk.fusion.Occurrence]
        groupSaveBaseline: int
        groupChildSaveBaseline: int
        target: CadContext | None
        probeReferenceResolutions: list[JsonObject]
        replacedByIndex: dict[int, adsk.fusion.Occurrence]
        retiredIndices: set[int]

    class _ExternalProbeState(_ExternalTypedDict, total=False):
        stage: _ExternalRequired[str]
        probeId: _ExternalRequired[str]
        source: _ExternalRequired[_ExternalPin]
        changed: bool
        restoring: bool
        localResult: _ExternalRequired[JsonObject | None]
        localProbeDeferred: bool
        sourceBaseline: int
        targetBaseline: int
        baselineSaveSubmitted: bool
        targetPin: _ExternalRequired[_ExternalPin | None]
        baselineEdges: list[_ExternalReferenceEdge]
        refreshBindings: list[JsonObject]
        refreshRequest: JsonObject
        publishedVersion: _ExternalRequired[int | None]
        appliedVersions: dict[str, int]
        consumerAppliedVersion: int
        originalExpressions: _ExternalRequired[dict[str, str]]
        restorationReserveMsPlanned: _ExternalRequired[float]
        restorationReserveMsUsed: _ExternalRequired[float]
        restorationStartedAt: float
        receipt: JsonObject
        status: str
        verify: JsonObject

    class _ExternalProbeLocalResult(_ExternalTypedDict, total=False):
        status: str
        restored: bool
        restoredGeometryChecks: list[JsonObject]

    class _ExternalCopyJob(_ExternalTypedDict, total=False):
        intent: _ExternalRequired[_ExternalCopyIntent]
        events: _ExternalRequired[list[_ExternalCopyEvent]]
        handlers: _ExternalRequired[list[tuple[adsk.core.DataEvent, adsk.core.DataEventHandler]]]
        diagnostics: _ExternalRequired[list[str]]
        disarmed: _ExternalRequired[bool]
        submitted: _ExternalRequired[bool]
        observationFailed: bool
        filePin: _ExternalPin

    class _ExternalFutureEntry(_ExternalTypedDict, total=False):
        future: adsk.core.DataFileFuture | None
        futureObserver: _ExternalCopyJob | None
        targetPin: _ExternalPin | None

    class _ExternalCopyObservation(_ExternalTypedDict, total=False):
        status: _ExternalRequired[str]
        reason: str
        fileId: str
        version: int
        events: list[JsonObject]

    class _ExternalCorrelatedCopyObservation(_ExternalTypedDict):
        status: str
        fileId: str
        version: int
        events: list[JsonObject]

    class _ExternalUploadStateValues(_ExternalProtocol):
        UploadProcessing: int
        UploadFinished: int
        UploadFailed: int

    class _ExternalCopyStatus(_ExternalTypedDict, total=False):
        status: JsonObject
        statusReadContext: str
        statusReadError: str
        statusReadErrorAt: str

    class _ExternalCopyComponentToken(_ExternalTypedDict):
        token: str

    class _ExternalPhaseState(_ExternalTypedDict, total=False):
        status: _ExternalRequired[str]
        receipt: '_ExternalReceipt | None'
        terminal: bool
        result: '_ExternalPhaseState'
        phaseResults: '_ExternalPhaseResults'
        cursor: int
        stepId: str
        phase: str
        itemId: str

    class _ExternalPhaseResults(_ExternalTypedDict, total=False):
        copy: _ExternalRequired[_ExternalPhaseState]
        verify: _ExternalRequired['_ExternalVerifyState']
        stage: _ExternalRequired[_ExternalPhaseState]
        retire: _ExternalRequired[_ExternalPhaseState]
        finalize: _ExternalRequired[_ExternalPhaseState]

    class _ExternalVerifyState(_ExternalTypedDict, total=False):
        sources: _ExternalRequired[_ExternalPhaseState]
        assembly: _ExternalRequired[_ExternalPhaseState]

    class _ExternalItemResult(_ExternalTypedDict):
        itemId: str
        uploadStatus: str
        rawUploadState: JsonValue
        phaseResults: _ExternalPhaseResults

    class _ExternalPending(_ExternalTypedDict):
        stepId: str
        phase: str
        itemId: str
        refreshRequest: _ExternalNotRequired[JsonObject]
        copyIntent: _ExternalNotRequired[JsonObject]

    class _ExternalInspectionPending(_ExternalTypedDict, total=False):
        stepId: str | None
        phase: str | None
        itemId: str | None
        refreshRequest: JsonObject
        copyIntent: JsonObject

    class _ExternalPendingWrapper(_ExternalTypedDict):
        _externalPending: JsonObject

    class _ExternalExecutionResult(_ExternalTypedDict, total=False):
        byItem: _ExternalRequired[dict[str, _ExternalItemResult]]
        pending: _ExternalRequired[_ExternalPending | None]

    class _ExternalCompletedRefresh(_ExternalTypedDict, total=False):
        fileId: _ExternalRequired[str]
        coldVerified: _ExternalRequired[bool]
        resultingVersion: _ExternalRequired[int]

    class _ExternalRefreshReceipt(_ExternalTypedDict, total=False):
        success: bool
        allIntendedReferencesCurrent: bool
        completed: list[_ExternalCompletedRefresh]
        invocationStatus: str
        planId: str

    class _ExternalSuccessfulRefreshReceipt(_ExternalTypedDict):
        success: bool
        allIntendedReferencesCurrent: bool
        completed: list[_ExternalCompletedRefresh]

    class _ExternalReceipt(_ExternalTypedDict, total=False):
        cursor: int
        creationId: str
        sourcePin: _ExternalPin
        checks: list[JsonObject]
        completed: list[JsonObject]
        refreshReceipt: _ExternalRefreshReceipt
        receipt: JsonObject
        terminal: bool
        error: str
        producerCloseObserved: bool
        publishedSource: _ExternalPin
        notStarted: bool
        preflightPending: bool
        saveAccepted: bool
        reconciledAfterException: bool
        savedTargetFingerprint: str
        copyCompletion: JsonObject
        isolatedParentCopyAccepted: bool
        groupCopyAccepted: bool
        observationError: str
        errorSite: list[JsonObject]

    class _ExternalInspectionSaveReceipt(_ExternalTypedDict, total=False):
        cursor: int
        file: _ExternalPin
        cloudComplete: bool
        targetTimeline: int
        retainedChildHistory: int
        sourceUnchanged: bool
        savedDocument: JsonObject
        reconciledAfterException: bool
        savedTargetFingerprint: str
        checks: list[JsonObject]

    class _ExternalAcceptedSaveAsObservation(_ExternalTypedDict):
        itemId: str
        cursor: int
        creationId: str

    class _ExternalSaveAsReceipt(_ExternalTypedDict):
        cursor: int
        creationId: str

    class _ExternalRegistryEntry(_ExternalTypedDict, total=False):
        requestHash: _ExternalRequired[str]
        sessionNonce: _ExternalRequired[str]

    class _ExternalRuntime(_ExternalRegistryEntry, total=False):
        processId: _ExternalRequired[int]
        source: _ExternalRequired[CadContext]
        sourceFingerprint: _ExternalRequired[str]
        target: _ExternalRequired[CadContext | None]
        targetFingerprint: _ExternalNotRequired[str]
        targetCreationId: _ExternalNotRequired[str]
        items: _ExternalRequired[dict[str, _ExternalItemState]]
        effects: _ExternalRequired[dict[str, JsonObject]]
        tolerance: _ExternalRequired[_ExternalTolerance]
        initialLifecycleEffects: list[JsonObject]
        compensation: _ExternalRequired[JsonObject | None]
        probes: dict[str, _ExternalProbeState]
        probeHandles: dict[str, CadContext]
        boundaries: list[_ExternalBoundaryState]
        boundariesCreated: int
        bindingsCreated: int
        saveBaseline: int
        saveAttempted: bool
        saveFileId: str
        saveProjectId: str
        saveCreationId: str
        saveContentFingerprint: str
        itemBindingPublication: _ExternalItemBindingPublication | None
        acceptedSaveAsObservation: _ExternalAcceptedSaveAsObservation
        deriveSources: dict[tuple[str, str, int], adsk.fusion.DeriveFeature]
        _externalPending: JsonObject
        bindingProgress: set[str]
        derivedBindings: list[JsonObject]
        referenceHelpers: list[JsonObject]
        completedProbes: set[str]

    class _ExternalSavedRuntime(_ExternalTypedDict, total=False):
        source: _ExternalRequired[CadContext]
        saveAttempted: _ExternalRequired[bool]
        saveFileId: _ExternalRequired[str]
        saveProjectId: _ExternalRequired[str]
        saveCreationId: _ExternalRequired[str]
        saveBaseline: _ExternalRequired[int]
        saveContentFingerprint: _ExternalRequired[str]

    class _ExternalPreflightEntry(_ExternalRegistryEntry, total=False):
        preflightPending: _ExternalRequired[bool]
        processId: int
        sourcePin: _ExternalPin


def _external_phase_receipt(state: "_ExternalPhaseState") -> "_ExternalReceipt":
    return state.get('receipt') or {}


def _external_observed_probe_receipt(data: object, item_id: str, phase: str) -> "_ExternalReceipt":
    probe_data = _external_cast('_ExternalProbeStepData', data)
    result = probe_data.get('result')
    if result is None:
        return {}
    item = result['byItem'].get(item_id)
    if item is None:
        return {}
    phase_results = item['phaseResults']
    verify = phase_results['verify']
    state = _external_cast('dict[str, _ExternalPhaseState]',verify).get(phase)
    return _external_phase_receipt(state) if state is not None else {}


def _external_result_receipt(result: JsonObject) -> "_ExternalReceipt":
    return _external_cast('_ExternalReceipt', result.get('receipt') or {})


def _external_probe_restoring(state: "_ExternalProbeState") -> bool:
    if 'restoring' not in state:
        raise KeyError('restoring')
    return _external_cast('bool',state.get('restoring'))


def _external_boundary_states(runtime: "_ExternalRuntime") -> "list[_ExternalBoundaryState]":
    return runtime.get('boundaries', [])


class _ExternalTimelineRestoreError(RuntimeError):
    pass


def _external_folder(app: "adsk.core.Application", destination: "_ExternalFolderDestination") -> "adsk.core.DataFolder":
    projects = _external_cast('_CadItemCollection[adsk.core.DataProject]', app.data.dataProjects)
    project = _cad_unique([p for p in _external_items(projects)
                           if p.id == destination['projectId']], 'destination project')
    pending: list[adsk.core.DataFolder] = [project.rootFolder]
    found: list[adsk.core.DataFolder] = []
    seen: set[str] = set()
    while pending:
        folder = pending.pop()
        if folder.id in seen: continue
        seen.add(folder.id)
        if folder.id == destination['folderId']: found.append(folder)
        children = _external_cast('_CadItemCollection[adsk.core.DataFolder]', folder.dataFolders)
        pending.extend(_external_items(children))
    return _cad_unique(found, 'exact destination folder')


def _external_collision(folder: "adsk.core.DataFolder", name: "str") -> "None":
    _external_require(not any(f.name == name for f in _external_items(folder.dataFiles)),
                      'Declared new filename already exists; no overwrite/name-only reuse')


def _external_refresh_complete(file: "adsk.core.DataFile") -> "bool":
    if file.isComplete is True:return True
    _external_refresh_file(file)
    return False


def _external_document(app: "adsk.core.Application", pin: "_ExternalPin", allow_open: "bool"=False, readonly: "bool"=False, editable: "bool"=False) -> "tuple[adsk.core.Document | None, JsonObject]":
    documents=_external_items(_external_cast('_CadItemCollection[adsk.core.Document]',app.documents))
    candidates: list[tuple[adsk.core.Document,bool]]=[]
    for doc in documents:
        file = _external_document_data_file(doc)
        if file is None or file.id != pin['fileId'] or file.parentProject.id != pin['projectId']: continue
        if file.versionNumber != pin['version']: continue
        creation_id=pin.get('creationId')
        if creation_id and doc.creationId!=creation_id:continue
        top: bool | None = None
        try: doc.allDocumentReferences.count; top = True
        except RuntimeError as error:
            if 'non-top-level document' in str(error): top = False
            else: raise
        candidates.append((doc, top))
    if pin.get('context')=='topLevel':
        candidates = [(d,t) for d,t in candidates if t is True]
    if len(candidates) > 1:
        return None, {'status':'ambiguous','candidates':[_external_document_identity(d) for d,t in candidates]}
    if candidates:
        doc = candidates[0][0]
        if editable and doc.dataFile.isReadOnly:
            return None, {'status':'blocked','reason':'editableOwnerUnavailable'}
        if not editable or candidates[0][1]:
            return doc, {'status':'resolved','identity':_external_document_identity(doc),'lifecycleEffects':[]}
    if not allow_open or readonly:
        return None, {'status':'unavailable','reason':'exactPinnedDocumentNotLoaded','lifecycleEffects':[]}
    file = _external_project_file(app, pin['projectId'], pin['fileId'], pin['version'])
    if not _external_refresh_complete(file):
        return None, {'status':'pendingPublication','reason':'pinnedSourceIncomplete','lifecycleEffects':[]}
    if editable and file.isReadOnly:
        return None, {'status':'blocked','reason':'editableOwnerUnavailable','lifecycleEffects':[]}
    doc = _cad_require_result(app.documents.open(file, True), 'Open exact owned pinned source')
    actual = _external_document_identity(doc)
    _external_require(actual['fileId'] == pin['fileId'] and actual['version'] == pin['version'] and
                      actual['projectId'] == pin['projectId'], 'Opened document differs from exact pin')
    lifecycle: list[JsonObject]=[{'action':'opened','docid':doc.creationId,'openedByOperation':True,'identity':actual}]
    try:doc.allDocumentReferences.count;top_level=True
    except RuntimeError as error:
        if 'non-top-level document' in str(error):top_level=False
        else:raise
    if (editable or pin.get('context')=='topLevel') and not top_level:
        return None, {'status':'blocked','reason':'openedPinnedDocumentIsNotTopLevel','identity':actual,
                      'lifecycleEffects':lifecycle}
    if editable and doc.dataFile.isReadOnly:
        return None, {'status':'blocked','reason':'editableOwnerUnavailable','identity':actual,
                      'lifecycleEffects':lifecycle}
    return doc, {'status':'resolved','identity':actual,'lifecycleEffects':lifecycle}


def _external_ctx(doc: "adsk.core.Document") -> "CadContext":
    project_file_check=_external_document_data_file(doc)
    project_id=(_external_cast('adsk.core.DataFile',_external_document_data_file(doc)).parentProject.id
                if project_file_check else None)
    document_file_check=_external_document_data_file(doc)
    document_file_id=(_external_cast('adsk.core.DataFile',_external_document_data_file(doc)).id
                      if document_file_check else None)
    return CadContext(doc.name,
        project_id=project_id,
        doc_id=doc.creationId,
        doc_file_id=document_file_id,
        resolved_doc=doc)


def _external_owned_document(runtime: "_ExternalRuntime",pin: "_ExternalPin") -> "tuple[adsk.core.Document | None, JsonObject]":
    # Reuse an actual handle already qualified and captured by this operation,
    # not a fresh guess between an editor and same-file reference buffers.
    pool: list[adsk.core.Document | None]=[
        entry.get('targetDoc') for entry in runtime['items'].values()]
    pool.extend([runtime['source'].doc, runtime['target'].doc if runtime['target'] else None])
    found: list[adsk.core.Document]=[]
    for doc in pool:
        if doc is None or not doc.isValid or doc in found:continue
        file=_external_document_data_file(doc)
        if file is None or file.id!=pin['fileId'] or file.parentProject.id!=pin['projectId'] or file.versionNumber!=pin['version']:continue
        creation_id=pin.get('creationId')
        if creation_id and doc.creationId!=creation_id:continue
        doc.allDocumentReferences.count
        found.append(doc)
    if len(found)==1:return found[0],{'status':'resolved','identity':_external_document_identity(found[0]),'lifecycleEffects':[]}
    if len(found)>1:return None,{'status':'ambiguous','candidates':[_external_document_identity(d) for d in found],'lifecycleEffects':[]}
    return _external_document(runtime['source'].app,pin,allow_open=True,editable=False)


def _external_pin(file: "adsk.core.DataFile", creation: "str | None"=None) -> "_ExternalPin":
    return _external_cast('_ExternalPin',{
        'fileId':file.id,'projectId':file.parentProject.id,'version':int(file.versionNumber),
        **({'creationId':creation} if creation else {})})


def _external_occurrence(ctx: "CadContext", ref: "_ExternalOccurrenceReference") -> "adsk.fusion.Occurrence":
    try:
        entity = ctx.resolve(ref, 'occurrence')
    except Exception:
        # Fusion can return a fresh exact token that findEntityByToken does not
        # resolve in a later RPC. Reconcile only inside the pinned root context.
        token = ref.get('token')
        _external_require(isinstance(token, str) and token,
                          'Unresolved occurrence has no exact native token')
        component_ref = ref.get('component')
        component_token = component_ref.get('token') if component_ref is not None else None
        path = ref.get('path')
        candidates = [o for o in _external_items(ctx.root.allOccurrences)
                      if (str(o.entityToken) == token or
                          (path and component_token and o.fullPathName == path and
                           str(o.component.entityToken) == component_token)) and
                      (not path or o.fullPathName == path) and
                      (not component_token or str(o.component.entityToken) == component_token)]
        entity = _cad_unique(candidates, 'Exact root-context occurrence token/path')
    native = getattr(entity, 'nativeObject', None) or entity
    matches = [o for o in _external_items(ctx.root.allOccurrences)
               if (getattr(o, 'nativeObject', None) or o) == native]
    path = ref.get('path')
    if path: matches = [o for o in matches if o.fullPathName == path]
    elif getattr(entity, 'assemblyContext', None) is not None:
        matches = [o for o in matches if o.fullPathName == entity.fullPathName]
    return _cad_unique(matches, 'root-context externalization occurrence')


def _external_joint(ctx: "CadContext", ref: "_ExternalOccurrenceReference") -> "adsk.fusion.Joint | adsk.fusion.AsBuiltJoint":
    try:
        return _external_cast('adsk.fusion.Joint | adsk.fusion.AsBuiltJoint',ctx.resolve(ref))
    except Exception:
        token = ref.get('token')
        _external_require(isinstance(token, str) and token,
                          'Unresolved boundary joint has no exact native token')
        candidates = [joint for component in _external_own_components(ctx.root)
                      for collection in (component.joints, component.asBuiltJoints)
                      for joint in _external_items(collection)
                      if str(joint.entityToken) == token]
        return _cad_unique(candidates, 'Exact native boundary-joint token')


def _external_disjoint_instances(instances: "list[adsk.fusion.Occurrence]", authorized_paths: "list[str]") -> "list[adsk.fusion.Occurrence]":
    result: list[adsk.fusion.Occurrence]=[]
    seen: set[str]=set()
    for occurrence in instances:
        path=occurrence.fullPathName
        if path in seen:continue
        _external_require(not any(path==prior or path.startswith(prior+'+') or prior.startswith(path+'+')
                                  for prior in authorized_paths),
                          'Expanded instancePolicy overlaps another authorized extraction scope')
        seen.add(path);authorized_paths.append(path);result.append(occurrence)
    return result


def _external_destination(ctx: "CadContext", data: "_ExternalDestinationPlan") -> "tuple[adsk.fusion.Component, adsk.fusion.Occurrence | None, adsk.core.Matrix3D | list[int | float], list[str]]":
    target = data.get('destination', 'root')
    parent_occ = None if target == 'root' else _external_root_occurrence(ctx, target)
    parent = ctx.root if parent_occ is None else parent_occ.component
    paths = [''] if parent_occ is None else _external_assembly_paths(ctx, parent)
    _external_require(len(paths) == 1 or data.get('sharedParentPolicy', 'reject') == 'allInstances',
                      'Repeated destination requires sharedParentPolicy:allInstances')
    _external_require('placementSpace' not in data or 'placement' in data, 'placementSpace without placement')
    if parent_occ is not None and 'placement' in data:
        _external_require(data.get('placementSpace') in ('root','parent'), 'Nested placement needs placementSpace')
    matrix = _external_assembly_matrix(ctx, data.get('placement', {}))
    if parent_occ is not None and data.get('placementSpace') == 'root':
        matrix = _external_entity_matrix(_external_entity_multiply(_external_entity_inverse(_external_entity_occurrence_matrix(ctx, parent_occ)), matrix.asArray()))
    return parent, parent_occ, matrix, paths


def _external_insert_reconcile(ctx: "CadContext",file: "adsk.core.DataFile",parent_paths: "list[str]",before_tokens: "set[str]") -> "_ExternalInsertObservation":
    occurrences=_external_items(_external_cast(
        '_CadItemCollection[adsk.fusion.Occurrence]',ctx.root.allOccurrences))
    matched: list[adsk.fusion.Occurrence]=[]
    candidates: list[adsk.fusion.Occurrence]=[]
    for parent_path in parent_paths:
        rows: list[adsk.fusion.Occurrence]=[]
        for occurrence in occurrences:
            if occurrence.entityToken in before_tokens or not occurrence.isReferencedComponent:continue
            parent=occurrence.fullPathName.rsplit('+',1)[0] if '+' in occurrence.fullPathName else ''
            if parent!=parent_path:continue
            ref=occurrence.documentReference
            if ref.dataFile.id==file.id and ref.dataFile.versionNumber==file.versionNumber:rows.append(occurrence)
        candidates.extend(rows)
        if len(rows)!=1:return {'status':'unresolved','occurrences':candidates}
        matched.append(rows[0])
    return {'status':'matched','occurrences':matched}


def _external_insert_delta(ctx: "CadContext",parent_paths: "list[str]",local: "adsk.core.Matrix3D") -> "adsk.core.Matrix3D":
    if parent_paths==['']:return local
    parent=_external_destination_parent(ctx,parent_paths[0])
    if parent is None:raise ValueError('Exact destination parent context is unavailable')
    world=list(_external_entity_occurrence_matrix(ctx,parent))
    # addByInsert applies a root-space delta to the parent's placement, unlike
    # addNewComponent's parent-space initial transform. Keep the public plan in
    # parent space and convert only at this native call boundary.
    values=_external_entity_multiply(_external_entity_multiply(world,list(local.asArray())),_external_entity_inverse(world))
    result=adsk.core.Matrix3D.create()
    _external_require(result.setWithArray(values),'Native insertion delta matrix rejected')
    return result


def _external_insert(ctx: "CadContext", data: "JsonObject", project_id: "str | None"=None, native_matrix: "list[int | float] | None"=None) -> "JsonValue":
    _cad_fields(data, ('source','confirm'), ('destination','placement','placementSpace','name','sharedParentPolicy'))
    ctx.require_confirm(data)
    request = _external_cast('_ExternalValidatedInsertRequest', data)
    source = request['source']
    _cad_fields(source, ('dataFileId','version'))
    version_value = source['version']
    _external_require(type(version_value) is int and version_value > 0, 'source.version must be a positive exact version')
    version = _external_cast('int', version_value)
    source_file = _external_document_data_file(ctx.doc)
    source_project = source_file.parentProject if source_file is not None else None
    project_id = project_id or (source_project.id if source_project is not None else None)
    _external_require(project_id, 'Saved destination or explicit compose destination project required')
    project_id = _external_cast('str', project_id)
    insert_source=source
    file = _external_project_file(ctx.app, project_id, insert_source['dataFileId'], version)
    _external_require(file.isComplete, 'Source is not cloud complete')
    _external_require(source_file is None or file.id != source_file.id, 'External reference cycle')
    parent, parent_occ, matrix, parent_paths = _external_destination(
        ctx, _external_cast('_ExternalDestinationPlan', request))
    if native_matrix is not None or isinstance(matrix,(list,tuple)):
        values=native_matrix if native_matrix is not None else _external_cast('list[int | float]',matrix)
        matrix=adsk.core.Matrix3D.create()
        _cad_require_result(matrix.setWithArray(values),'Set exact external insertion transform')
    _assembly_capture_ready(ctx)
    # Native authoritative forward graph, not childReferences, proves no cycle.
    graph = _external_collect_graph({'root':_external_pin_object(_external_pin(file)),
        'policy':'preserve','lifecycle':'openOwned','allowedProjectIds':[project_id]})
    _external_require(graph['graphComplete'], 'Source graph unavailable; cannot prove insertion cycle safety')
    _external_require(all(e.get('scopeProjectAllowed') is True for e in graph.get('edges',[])),
                      'Source graph has out-of-project edges; insertion cycle coverage is incomplete')
    if source_file is not None:
        _external_require(all(d['fileId'] != source_file.id for d in graph['documents']), 'External reference cycle')
    activation_effects=_external_activate(ctx)
    before_occurrences=_external_items(_external_cast(
        '_CadItemCollection[adsk.fusion.Occurrence]',ctx.root.allOccurrences))
    before_tokens: set[str]={o.entityToken for o in before_occurrences}
    local_matrix=list(matrix.asArray())
    matrix=_external_insert_delta(ctx,parent_paths,matrix)
    reconciled=False
    try:
        occurrence = _cad_require_result(
            parent.occurrences.addByInsert(file,matrix,True), 'Native external insertion')
    except Exception as error:
        observation=_external_insert_reconcile(ctx,file,parent_paths,before_tokens)
        if observation['status']!='matched':
            return {'status':'unknown','partial':bool(observation['occurrences']),'noReplay':True,
                    'reason':'Native insertion raised and exact new target contexts could not be uniquely reconciled: '+
                            type(error).__name__+': '+str(error),
                    'observedCandidates':[ctx.ref(o) for o in observation['occurrences']],
                    'lifecycleEffects':[*(_external_graph_lifecycle_effects(graph)),*activation_effects]}
        occurrence=observation['occurrences'][0];reconciled=True
    try:
        ref = occurrence.documentReference
        if ref.dataFile.versionNumber != version:
            ref.version = version
        _external_require(ref.dataFile.id == file.id and ref.dataFile.versionNumber == version and occurrence.isReferencedComponent,
                          'Inserted native reference differs from requested exact pin')
        occurrence_name=request.get('name')
        if occurrence_name:
            _external_cast('_ExternalInsertNameOccurrence',occurrence).name=occurrence_name
        native = _external_cast('adsk.core.Base',getattr(occurrence,'nativeObject',None) or occurrence)
        all_occurrences=_external_items(_external_cast(
            '_CadItemCollection[adsk.fusion.Occurrence]',ctx.root.allOccurrences))
        actual: list[adsk.fusion.Occurrence]=[
            o for o in all_occurrences if (getattr(o,'nativeObject',None) or o) == native]
        _external_require(len(actual)==len(parent_paths), 'Inserted occurrence context coverage mismatch')
        return {'status':'complete','occurrences':[ctx.ref(o) for o in actual],
                'paths':[o.fullPathName for o in actual], 'fileId':file.id,'version':version,
                 'worldPoses':[list(_external_entity_occurrence_matrix(ctx,o)) for o in actual],
                 'parentLocalMatrix':local_matrix,'nativeInsertDelta':list(matrix.asArray()),
                'isReferencedComponent':True,'lifecycleEffects':[*(_external_graph_lifecycle_effects(graph)),*activation_effects],
                'reconciledAfterException':reconciled}
    except Exception as error:
        return {'status':'failed','retainedOccurrence':ctx.ref(occurrence),'partial':True,
                'reason':str(error),'noReplay':True,
                'lifecycleEffects':[*(_external_graph_lifecycle_effects(graph)),*activation_effects]}


def _external_attributes(entity: "_ExternalAttributed") -> "list[tuple[str, str, str]]":
    return sorted((a.groupName,a.name,a.value) for a in _external_items(entity.attributes))


def _external_parent_namespace_values(ctx: "CadContext",parent_occurrence: "adsk.fusion.Occurrence | None",declarations: "list[JsonObject]") -> "list[JsonObject]":
    if not declarations:return []
    owner=parent_occurrence if parent_occurrence is not None else ctx.root
    attributes: dict[tuple[str,str],str]={(group,name):value for group,name,value in _external_attributes(owner)}
    result: list[JsonObject]=[]
    for declaration in declarations:
        values: list[tuple[str,str]]=[]
        group=_external_cast('str',declaration['group'])
        keys=_external_cast('list[str]',declaration['keys'])
        for name in keys:
            key=(group,name)
            _external_require(key in attributes,'Caller identity attribute is missing from the exact parent context')
            values.append((name,attributes[key]))
        result.append({'group':declaration['group'],'values':values})
    return result


def _external_parent_context_match(source_ctx: "CadContext",target_ctx: "CadContext",target_parent: "adsk.fusion.Occurrence | None",source_instance: "_ExternalInstanceMap") -> "bool":
    target_token=target_parent.entityToken if target_parent is not None else None
    same_document=(source_ctx.doc.creationId==target_ctx.doc.creationId and
                   source_ctx.doc.dataFile.id==target_ctx.doc.dataFile.id)
    if same_document and source_instance.get('parentToken')==target_token:return True
    declarations=source_instance.get('callerNamespaceSpecs',[])
    if not declarations:return False
    try:
        return _external_parent_namespace_values(target_ctx,target_parent,declarations)==source_instance.get('callerNamespaces')
    except Exception:
        return False


def _external_destination_parent(ctx: "CadContext",path: "str") -> "adsk.fusion.Occurrence | None":
    if not path:return None
    matches: list[adsk.fusion.Occurrence]=[
        o for o in _external_items(ctx.root.allOccurrences) if o.fullPathName==path]
    return _cad_unique(matches,'exact destination parent context')


def _external_existing_derive(ctx: "CadContext",pin: "_ExternalPin") -> "adsk.fusion.DeriveFeature | None":
    matches: list[adsk.fusion.DeriveFeature]=[]
    for feature in _external_items(ctx.root.features.deriveFeatures):
        if bool(feature.isSuppressed):continue
        try:
            reference=feature.documentReference
            source_file=reference.dataFile
            file_id=source_file.id
            try:version=int(reference.version)
            except RuntimeError:
                # Same conservative saved-forward-edge evidence used by .10.
                # A cold version getter error is not proof of a broken link.
                reference_collection=_external_cast(
                    '_CadItemCollection[adsk.core.DocumentReference]',ctx.doc.documentReferences)
                refs: list[adsk.core.DocumentReference]=list(_external_items(reference_collection))
                for owner in _external_own_components(ctx.root):
                    derives=_external_cast(
                        '_CadItemCollection[adsk.fusion.DeriveFeature]',owner.features.deriveFeatures)
                    for derive in _external_items(derives):
                        if not derive.isSuppressed and not any(r==derive.documentReference for r in refs):
                            refs.append(derive.documentReference)
                count=sum(r.dataFile.id==file_id for r in refs)
                evidence=_external_edge_version(ctx.doc,reference,file_id,count)
                version=evidence['baselineVersion']
                _external_require(type(version) is int,'Saved Derive version evidence is unresolved')
        except Exception as error:
            raise ValueError('Existing owned Derive identity is unresolved; refusing to create/reselect: '+
                             type(error).__name__+': '+str(error))
        if file_id!=pin['fileId']:continue
        if version!=pin['version']:
            raise ValueError('Existing owned Derive pins another source version; routine refresh belongs to references.refresh')
        matches.append(feature)
    _external_require(len(matches)<=1,'Ambiguous existing owned Derive for exact source pin')
    return matches[0] if matches else None


def _external_ensure_attributes(entity: "_ExternalAttributed",attributes: "list[tuple[str, str, str]]") -> "None":
    for group,name,value in attributes:
        current_value: object=entity.attributes.itemByName(group,name)
        current=_external_cast('adsk.core.Attribute | None',current_value)
        _external_require(current is None or current.value==value,
                          'Existing native attribute differs from declared source metadata')
        if current is None:entity.attributes.add(group,name,value)


def _external_joint_present(ctx: "CadContext",token: "str") -> "bool":
    return any(joint.entityToken==token for component in _external_own_components(ctx.root)
        for collection in (component.joints,component.asBuiltJoints) for joint in _external_items(collection))


def _external_delete_joint_checkpoint(ctx: "CadContext",joint: "adsk.fusion.Joint | adsk.fusion.AsBuiltJoint",token: "str") -> "JsonObject":
    error=None;returned=None
    try:returned=joint.deleteMe()
    except Exception as exc:error=type(exc).__name__+': '+str(exc)
    present=_external_joint_present(ctx,token)
    if not present:return {'status':'removed','reconciledAfterException':error is not None or returned is not True,
                          'submitError':error}
    return {'status':'retained','reconciledAfterException':False,'submitError':error,
            'reason':'Native joint delete was not observed; original remains present'}


def _external_occurrence_present(ctx: "CadContext",captured: "_ExternalInstanceMap") -> "bool":
    return any(o.entityToken==captured['token'] or
        (o.fullPathName==captured['path'] and o.component.entityToken==captured['definition'])
        for o in _external_items(ctx.root.allOccurrences))


def _external_delete_occurrence_checkpoint(ctx: "CadContext",occurrence: "adsk.fusion.Occurrence",captured: "_ExternalInstanceMap") -> "JsonObject":
    error=None;returned=None
    try:returned=occurrence.deleteMe()
    except Exception as exc:error=type(exc).__name__+': '+str(exc)
    if not _external_occurrence_present(ctx,captured):
        return {'status':'removed','reconciledAfterException':error is not None or returned is not True,
                'submitError':error}
    return {'status':'retained','reconciledAfterException':False,'submitError':error,
            'reason':'deleteMe returned/raised but the exact local occurrence still exists'}


def _external_parameter_reference(entity: "_ExternalAttributed") -> "bool":
    attribute_value: object=getattr(entity,'attributes',None)
    if attribute_value is None:return False
    attributes=_external_cast('_CadItemCollection[adsk.core.Attribute]',attribute_value)
    return any(a.groupName=='fmcad.externalization' and a.name=='role' and
        a.value=='declaredParameterReference' for a in _external_items(attributes))


def _external_physical_occurrences(component: "adsk.fusion.Component") -> "list[adsk.fusion.Occurrence]":
    rows=_external_items(component.allOccurrences)
    excluded=[o.fullPathName for o in rows if _external_parameter_reference(o)]
    return [o for o in rows if not any(o.fullPathName==p or o.fullPathName.startswith(p+'+') for p in excluded)]


def _external_native_features(component: "adsk.fusion.Component") -> "list[adsk.fusion.Feature]":
    return [f for f in _external_items(component.features) if not _external_parameter_reference(f)]


def _external_inventory(component: "adsk.fusion.Component") -> "_ExternalInventory":
    occurrences = _external_physical_occurrences(component)
    components = [component]
    for o in occurrences:
        if o.component not in components: components.append(o.component)
    return {'bodies':sum(c.bRepBodies.count for c in components),'occurrences':len(occurrences),
            'history':sum(len(_external_native_features(c)) + c.sketches.count for c in components)}


def _external_health(component: "adsk.fusion.Component") -> "None":
    for c in [component]+[o.component for o in _external_items(component.allOccurrences)]:
        for f in _external_items(c.features):
            health_state=int(_external_cast('_ExternalSupportsInt',f.healthState))
            healthy_state=int(_external_cast(
                '_ExternalSupportsInt',adsk.fusion.FeatureHealthStates.HealthyFeatureHealthState))
            _external_require(not f.isSuppressed and health_state==healthy_state,
                              'Unhealthy/suppressed native history requires explicit repair/grouping before installation')


def _external_feature_inputs(feature: "adsk.fusion.Feature") -> "list[adsk.core.Base]":
    kind=_cad_type(feature)
    if kind=='ExtrudeFeature':
        extrude=_external_cast('adsk.fusion.ExtrudeFeature',feature)
        profile=_external_cast(
            'adsk.fusion.Profile | _CadItemCollection[adsk.fusion.Profile]',extrude.profile)
        if hasattr(profile,'count'):
            profiles=_external_items(_external_cast(
                '_CadItemCollection[adsk.fusion.Profile]',profile))
        else:
            profiles=[_external_cast('adsk.fusion.Profile',profile)]
        return _external_cast('list[adsk.core.Base]',[p.parentSketch for p in profiles])
    if kind=='CombineFeature':
        combine=_external_cast('adsk.fusion.CombineFeature',feature)
        return _external_cast('list[adsk.core.Base]',[combine.targetBody]+_external_items(combine.toolBodies))
    if kind in ('RectangularPatternFeature','CircularPatternFeature'):
        pattern=_external_cast(
            'adsk.fusion.RectangularPatternFeature | adsk.fusion.CircularPatternFeature',feature)
        _external_require(hasattr(pattern,'inputEntities'),'Pattern input coverage unavailable; explicit grouping/repair required')
        inputs=_external_cast('_CadItemCollection[adsk.core.Base]',pattern.inputEntities)
        return _external_items(inputs)
    if kind=='CutPasteBody':
        cut_paste=_external_cast('adsk.fusion.CutPasteBody',feature)
        _external_require(hasattr(cut_paste,'sourceBodies'),'CutPaste native source context unavailable; no automatic repair')
        cut_paste_source=_external_cast('_ExternalCutPasteBody',cut_paste)
        inputs=_external_cast('_CadItemCollection[adsk.fusion.BRepBody]',cut_paste_source.sourceBodies)
        return _external_cast('list[adsk.core.Base]',_external_items(inputs))
    if kind=='DeriveFeature':
        derive=_external_cast('adsk.fusion.DeriveFeature',feature)
        _external_require(_external_reference_data_file(derive.documentReference) is not None,
                          'Unresolved external Derive input')
        return []
    raise ValueError('Unsupported native feature input coverage: '+str(kind))


def _external_input_owner(entity: "adsk.core.Base") -> "adsk.fusion.Component | None":
    native=getattr(entity,'nativeObject',None) or entity
    owner=getattr(native,'parentComponent',None)
    return owner if owner is not None else getattr(getattr(native,'body',None),'parentComponent',None)


def _external_feature_input_owners(feature: "adsk.fusion.Feature",allow_timeline: "bool"=False) -> "list[adsk.fusion.Component | None]":
    try:return [_external_input_owner(e) for e in _external_feature_inputs(feature)]
    except RuntimeError as error:
        if not allow_timeline or _cad_type(feature)!='CombineFeature' or "Didn't roll editing feature back" not in str(error):raise
    # Combine input bodies are evaluated before their consuming feature. Capture
    # stable component owners there, then restore the exact caller marker.
    timeline=feature.parentComponent.parentDesign.timeline;marker=timeline.markerPosition
    try:
        _external_require(feature.timelineObject.rollTo(True),'Cannot inspect native Combine inputs before feature')
        return [_external_input_owner(e) for e in _external_feature_inputs(feature)]
    finally:
        try:
            timeline.markerPosition=marker
            _external_require(timeline.markerPosition==marker,'Combine input inspection failed to restore timeline marker')
        except Exception as error:
            raise _ExternalTimelineRestoreError(str(error)) from error


def _external_dependency_coverage(component: "adsk.fusion.Component", allowed: "list[adsk.fusion.Component]",defer_combine: "bool"=False,allow_timeline: "bool"=False) -> "None":
    components=[component]+[o.component for o in _external_items(component.allOccurrences)]
    owners=list(allowed)+components
    for owner in components:
        for feature in _external_items(owner.features):
            if defer_combine and _cad_type(feature)=='CombineFeature':continue
            for input_owner in _external_feature_input_owners(feature,allow_timeline):
                _external_require(input_owner in owners,'Cross-component dependency requires an explicit same-parent extraction group')


def _external_content_fingerprint(ctx: "CadContext") -> "str":
    return _external_digest({'metadata':_external_metadata(ctx.design,ctx.root),
        'parameters':_external_parameters(ctx.design),'history':_external_history_signature(ctx.root),
        'joints':_external_internal_joints(ctx.root),
        'marker':ctx.design.timeline.markerPosition,'count':ctx.design.timeline.count})


def _external_fingerprint(ctx: "CadContext") -> "str":
    if not ctx.doc.isValid:return 'closed-owned-editor'
    return _external_digest({'identity':_external_document_identity(ctx.doc),
                             'content':_external_content_fingerprint(ctx)})


def _external_inplace_save_is_settled(runtime: "_ExternalRuntime") -> "bool":
    try:
        if not runtime.get('saveAttempted') or runtime.get('saveFileId') is None:return False
        saved=_external_cast('_ExternalSavedRuntime',runtime)
        ctx=saved['source'];doc=ctx.doc;file=_external_document_data_file(doc)
        return (file is not None and file.id==saved['saveFileId'] and
            file.parentProject.id==saved['saveProjectId'] and
            file.versionNumber==saved['saveBaseline']+1 and file.isComplete is True and
            doc.creationId==saved['saveCreationId'] and doc.isModified is False and
            _external_content_fingerprint(ctx)==saved['saveContentFingerprint'])
    except Exception:return False


def _external_inplace_save_is_pending(runtime: "_ExternalRuntime",data: "_ExternalStepData") -> "bool":
    try:
        if data['phase']!='finalize' or not runtime.get('saveAttempted'):return False
        entry=runtime['items'][data['itemId']]
        phase_state=data['result']['byItem'][data['itemId']]['phaseResults']['finalize']
        receipt=_external_phase_receipt(phase_state)
        baseline=_external_cast('_ExternalSnapshot',entry.get('baseline'))
        checks=(len(baseline['bodies'])+1)*len(entry['staged'])
        if receipt.get('saveAccepted') is not True or receipt.get('cursor',0)<=checks+1:return False
        saved=_external_cast('_ExternalSavedRuntime',runtime)
        ctx=saved['source'];doc=ctx.doc;file=_external_document_data_file(doc)
        return (file is not None and file.id==saved['saveFileId'] and
            file.parentProject.id==saved['saveProjectId'] and doc.creationId==saved['saveCreationId'] and
            file.versionNumber in (saved['saveBaseline'],saved['saveBaseline']+1) and
            _external_content_fingerprint(ctx)==saved['saveContentFingerprint'])
    except Exception:return False


def _external_probe_refresh_checkpoint(runtime: "_ExternalRuntime",data: "_ExternalStepData") -> "bool":
    """Allow only the pinned .10 driver-refresh checkpoint that this probe submitted."""
    try:
        if data.get('phase')!='verify:assembly':return False
        item_id=data['itemId']
        probes=[p for p in data['manifest'].get('probes',[]) if p['itemId']==item_id and
                p.get('scope','assembly')=='assembly']
        if len(probes)!=1:return False
        probe=probes[0];state=runtime.get('probes',{}).get(probe['probeId'])
        if state is None:return False
        probe_handles=runtime.get('probeHandles',{})
        ctx=runtime['target'] or runtime['source'];doc=ctx.doc;file=_external_document_data_file(doc)
        if state.get('stage')=='baselineObserve':
            if data['manifest']['mode'] not in ('copyAndReplace','replaceFromExisting','replaceExternal'):
                return False
            if file is None:return False
            local=_external_cast('_ExternalProbeLocalResult',state.get('localResult') or {})
            source_pin=_external_cast('_ExternalProbeSourceCreation',data['manifest']['source'])
            probe_ctx=probe_handles.get(probe['probeId'])
            deferred_source_clean=(probe_ctx is not None and not probe_ctx.doc.isModified and
                _external_required_data_file(probe_ctx.doc).versionNumber==state['source']['version'])
            binding=next((row for row in runtime.get('derivedBindings',[])
                          if row.get('sourceFileId')==state['source']['fileId'] and
                          row.get('consumerAlias') in [p['consumerAlias'] for p in data['manifest'].get('parameterBindings',[])]),None)
            return (file.id==source_pin['fileId'] and
                doc.creationId==source_pin['creationId'] and
                int(file.versionNumber)>int(state.get('targetBaseline',0)) and file.isComplete is True and
                doc.isModified is False and (local.get('restored') is True or
                    state.get('localProbeDeferred') is True and
                    deferred_source_clean) and
                all(check.get('passed') is True for check in local.get('restoredGeometryChecks',[])) and
                binding is not None)
        if state.get('stage') not in ('refreshPlan','refreshApply','verifyConsumer'):return False
        if file is None or not file.isComplete or doc.isModified:return False
        target_pin=state.get('targetPin')
        if target_pin is None:return False
        if file.id!=target_pin['fileId']:return False
        refresh_receipt=_external_observed_probe_receipt(data,item_id,'assembly').get('refreshReceipt')
        refreshed_row=None
        if state.get('stage')=='verifyConsumer':
            if refresh_receipt is None or refresh_receipt.get('success') is not True or \
                    refresh_receipt.get('allIntendedReferencesCurrent') is not True:return False
            successful_receipt=_external_cast('_ExternalSuccessfulRefreshReceipt',refresh_receipt)
            rows=[row for row in successful_receipt['completed']
                  if row.get('fileId')==target_pin['fileId'] and row.get('coldVerified') is True]
            if len(rows)!=1:return False
            refreshed_row=rows[0]
            if int(file.versionNumber)!=int(refreshed_row['resultingVersion']):return False
        elif int(file.versionNumber)!=target_pin['version']:
            return False
        if state.get('stage')=='refreshApply' and (not refresh_receipt or
                refresh_receipt.get('invocationStatus')!='complete' or not refresh_receipt.get('planId')):
            return False
        baseline_edges=state.get('baselineEdges',[])
        baseline: dict[str,_ExternalReferenceEdge]={
            edge['edgeId']:edge for edge in baseline_edges if edge.get('ownerFileId',file.id)==file.id}
        current_rows=_external_current_edges(ctx)
        current={edge['edgeId']:edge for edge in current_rows}
        if len(current)!=len(current_rows) or set(current)!=set(baseline):return False
        producer_id=state['source']['fileId'];restoring=state.get('restoring') is True
        applied_version=state.get('consumerAppliedVersion') if restoring else None
        for edge_id,row in current.items():
            old=baseline[edge_id]
            if row.get('sourceFileId')!=old.get('sourceFileId') or row.get('kind')!=old.get('kind'):
                return False
            if row.get('sourceFileId')==producer_id:
                if state.get('stage')=='verifyConsumer':
                    expected_baseline=state.get('publishedVersion')
                    expected_latest=state.get('publishedVersion')
                elif restoring:
                    expected_baseline=applied_version;expected_latest=state.get('publishedVersion')
                else:
                    expected_baseline=old.get('baselineVersion');expected_latest=state.get('publishedVersion')
                if expected_baseline is None or row.get('baselineVersion')!=expected_baseline or \
                        row.get('latestVersion')!=expected_latest:
                    return False
            elif row.get('baselineVersion')!=state.get('appliedVersions',{}).get(row['sourceFileId'],old.get('baselineVersion')) or \
                    row.get('latestVersion')!=state.get('appliedVersions',{}).get(row['sourceFileId'],old.get('latestVersion')):
                return False
            if row.get('versionSource')=='unresolved':return False
        if state.get('stage') in ('refreshPlan','refreshApply'):
            entry=runtime['items'][item_id]
            original=entry.get('originals',[])
            baseline_value=entry.get('baseline')
            if len(original)!=1 or baseline_value is None:return False
            baseline_snapshot=baseline_value
            for check in range(len(baseline_snapshot['bodies'])+1):
                _external_compare(baseline_snapshot,original[0].component,check,runtime['tolerance'],entry['spec'])
            return True
        return refreshed_row is not None
    except Exception:
        return False


def _external_bodies(component: "adsk.fusion.Component") -> "list[tuple[tuple[str, int] | tuple[str, int, int], adsk.fusion.BRepBody]]":
    result: list[tuple[tuple[str, int] | tuple[str, int, int], adsk.fusion.BRepBody]] = [
        (('root',i),b) for i,b in enumerate(_external_items(component.bRepBodies))]
    for index,occ in enumerate(_external_physical_occurrences(component)):
        for j,b in enumerate(_external_items(occ.component.bRepBodies)):
            result.append((('occurrence',index,j),b))
    return result


def _external_snapshot(component: "adsk.fusion.Component") -> "_ExternalSnapshot":
    _external_health(component)
    manager=adsk.fusion.TemporaryBRepManager.get()
    bodies: list[tuple[tuple[str, int] | tuple[str, int, int], adsk.fusion.BRepBody, str,
                       list[tuple[str, str, str]]]]=[]
    for key,body in _external_bodies(component):
        bodies.append((key,manager.copy(body),
                       body.material.id,_external_attributes(body)))
    occurrences: list[_ExternalSnapshotOccurrence]=[]
    for i,o in enumerate(_external_physical_occurrences(component)):
        occurrences.append({'index':i,'componentToken':o.component.entityToken,'token':o.entityToken,
            'nativeToken':_external_native_occurrence_token(getattr(o,'nativeObject',None) or o),'path':o.fullPathName,
            'pose':list(o.transform2.asArray()),'attrs':_external_attributes(o),
            'nativeAttrs':_external_attributes(_external_native_attributed(o)),
            'componentAttrs':_external_attributes(o.component)})
    return {'inventory':_external_inventory(component),'joints':_external_internal_joints(component),
        'history':_external_history_signature(component),
        'bodies':bodies,
        'attributes':_external_attributes(component),
        'occurrences':occurrences}


def _external_compare(snapshot: "_ExternalSnapshot", component: "adsk.fusion.Component", check: "int", tolerance: "_ExternalTolerance", mappings: "_ExternalMappings | None"=None) -> "JsonObject":
    _external_health(component)
    _external_require(_external_inventory(component)==snapshot['inventory'], 'Source-bound inventory/history differs')
    _external_require('history' in snapshot and _external_history_signature(component)==snapshot['history'], 'Native feature history differs or its baseline is unavailable')
    _external_require('joints' in snapshot and _external_internal_joints(component)==snapshot['joints'], 'Internal native joint state/limits differ or baseline is unavailable')
    bodies = _external_bodies(component)
    mappings=mappings or {}
    body_mapping=mappings.get('bodyMap')
    if body_mapping:
        mapping=body_mapping
        _external_require(len(mapping)==len(bodies) and {r['sourceIndex'] for r in mapping}==set(range(len(bodies))) and
            {r['targetIndex'] for r in mapping}==set(range(len(bodies))),'Body map must bijectively cover the captured inventory')
        bodies=[bodies[next(r['targetIndex'] for r in mapping if r['sourceIndex']==i)] for i in range(len(bodies))]
    if check < len(snapshot['bodies']):
        key,old,material,attrs=snapshot['bodies'][check]
        _external_require(check < len(bodies) and (body_mapping or bodies[check][0]==key), 'Body mapping cardinality mismatch')
        new=bodies[check][1]
        _external_require(new.material.id==material and _external_attributes(new)==attrs, 'Body material/native attributes differ')
        manager=adsk.fusion.TemporaryBRepManager.get()
        difference: list[float]=[]
        difference_type=_external_cast('adsk.fusion.BooleanTypes',
            adsk.fusion.BooleanTypes.DifferenceBooleanType)
        for a,b in ((old,new),(new,old)):
            temp=manager.copy(a)
            _external_require(manager.booleanOperation(temp,manager.copy(b),difference_type), 'CSG operation failed')
            difference.append(float(temp.volume))
        _external_require(max(difference)<=tolerance['volume'], 'Bidirectional CSG mismatch')
        return {'checkId':'body:'+str(check),'passed':True,'differencesInternal':difference}
    actual=_external_physical_occurrences(component)
    occurrence_mapping=mappings.get('occurrenceMap')
    if occurrence_mapping:
        mapping=occurrence_mapping
        _external_require(len(mapping)==len(actual) and {r['sourceIndex'] for r in mapping}==set(range(len(actual))) and
            {r['targetIndex'] for r in mapping}==set(range(len(actual))),'Occurrence map must bijectively cover distinct captured contexts')
        actual=[actual[next(r['targetIndex'] for r in mapping if r['sourceIndex']==i)] for i in range(len(actual))]
    _external_require(_external_attributes(component)==snapshot['attributes'], 'Component attributes differ')
    _external_require(len(actual)==len(snapshot['occurrences']), 'Occurrence map incomplete')
    for before,after in zip(snapshot['occurrences'],actual):
        _external_require(_external_attributes(after)==before['attrs'] and
            _external_attributes(_external_native_attributed(after))==before['nativeAttrs'] and
            _external_attributes(after.component)==before['componentAttrs'], 'Context/native/component attributes differ')
        linear,angular=_external_pose_delta(before['pose'],list(after.transform2.asArray()))
        _external_require(linear<=tolerance['linear'] and angular<=tolerance['angular'], 'Occurrence pose mismatch')
    return {'checkId':'history:poses:attributes','passed':True}


def _external_registry(create: "bool"=False) -> "dict[str, _ExternalRegistryEntry]":
    name='_fmcad_externalization_runtime'
    if name not in _external_sys.modules and create:
        module=_external_types.ModuleType(name)
        _external_cast('dict[str, object]',module.__dict__)['operations']={}
        _external_sys.modules[name]=module
    operations=getattr(_external_sys.modules.get(name),'operations',{})
    return _external_cast('dict[str, _ExternalRegistryEntry]',operations)


def _external_history_signature(component: "adsk.fusion.Component") -> "list[JsonObject]":
    components=[component]
    for occurrence in _external_physical_occurrences(component):
        if occurrence.component not in components:components.append(occurrence.component)
    return [_external_component_history(c) for c in components]


def _external_component_history(component: "adsk.fusion.Component") -> "JsonObject":
    features: list[JsonObject]=[]
    for feature in _external_native_features(component):
        parameters: list[tuple[str,str,str]] | None=None
        if hasattr(feature,'parameters'):
            collection=_external_cast(
                '_CadItemCollection[adsk.fusion.Parameter]',getattr(feature,'parameters'))
            parameters=[(str(parameter.name),str(parameter.expression),str(parameter.unit))
                        for parameter in _external_items(collection)]
        feature_health=_external_cast('_ExternalSupportsInt',feature.healthState)
        features.append({'type':_cad_type(feature),'name':str(feature.name),
            'suppressed':bool(feature.isSuppressed),'healthState':int(feature_health),
            'parameters':parameters})
    sketches: list[JsonObject]=[]
    sketch_collection=_external_cast('_CadItemCollection[adsk.fusion.Sketch]',component.sketches)
    for sketch in _external_items(sketch_collection):
        sketches.append({'name':str(sketch.name),'isFullyConstrained':bool(sketch.isFullyConstrained),
            'curves':int(sketch.sketchCurves.count),'constraints':int(sketch.geometricConstraints.count),
            'dimensions':int(sketch.sketchDimensions.count)})
    return {'features':features,'sketches':sketches}


def _external_internal_joints(component: "adsk.fusion.Component | None",components: "list[adsk.fusion.Component | None] | None"=None) -> "list[JsonObject]":
    if components is None:
        component=_external_cast('adsk.fusion.Component',component)
        components=[component]
        for occurrence in _external_physical_occurrences(component):
            if occurrence.component not in components:components.append(occurrence.component)
    result: list[JsonObject]=[]
    for index,owner in enumerate(components):
        if owner is None:continue
        local=_external_items(_external_cast(
            '_CadItemCollection[adsk.fusion.Occurrence]',owner.allOccurrences))
        def endpoint(occurrence: "adsk.fusion.Occurrence | None") -> "int | None":
            if occurrence is None:return None
            native=getattr(occurrence,'nativeObject',None) or occurrence
            matches: list[int]=[i for i,o in enumerate(local) if (getattr(o,'nativeObject',None) or o)==native]
            return _cad_unique(matches,'closed internal-joint endpoint context')
        joint_collections=(_external_cast('_CadItemCollection[adsk.fusion.Joint]',owner.joints),
                           _external_cast('_CadItemCollection[adsk.fusion.AsBuiltJoint]',owner.asBuiltJoints))
        for collection in joint_collections:
            for joint in _external_items(collection):
                motion=joint.jointMotion
                kind=int(_external_cast('_ExternalSupportsInt',motion.jointType))
                _external_require(kind in (0,1,2,3),'Unqualified internal joint motion type')
                row: JsonObject={'owner':index,'name':joint.name,'form':_cad_type(joint),'kind':kind,
                     'endpoints':[endpoint(_external_joint_occurrence(joint,0)),
                                  endpoint(_external_joint_occurrence(joint,1))],
                     'attrs':_external_attributes(joint)}
                for key in ('offset','angle'):
                    if hasattr(joint,key):
                        expression=_external_joint_expression(joint,key)
                        row[key]=_external_cast('str',expression)
                if hasattr(joint,'isFlipped'):
                    regular_joint=_external_cast('adsk.fusion.Joint',joint)
                    row['isFlipped']=bool(regular_joint.isFlipped)
                motion_values=_external_cast('_ExternalJointMotionValues',motion)
                for prefix in (('rotation',) if kind==1 else ('slide',) if kind==2 else ('rotation','slide') if kind==3 else ()):
                    if prefix=='rotation':
                        row[prefix+'Value']=motion_values.rotationValue
                        limits=motion_values.rotationLimits
                    else:
                        row[prefix+'Value']=motion_values.slideValue
                        limits=motion_values.slideLimits
                    joint_limits: JsonObject={'minimumValue':limits.minimumValue,'maximumValue':limits.maximumValue,
                        'restValue':limits.restValue,'isMinimumValueEnabled':limits.isMinimumValueEnabled,
                        'isMaximumValueEnabled':limits.isMaximumValueEnabled,'isRestValueEnabled':limits.isRestValueEnabled}
                    row[prefix+'Limits']=joint_limits
                result.append(row)
    return result


def _external_initial(data: "_ExternalStepData") -> "_ExternalRuntime | _ExternalPendingWrapper":
    lifecycle_effects: list[JsonObject]=[]
    try:return _external_initial_impl(data,lifecycle_effects)
    except Exception as error:
        if not lifecycle_effects:raise
        return _external_cast('_ExternalPendingWrapper',{'_externalPending':{'status':'blocked','notStarted':True,
            'receipt':{'cursor':0,'reason':type(error).__name__+': '+str(error)},
            'lifecycleEffects':lifecycle_effects}})


def _external_initial_pending(result: "_ExternalRuntime | _ExternalPendingWrapper") -> "JsonObject | None":
    pending = result.get('_externalPending')
    return pending


def _external_initial_impl(data: "_ExternalStepData",lifecycle_effects: "list[JsonObject]") -> "_ExternalRuntime | _ExternalPendingWrapper":
    m=data['manifest'];app=adsk.core.Application.get()
    source_item_ids={item['itemId'] for item in m['items'] if item.get('dataFileId')==m['source']['fileId']}
    probe_uses_owner=any((probe['source'].get('fileId')==m['source']['fileId'] or
        probe['source'].get('itemId') in source_item_ids) for probe in m.get('probes',[]))
    if m['mode']=='composeNew' and probe_uses_owner:
        _external_require(False,'composeNew driver probes cannot publish the preserved source document')
    source_editable=m['mode']!='composeNew'
    doc,resolved=_external_document(app,m['source'],allow_open=True,
        readonly=data.get('outerReadOnly',False),editable=source_editable)
    lifecycle_effects.extend(_external_lifecycle_effects(resolved))
    if doc is None and resolved.get('status')=='pendingPublication':
        return _external_cast('_ExternalPendingWrapper',{'_externalPending':{'status':'pending','receipt':{'cursor':0,'reason':'sourcePublicationPending',
            'preflightPending':True,'sourcePin':_external_pin_json(_external_pin(
                _external_project_file(app,m['source']['projectId'],m['source']['fileId'],m['source']['version'])))},
            'waitingPublication':True,
            'lifecycleEffects':lifecycle_effects}})
    _external_require(doc is not None, 'Exact saved source owner unavailable: '+str(resolved))
    doc=_external_cast('adsk.core.Document',doc)
    _external_require(not doc.isModified and (not source_editable or not doc.dataFile.isReadOnly),
                       'Source recovery baseline must be saved and writable for this mode')
    if not _external_refresh_complete(doc.dataFile):
        return _external_cast('_ExternalPendingWrapper',{'_externalPending':{'status':'pending','receipt':{'cursor':0,'reason':'sourcePublicationPending',
            'preflightPending':True,'sourcePin':_external_pin_json(_external_pin(doc.dataFile))},
            'waitingPublication':True,'lifecycleEffects':lifecycle_effects}})
    ctx=_external_ctx(doc);_assembly_capture_ready(ctx)
    _external_require(_external_feature_health(ctx)['healthy'],'Source recovery history is not healthy')
    runtime: '_ExternalRuntime'={'requestHash':data['requestHash'],'sessionNonce':data['sessionNonce'],'processId':_external_os.getpid(),
        'source':ctx,'sourceFingerprint':_external_fingerprint(ctx),'items':{},'effects':{},'target':None,
        'initialLifecycleEffects':lifecycle_effects,
        'tolerance':{'linear':ctx.length(m['linearTolerance']),'angular':ctx.angle(m['angularTolerance']),
            'volume':ctx.design.unitsManager.evaluateExpression(m['volumeTolerance'],'cm^3')},'compensation':None}
    tolerance=runtime['tolerance']
    _external_require(all(_external_math.isfinite(v) and v>=0 for v in
        (tolerance['linear'],tolerance['angular'],tolerance['volume'])),
        'Tolerances must be finite and nonnegative')
    compose_manifest: _ExternalComposeNewManifest | None=None
    if m['mode']=='composeNew':
        compose_manifest=_external_cast('_ExternalComposeNewManifest',m)
        destination_document=compose_manifest['destinationDocument']
        folder=_external_folder(app,destination_document);_external_collision(folder,destination_document['name'])
    selected: list[str]=[]
    authorized_instance_paths: list[str]=[]
    definitions: dict[tuple[str | None,int],str]={}
    extraction_groups=m.get('extractionGroups',[])
    groups: dict[str,_ExternalGroupSpec]={g['id']:g for g in extraction_groups}
    for spec in m['items']:
        target_project=(compose_manifest['destinationDocument']['projectId'] if compose_manifest is not None
                        else m['source']['projectId'])
        if spec.get('dataFileId'):
            pinned_spec=_external_cast('_ExternalPinnedItemSpec',spec)
            _external_require(pinned_spec['projectId']==target_project,'Pinned reused source must belong to the destination project')
        else:
            destination=_external_cast('_ExternalFileDestination',spec.get('destination'))
            _external_require(destination['projectId']==target_project,'New native copy destination must match the assembly project')
        group_id=spec.get('groupId')
        selection=spec.get('selection')
        refs=groups[group_id]['members'] if group_id else ([selection] if selection is not None else [])
        roots: list[adsk.fusion.Occurrence]=[
            _external_occurrence(ctx,ref) for ref in refs]
        for occurrence in roots:
            _external_require(all(not (occurrence.fullPathName==old or occurrence.fullPathName.startswith(old+'+') or old.startswith(occurrence.fullPathName+'+')) for old in selected),'Overlapping/ancestor selections')
            selected.append(occurrence.fullPathName)
        if roots:
            external=spec.get('definitionPolicy','local')=='external'
            _external_require(all(o.isReferencedComponent==external for o in roots),'Explicit local/external definition policy mismatch')
            _external_require(m['mode']=='replaceExternal' or not external or m['mode']=='composeNew','Local retirement cannot target external definitions')
            if m['mode']=='replaceExternal':_external_require(external,'replaceExternal requires external-definition policy')
            if spec.get('groupId'):
                _external_require(spec['instancePolicy']=='selected',
                    'Extraction groups require explicit selected sibling membership; implicit allInstances group expansion is unsupported')
                parents={o.fullPathName.rsplit('+',1)[0] if '+' in o.fullPathName else '' for o in roots}
                _external_require(len(parents)==1,'Extraction group requires same-parent siblings')
            component=roots[0].component
            for root in roots:_external_dependency_coverage(root.component,[o.component for o in roots],
                defer_combine=bool(spec.get('groupId')))
            if spec['instancePolicy']=='allInstances':
                all_occurrences=_external_items(_external_cast(
                    '_CadItemCollection[adsk.fusion.Occurrence]',ctx.root.allOccurrences))
                instances: list[adsk.fusion.Occurrence]=[o for o in all_occurrences if o.component==component]
            else:
                instances=roots
            instances=_external_disjoint_instances(instances,authorized_instance_paths)
            destination_occurrence=spec.get('destinationOccurrence')
            if m['mode']!='composeNew' and destination_occurrence not in (None,'root'):
                destination_parent=_external_root_occurrence(ctx,destination_occurrence)
                _external_require(all(destination_parent.fullPathName!=o.fullPathName and
                    not destination_parent.fullPathName.startswith(o.fullPathName+'+') for o in instances),
                    'Insertion destination cannot be inside a selected externalization item')
            if m['mode']=='composeNew' and spec.get('placement') is not None:
                _external_require(len(instances)==1,'Explicit composeNew placement requires one selected source instance per item')
            # Equality, not Python wrapper id, defines the shared-native scope.
            for o in instances:
                peers=[p for p in _external_items(ctx.root.allOccurrences) if (getattr(p,'nativeObject',None) or p)==(getattr(o,'nativeObject',None) or o)]
                _external_require(all(p.fullPathName in [i.fullPathName for i in instances] for p in peers),'Shared-parent write would affect outside authorized instanceMap')
            baseline=_external_snapshot(component) if not spec.get('groupId') else None
            if baseline is not None:_external_require(baseline['inventory']==m['expectedInventory'][spec['itemId']],'Declared source inventory differs')
        else:
            instances=[];component=None;baseline=None
        pinned_spec: _ExternalPinnedItemSpec | None=None
        if spec.get('dataFileId'):
            pinned_spec=_external_cast('_ExternalPinnedItemSpec',spec)
            file=_external_project_file(app,pinned_spec['projectId'],pinned_spec['dataFileId'],pinned_spec['version'])
            target_pin=_external_pin(file)
            creation_id=pinned_spec.get('creationId')
            context=pinned_spec.get('context')
            if creation_id:target_pin['creationId']=creation_id
            if context:target_pin['context']=context
        else:
            destination=_external_cast('_ExternalFileDestination',spec.get('destination'))
            folder=_external_folder(app,destination);_external_collision(folder,destination['fileName'])
            target_pin=None
        if component is not None:
            component_token=component.entityToken
        else:
            if pinned_spec is None:raise ValueError('Source item has no selected component or pinned file')
            component_token=pinned_spec['dataFileId']
        key=(component_token,m['source']['version'])
        owner=definitions.setdefault(key,spec['itemId'])
        if owner!=spec['itemId']:
            previous=next(i for i in m['items'] if i['itemId']==owner)
            _external_require(previous.get('destination')==spec.get('destination'), 'One native definition cannot declare competing copies')
        namespace_specs: list[JsonObject]=[declaration for declaration in m.get('callerNamespaces',[])
                         if declaration['itemId']==spec['itemId']]
        instance_map: list[_ExternalInstanceMap]=[]
        for occurrence in instances:
            parent_occurrence=_external_assembly_context(occurrence)
            instance_map.append({'source':ctx.ref(occurrence),'token':occurrence.entityToken,
                'definition':occurrence.component.entityToken,'path':occurrence.fullPathName,
                'worldPose':list(_external_entity_occurrence_matrix(ctx,occurrence)),
                'parentToken':parent_occurrence.entityToken if parent_occurrence is not None else None,
                'parentWorldPose':list(_external_entity_occurrence_matrix(ctx,parent_occurrence))
                    if parent_occurrence is not None else list(adsk.core.Matrix3D.create().asArray()),
                'callerNamespaceSpecs':namespace_specs,
                'callerNamespaces':_external_parent_namespace_values(ctx,parent_occurrence,namespace_specs),
                'fileId':occurrence.documentReference.dataFile.id if occurrence.isReferencedComponent else None,
                'version':int(occurrence.documentReference.version) if occurrence.isReferencedComponent else None,
                'grounded':bool(occurrence.isGrounded),'groundToParent':bool(occurrence.isGroundToParent),
                'attributes':_external_attributes(occurrence),
                'nativeAttributes':_external_attributes(_external_native_attributed(occurrence))})
        runtime['items'][spec['itemId']]={'spec':spec,'component':component,'originals':instances,'baseline':baseline,
            'definitionOwner':owner,'targetPin':target_pin,'future':None,'staged':[],
            'instanceMap':instance_map}
        runtime['items'][spec['itemId']]['retireMap']=list(runtime['items'][spec['itemId']]['instanceMap'])
    selected_owners: list[adsk.fusion.Component]=[]
    for entry in runtime['items'].values():
        for occurrence in entry['originals']:
            descendants=_external_cast(
                '_CadItemCollection[adsk.fusion.Occurrence]',occurrence.component.allOccurrences)
            selected_owners.extend([occurrence.component]+[o.component for o in _external_items(descendants)])
    if m['mode'] in ('copyAndReplace','replaceFromExisting','replaceExternal'):
        for component in _external_own_components(ctx.root):
            if component in selected_owners:continue
            for feature in _external_items(component.features):
                _external_require(not any(owner in selected_owners for owner in _external_feature_input_owners(feature)),
                    'Outside feature consumes selected geometry; explicit closed extraction group/interface required')
    _external_preflight_boundaries(runtime,m)
    for entry in runtime['items'].values():
        group_id=entry['spec'].get('groupId')
        if group_id:
            group=groups[group_id]
            entry['baseline']=_external_group_snapshot(ctx,[_external_occurrence(ctx,r) for r in group['members']])
            _external_require(entry['baseline']['inventory']==m['expectedInventory'][entry['spec']['itemId']],'Declared group inventory differs')
            path=entry['originals'][0].fullPathName.rsplit('+',1)[0] if '+' in entry['originals'][0].fullPathName else ''
            pose=list(_external_entity_occurrence_matrix(ctx,_external_occurrence(ctx,{'path':path}))) if path else list(adsk.core.Matrix3D.create().asArray())
            entry['instanceMap']=[{'source':None,'token':None,'definition':group['id'],'path':path,'worldPose':pose,
                'attributes':[],'nativeAttributes':[],'grounded':False,'groundToParent':False}]
    return runtime


def _external_result(status: "str",cursor: "int",**values: "JsonValue") -> "JsonObject":
    return {'status':status,'receipt':{'cursor':cursor,**values}}


def _external_copy(runtime: "_ExternalRuntime",data: "_ExternalStepData",entry: "_ExternalItemState",cursor: "int") -> "JsonObject":
    spec=entry['spec'];ctx=runtime['source']
    if spec.get('dataFileId'):
        return _external_result('notApplicable',1,reuse=_external_pin_json(entry['targetPin']),reason='exactPinnedReuse')
    if entry['definitionOwner']!=spec['itemId']:
        owner=runtime['items'][entry['definitionOwner']]
        if owner['targetPin'] is None:return _external_result('blocked',cursor,reason='sharedDefinitionCopyPending')
        entry['targetPin']=owner['targetPin']
        return _external_result('complete',1,reuse=_external_pin_json(entry['targetPin']),sharedDefinitionOwner=entry['definitionOwner'])
    if spec.get('groupId'):
        return _external_group_copy(runtime,data,entry,cursor)
    if cursor==0:
        effects=_external_activate(ctx)
        destination=_external_file_destination(spec)
        folder=_external_folder(ctx.app,destination);_external_collision(folder,destination['fileName'])
        component=_external_cast('adsk.fusion.Component',entry['component'])
        return _external_with_lifecycle(_external_begin_copy(runtime,data,entry,ctx,component,
            destination,folder,'component','future',cursor),effects)
    return _external_future(entry,cursor,_external_file_destination(spec))


def _external_copy_events(job: "_ExternalCopyJob") -> "_ExternalCopyObservation":
    rows=[row for row in job['events'] if _external_event_matches(job['intent'],row)]
    ids={row['fileId'] for row in rows}
    if len(ids)>1:return {'status':'unknown','reason':'copyNonceMatchedMultipleFiles'}
    if any(row['status'].get('isError') is True for row in rows):
        return {'status':'failed','reason':'copyCompletionEventFailed'}
    # DataEventArgs properties are not populated on every event. Status is a
    # diagnostic, not the completion proof: exact nonce-bound identity plus a
    # fresh DataFile.isComplete read supplies that independently below.
    versions={row['version'] for row in rows}
    if len(versions)>1:return {'status':'unknown','reason':'copyCompletionEventVersionDrift'}
    if job.get('observationFailed'):return {'status':'unknown','reason':'copyCompletionEventReadbackFailed'}
    if not rows:return {'status':'pending'}
    return {'status':'correlated','fileId':rows[0]['fileId'],'version':rows[0]['version'],
            'events':_external_cast('list[JsonObject]',rows)}


def _external_capture_copy_status(args: "adsk.core.DataEventArgs") -> "_ExternalCopyStatus":
    row: '_ExternalCopyStatus'={'status':{},'statusReadContext':'notify'};field='args.isValid'
    try:
        _external_require(args.isValid,'Completion event arguments are no longer valid')
        field='args.status';status=_external_cast('_ExternalStatusView',args.status)
        field='status.isError';row['status']['isError']=bool(status.isError)
        field='status.isWarning';row['status']['isWarning']=bool(status.isWarning)
        field='status.isOK';row['status']['isOK']=bool(status.isOK)
    except Exception as error:
        row['statusReadError']=type(error).__name__+': '+str(error)
        row['statusReadErrorAt']=field
    return row


def _external_copy_disarm(job: "_ExternalCopyJob") -> "None":
    if job.get('disarmed'):return
    for event,handler in job['handlers']:
        _external_require(event.remove(handler),'Unable to remove this copy completion handler')
    job['disarmed']=True


def _external_begin_copy(runtime: "_ExternalRuntime",data: "_ExternalStepData",entry: "_ExternalItemState",ctx: "CadContext",component: "adsk.fusion.Component",destination: "_ExternalFileDestination",folder: "adsk.core.DataFolder",purpose: "str",slot: "str",cursor: "int") -> "JsonObject":
    elapsed=(_external_time.monotonic()-data.get('_copyStepStartedAt',_external_time.monotonic()))*1000
    available=min(data.get('remainingMs',0),data.get('copyRpcBudgetMs',54000))-elapsed-2000
    if available<=0:return _external_result('pending',cursor,stopReason='budgetExhausted',reason='budgetExhausted')
    intent=data.get('copyIntent')
    if not intent:return {**_external_result('blocked',cursor,notStarted=True,reason='Missing durable new-copy intent'),'notStarted':True}
    _external_require(intent['operationId']==data['operationId'] and intent['itemId']==entry['spec']['itemId'] and
        intent['purpose']==purpose and intent['destination']==destination,'Copy intent differs from the declared native action')
    pin=intent['source'];actual=_external_required_data_file(ctx.doc)
    _external_require(actual.id==pin['fileId'] and actual.versionNumber==pin['version'] and
        actual.parentProject.id==pin['projectId'] and (not pin.get('creationId') or ctx.doc.creationId==pin.get('creationId')),
        'Copy intent source differs from the exact saved source')
    _external_require(len(intent['nonce'])==64 and all(c in '0123456789abcdef' for c in intent['nonce']) and
        intent['description']==intent['finalDescription']+' [fmcad-copy:'+intent['nonce']+']','Invalid private copy nonce description')
    if purpose=='component':
        selection=_external_cast('_ExternalOccurrenceReference',entry['spec'].get('selection'))
        _external_require(intent['component']==selection and component==entry.get('component'),
                          'Copy component binding differs')
    elif purpose=='groupParent':
        group_id=_external_cast('str',entry['spec'].get('groupId'))
        extraction_groups=data['manifest'].get('extractionGroups',[])
        group=next(g for g in extraction_groups if g['id']==group_id)
        _external_require(intent['component']=={'parentOf':group['members']},'Group parent binding differs')
    else:
        component_ref=_external_cast('_ExternalCopyComponentToken',intent['component'])
        _external_require(component.entityToken==component_ref['token'],'Staged group component binding differs')
    _external_require(entry.get(slot) is None and entry.get(slot+'Observer') is None,'Copy was already submitted or armed; no replay')
    job: '_ExternalCopyJob'={'intent':intent,'events':[],'handlers':[],'diagnostics':[],
        'disarmed':False,'submitted':False}
    entry[slot+'Observer']=job
    class Handler(adsk.core.DataEventHandler):
        def __init__(self,event_name: "str") -> "None":
            super().__init__();self.event_name=event_name
        def notify(self,eventArgs: "adsk.core.DataEventArgs") -> "None":
            correlated=False;field='file'
            try:
                file=_external_event_file(eventArgs)
                if file is None:return
                field='scope';project_id=file.parentProject.id;folder_id=file.parentFolder.id
                if project_id!=destination['projectId'] or folder_id!=destination['folderId']:return
                field='description';description=file.description
                if description!=intent['description']:return
                correlated=True
                field='fileIdentity'
                row: '_ExternalCopyEvent'={'event':self.event_name,'fileId':file.id,'version':int(file.versionNumber),
                    'projectId':project_id,'folderId':folder_id,'name':file.name,
                    'description':description,'isComplete':bool(file.isComplete),'status':{}}
                if len(job['events'])>=32:raise ValueError('Copy completion event observation limit exceeded')
                job['events'].append(row)
                # Snapshot primitives during dispatch; event args and Status
                # wrappers have no documented lifetime after notify returns.
                status_fields=_external_cast('_ExternalCopyEvent',_external_capture_copy_status(eventArgs))
                row.update(status_fields)
            except Exception as error:
                if correlated:job['observationFailed']=True
                if len(job['diagnostics'])<32:job['diagnostics'].append(self.event_name+': '+field+': '+type(error).__name__+': '+str(error))
    try:
        for name in ('dataFileComplete','dataFileCopyComplete'):
            event=_external_data_event(ctx.app,name);handler=Handler(name)
            _external_require(event.add(handler),'Copy completion event registration failed')
            job['handlers'].append((event,handler))
    except Exception:
        _external_copy_disarm(job)
        raise
    before=_external_fingerprint(ctx);started=_external_time.monotonic()
    job['submitted']=True
    entry[slot]=component.saveCopyAs(destination['fileName'],folder,intent['description'],'')
    future_value=entry.get(slot)
    _external_require(future_value is not None,'Native copy submission returned no future')
    future=_external_cast('adsk.core.DataFileFuture',future_value)
    deadline=started+min(30000,available)/1000
    while _external_time.monotonic()<deadline:
        adsk.doEvents()
        if _external_future_upload_state(future)!=adsk.core.UploadStates.UploadProcessing or job['events']:break
        _external_time.sleep(.1)
    _external_require(_external_fingerprint(ctx)==before,'Copy submission changed the saved source')
    upload_state=_external_future_upload_state(future)
    return {**_external_result('pending',cursor+1,accepted=True,copyIntent=_external_cast('JsonValue',intent),
        initiatingPumpMs=int((_external_time.monotonic()-started)*1000),sourceUnchanged=True),
        'uploadStatus':'pending','rawUploadState':{'value':upload_state,'name':str(_external_future_upload_state(future))},
        'lifecycleEffects':[{'action':'copyObserverArmed','nonce':intent['nonce'],
            'events':['dataFileComplete','dataFileCopyComplete'],'owned':True}]}


def _external_future(entry: "_ExternalItemState | _ExternalFutureEntry",cursor: "int",destination: "_ExternalFileDestination") -> "JsonObject":
    future=entry.get('future')
    job=entry.get('futureObserver')
    observed: _ExternalCopyObservation=_external_copy_events(job) if job is not None else {'status':'pending'}
    raw=_external_cast('int | None',future.uploadState) if future is not None else None
    upload_states=_external_cast('_ExternalUploadStateValues',adsk.core.UploadStates)
    descriptor={'value':raw,'name':str(raw)} if raw is not None else None
    event_diagnostic=observed.get('reason')
    primary_only=(raw==upload_states.UploadFinished and
        observed.get('reason')=='copyCompletionEventReadbackFailed')
    if observed['status']=='failed' and raw==upload_states.UploadFinished:
        return {**_external_result('unknown',cursor,reason='Contradictory native copy receipts'),'uploadStatus':'unknown','rawUploadState':descriptor}
    if observed['status'] in ('unknown','failed') and not primary_only:
        if observed['status']=='failed' and job is not None:_external_copy_disarm(job)
        return {**_external_result(observed['status'],cursor,reason=observed.get('reason',''),
                                   copyEvents=_external_cast('JsonValue',job['events']) if job is not None else []),
            'uploadStatus':observed['status'],'rawUploadState':descriptor}
    event_file=None
    if observed['status']=='correlated':
        correlated=_external_cast('_ExternalCorrelatedCopyObservation',observed)
        event_file=_external_find_file(adsk.core.Application.get(),correlated['fileId'])
        if event_file is None:raise ValueError('Correlated copy file is missing')
        _external_require(event_file.id==correlated['fileId'] and
            int(event_file.versionNumber)==correlated['version'],'Correlated copy file identity/version changed')
    if raw==upload_states.UploadFailed and event_file is not None:
        return {**_external_result('unknown',cursor,reason='Contradictory native copy receipts'),'uploadStatus':'unknown','rawUploadState':descriptor}
    if raw==upload_states.UploadFailed:
        if job:_external_copy_disarm(job)
        return {**_external_result('failed',cursor,reason='nativeUploadFailed'),'uploadStatus':'failed','rawUploadState':descriptor}
    if raw==upload_states.UploadProcessing and event_file is None:
        return {**_external_result('pending',cursor,accepted=True),'uploadStatus':'pending','rawUploadState':descriptor,'waitingPublication':True}
    if future is None and event_file is None:return {**_external_result('unknown',cursor,reason='lostNativeFuture'),'uploadStatus':'unknown'}
    if raw not in (None,upload_states.UploadFinished,upload_states.UploadProcessing):
        return {**_external_result('unknown',cursor,reason='unrecognizedNativeUploadState'),'uploadStatus':'unknown','rawUploadState':descriptor}
    file=_external_future_data_file(future) if raw==upload_states.UploadFinished and future is not None else event_file
    if file is None:raise ValueError('Completed future has no data file')
    if event_file is not None:
        correlated=_external_cast('_ExternalCorrelatedCopyObservation',observed)
        _external_require(file.id==event_file.id and file.versionNumber==correlated['version'],'Future and event copy identity differ')
    _external_require(file.parentProject.id==destination['projectId'] and
        file.parentFolder.id==destination['folderId'] and file.name==destination['fileName'],'Copy future resolved wrong immutable identity')
    if job:_external_require(file.description==job['intent']['description'],'Copy nonce description readback differs')
    entry['targetPin']=_external_pin(file)
    if not file.isComplete:
        _external_refresh_file(file)
        return {**_external_result('pending',cursor,target=_external_pin_json(entry['targetPin'])),'uploadStatus':'pending','rawUploadState':descriptor,'waitingPublication':True}
    if job:
        job['filePin']=entry['targetPin'];_external_copy_disarm(job)
    return {**_external_result('complete',cursor+1,target=_external_pin_json(entry['targetPin']),
        **({'copyCompletion':{'method':'future' if raw==upload_states.UploadFinished else 'correlatedEvent',
            'intent':_external_cast('JsonValue',job['intent']),
            'events':_external_cast('JsonValue',job['events']),
            'rawUploadState':descriptor,'observerDisarmed':job['disarmed'],
            'descriptionVerified':True,'eventQualification':observed['status'],
            'eventDiagnostic':event_diagnostic,'diagnostics':job['diagnostics']}} if job else {})),
        'uploadStatus':'complete','rawUploadState':descriptor,
        **({'lifecycleEffects':[{'action':'copyObserverDisarmed','nonce':job['intent']['nonce'],'owned':True}]} if job else {})}


def _external_verify(runtime: "_ExternalRuntime",data: "_ExternalStepData",entry: "_ExternalItemState",cursor: "int") -> "JsonObject":
    phase=data['phase'];pin=_external_cast('_ExternalPin',entry.get('targetPin'));ctx=runtime['source']
    effects: list[JsonObject]=[]
    baseline_value=entry.get('baseline')
    if baseline_value is not None and cursor>=len(baseline_value['bodies'])+1:
        return _external_probe_step(runtime,data,entry,cursor)
    if phase=='verify:sources':
        file=_external_project_file(ctx.app,pin['projectId'],pin['fileId'],pin['version'])
        if not _external_refresh_complete(file):
            return {**_external_result('pending',cursor,target=_external_pin_json(_external_pin(file)),reason='pendingPublication'),
                    'waitingPublication':True}
        doc,lifecycle=_external_document(ctx.app,pin,allow_open=True,readonly=data.get('outerReadOnly',False),editable=False)
        if doc is None:return _external_result('blocked',cursor,reason=lifecycle)
        lifecycle_effects=_external_lifecycle_effects(lifecycle)
        effects=lifecycle_effects;component=_external_ctx(doc).root
        _external_health(component)
        # A declared group already inspected Combine owners in its isolated
        # parent copy. Do not roll (and dirty) the final child during read-only
        # verification; exact history/geometry and declared driver checks follow.
        grouped_coverage=bool(entry['spec'].get('groupId') and entry.get('groupDependencyCoverage'))
        _external_dependency_coverage(component,[component],defer_combine=grouped_coverage)
        entry['targetDoc']=doc
        if entry['baseline'] is None:
            _external_require(_external_inventory(component)==data['manifest']['expectedInventory'][entry['spec']['itemId']],'Reused source inventory differs')
            entry['baseline']=_external_snapshot(component)
    else:
        _external_require(entry['staged'],'Assembly verification requires actual staged instances')
        component=entry['staged'][0].component
        if entry['spec'].get('groupId'):_external_group_context_attributes(ctx,entry)
    baseline_value=entry.get('baseline')
    if baseline_value is None:raise ValueError('Assembly verification baseline is unavailable')
    baseline=baseline_value
    count=len(baseline['bodies'])+1
    if cursor<count:
        check=_external_compare(baseline,component,cursor,runtime['tolerance'],entry['spec'])
        probes=[p for p in data['manifest'].get('probes',[]) if p['itemId']==entry['spec']['itemId'] and
                p.get('scope','assembly')==phase.split(':')[1]]
        return {**_external_result('pending' if cursor+1<count or probes else 'complete',cursor+1,
            checks=_external_cast('JsonValue',[check]),
            sourceFingerprint=runtime['sourceFingerprint'],target=_external_pin_json(pin),
            remainingCheckIds=['body:'+str(i) if i<len(baseline['bodies']) else 'history:poses:attributes' for i in range(cursor+1,count)]),
            'completedChecks':1,'lifecycleEffects':effects}
    return _external_probe_step(runtime,data,entry,cursor)


def _external_activate(ctx: "CadContext") -> "list[JsonObject]":
    _external_require(ctx.app.userInterface.activeCommand in ('','SelectCommand'),'Interactive command active')
    if ctx.app.activeDocument==ctx.doc:return []
    identity=_external_document_identity(ctx.doc)
    _external_require(ctx.doc.activate() and ctx.app.activeDocument==ctx.doc,'Activate exact operation-owned document')
    return [{'action':'activated','docid':ctx.doc.creationId,'openedByOperation':False,'identity':identity}]


def _external_with_lifecycle(result: "JsonObject",effects: "list[JsonObject]") -> "JsonObject":
    if effects:
        existing=result.get('lifecycleEffects') or []
        result['lifecycleEffects']=[*_external_cast('list[JsonObject]',existing),*effects]
    return result


def _external_close_owned_clean_doc(ctx: "CadContext",pin: "_ExternalPin") -> "JsonObject":
    doc=ctx.doc;app=ctx.app;file=_external_document_data_file(doc)
    _external_require(doc.isValid and file is not None and
        file.id==pin['fileId'] and int(file.versionNumber)==int(pin['version']) and
        file.isComplete is True and file.isReadOnly is False and doc.isModified is False,
        'Driver probe may close only its exact saved, complete, clean editable consumer')
    _external_require(app.userInterface.activeCommand in ('','SelectCommand'),
                      'Interactive command active; retain the owned consumer editor')
    same_file=[candidate for candidate in _external_items(app.documents)
        if getattr(getattr(candidate,'dataFile',None),'id',None)==pin['fileId'] and
        int(candidate.dataFile.versionNumber)==int(pin['version'])]
    _external_require(len(same_file)==1 and same_file[0].creationId==doc.creationId,
                      'Duplicate consumer editor context; no close by title or file ID')
    identity=_external_document_identity(doc)
    _external_require(doc.close(False) is True,'Close exact owned clean consumer editor returned false')
    _external_require(not any(candidate.creationId==identity['creationId'] and
        getattr(getattr(candidate,'dataFile',None),'id',None)==pin['fileId']
        for candidate in _external_items(app.documents)),
        'Exact owned consumer editor remains after close request')
    return {'action':'closed','docid':identity['creationId'],'openedByOperation':False,
            'identity':identity,'owned':True}


def _external_target(runtime: "_ExternalRuntime",data: "_ExternalStepData") -> "tuple[CadContext, list[JsonObject]]":
    m=data['manifest'];source=runtime['source']
    if m['mode']!='composeNew':return source,[]
    if runtime['target'] is not None:
        _external_require(runtime['target'].doc.isValid,'Created target handle lost; no second target')
        return runtime['target'],[]
    _external_require(not data.get('outerReadOnly'),'Read-only caller forbids target creation')
    compose_manifest=_external_cast('_ExternalComposeNewManifest',m)
    destination=compose_manifest['destinationDocument']
    folder=_external_folder(source.app,destination);_external_collision(folder,destination['name'])
    document_type=_external_cast('adsk.core.DocumentTypes',adsk.core.DocumentTypes.FusionDesignDocumentType)
    doc=_external_new_document(source.app.documents,document_type)
    _external_require(doc is not None,'New target creation unconfirmed')
    doc=_external_cast('adsk.core.Document',doc)
    # Retain the exact new identity before any subsequent cloud submission.
    target_ctx=_external_ctx(doc)
    runtime['target']=target_ctx;runtime['targetCreationId']=doc.creationId
    design=target_ctx.design
    parametric_type=_external_cast(
        'adsk.fusion.DesignTypes',adsk.fusion.DesignTypes.ParametricDesignType)
    if design.designType!=parametric_type:
        design.designType=parametric_type
    _external_require(design.designType==parametric_type,
                      'composeNew requires a native parametric target design')
    return target_ctx,[{'action':'created','docid':doc.creationId,'createdByOperation':True,
                               'identity':{'creationId':doc.creationId,'fileId':None}}]


def _external_stage_insert_plan(ctx: "CadContext",source_ctx: "CadContext",spec: "_ExternalItemSpec",mapping: "list[_ExternalInstanceMap]",index: "int",tolerance: "_ExternalTolerance") -> "_ExternalInsertPlan":
    destination=spec.get('destinationOccurrence','root')
    request: _ExternalDestinationPlan={'destination':destination,
        'sharedParentPolicy':spec.get('sharedParentPolicy','reject')}
    placement=spec.get('placement')
    if placement is not None:
        request.update(placement=placement,placementSpace=spec.get('placementSpace'))
    parent,parent_occ,base_matrix,parent_paths=_external_destination(ctx,request)
    parents: list[tuple[str,adsk.fusion.Occurrence | None]]=[
        (path,_external_destination_parent(ctx,path)) for path in parent_paths]
    source_by_parent: dict[str,int]={}
    if mapping and len(parent_paths)>1 and len(mapping)>1:
        _external_require(len(mapping)==len(parent_paths),
                          'Repeated destination context needs one selected source instance per target parent')
        used: set[int]=set()
        for path,target_parent in parents:
            matches: list[int]=[i for i,row in enumerate(mapping)
                     if _external_parent_context_match(source_ctx,ctx,target_parent,row)]
            _external_require(len(matches)==1 and matches[0] not in used,
                              'Repeated destination parents require unique native context or callerNamespaces mapping')
            source_by_parent[path]=matches[0];used.add(matches[0])
        _external_require(len(used)==len(mapping),'Repeated destination map omitted a selected source context')
    elif mapping and len(parent_paths)==1 and len(mapping)>1:
        _external_require(index<len(mapping),'Selected source instance map exhausted')
        source_by_parent[parent_paths[0]]=index
    elif mapping:
        for path in parent_paths:source_by_parent[path]=0

    placement_world=_external_assembly_matrix(ctx,placement).asArray() if placement is not None else None
    local_by_parent: list[tuple[str,list[int | float],list[int | float]]]=[]
    for path,target_parent in parents:
        parent_world: list[int | float]=(list(_external_entity_occurrence_matrix(ctx,target_parent))
            if target_parent is not None else list(adsk.core.Matrix3D.create().asArray()))
        if placement is not None and spec.get('placementSpace')=='root' and target_parent is not None:
            local=_external_entity_multiply(_external_entity_inverse(parent_world),
                _external_cast('list[int | float]',placement_world))
        elif placement is not None:
            local=_external_cast('list[int | float]',placement_world)
        elif mapping:
            row=mapping[source_by_parent[path]]
            local=_external_entity_multiply(_external_entity_inverse(parent_world),row['worldPose'])
        else:
            local=list(_external_cast('adsk.core.Matrix3D',base_matrix).asArray())
        local_by_parent.append((path,local,parent_world))
    _external_require(bool(local_by_parent),'Destination has no authorized parent contexts')
    matrix: list[int | float]=local_by_parent[0][1]
    for path,local,parent_world in local_by_parent[1:]:
        linear,angular=_external_pose_delta(matrix,local)
        _external_require(linear<=tolerance['linear'] and angular<=tolerance['angular'],
                          'Shared parent contexts require incompatible local transforms; split the mapping')
    expected_world: dict[str,list[int | float]]={
        path:_external_entity_multiply(parent_world,matrix) for path,local,parent_world in local_by_parent}
    return {'destination':destination,'parentPaths':parent_paths,'sourceByParent':source_by_parent,
            'matrix':_external_entity_matrix(matrix),'expectedWorld':expected_world}


def _external_stage(runtime: "_ExternalRuntime",data: "_ExternalStepData",entry: "_ExternalItemState",cursor: "int") -> "JsonObject":
    ctx,effects=_external_target(runtime,data);effects.extend(_external_activate(ctx))
    if effects:return {**_external_result('pending',cursor+1,targetCreationId=ctx.doc.creationId),'lifecycleEffects':effects}
    if not runtime.get('bindingsCreated'):
        return _external_with_lifecycle(_external_bindings_stage(runtime,data,entry,cursor),effects)
    if data['manifest']['mode']=='replaceExternal':
        return _external_with_lifecycle(_external_replace_stage(runtime,data,entry,cursor),effects)
    index=len(entry['staged']);spec=entry['spec'];mapping=entry['instanceMap']
    if index<max(1,len(mapping)):
        placement=spec.get('placement');space=spec.get('placementSpace')
        try:plan=_external_stage_insert_plan(ctx,runtime['source'],spec,mapping,index,runtime['tolerance'])
        except Exception as error:
            return _external_with_lifecycle(_external_result('blocked',cursor,notStarted=True,
                reason='stageInsertPreflight: '+type(error).__name__+': '+str(error)),effects)
        target_pin=_external_cast('_ExternalPin',entry.get('targetPin'))
        payload=_external_cast('JsonObject',{'source':{'dataFileId':target_pin['fileId'],'version':target_pin['version']},
                 'destination':plan['destination'],'sharedParentPolicy':spec.get('sharedParentPolicy','reject'),'confirm':True}
                 )
        if placement is not None:payload.update(placement=placement,placementSpace=space)
        context_file=_external_document_data_file(ctx.doc)
        if context_file is not None:
            destination_project=context_file.parentProject.id
        else:
            destination_project=_external_cast(
                '_ExternalComposeNewManifest',data['manifest'])['destinationDocument']['projectId']
        try:inserted=_external_insert_matrix(ctx,payload,plan['matrix'],destination_project)
        except Exception as error:
            return _external_with_lifecycle(_external_result('blocked',cursor,notStarted=True,
                reason='stageInsertPreflight: '+type(error).__name__+': '+str(error)),effects)
        if inserted['status']!='complete':
            state='unknown' if inserted['status']=='unknown' else 'failed'
            return _external_with_lifecycle(_external_result(state,cursor+1,partial=inserted.get('partial') is True,
                                    insertion=_external_cast('JsonValue',inserted),noReplay=True),effects)
        completed_insert=_external_cast('_ExternalCompletedInsertResult',inserted)
        actuals: list[adsk.fusion.Occurrence]=[
            _external_occurrence(ctx,ref) for ref in completed_insert['occurrences']]
        entry['staged'].extend(actuals)
        try:
            for actual in actuals:
                parent_path=actual.fullPathName.rsplit('+',1)[0] if '+' in actual.fullPathName else ''
                _external_require(parent_path in plan['expectedWorld'],'Inserted occurrence has no explicit destination context receipt')
                if mapping:
                    if len(mapping)==1:row=mapping[0]
                    else:
                        source_index=plan['sourceByParent'].get(parent_path)
                        _external_require(source_index is not None,'Inserted occurrence has no source-context map')
                        row=mapping[_external_cast('int',source_index)]
                    _external_ensure_attributes(actual,row['attributes'])
                    native=getattr(actual,'nativeObject',None) or actual
                    _external_ensure_attributes(native,row['nativeAttributes'])
                    actual.isGrounded=row['grounded'];actual.isGroundToParent=row['groundToParent']
                expected_world=plan['expectedWorld'][parent_path]
                linear,angular=_external_pose_delta(expected_world,list(_external_entity_occurrence_matrix(ctx,actual)))
                _external_require(linear<=runtime['tolerance']['linear'] and angular<=runtime['tolerance']['angular'],
                                  'Staged world pose differs from the exact source/destination transform mapping')
            if spec.get('groupId'):_external_group_context_attributes(ctx,entry,apply=True)
        except Exception as error:
            return _external_with_lifecycle(_external_result('failed',cursor+1,partial=True,
                insertion=_external_cast('JsonValue',inserted),stagedRefs=[ctx.ref(o) for o in actuals],
                postcheckError=type(error).__name__+': '+str(error),noReplay=True),effects)
        return _external_with_lifecycle(_external_result('pending',cursor+1,instanceMap=[ctx.ref(o) for o in entry['staged']]),
                                        [*effects,*(_external_lifecycle_effects(
                                            _external_cast('JsonObject',inserted)))])
    needed: set[str]={item_id for row in _external_boundary_states(runtime)
        for endpoint in row['spec']['endpoints'] if (item_id:=endpoint.get('itemId')) is not None}
    awaiting=[item_id for item_id in needed if not runtime['items'][item_id]['staged']]
    if awaiting:return _external_with_lifecycle({**_external_result('pending',cursor+1,localStaged=True,awaitingItems=awaiting),'defer':True},effects)
    if all(e['staged'] for e in runtime['items'].values()):
        for row in _external_boundary_states(runtime):
            if row.get('new') is None:
                before: dict[str,list[int | float]]=_assembly_pose_snapshot(ctx)
                row['rebuildBeforePoses']=before;row['rebuildStepId']=data['stepId']
                joint=_external_rebuild_joint(runtime,ctx,row)
                _external_require(ctx.design.computeAll(),'Boundary recompute failed')
                after=_assembly_pose_snapshot(ctx)
                _external_require(set(before)==set(after),'Boundary changed occurrence inventory')
                for key in before:
                    linear,angular=_external_pose_delta(before[key],after[key])
                    _external_require(linear<=runtime['tolerance']['linear'] and angular<=runtime['tolerance']['angular'],'Boundary moved protected nominal pose')
                return _external_with_lifecycle(_external_result('pending',cursor+1,boundary=joint,
                    positionSnapshot=row.get('positionSnapshot')),effects)
        runtime['boundariesCreated']=True
    _external_require(ctx.design.computeAll(),'Stage recompute failed')
    entry['stagedRefs']=[_external_cast('_ExternalOccurrenceReference',ctx.ref(o)) for o in entry['staged']]
    return _external_with_lifecycle(_external_result('complete',cursor+1,localStaged=True,awaitingItems=[],
        instanceMap=_external_cast('JsonValue',entry['stagedRefs']),targetCreationId=ctx.doc.creationId),effects)


def _external_retire(runtime: "_ExternalRuntime",data: "_ExternalStepData",entry: "_ExternalItemState",cursor: "int") -> "JsonObject":
    _external_require(data['manifest']['mode'] in ('copyAndReplace','replaceFromExisting'),'Retire not applicable')
    ctx=runtime['source'];lifecycle_effects=_external_activate(ctx)
    for row in sorted(_external_boundary_states(runtime),key=lambda r:r['old'].timelineObject.index if r['old'].isValid else -1,reverse=True):
        if not row['detached'] and any(e.get('itemId')==entry['spec']['itemId'] for e in row['spec']['endpoints']):
            new_joint=row.get('new')
            _external_require(new_joint is not None and new_joint.isValid,'Mapped replacement boundary is not verified')
            deletion=_external_delete_joint_checkpoint(ctx,row['old'],row['token'])
            if deletion['status']!='removed':
                return _external_with_lifecycle(_external_result('failed',cursor+1,partial=bool(entry.get('retiredCount',0) or
                    any(boundary['detached'] for boundary in _external_boundary_states(runtime))),removedJoint=row['token'],
                    deletion=deletion,noReplay=True),lifecycle_effects)
            row['detached']=True;return _external_with_lifecycle(_external_result('pending',cursor+1,removedJoint=row['token']),lifecycle_effects)
    originals=entry['originals'];retire_map=entry.get('retireMap',entry['instanceMap'])
    retired=entry.setdefault('retiredIndices',set(range(entry.get('retiredCount',0))))
    remaining=[i for i in range(len(originals)) if i not in retired]
    if remaining:
        index=remaining[0]
        old=originals[index]
        _external_require(old.isValid and not old.isReferencedComponent,'Retire requires mapped original local instance')
        captured=retire_map[index]
        native=getattr(old,'nativeObject',None) or old
        peers=[i for i in remaining if originals[i].isValid and
               (getattr(originals[i],'nativeObject',None) or originals[i])==native]
        deletion=_external_delete_occurrence_checkpoint(
            ctx,_external_cast('adsk.fusion.Occurrence',native),captured)
        if deletion['status']!='removed':
            return _external_with_lifecycle(_external_result('failed',cursor+1,partial=bool(index or any(boundary['detached'] for boundary in _external_boundary_states(runtime))),
                removedToken=captured['token'],deletion=deletion,noReplay=True),lifecycle_effects)
        absent=[i for i in peers if not _external_occurrence_present(ctx,retire_map[i])]
        _external_require(len(absent)==len(peers),'Shared native retirement did not remove every authorized context')
        retired.update(absent);entry['retiredCount']=len(retired)
        return _external_with_lifecycle(_external_result('pending',cursor+1,removedToken=captured['token'],
            removedTokens=[retire_map[i]['token'] for i in absent],
            reconciledAfterException=deletion['reconciledAfterException']),lifecycle_effects)
    return _external_with_lifecycle(_external_result('complete',cursor,removed=[row['token'] for row in retire_map]),lifecycle_effects)


def _external_finalize(runtime: "_ExternalRuntime",data: "_ExternalStepData",entry: "_ExternalItemState",cursor: "int") -> "JsonObject":
    ctx=runtime['target'] or runtime['source'];lifecycle_effects=_external_activate(ctx)
    baseline=_external_cast('_ExternalSnapshot',entry.get('baseline'))
    _external_require(data['manifest'].get('save') is True,'Finalize requires authorized save')
    if cursor==0:
        lifecycle_effects.extend(_external_verify_copy_descriptions(ctx,entry))
        for row in _external_boundary_states(runtime):
            if not any(e.get('itemId')==entry['spec']['itemId'] for e in row['spec']['endpoints']):continue
            joint_value=row.get('new')
            _external_require(joint_value is not None,'Verified boundary missing at finalize')
            joint=_external_cast('_ExternalNamedBoundaryJoint',joint_value)
            _external_require(joint.isValid,'Verified boundary missing at finalize')
            if data['manifest']['mode'] in ('copyAndReplace','replaceFromExisting'):
                _external_require(not _external_joint_present(ctx,row['token']),'Original boundary remains before final naming')
            others=[j for collection in (ctx.root.joints,ctx.root.asBuiltJoints) for j in _external_items(collection)
                    if j!=joint and j.name==row['name']]
            _external_require(not others,'Final boundary name collides with an unrelated joint')
            joint.name=row['name'];_external_require(joint.name==row['name'],'Final boundary name readback differs')
            _external_boundary_readback(runtime,ctx,row)
        final_name=entry['spec'].get('name')
        if final_name:
            for occurrence in entry['staged']:
                _external_cast('_ExternalNamedOccurrence',occurrence).name=final_name
        for occurrence in entry['staged']:_external_health(occurrence.component)
        return _external_with_lifecycle(_external_result('pending',1,namingComplete=True),lifecycle_effects)
    # Finalize's post-metadata checks obey the same per-check bound as verify.
    per_instance=len(baseline['bodies'])+1
    count=per_instance*len(entry['staged'])
    if 1<=cursor<=count:
        occurrence=entry['staged'][(cursor-1)//per_instance]
        check=_external_cast('_ExternalComparisonCheck',_external_compare(
            baseline,occurrence.component,(cursor-1)%per_instance,runtime['tolerance'],entry['spec']))
        check['checkId']='final:'+str(cursor-1)+':'+check['checkId']
        return _external_with_lifecycle({**_external_result('pending',cursor+1,
            checks=_external_cast('JsonValue',[check])),'completedChecks':1},lifecycle_effects)
    if cursor==count+1:
        document_file=_external_document_data_file(ctx.doc)
        before=document_file.versionNumber if document_file is not None else 0
        runtime['saveBaseline']=before
        if document_file is not None:
            if not ctx.doc.isModified:return _external_with_lifecycle(
                _external_result('complete',cursor+1,file=_external_pin_json(_external_pin(document_file)),unchanged=True),lifecycle_effects)
            runtime['saveAttempted']=True;runtime['saveFileId']=document_file.id
            runtime['saveProjectId']=document_file.parentProject.id
            runtime['saveCreationId']=ctx.doc.creationId
            runtime['saveContentFingerprint']=_external_content_fingerprint(ctx)
            accepted=ctx.doc.save('Externalization '+data['operationId'])
        else:
            compose_manifest=_external_cast('_ExternalComposeNewManifest',data['manifest'])
            dest=compose_manifest['destinationDocument']
            folder=_external_folder(ctx.app,dest);_external_collision(folder,dest['name'])
            target_creation_id=_external_cast('str',runtime.get('targetCreationId'))
            _external_require(ctx.doc.creationId==target_creation_id,'Created target identity changed')
            runtime['saveContentFingerprint']=_external_content_fingerprint(ctx)
            accepted=ctx.doc.saveAs(dest['name'],folder,'Native externalization '+data['operationId'],'')
        _external_require(accepted,'Final save not accepted')
        return _external_result('pending',cursor+1,saveAccepted=True,creationId=ctx.doc.creationId)
    file=_external_document_data_file(ctx.doc)
    save_baseline=_external_cast('int',runtime.get('saveBaseline'))
    if file is None or not file.isComplete or ctx.doc.isModified or file.versionNumber<=save_baseline:
        if file is not None:_external_refresh_file(file)
        return {**_external_result('pending',cursor,saveAccepted=True),'waitingPublication':True}
    expected=(_external_cast('_ExternalComposeNewManifest',data['manifest'])['destinationDocument']
              if data['manifest']['mode']=='composeNew' else None)
    if expected:
        _external_require(file.parentProject.id==expected['projectId'] and file.parentFolder.id==expected['folderId'] and
                          file.name==expected['name'],'Saved target is outside declared destination')
        _external_require(runtime['source'].doc.isModified is False and
            runtime['source'].doc.dataFile.id==data['manifest']['source']['fileId'],
            'composeNew must retain the unmodified original source')
    else:_external_require(file.id==data['manifest']['source']['fileId'],'Finalize changed original lineage')
    return _external_with_lifecycle(_external_result('complete',cursor+1,file=_external_pin_json(_external_pin(file)),cloudComplete=True,
        targetTimeline=ctx.design.timeline.count,retainedChildHistory=baseline['inventory']['history'],
        sourceUnchanged=data['manifest']['mode']!='composeNew' or runtime['source'].doc.isModified is False,
        referenceHelpers=runtime.get('referenceHelpers',[])),lifecycle_effects)


def _external_verify_copy_descriptions(ctx: "CadContext",entry: "_ExternalItemState") -> "list[JsonObject]":
    effects: list[JsonObject]=[]
    copies=(('future',entry.get('targetPin'),entry.get('futureObserver')),
            ('groupParentFuture',entry.get('groupParentPin'),entry.get('groupParentFutureObserver')))
    for slot,pin_value,job in copies:
        if job is None:continue
        copy_pin=job.get('filePin')
        _external_require(pin_value is not None and copy_pin is not None,
                          'Copy metadata requires its exact confirmed file identity')
        pin=_external_cast('_ExternalPin',pin_value)
        confirmed_pin=_external_cast('_ExternalPin',copy_pin)
        _external_require(confirmed_pin.get('fileId')==pin['fileId'] and
            confirmed_pin.get('projectId')==pin['projectId'] and confirmed_pin['version']<=pin['version'],
            'Copy metadata requires its exact confirmed file identity')
        file=_external_project_file(ctx.app,confirmed_pin['projectId'],confirmed_pin['fileId'],confirmed_pin['version'])
        _external_require(file.isComplete,'Copy metadata owner is unavailable')
        # The description is version-specific: Document.save descriptions on
        # later owned versions do not replace the immutable copy-version marker.
        _external_require(file.description==job['intent']['description'],'Copy description changed outside this operation')
        effects.append({'action':'copyDescriptionVerified','fileId':file.id,'version':int(file.versionNumber),
            'property':'description','markerRetained':True,'owned':True})
    return effects


def _external_inspect_finalize_save(runtime: "_ExternalRuntime",data: "_ExternalOperationData | _ExternalStepData",pending: "_ExternalInspectionPending") -> "JsonObject | None":
    """Reconcile a composeNew SaveAs exception only from exact saved native readback."""
    stage='preconditions'
    try:
        manifest=data['manifest'];result=data['result']
        if manifest['mode']!='composeNew' or any(
                manifest.get(key) for key in ('parameterBindings','rootDatums','boundaries','probes')):
            return {'diagnostic':'reconciliationScopeNotQualified'}
        item_id=pending.get('itemId')
        if pending.get('phase')!='finalize' or item_id not in runtime['items']:
            return {'diagnostic':'pendingStepNotFinalSave'}
        entry=runtime['items'][item_id]
        baseline_value=entry.get('baseline')
        staged=entry.get('staged',[])
        if baseline_value is None:return {'diagnostic':'stagedCoverageMissing'}
        baseline=baseline_value
        if not staged:return {'diagnostic':'stagedCoverageMissing'}
        state=result['byItem'][item_id]['phaseResults']['finalize']
        state_receipt=_external_phase_receipt(state)
        per_instance=len(baseline['bodies'])+1;count=per_instance*len(staged)
        prior_reconciliation=(state.get('status')=='complete' and
            state_receipt.get('reconciledAfterException') is True and
            state_receipt.get('cursor')==count+2)
        if not prior_reconciliation and (state.get('status') not in ('pending','unknown') or
                state_receipt.get('cursor')!=count+1):
            return {'diagnostic':'finalChecksNotAtSaveCheckpoint'}
        expected=['final:'+str(i)+':'+('body:'+str(i%per_instance) if i%per_instance<len(baseline['bodies']) else 'history:poses:attributes')
                  for i in range(count)]
        checks=state_receipt.get('checks',[])
        if prior_reconciliation:checks=[check for check in checks if _external_cast('str',check.get('checkId','')).startswith('final:')]
        if [check.get('checkId') for check in checks]!=expected or any(check.get('passed') is not True for check in checks):
            return {'diagnostic':'finalChecksIncompleteOrFailed'}
        destination=_external_cast('_ExternalDestinationDocument',manifest.get('destinationDocument'))
        app=runtime['source'].app
        stage='readRetainedTargetDocument'
        # SaveAs can change creationId even when its retained native document
        # survives. Resolve through that exact object, never a name candidate.
        target_ctx=_external_cast('CadContext',runtime['target'])
        target=target_ctx.doc;file=_external_document_data_file(target)
        if file is None:return {'diagnostic':'savedTargetFileAbsentOrAmbiguous'}
        if (file.isComplete is not True or file.name!=destination['name'] or file.parentProject.id!=destination['projectId'] or
                file.parentFolder.id!=destination['folderId']):return {'diagnostic':'savedTargetIdentityOrCloudIncomplete'}
        if int(file.versionNumber)!=int(runtime.get('saveBaseline',0))+1:
            return {'diagnostic':'savedTargetUnexpectedVersion'}
        stage='findExactOpenTargetDocument'
        documents=_external_items(_external_cast('_CadItemCollection[adsk.core.Document]',app.documents))
        docs: list[adsk.core.Document]=[doc for doc in documents
              if doc==target and getattr(getattr(doc,'dataFile',None),'id',None)==file.id and not doc.isModified]
        if len(docs)!=1:return {'diagnostic':'savedTargetDocumentUnavailableOrAmbiguous'}
        doc=docs[0]
        if doc.isSaved is not True or doc.dataFile.versionNumber!=file.versionNumber:
            return {'diagnostic':'savedTargetDocumentVersionMismatch'}
        stage='verifyUnchangedSource'
        source=runtime['source'].doc
        if (source.isModified or source.dataFile.id!=manifest['source']['fileId'] or
                int(source.dataFile.versionNumber)!=manifest['source']['version'] or
                _external_fingerprint(runtime['source'])!=runtime['sourceFingerprint']):
            return {'diagnostic':'sourceRecoveryBaselineChanged'}
        stage='verifySavedTargetGeometry'
        target_ctx=_external_ctx(doc);_external_health(target_ctx.root)
        save_content_fingerprint=runtime.get('saveContentFingerprint')
        if save_content_fingerprint is not None and \
                _external_content_fingerprint(target_ctx)!=save_content_fingerprint:
            return {'diagnostic':'savedTargetContentChanged'}
        pin=_external_cast('_ExternalPin',entry.get('targetPin'))
        occurrences=_external_items(_external_cast(
            '_CadItemCollection[adsk.fusion.Occurrence]',target_ctx.root.allOccurrences))
        matches: list[adsk.fusion.Occurrence]=[]
        for retained in staged:
            found: list[adsk.fusion.Occurrence]=[o for o in occurrences if o==retained and o.isReferencedComponent and
                o.documentReference.dataFile.id==pin['fileId'] and int(o.documentReference.version)==pin['version']]
            if len(found)!=1 or any(found[0]==previous for previous in matches):
                return {'diagnostic':'savedTargetLinkCoverageMismatch'}
            matches.append(found[0])
        final_checks: list[JsonObject]=[]
        for instance,occurrence in enumerate(matches):
            plan=_external_stage_insert_plan(target_ctx,runtime['source'],entry['spec'],entry.get('instanceMap',[]),instance,runtime['tolerance'])
            linear,angular=_external_pose_delta(plan['expectedWorld'][''],list(_external_entity_occurrence_matrix(target_ctx,occurrence)))
            if linear>runtime['tolerance']['linear'] or angular>runtime['tolerance']['angular']:
                return {'diagnostic':'savedTargetWorldPoseChanged'}
            for check in range(per_instance):
                checked=_external_compare(baseline,occurrence.component,check,runtime['tolerance'],entry['spec'])
                final_checks.append({**checked,'instanceIndex':instance})
        if any(check.get('passed') is not True for check in final_checks):
            return {'diagnostic':'savedTargetFinalChecksFailed'}
        # Other items retain their own finalize phase, but the save checkpoint
        # covers a shared document: recheck every staged definition now.
        for other_id,other in runtime['items'].items():
            if other_id==item_id:continue
            other_baseline=other.get('baseline');other_staged=other.get('staged') or []
            if not other_staged:continue
            if other_baseline is None:return {'diagnostic':'savedTargetOtherItemIncomplete'}
            for occurrence in other_staged:
                other_pin=_external_cast('_ExternalPin',other.get('targetPin'))
                if (not occurrence.isValid or not occurrence.isReferencedComponent or
                    occurrence.documentReference.dataFile.id!=other_pin['fileId'] or
                    int(occurrence.documentReference.version)!=other_pin['version']):
                    return {'diagnostic':'savedTargetOtherItemIdentityChanged'}
                for check in range(len(other_baseline['bodies'])+1):
                    _external_compare(other_baseline,occurrence.component,check,runtime['tolerance'],other['spec'])
        identity=_external_document_identity(doc)
        if identity.get('fileId')!=file.id or identity.get('projectId')!=destination['projectId'] or \
                identity.get('version')!=file.versionNumber:return {'diagnostic':'savedTargetReadbackIdentityMismatch'}
        receipt=_external_cast('_ExternalInspectionSaveReceipt',{
            **state_receipt,'cursor':count+2,'file':_external_pin(file),
            'cloudComplete':True,'targetTimeline':target_ctx.design.timeline.count,
            'retainedChildHistory':baseline['inventory']['history'],'sourceUnchanged':True,
            'savedDocument':identity,'reconciledAfterException':True,'savedTargetFingerprint':_external_fingerprint(target_ctx),
            'checks':[*state_receipt.get('checks',[]),*[
                {**check,'checkId':'saved:'+_external_cast('str',check.get('checkId'))} for check in final_checks]]})
        return {'stepId':pending.get('stepId'),'terminal':True,
                'result':{'status':'complete','receipt':_external_cast('JsonObject',receipt)}}
    except Exception as error:
        return {'diagnostic':stage+': '+type(error).__name__+': '+str(error)}


def _external_error_site(error: "Exception") -> "list[JsonObject]":
    frames: list[JsonObject]=[];trace=error.__traceback__
    while trace is not None:
        frames.append({'function':trace.tb_frame.f_code.co_name,'line':trace.tb_lineno})
        trace=trace.tb_next
    return frames


def _external_observe_accepted_save_as(runtime: "_ExternalRuntime",data: "_ExternalStepData") -> "JsonObject | None":
    pending=runtime.get('acceptedSaveAsObservation')
    if pending is None:return None
    if data['phase']!='finalize' or data['itemId']!=pending['itemId']:
        return _external_result('blocked',0,notStarted=True,reason='Accepted SaveAs must settle before another action')
    target=_external_cast('CadContext',runtime['target'])
    doc=target.doc
    destination=_external_cast('_ExternalDestinationDocument',data['manifest'].get('destinationDocument'))
    cursor=pending['cursor']
    try:
        _external_require(doc.isValid and doc.creationId==pending['creationId'],'Accepted SaveAs native document changed')
        _external_require(_external_fingerprint(runtime['source'])==runtime['sourceFingerprint'],'Preserved source changed during SaveAs')
        save_content_fingerprint=runtime.get('saveContentFingerprint')
        _external_require(save_content_fingerprint is not None,'Accepted SaveAs lost its content fingerprint')
        _external_require(_external_content_fingerprint(target)==save_content_fingerprint,'Created target content changed during SaveAs')
        file=_external_document_data_file(doc)
        if file is None or not file.isComplete or doc.isModified:
            return {**_external_result('pending',cursor,saveAccepted=True),'waitingPublication':True}
        save_baseline=_external_cast('int',runtime.get('saveBaseline'))
        _external_require(file.parentProject.id==destination['projectId'] and file.parentFolder.id==destination['folderId'] and
            file.name==destination['name'] and int(file.versionNumber)==save_baseline+1,'Accepted SaveAs destination/version changed')
        fingerprint=_external_fingerprint(target)
    except RuntimeError as error:
        # A known accepted save is observed only; never resubmit or guess IDs.
        return {**_external_result('pending',cursor,saveAccepted=True,observationError=str(error),
            errorSite=_external_error_site(error)),'waitingPublication':True}
    except ValueError as error:
        return _external_result('blocked',cursor,notStarted=True,reason=str(error))
    runtime['targetFingerprint']=fingerprint
    runtime.pop('acceptedSaveAsObservation')
    return None


def _external_refresh_internal(action: "str",data: "_ExternalOperationData") -> "JsonObject":
    data=_external_cast('_ExternalOperationData',{
        **data,'_copyStepStartedAt':_external_time.monotonic()})
    operations=_external_registry(action!='inspect');opid=data['operationId']
    runtime=operations.get(opid)
    if action=='inspect':
        if runtime is None:
            doc,identity=_external_document(adsk.core.Application.get(),data['manifest']['source'],allow_open=False,editable=False)
            return {'status':'unavailable','terminal':False,'reason':'runtimeLost','sourceObservation':identity,'lifecycleEffects':[]}
        _external_require(runtime['requestHash']==data['requestHash'] and runtime['sessionNonce']==data['sessionNonce'],'Operation runtime identity mismatch')
        if runtime.get('preflightPending'):
            return {'status':'observed','terminal':False,'preflightPending':True,'processId':runtime.get('processId'),
                    'lifecycleEffects':[]}
        runtime=_external_cast('_ExternalRuntime',runtime)
        pending=data['result'].get('pending')
        receipt=runtime['effects'].get(pending['stepId']) if pending else None
        source_observation: JsonObject={}
        try:
            source_observation={'recordedFingerprint':runtime['sourceFingerprint'],
                'observedFingerprint':_external_fingerprint(runtime['source']),
                'identity':_external_document_identity(runtime['source'].doc)}
        except Exception as error:
            source_observation={'recordedFingerprint':runtime.get('sourceFingerprint'),
                'readbackError':type(error).__name__+': '+str(error)}
        driver_states: list[JsonObject]=[]
        for probe_id,state in runtime.get('probes',{}).items():
            if state.get('stage') not in ('refreshPlan','refreshApply','verifyConsumer'):continue
            try:
                edges=_external_current_edges(runtime['target'] or runtime['source'])
                edge_fields=('edgeId','kind','ownerFileId','sourceFileId','baselineVersion','dataFileVersion',
                    'latestVersion','versionSource','latestVersionSource','latestVersionError','getterError')
                driver_states.append(_external_cast('JsonObject',{'probeId':probe_id,'stage':state['stage'],'restoring':state.get('restoring',False),
                    'publishedVersion':state.get('publishedVersion'),'consumerAppliedVersion':state.get('consumerAppliedVersion'),
                    'targetPin':state.get('targetPin'),
                    'baselineEdges':[{k:row.get(k) for k in edge_fields} for row in state.get('baselineEdges',[])],
                    'currentEdges':[{k:row.get(k) for k in edge_fields} for row in edges]}))
            except Exception as error:
                driver_states.append({'probeId':probe_id,'stage':state['stage'],
                    'edgeReadbackError':type(error).__name__+': '+str(error)})
        if driver_states:source_observation['driverRefreshStates']=driver_states
        if not receipt or receipt.get('terminal') is not True:
            # Reconcile only this proven read-only failure site, never an
            # arbitrary exception/absence-of-change after a native submission.
            error=str((receipt or {}).get('error',''))
            if (pending and pending.get('phase')=='finalize' and
                    error=='ValueError: Copy description changed outside this operation' and
                    not runtime.get('saveAttempted') and
                    source_observation.get('observedFingerprint')==source_observation.get('recordedFingerprint')):
                entry=runtime['items'][pending['itemId']]
                state=data['result']['byItem'][pending['itemId']]['phaseResults']['finalize']
                if _external_phase_receipt(state).get('cursor')==0:
                    # This exact guard precedes all finalize metadata/model/save
                    # writes. Verify the original copy versions, never reset the
                    # failed receipt or re-submit an earlier modeling step.
                    evidence=_external_verify_copy_descriptions(runtime['target'] or runtime['source'],entry)
                    return {'status':'observed','stepId':pending['stepId'],'terminal':True,
                        'result':{**_external_result('blocked',0,notStarted=True,reason=error,
                            copyVersionEvidence=evidence),'notStarted':True},
                        'sourceObservation':source_observation,'lifecycleEffects':[], 'modelMutationSubmitted':False}
            if (pending and pending.get('phase')=='verify:assembly' and
                    error=='ValueError: Exact owned consumer editor remains after close request'):
                states=[s for s in runtime.get('probes',{}).values() if
                    s.get('stage') in ('publishObserve','restoreObserve') and
                    s.get('publishedVersion')==s.get('source',{}).get('version')]
                if len(states)==1:
                    pin=states[0]['source'];app=runtime['source'].app
                    present=[d for d in _external_items(app.documents) if
                        getattr(getattr(d,'dataFile',None),'id',None)==pin['fileId']]
                    file=_external_project_file(app,pin['projectId'],pin['fileId'],pin['version'])
                    if not present and file.isComplete and file.versionNumber==pin['version']:
                        cursor=_external_phase_receipt(
                            data['result']['byItem'][pending['itemId']]['phaseResults']['verify']['assembly']).get('cursor',0)
                        return {'status':'observed','stepId':pending['stepId'],'terminal':True,
                            'result':_external_result('pending',cursor,producerCloseObserved=True,publishedSource=_external_pin_json(pin)),
                            'sourceObservation':source_observation,'lifecycleEffects':[]}
            if (pending and pending.get('phase')=='verify:assembly' and
                    error=='ValueError: Entity token: expected one match, found 0' and
                    not runtime.get('probes') and
                    source_observation.get('observedFingerprint')==source_observation.get('recordedFingerprint')):
                entry=runtime['items'][pending['itemId']]
                cursor=_external_phase_receipt(
                    data['result']['byItem'][pending['itemId']]['phaseResults']['verify']['assembly']).get('cursor',0)
                probes=[p for p in data['manifest'].get('probes',[]) if p['itemId']==pending['itemId'] and
                        p.get('scope','assembly')=='assembly']
                baseline=_external_cast('_ExternalSnapshot',entry.get('baseline'))
                if probes and cursor==len(baseline['bodies'])+1:
                    # At this exact checkpoint token resolution occurs in the
                    # read-only check preflight, before source activation/state.
                    return {'status':'observed','stepId':pending['stepId'],'terminal':True,
                        'result':{**_external_result('blocked',cursor,notStarted=True,reason=error),'notStarted':True},
                        'sourceObservation':source_observation,'lifecycleEffects':[], 'modelMutationSubmitted':False}
            source_identity=_external_cast('JsonObject',source_observation.get('identity',{}))
            if (pending and pending.get('phase')=='stage' and
                    error.startswith('ValueError: Existing owned Derive identity is unresolved; refusing to create/reselect:') and
                    source_observation.get('observedFingerprint')==source_observation.get('recordedFingerprint') and
                    source_identity.get('modified') is False):
                cursor=_external_phase_receipt(
                    data['result']['byItem'][pending['itemId']]['phaseResults']['stage']).get('cursor',0)
                return {'status':'observed','stepId':pending['stepId'],'terminal':True,
                    'result':{**_external_result('blocked',cursor,notStarted=True,reason=error),'notStarted':True},
                    'sourceObservation':source_observation,'lifecycleEffects':[], 'modelMutationSubmitted':False}
            reconciled=_external_inspect_finalize_save(
                runtime,data,
                _external_cast('_ExternalInspectionPending',pending or {}))
            if reconciled and reconciled.get('terminal') is True:
                return {**reconciled,'status':'observed','processId':runtime['processId'],
                    'lifecycleEffects':[],'compensation':runtime['compensation']}
            if reconciled:receipt={**(receipt or {}),'inspectionDiagnostic':reconciled['diagnostic']}
        receipt_data: JsonObject=receipt if receipt is not None else {}
        return {**receipt_data,'status':'observed','processId':runtime['processId'],
                'lifecycleEffects':[],'compensation':runtime['compensation'],
                'sourceObservation':source_observation}
    step_data=_external_cast('_ExternalStepData',data)
    if runtime is None:
        prior_states=[s for item in step_data['result']['byItem'].values()
            for s in [item['phaseResults']['copy'],item['phaseResults']['stage']]]
        progressed=[s for s in prior_states if s['status']!='notStarted']
        safe_preflight=bool(progressed) and all(
            s['status']=='pending' and (s.get('receipt') or {}).get('preflightPending') is True or
            s['status']=='blocked' and (s.get('receipt') or {}).get('notStarted') is True and
                (s.get('receipt') or {}).get('cursor')==0 for s in progressed)
        if progressed and not safe_preflight:
            return _external_result('unknown',0,reason='runtimeLost; no recreation')
        try:initialized=_external_initial(step_data)
        except _ExternalTimelineRestoreError as error:return _external_result('unknown',0,reason=str(error))
        except Exception as error:return _external_result('blocked',0,reason=type(error).__name__+': '+str(error),notStarted=True)
        initial_output=_external_initial_pending(initialized)
        if initial_output is not None:
            initial_receipt=_external_result_receipt(initial_output)
            if initial_output.get('status')=='pending' and initial_receipt.get('preflightPending') is True:
                operations[opid]=_external_cast('_ExternalPreflightEntry',{
                    'requestHash':step_data['requestHash'],'sessionNonce':step_data['sessionNonce'],
                    'preflightPending':True,
                    'sourcePin':_external_cast('_ExternalPin',initial_receipt.get('sourcePin'))})
            return initial_output
        runtime=_external_cast('_ExternalRuntime',initialized)
        operations[opid]=runtime
    elif runtime.get('preflightPending'):
        try:initialized=_external_initial(step_data)
        except _ExternalTimelineRestoreError as error:return _external_result('unknown',0,reason=str(error))
        except Exception as error:return _external_result('blocked',0,reason=type(error).__name__+': '+str(error),notStarted=True)
        initial_output=_external_initial_pending(initialized)
        if initial_output is not None:
            initial_receipt=_external_result_receipt(initial_output)
            if initial_output.get('status')!='pending' or initial_receipt.get('preflightPending') is not True:
                operations.pop(opid,None)
            return initial_output
        runtime=_external_cast('_ExternalRuntime',initialized);operations[opid]=runtime
    else:
        runtime=_external_cast('_ExternalRuntime',runtime)
    _external_require(runtime['requestHash']==step_data['requestHash'] and runtime['sessionNonce']==step_data['sessionNonce'],'Immutable operation mismatch')
    step_id=step_data['stepId']
    if step_id in runtime['effects']:
        return _external_result('unknown',0,reason='Effect already submitted; inspect original receipt, never replay')
    observed=_external_observe_accepted_save_as(runtime,step_data)
    if observed is not None:
        runtime['effects'][step_id]={'stepId':step_id,'terminal':True,'result':observed}
        return observed
    initial_effects=runtime.pop('initialLifecycleEffects',[])
    entry=runtime['items'][step_data['itemId']]
    phase=step_data['phase']
    if runtime['sourceFingerprint']!=_external_fingerprint(runtime['source']):
        if phase=='finalize' and (_external_inplace_save_is_settled(runtime) or _external_inplace_save_is_pending(runtime,step_data)):
            runtime['sourceFingerprint']=_external_fingerprint(runtime['source'])
        elif phase.startswith('verify:') and _external_probe_refresh_checkpoint(runtime,step_data):
            runtime['sourceFingerprint']=_external_fingerprint(runtime['source'])
        else:
            return _external_with_lifecycle(_external_result('blocked',0,notStarted=True,
                reason='staleEvidence: source changed outside operation'),initial_effects)
    target_fingerprint=runtime.get('targetFingerprint')
    if runtime['target'] is not None and target_fingerprint is not None:
        current_target_fingerprint=_external_fingerprint(runtime['target'])
        if target_fingerprint!=current_target_fingerprint:
            saved_receipts=[row['phaseResults']['finalize'] for row in step_data['result']['byItem'].values()]
            target_save=_external_cast('_ExternalRuntime',{**runtime,'source':runtime['target']})
            reconciled=(phase=='finalize' and (_external_inplace_save_is_settled(target_save) or
                _external_inplace_save_is_pending(target_save,step_data))) or any(row['status']=='complete' and
                _external_phase_receipt(row).get('reconciledAfterException') is True and
                _external_phase_receipt(row).get('savedTargetFingerprint')==current_target_fingerprint for row in saved_receipts)
            if not reconciled:
                for saved_id,saved_item in step_data['result']['byItem'].items():
                    saved=saved_item['phaseResults']['finalize'];proof=_external_phase_receipt(saved)
                    if saved['status']!='complete' or proof.get('reconciledAfterException') is not True or 'savedTargetFingerprint' in proof:continue
                    observed=_external_inspect_finalize_save(runtime,step_data,
                        _external_cast('_ExternalInspectionPending',{'phase':'finalize','itemId':saved_id,'stepId':None}))
                    if observed is not None and observed.get('terminal') is True:
                        observed_result=_external_cast('JsonObject',observed['result'])
                        if _external_result_receipt(observed_result).get('savedTargetFingerprint')==current_target_fingerprint:
                            reconciled=True;break
            if not reconciled:
                return _external_with_lifecycle(_external_result('blocked',0,notStarted=True,
                    reason='staleEvidence: created target changed outside operation'),initial_effects)
            runtime['targetFingerprint']=current_target_fingerprint
    phase_results=step_data['result']['byItem'][step_data['itemId']]['phaseResults']
    if phase.startswith('verify:'):
        verify_phase=phase.split(':')[1]
        verify_results=phase_results['verify']
        state=_external_cast('dict[str, _ExternalPhaseState]',verify_results)[verify_phase]
    else:
        state=_external_cast('dict[str, _ExternalPhaseState]',phase_results)[phase]
    cursor=_external_phase_receipt(state).get('cursor',0)
    if step_data.get('outerReadOnly') and not phase.startswith('verify:'):
        return _external_result('blocked',cursor,reason='outerReadOnly')
    runtime['effects'][step_id]={'stepId':step_id,'terminal':False,'nativeOutcome':'unknown'}
    try:
        function={'copy':_external_copy,'verify:sources':_external_verify,'verify:assembly':_external_verify,
            'stage':_external_stage,'retire':_external_retire,'finalize':_external_finalize}[phase]
        output=function(runtime,step_data,entry,cursor)
        output=_external_with_lifecycle(output,initial_effects)
        output_receipt=_external_result_receipt(output)
        accepted_save_as=(step_data['manifest']['mode']=='composeNew' and phase=='finalize' and runtime.get('saveBaseline')==0 and
            output['status']=='pending' and output_receipt.get('saveAccepted') is True)
        if accepted_save_as:
            save_receipt=_external_cast('_ExternalSaveAsReceipt',output_receipt)
            runtime['acceptedSaveAsObservation']={'itemId':step_data['itemId'],'cursor':save_receipt['cursor'],
                'creationId':save_receipt['creationId']}
            output['waitingPublication']=True
        try:
            runtime['sourceFingerprint']=_external_fingerprint(runtime['source'])
            if runtime['target'] is not None:runtime['targetFingerprint']=_external_fingerprint(runtime['target'])
        except RuntimeError as error:
            if not accepted_save_as:raise
            output_receipt['observationError']=type(error).__name__+': '+str(error)
            output_receipt['errorSite']=_external_error_site(error)
            output['waitingPublication']=True
        runtime['effects'][step_id]={'stepId':step_id,'terminal':output['status']!='unknown','result':output}
        return output
    except Exception as error:
        # Do not reinterpret an exception after native entry as notStarted.
        geometry_read=phase.startswith('verify:') and cursor<len((entry.get('baseline') or {}).get('bodies',[]))+1
        output=_external_with_lifecycle(_external_result('failed' if geometry_read else 'unknown',cursor,
            reason=type(error).__name__+': '+str(error),errorSite=_external_error_site(error)),initial_effects)
        if geometry_read:runtime['effects'][step_id]={'stepId':step_id,'terminal':True,'result':output}
        else:runtime['effects'][step_id]['error']=_external_result_receipt(output).get('reason','')
        return output


def _external_insert_matrix(ctx: "CadContext",data: "JsonObject",matrix: "list[int | float]",project_id: "str") -> "_ExternalInsertResult":
    return _external_cast('_ExternalInsertResult',_external_insert(ctx,data,project_id,matrix))


def _external_boundary_endpoint_preflight(endpoint: "_ExternalBoundaryEndpoint",item_ids: "set[str]",group_ids: "set[str]",datum_names: "set[str]") -> "None":
    _cad_fields(endpoint,(),('itemId','instanceIndex','memberIndex','relativePath','occurrence','originName','rootDatum','componentOrigin'))
    identities=[key for key in ('itemId','occurrence','rootDatum') if endpoint.get(key) is not None]
    _external_require(len(identities)==1,'Boundary endpoint requires exactly one itemId, occurrence or rootDatum identity')
    component_origin=endpoint.get('componentOrigin')
    _external_require(component_origin is None or type(component_origin) is bool,
                      'componentOrigin must be boolean')
    item_id=endpoint.get('itemId')
    if item_id:
        _external_require(item_id in item_ids,'Unknown boundary itemId')
        _external_require(not ('instanceIndex' in endpoint and 'memberIndex' in endpoint),
                          'Boundary endpoint cannot combine instanceIndex and memberIndex')
        _external_require('memberIndex' not in endpoint or item_id in group_ids,
                          'memberIndex is only valid for an extraction-group item')
        relative_path=endpoint.get('relativePath')
        if item_id in group_ids:
            _external_require(_external_is_str(relative_path) and relative_path and
                              'instanceIndex' not in endpoint,
                              'Grouped boundary requires an exact member relativePath, not a staged instance index')
        for key in ('instanceIndex','memberIndex'):
            if key in endpoint:
                value=_external_cast('object',endpoint.get(key))
                _external_require(type(value) is int and value>=0,key+' must be a nonnegative index')
        if 'relativePath' in endpoint:
            _external_require(_external_is_str(relative_path) and relative_path,
                              'relativePath must be an exact nonempty child path')
    elif endpoint.get('occurrence') is not None:
        occurrence_value=endpoint.get('occurrence')
        _external_require(_external_is_dict(occurrence_value),
                          'Outside boundary occurrence requires an exact token, kind and context path')
        occurrence=_external_cast('_ExternalOccurrenceReference',occurrence_value)
        token=occurrence.get('token');path=occurrence.get('path')
        _external_require(occurrence.get('kind')=='occurrence' and
                          _external_is_str(token) and token and
                          _external_is_str(path) and path,
                          'Outside boundary occurrence requires an exact token, kind and context path')
        _external_require(not any(key in endpoint for key in ('instanceIndex','memberIndex','relativePath')),
                          'Occurrence endpoint cannot use item-relative indexes or paths')
    else:
        root_datum=endpoint.get('rootDatum')
        _external_require(_external_is_str(root_datum) and root_datum in datum_names,
                          'Boundary rootDatum must name a declared root datum')
        _external_require(not any(key in endpoint for key in ('instanceIndex','memberIndex','relativePath','occurrence','originName')),
                          'rootDatum endpoint cannot include another context identity')


def _external_validate_root_datums(ctx: "CadContext",manifest: "_ExternalManifest") -> "None":
    names: set[str]=set();available: set[str]=set()
    if manifest['mode']!='composeNew':
        available.update(str(p.name) for p in _external_items(ctx.design.allParameters) if getattr(p,'name',None))
    available.update(binding['consumerAlias'] for binding in manifest.get('parameterBindings',[]))
    for datum in manifest.get('rootDatums',[]):
        _cad_fields(datum,('name','offsetX','offsetY','offsetZ','angle','isFlipped','xAxis','zAxis','parameters'))
        _external_require(_external_is_str(datum['name']) and datum['name'] and datum['name'] not in names,
                          'Root datum names must be unique and nonempty')
        names.add(datum['name'])
        if manifest['mode']!='composeNew':
            _external_require(_external_joint_origin(ctx,datum['name']) is None,
                              'Root datum name already exists in the mutable destination')
        _external_require(all(_external_is_str(datum[key]) and datum[key] for key in ('offsetX','offsetY','offsetZ','angle')),
                          'Root datum offsets and angle require explicit expressions')
        _external_require(type(datum['isFlipped']) is bool,'Root datum isFlipped must be boolean')
        _external_require(datum['xAxis'] in ('x','y','z') and datum['zAxis'] in ('x','y','z') and
                          datum['xAxis']!=datum['zAxis'],'Finite root-origin datum requires distinct declared native root axes')
        _external_require(_external_is_list(datum['parameters']),'Root datum needs explicit expression dependency map')
        local_names: set[str]=set()
        for parameter in datum['parameters']:
            _cad_fields(parameter,('name','expression','unit','dependsOn'))
            _external_require(_external_is_str(parameter['name']) and parameter['name'] and parameter['name'] not in local_names,
                              'Datum parameter names must be unique and nonempty')
            _external_require(_external_is_str(parameter['expression']) and parameter['expression'] and
                              _external_is_str(parameter['unit']),'Datum parameter needs an explicit expression and unit')
            dependencies=parameter['dependsOn']
            _external_require(_external_is_list(dependencies) and all(_external_is_str(name) and name for name in dependencies) and
                              len(set(dependencies))==len(dependencies),'Datum dependsOn must be unique parameter names')
            _external_require(all(name in available for name in dependencies),'Datum dependency map is not topologically ordered')
            if manifest['mode']!='composeNew':
                existing=_external_user_parameter(ctx.design,parameter['name'])
                if existing is not None:
                    _external_require(existing.expression==parameter['expression'] and existing.unit==parameter['unit'],
                                      'Root datum parameter conflicts with the saved destination precondition')
            local_names.add(parameter['name']);available.add(parameter['name'])


def _external_preflight_boundaries(runtime: "_ExternalRuntime",manifest: "_ExternalManifest") -> "None":
    ctx=runtime['source'];declared:dict[str,_ExternalBoundarySpec]={}
    boundary_rows:list[_ExternalBoundaryState]=[];runtime['boundaries']=boundary_rows;runtime['boundariesCreated']=False
    roots:list[str]=[o.fullPathName for entry in runtime['items'].values() for o in entry['originals']]
    item_ids:set[str]=set(runtime['items']);group_ids:set[str]={item['itemId'] for item in manifest['items'] if item.get('groupId')}
    _external_validate_root_datums(ctx,manifest)
    boundary_ids:set[str]=set();datum_names:set[str]={datum['name'] for datum in manifest.get('rootDatums',[])}
    for spec in manifest.get('boundaries',[]):
        _cad_fields(spec,('id','joint','endpoints'))
        _external_require(_external_is_str(spec['id']) and spec['id'] and spec['id'] not in boundary_ids,
                          'Boundary id must be unique and nonempty')
        boundary_ids.add(spec['id'])
        _external_require(_external_is_list(spec['endpoints']) and len(spec['endpoints'])==2,'Boundary needs two explicit endpoint mappings')
        for endpoint in spec['endpoints']:
            _external_boundary_endpoint_preflight(endpoint,item_ids,group_ids,datum_names)
        joint=_external_joint(ctx,spec['joint'])
        _external_require(_cad_type(joint) in ('Joint','AsBuiltJoint'),'Unsupported native joint form')
        kind=int(_external_cast('_ExternalSupportsInt',joint.jointMotion.jointType))
        _external_require(kind in (0,1),'Only native rigid and revolute migration boundaries are supported')
        health_joint=_external_cast('_ExternalHealthJoint',joint)
        _external_require(health_joint.healthState==0,'Unhealthy boundary joint')
        _external_require(joint.entityToken not in declared,'Duplicate boundary mapping')
        declared[joint.entityToken]=spec
        row: _ExternalBoundaryState={'spec':spec,'old':joint,'token':joint.entityToken,'kind':kind,'form':_cad_type(joint),
             'name':joint.name,'attrs':_external_attributes(joint),'detached':False,'new':None,
              'offset':_external_cast('str',getattr(joint,'offset').expression) if hasattr(joint,'offset') else None,
              'angle':_external_cast('str',getattr(joint,'angle').expression) if hasattr(joint,'angle') else None,
              'flipped':bool(_external_cast('bool',getattr(joint,'isFlipped'))) if hasattr(joint,'isFlipped') else None,
             'endpoints':[]}
        if row['form']=='AsBuiltJoint':
            _external_require(all(endpoint.get('itemId') or endpoint.get('occurrence') for endpoint in spec['endpoints']),
                              'As-built boundaries require mapped occurrence endpoints, not JointOrigin datums')
        for index,endpoint in enumerate(spec['endpoints']):
            old=_external_joint_occurrence(joint,index)
            item_id=endpoint.get('itemId')
            if item_id:
                item=runtime['items'][item_id]
                number=endpoint.get('memberIndex',endpoint.get('instanceIndex',0))
                _external_require(type(number) is int and 0<=number<len(item['originals']),'Boundary instance index outside captured instanceMap')
                _external_require(old==item['originals'][number],'Boundary mapping does not identify the captured endpoint')
            else:
                _external_require(endpoint.get('rootDatum') or endpoint.get('occurrence'),'Outside endpoint needs exact occurrence or declared rootDatum')
                occurrence_ref=endpoint.get('occurrence')
                if occurrence_ref:_external_require(_external_occurrence(ctx,occurrence_ref)==old,'Outside endpoint mismatch')
            if row['form']=='Joint':
                regular_joint=_external_cast('adsk.fusion.Joint',joint)
                geometry=_external_cast(
                    'adsk.fusion.JointGeometry | adsk.fusion.JointOrigin',
                    getattr(regular_joint,'geometryOrOriginOne' if index==0 else 'geometryOrOriginTwo'))
                if _cad_type(geometry)=='JointOrigin':
                    origin=_external_cast('adsk.fusion.JointOrigin',geometry)
                    _external_require(endpoint.get('originName') or endpoint.get('rootDatum'),'Native JointOrigin requires an explicit target origin mapping')
                    native_origin=_external_cast('adsk.fusion.JointOrigin',getattr(origin,'nativeObject',None) or origin)
                    row['endpoints'].append({'transform':list(native_origin.transform.asArray())})
                else:
                    joint_geometry=_external_cast('adsk.fusion.JointGeometry',geometry)
                    entity=joint_geometry.entityOne
                    native=getattr(entity,'nativeObject',None) or entity
                    _external_require(old is not None,'Component-origin JointGeometry has no mapped occurrence')
                    old_occurrence=_external_cast('adsk.fusion.Occurrence',old)
                    _external_require(native==old_occurrence.component.originConstructionPoint and endpoint.get('componentOrigin') is True,
                                      'Only declared component-origin JointGeometry is supported')
                    row['endpoints'].append({'componentOrigin':True})
            else:row['endpoints'].append({})
            if old is not None:
                row['endpoints'][-1].update(componentAttributes=_external_attributes(old.component),
                                             componentName=old.component.name)
        if kind==1:
            motion=_external_cast('adsk.fusion.RevoluteJointMotion',joint.jointMotion)
            row['rotationAxis']=motion.rotationAxis;row['rotationValue']=float(motion.rotationValue)
            directions=adsk.fusion.JointDirections
            _external_require(row['rotationAxis'] in (directions.XAxisJointDirection,directions.YAxisJointDirection,directions.ZAxisJointDirection),
                              'Custom direction entity must be represented by an explicitly mapped JointOrigin frame before migration')
            limits=motion.rotationLimits
            joint_limits: _ExternalJointLimits={'minimumValue':limits.minimumValue,'maximumValue':limits.maximumValue,
                'restValue':limits.restValue,'isMinimumValueEnabled':limits.isMinimumValueEnabled,
                'isMaximumValueEnabled':limits.isMaximumValueEnabled,'isRestValueEnabled':limits.isRestValueEnabled}
            row['limits']=joint_limits
            _external_require(row['form']=='Joint','As-built arbitrary-axis revolute is not a qualified SDK form; use a regular native boundary')
        boundary_rows.append(row)
    # Boundary coverage is explicit; never silently drop an unmapped source joint.
    for component in _external_own_components(ctx.root):
        for collection in (component.joints,component.asBuiltJoints):
            for joint in _external_items(collection):
                endpoint_paths=[o.fullPathName for o in
                    (_external_joint_occurrence(joint,0),_external_joint_occurrence(joint,1)) if o is not None]
                touches=any(any(p==r or p.startswith(r+'+') for r in roots) for p in endpoint_paths)
                internal=any(component==entry['component'] for entry in runtime['items'].values())
                if touches and not internal:_external_require(joint.entityToken in declared,'Affected boundary joint omitted from immutable interface map')
    for binding in manifest.get('parameterBindings',[]):
        _cad_fields(binding,('source','sourceParameter','consumerAlias'),('nativeDerivedParameter','unit','existingExpression','targetItemId'))
        target_item_id=binding.get('targetItemId')
        if target_item_id:
            _external_require(target_item_id in runtime['items'] and manifest.get('save') is True,
                              'Item binding requires an authorized target item and publication')
        source=binding['source']
        if 'itemId' in source:
            _cad_fields(source,('itemId',));_external_require(source['itemId'] in runtime['items'],'Unknown binding source itemId')
        else:
            _cad_fields(source,('projectId','dataFileId','version'),('creationId','context'))
            exact_source=_external_cast('_ExternalExactProbeSource',source)
            _external_require(type(exact_source['version']) is int and exact_source['version']>0,
                              'Binding source must pin an exact version')
            _external_require(source.get('context') in (None,'topLevel'),'Binding source context must be topLevel when specified')
        if manifest['mode']!='composeNew' and not binding.get('targetItemId'):
            existing=_external_user_parameter(ctx.design,binding['consumerAlias'])
            if existing is not None:
                _external_require(binding.get('existingExpression')==existing.expression,'Existing alias requires its exact declared expression precondition')
def _external_bindings_stage(runtime: "_ExternalRuntime",data: "_ExternalStepData",entry: "_ExternalItemState",cursor: "int") -> "JsonObject":
    ctx=runtime['target'] or runtime['source'];m=data['manifest']
    publication=runtime.get('itemBindingPublication')
    if publication:
        owner=publication['ctx'];item=runtime['items'][publication['itemId']]
        effects=_external_activate(owner)
        if not publication['submitted'] and owner.doc.isModified:
            publication['submitted']=True
            _external_require(owner.doc.save('Authorized native item parameter binding '+data['operationId']),
                              'Item binding save not accepted')
            return _external_with_lifecycle(_external_result('pending',cursor+1,itemBindingSaveAccepted=True),effects)
        file=owner.doc.dataFile
        if owner.doc.isModified or not file.isComplete or publication['submitted'] and file.versionNumber<=publication['beforeVersion']:
            _external_refresh_complete(file)
            return {**_external_result('pending',cursor,itemBindingPublication=True),'waitingPublication':True}
        _external_require(file.id==publication['fileId'],'Item binding changed lineage')
        item['targetPin']=_external_pin(file,owner.doc.creationId)
        item['targetPin']['context']='topLevel'
        effects.append(_external_close_owned_clean_doc(owner,item['targetPin']))
        runtime['itemBindingPublication']=None
        return _external_with_lifecycle(_external_result('pending',cursor+1,
            itemBindingPublication={'itemId':publication['itemId'],
                'file':_external_pin_json(item['targetPin']),'cloudComplete':True}),effects)
    done=runtime.setdefault('bindingProgress',set());bindings=runtime.setdefault('derivedBindings',[])
    for index,spec in enumerate(m.get('parameterBindings',[])):
        key='parameter:'+str(index)
        if key in done:continue
        target_item_id=spec.get('targetItemId')
        target_item=runtime['items'].get(target_item_id) if target_item_id is not None else None
        target_effects=[]
        if target_item is not None:
            target_pin=target_item.get('targetPin')
            if target_pin is None:return {**_external_result('pending',cursor+1,awaitingItems=[target_item_id]),'defer':True}
            target_doc,target_effect=_external_owned_document(runtime,target_pin)
            _external_require(target_doc is not None and not target_doc.isModified,
                              'Item binding requires its exact clean owned saved editor')
            target_doc=_external_cast('adsk.core.Document',target_doc)
            ctx=_external_ctx(target_doc);target_effects=_external_lifecycle_effects(target_effect)
        source=spec['source']
        source_item_id=source.get('itemId')
        if source_item_id and runtime['items'][source_item_id]['targetPin'] is None:
            return {**_external_result('pending',cursor+1,localStaged=False,awaitingItems=[source_item_id]),'defer':True}
        pin=_external_source_pin(runtime,source,True)
        source_file=_external_project_file(ctx.app,pin['projectId'],pin['fileId'],pin['version'])
        if not _external_refresh_complete(source_file):
            return {**_external_result('pending',cursor,target=_external_pin_json(_external_pin(source_file)),reason='pendingPublication'),
                    'waitingPublication':True}
        doc,effect=_external_owned_document(runtime,pin)
        _external_require(doc is not None,str(effect));doc=_external_cast('adsk.core.Document',doc)
        sd=_external_ctx(doc).design
        parameters=[p for p in _external_items(sd.userParameters) if p.name==spec['sourceParameter'] and p.isFavorite]
        parameter=_cad_unique(parameters,'exact exported favorite USER parameter')
        if 'unit' in spec:_external_require(spec['unit']==parameter.unit,'Declared binding unit differs from exported parameter')
        before_alias=_external_user_parameter(ctx.design,spec['consumerAlias'])
        if before_alias is not None and (before_alias.expression!=spec.get('existingExpression') or
                before_alias.unit!=parameter.unit or abs(before_alias.value-parameter.value)>=1e-9):
            return _external_with_lifecycle({**_external_result('blocked',cursor,notStarted=True,
                reason='Existing alias does not match its declared precondition',
                observedExpression=before_alias.expression),'notStarted':True},target_effects+_external_lifecycle_effects(effect))
        _external_health(ctx.root);activation_effects=_external_activate(ctx)
        derive_key=(ctx.doc.creationId,pin['fileId'],pin['version'])
        derive_sources=runtime.setdefault('deriveSources',{})
        feature=derive_sources.get(derive_key)
        if feature is None:
            try:feature=_external_existing_derive(ctx,pin)
            except ValueError as error:
                return _external_with_lifecycle({**_external_result('blocked',cursor,notStarted=True,reason=str(error)),
                    'notStarted':True},[*_external_lifecycle_effects(effect),*activation_effects])
        if feature is None:
            marker=ctx.design.timeline.markerPosition
            before_helpers={o.entityToken for o in _external_items(ctx.root.occurrences)}
            try:
                ctx.design.timeline.markerPosition=0
                inp=ctx.root.features.deriveFeatures.createInput(sd)
                inp.isIncludeFavoriteParameters=True;inp.isIncludeComponentParameters=False
                inp.sourceEntities=[inp.sourceDesign.rootComponent]
                feature=_cad_require_result(
                    ctx.root.features.deriveFeatures.add(inp),'Create initial native Derive')
                feature.attributes.add('fmcad.externalization','role','declaredParameterReference')
            finally:ctx.design.timeline.markerPosition=ctx.design.timeline.count if marker==0 else min(marker+1,ctx.design.timeline.count)
            derive_sources[derive_key]=feature
            for occurrence in _external_items(ctx.root.occurrences):
                if occurrence.entityToken not in before_helpers:
                    _external_require(occurrence.isDerived,'Unexpected non-Derive occurrence created by parameter binding')
                    _external_ensure_attributes(occurrence,[('fmcad.externalization','role','declaredParameterReference')])
                    runtime.setdefault('referenceHelpers',[]).append({'ref':ctx.ref(occurrence),
                        'source':_external_pin_json(pin),
                        **({'ownerFileId':ctx.doc.dataFile.id} if target_item is not None else {}),
                        'role':'reference','bodyDefinitions':occurrence.component.bRepBodies.count})
        actual=[p for p in _external_items(ctx.design.derivedParameters) if p.deriveFeature==feature]
        native_derived_parameter=spec.get('nativeDerivedParameter')
        if native_derived_parameter:actual=[p for p in actual if p.name==native_derived_parameter]
        else:
            # Cardinality is authoritative for a single exported parameter. For
            # multi-parameter sources callers must map observed names explicitly.
            _external_require(len([p for p in _external_items(sd.userParameters) if p.isFavorite])==1,
                              'Multiple favorite parameters require explicit actual nativeDerivedParameter mapping; no suffix guessing')
        dp=_cad_unique(actual,'actual created DerivedParameter')
        _external_require(dp.unit==parameter.unit and abs(dp.value-parameter.value)<1e-9,'Native binding value/unit differs from independent source')
        alias=_external_user_parameter(ctx.design,spec['consumerAlias'])
        if alias is not None:
            _external_require(alias.expression==spec.get('existingExpression') and alias.unit==parameter.unit and
                              abs(alias.value-parameter.value)<1e-9,'Existing alias does not match its declared precondition')
            if alias.expression!=dp.name:alias.expression=dp.name
        else:alias=ctx.design.userParameters.add(spec['consumerAlias'],adsk.core.ValueInput.createByString(dp.name),parameter.unit,'Native external interface')
        _external_require(alias.expression==dp.name and abs(alias.value-parameter.value)<1e-9,'Alias is not a verified native binding')
        target_item_key=target_item['spec']['itemId'] if target_item is not None else None
        bindings.append({'sourceFileId':pin['fileId'],'sourceParameter':parameter.name,'nativeDerivedParameter':dp.name,
            'consumerAlias':alias.name,'featureToken':feature.entityToken,
            **({'targetItemId':target_item_key,'ownerFileId':ctx.doc.dataFile.id} if target_item is not None else {})})
        if target_item is not None:
            _external_require(ctx.design.computeAll(),'Item binding recompute failed')
            new_publication: _ExternalRequiredItemBindingPublication={
                'ctx':ctx,'itemId':target_item['spec']['itemId'],'fileId':ctx.doc.dataFile.id,
                'beforeVersion':ctx.doc.dataFile.versionNumber,'submitted':False}
            runtime['itemBindingPublication']=new_publication
        done.add(key)
        return _external_with_lifecycle(_external_result('pending',cursor+1,binding=bindings[-1]),
                                        [*target_effects,*_external_lifecycle_effects(effect),*activation_effects])
    for index,spec in enumerate(m.get('rootDatums',[])):
        key='datum:'+str(index)
        if key in done:continue
        for p in spec['parameters']:
            _external_require(all(_external_parameter(ctx.design,name) is not None for name in p['dependsOn']), 'Datum dependency map is not topologically ordered')
            existing=_external_user_parameter(ctx.design,p['name'])
            if existing:_external_require(existing.expression==p['expression'] and existing.unit==p['unit'],'Conflicting datum parameter')
            else:ctx.design.userParameters.add(p['name'],adsk.core.ValueInput.createByString(p['expression']),p['unit'],'Declared root datum')
        _external_require(_external_joint_origin(ctx,spec['name']) is None,'Root datum collision')
        geometry=adsk.fusion.JointGeometry.createByPoint(ctx.root.originConstructionPoint)
        inp=ctx.root.jointOrigins.createInput(geometry)
        inp.xAxisEntity=getattr(ctx.root,spec['xAxis']+'ConstructionAxis');inp.zAxisEntity=getattr(ctx.root,spec['zAxis']+'ConstructionAxis')
        for prop in ('offsetX','offsetY','offsetZ','angle'):setattr(inp,prop,adsk.core.ValueInput.createByString(spec[prop]))
        inp.isFlipped=spec['isFlipped'];origin=ctx.root.jointOrigins.add(inp);origin.name=spec['name']
        done.add(key);return _external_with_lifecycle(_external_result('pending',cursor+1,datum=ctx.ref(origin)),
                                                       _external_activate(ctx))
    runtime['bindingsCreated']=True
    return _external_with_lifecycle(_external_result('pending',cursor+1,parameterBindings=bindings),_external_activate(ctx))


def _external_endpoint(runtime: "_ExternalRuntime",ctx: "CadContext",endpoint: "_ExternalBoundaryEndpoint",captured: "_ExternalCapturedBoundaryEndpoint",require_geometry: "bool"=True) -> "tuple[adsk.core.Base | None, adsk.fusion.Occurrence | None]":
    if endpoint.get('rootDatum'):
        _external_require(require_geometry,'As-built boundary endpoints require occurrence contexts, not root datums')
        origin_name=_external_cast('str',endpoint.get('rootDatum'))
        origin=_cad_require_result(_external_joint_origin(ctx,origin_name),'Declared root datum')
        transform=captured.get('transform')
        if transform:
            linear,angular=_external_pose_delta(transform,list(origin.transform.asArray()))
            _external_require(linear<=runtime['tolerance']['linear'] and angular<=runtime['tolerance']['angular'],'Declared root datum differs from the captured source frame')
        return origin,None
    item_id=endpoint.get('itemId')
    if item_id:
        item=runtime['items'][item_id]
        if item.get('spec',{}).get('groupId'):
            relative_path=endpoint.get('relativePath')
            _external_require(len(item['staged'])==1 and relative_path,
                              'Grouped endpoint requires one staged group and an explicit member path')
            i=0
        else:i=endpoint.get('instanceIndex',0)
        _external_require(i<len(item['staged']),'Endpoint target instance not staged')
        occ=item['staged'][i]
    else:
        occ=_external_occurrence(ctx,_external_cast('_ExternalOccurrenceReference',endpoint.get('occurrence')))
    relative_path=endpoint.get('relativePath')
    if relative_path:
        occ=_cad_unique([o for o in _external_items(ctx.root.allOccurrences)
            if o.fullPathName==occ.fullPathName+'+'+relative_path],'explicit mapped child endpoint')
        _external_require(occ.component.name==captured.get('componentName'),'Mapped child definition name differs from source provenance')
    component_attributes=captured.get('componentAttributes',_external_attributes(occ.component))
    _external_require(_external_attributes(occ.component)==component_attributes,
                      'Mapped endpoint component attributes differ')
    if not require_geometry:return None,occ
    if endpoint.get('componentOrigin'):
        point=occ.component.originConstructionPoint.createForAssemblyContext(occ)
        return adsk.fusion.JointGeometry.createByPoint(point),occ
    origin_name=_external_cast('str',endpoint.get('originName'))
    origin=_cad_require_result(_external_component_joint_origin(occ.component,origin_name),'Mapped target JointOrigin')
    transform=_external_cast('list[int | float]',captured.get('transform'))
    linear,angular=_external_pose_delta(transform,list(origin.transform.asArray()))
    _external_require(linear<=runtime['tolerance']['linear'] and angular<=runtime['tolerance']['angular'],'Target origin frame differs from captured source')
    return origin.createForAssemblyContext(occ),occ


def _external_boundary_readback(runtime: "_ExternalRuntime",ctx: "CadContext",row: "_ExternalBoundaryState") -> "None":
    readback_row=_external_cast('_ExternalRebuildJointState',row)
    joint_value=row.get('new')
    _external_require(joint_value is not None,'Final boundary is not present for readback')
    joint=_external_cast('adsk.fusion.Joint | adsk.fusion.AsBuiltJoint',joint_value)
    health_joint=_external_cast('_ExternalHealthJoint',joint)
    motion=joint.jointMotion
    _external_require(health_joint.healthState==adsk.fusion.FeatureHealthStates.HealthyFeatureHealthState and
        int(_external_cast('_ExternalSupportsInt',motion.jointType))==readback_row['kind'],
        'Final boundary health/type differs')
    endpoints=[_external_endpoint(runtime,ctx,s,c,require_geometry=readback_row['form']!='AsBuiltJoint')
               for s,c in zip(readback_row['spec']['endpoints'],readback_row['endpoints'])]
    _external_require([joint.occurrenceOne,joint.occurrenceTwo]==[value[1] for value in endpoints],
                      'Final boundary endpoint context differs')
    _external_require(_external_attributes(joint)==readback_row['attrs'],'Final boundary attributes differ')
    for key in ('offset','angle'):
        if readback_row.get(key) is not None:
            regular_joint=_external_cast('adsk.fusion.Joint',joint)
            expression=_external_cast('str',getattr(regular_joint,key).expression)
            _external_require(expression==readback_row[key],'Final boundary expression differs')
    if readback_row.get('flipped') is not None:
        regular_joint=_external_cast('adsk.fusion.Joint',joint)
        _external_require(bool(regular_joint.isFlipped)==readback_row['flipped'],'Final boundary flip differs')
    if readback_row['kind']==1:
        revolute_row=_external_cast('_ExternalRevoluteBoundaryState',readback_row)
        motion=_external_cast('adsk.fusion.RevoluteJointMotion',joint.jointMotion)
        _external_require(motion.rotationAxis==revolute_row['rotationAxis'] and
            abs(motion.rotationValue-revolute_row['rotationValue'])<=runtime['tolerance']['angular'],
            'Final revolute axis/nominal differs')
        _external_require(all(getattr(motion.rotationLimits,k)==v for k,v in revolute_row['limits'].items()),
                          'Final revolute stored limits differ')


def _external_rebuild_joint(runtime: "_ExternalRuntime",ctx: "CadContext",row: "_ExternalBoundaryState") -> "JsonObject":
    rebuild_row=_external_cast('_ExternalRebuildJointState',row)
    endpoints=[_external_endpoint(runtime,ctx,s,c,require_geometry=rebuild_row['form']!='AsBuiltJoint')
               for s,c in zip(rebuild_row['spec']['endpoints'],rebuild_row['endpoints'])]
    joint: adsk.fusion.Joint | adsk.fusion.AsBuiltJoint | None
    if rebuild_row['form']=='AsBuiltJoint':
        _external_require(rebuild_row['kind']==0 and all(o is not None for g,o in endpoints),'Unsupported as-built boundary form')
        as_built_factory=_external_cast('_ExternalAsBuiltJointInputFactory',ctx.root.asBuiltJoints)
        inp=as_built_factory.createInput(
            _external_cast('adsk.fusion.Occurrence',endpoints[0][1]),
            _external_cast('adsk.fusion.Occurrence',endpoints[1][1]),None)
        inp.setAsRigidJointMotion()
        joint=_external_nullable_joint(ctx.root.asBuiltJoints.add(inp))
    else:
        inp=ctx.root.joints.createInput(
            _external_cast('adsk.core.Base',endpoints[0][0]),
            _external_cast('adsk.core.Base',endpoints[1][0]))
        if rebuild_row['kind']==0:inp.setAsRigidJointMotion()
        else:
            revolute_row=_external_cast('_ExternalRevoluteBoundaryState',rebuild_row)
            inp.setAsRevoluteJointMotion(revolute_row['rotationAxis'])
        inp.offset=adsk.core.ValueInput.createByString(_external_cast('str',rebuild_row['offset']))
        inp.angle=adsk.core.ValueInput.createByString(_external_cast('str',rebuild_row['angle']))
        inp.isFlipped=_external_cast('bool',rebuild_row['flipped'])
        joint=_external_nullable_joint(ctx.root.joints.add(inp))
    _external_require(joint is not None,'Boundary reconstruction failed')
    joint=_external_cast('adsk.fusion.Joint | adsk.fusion.AsBuiltJoint',joint)
    health_joint=_external_cast('_ExternalHealthJoint',joint)
    _external_require(health_joint.healthState==adsk.fusion.FeatureHealthStates.HealthyFeatureHealthState,
                      'Boundary reconstruction failed')
    joint.name=rebuild_row['name']
    for index,target in enumerate(endpoints):
        actual=_external_joint_occurrence(joint,index)
        _external_require((actual is None and target[1] is None) or actual==target[1],
                          'Rebuilt joint endpoint context differs from the explicit mapping')
    _external_ensure_attributes(joint,rebuild_row['attrs'])
    if rebuild_row['form']=='Joint':
        regular_joint=_external_cast('adsk.fusion.Joint',joint)
        _external_require(bool(regular_joint.isFlipped)==rebuild_row['flipped'],'Rebuilt joint flip state differs')
        for key in ('offset','angle'):
            expression=_external_joint_expression(regular_joint,key)
            _external_require(expression is not None and expression==rebuild_row[key],
                              'Rebuilt joint expression differs for '+key)
    if rebuild_row['kind']==1:
        revolute_row=_external_cast('_ExternalRevoluteBoundaryState',rebuild_row)
        motion=_external_cast('adsk.fusion.RevoluteJointMotion',joint.jointMotion)
        limits=motion.rotationLimits
        _external_require(motion.rotationAxis==revolute_row['rotationAxis'],
                          'Rebuilt revolute axis differs')
        for key in ('minimumValue','maximumValue','restValue','isMinimumValueEnabled','isMaximumValueEnabled','isRestValueEnabled'):
            setattr(limits,key,revolute_row['limits'][key])
        motion.rotationValue=revolute_row['rotationValue']
        _external_require(all(getattr(limits,k)==v for k,v in revolute_row['limits'].items()),
                          'Enabled or disabled stored revolute limits differ')
        _external_require(abs(float(motion.rotationValue)-revolute_row['rotationValue'])<=runtime['tolerance']['angular'],
                          'Rebuilt revolute nominal value differs after assignment')
        if ctx.design.snapshots.hasPendingSnapshot:
            parametric_type=_external_cast(
                'adsk.fusion.DesignTypes',adsk.fusion.DesignTypes.ParametricDesignType)
            _external_cast('JsonObject',row)['positionSnapshot']=_assembly_capture(
                ctx,ctx.design.designType==parametric_type)
    row['new']=joint
    return ctx.ref(joint)


def _external_replacement_index(ctx: "CadContext",file: "adsk.core.DataFile") -> "_ExternalReplacementIndex":
    by_parent: dict[str | None,list[tuple[adsk.fusion.Occurrence,list[int | float]]]]={}
    by_token: dict[str,adsk.fusion.Occurrence]={}
    occurrences=_external_items(_external_cast(
        '_CadItemCollection[adsk.fusion.Occurrence]',ctx.root.allOccurrences))
    for occurrence in occurrences:
        by_token[occurrence.entityToken]=occurrence
        if not occurrence.isReferencedComponent:continue
        ref=occurrence.documentReference
        if ref.dataFile.id!=file.id or ref.dataFile.versionNumber!=file.versionNumber:continue
        parent=_external_assembly_context(occurrence)
        parent_token=parent.entityToken if parent is not None else None
        by_parent.setdefault(parent_token,[]).append((occurrence,list(_external_entity_occurrence_matrix(ctx,occurrence))))
    return {'byParent':by_parent,'byToken':by_token}


def _external_replacement_observation(ctx: "CadContext",file: "adsk.core.DataFile",captured: "_ExternalInstanceMap",old: "adsk.fusion.Occurrence",tolerance: "_ExternalTolerance",index: "_ExternalReplacementIndex | None"=None) -> "_ExternalReplacementObservation":
    index=index if index is not None else _external_replacement_index(ctx,file)
    targets: list[tuple[adsk.fusion.Occurrence,bool]]=[]
    for occurrence,pose in index['byParent'].get(captured.get('parentToken'),[]):
        linear,angular=_external_pose_delta(captured['worldPose'],pose)
        if linear<=tolerance['linear'] and angular<=tolerance['angular']:
            targets.append((occurrence,occurrence.fullPathName==captured['path']))
    exact=[row for row in targets if row[1]]
    if len(exact)==1:return {'status':'replaced','occurrence':exact[0][0],'pathMatched':True}
    if len(exact)>1:return {'status':'ambiguous','candidates':[ctx.ref(row[0]) for row in exact]}
    if len(targets)==1:
        try:
            if old.isValid:
                ref=old.documentReference
                if ref.dataFile.id==captured.get('fileId') and int(ref.version)==captured.get('version'):
                    return {'status':'ambiguous','candidates':[ctx.ref(targets[0][0]),ctx.ref(old)]}
        except Exception:pass
        return {'status':'replaced','occurrence':targets[0][0],'pathMatched':False}
    if len(targets)>1:return {'status':'ambiguous','candidates':[ctx.ref(row[0]) for row in targets]}
    try:
        if old.isValid:
            ref=old.documentReference
            if ref.dataFile.id==captured.get('fileId') and int(ref.version)==captured.get('version'):
                return {'status':'originalRetained','occurrence':ctx.ref(old)}
    except Exception:
        pass
    return {'status':'unknown','candidates':[]}


def _external_replacement_json(observation: "_ExternalReplacementObservation") -> JsonObject:
    result: JsonObject={'status':observation['status']}
    if 'candidates' in observation:result['candidates']=observation['candidates']
    return result


def _external_replace_stage(runtime: "_ExternalRuntime",data: "_ExternalStepData",entry: "_ExternalItemState",cursor: "int") -> "JsonObject":
    ctx=runtime['source']
    affected=[r for r in _external_boundary_states(runtime) if any(e.get('itemId')==entry['spec']['itemId'] for e in r['spec']['endpoints'])]
    pending=sorted([r for r in affected if not r['detached']],key=lambda r:r['old'].timelineObject.index,reverse=True)
    if pending:
        row=pending[0];deletion=_external_delete_joint_checkpoint(ctx,row['old'],row['token'])
        if deletion['status']!='removed':
            return _external_result('failed',cursor+1,partial=any(boundary['detached'] for boundary in affected),
                detachedJoint=row['token'],deletion=deletion,noReplay=True)
        row['detached']=True
        return _external_result('pending',cursor+1,detached=row['token'],
            reconciledAfterException=deletion['reconciledAfterException'])
    replaced_by_index=entry.setdefault('replacedByIndex',{i:o for i,o in enumerate(entry['staged'])})
    remaining=[i for i in range(len(entry['originals'])) if i not in replaced_by_index]
    if remaining:
        index=remaining[0]
        old=entry['originals'][index];captured=entry['instanceMap'][index]
        _external_require(old.isValid and old.isReferencedComponent,'replaceExternal requires a current external occurrence')
        native=getattr(old,'nativeObject',None) or old
        peers=[i for i in remaining if entry['originals'][i].isValid and
               (getattr(entry['originals'][i],'nativeObject',None) or entry['originals'][i])==native]
        paths: list[str]=[entry['instanceMap'][i]['path'] for i in peers]
        all_occurrences=_external_items(_external_cast(
            '_CadItemCollection[adsk.fusion.Occurrence]',ctx.root.allOccurrences))
        outside: dict[str,list[int | float]]={o.entityToken:list(_external_entity_occurrence_matrix(ctx,o)) for o in all_occurrences
            if not any(o.fullPathName==path or o.fullPathName.startswith(path+'+') for path in paths)}
        target_pin=_external_cast('_ExternalPin',entry.get('targetPin'))
        file=_external_project_file(ctx.app,target_pin['projectId'],target_pin['fileId'],target_pin['version'])
        _external_require(file.id!=captured.get('fileId') or file.versionNumber!=captured.get('version'),
                          'replaceExternal target is already the selected source version')
        submit_error=None
        try:submitted=old.replace(file,False)
        except Exception as error:submitted=None;submit_error=type(error).__name__+': '+str(error)
        replacement_index=_external_replacement_index(ctx,file)
        observation=_external_replacement_observation(ctx,file,captured,old,runtime['tolerance'],replacement_index)
        if observation['status']=='originalRetained':
            retained=_external_cast('_ExternalOriginalRetainedObservation',observation)
            return _external_result('failed',cursor+1,notStarted=True,replaceReturned=submitted is False,
                reason='Native replacement left the pinned original occurrence in place',submitError=submit_error,
                originalRetained=retained['occurrence'],noReplay=True)
        if observation['status']!='replaced':
            return _external_result('unknown',cursor,reason='Native replacement outcome could not be uniquely reconciled',
                submitError=submit_error,observation=_external_replacement_json(observation),noReplay=True)
        replaced_observation=_external_cast('_ExternalReplacedObservation',observation)
        new=replaced_observation['occurrence']
        current=replacement_index['byToken']
        for token,pose in outside.items():
            _external_require(token in current,'Unexpected outside occurrence loss after replace')
            linear,angular=_external_pose_delta(pose,list(_external_entity_occurrence_matrix(ctx,current[token])))
            _external_require(linear<=runtime['tolerance']['linear'] and angular<=runtime['tolerance']['angular'],'Replacement changed protected outside pose')
        observations: dict[int,_ExternalReplacedObservation]={
            index:_external_cast('_ExternalReplacedObservation',observation)}
        for peer in peers:
            if peer==index:continue
            peer_observation=_external_replacement_observation(
                ctx,file,entry['instanceMap'][peer],entry['originals'][peer],runtime['tolerance'],replacement_index)
            _external_require(peer_observation['status']=='replaced','Shared native replacement context is unresolved; no replay')
            observations[peer]=_external_cast('_ExternalReplacedObservation',peer_observation)
        for peer,observed in observations.items():
            _external_ensure_attributes(observed['occurrence'],entry['instanceMap'][peer]['attributes'])
            replaced_by_index[peer]=observed['occurrence']
        entry['staged']=[replaced_by_index[i] for i in sorted(replaced_by_index)]
        return _external_result('pending',cursor+1,replaced=ctx.ref(new),nativeReplaceAll=False,
            replacedContexts=[ctx.ref(observations[i]['occurrence']) for i in sorted(observations)],
            reconciledAfterException=submit_error is not None or submitted is not True,
            submitError=submit_error,pathMatched=replaced_observation['pathMatched'])
    for row in affected:
        if row.get('new') is None:return _external_result('pending',cursor+1,binding=_external_rebuild_joint(runtime,ctx,row))
    _external_require(ctx.design.computeAll(),'Replacement recompute failed')
    staged_refs: list[_ExternalOccurrenceReference]=[
        _external_cast('_ExternalOccurrenceReference',ctx.ref(o)) for o in entry['staged']]
    entry['stagedRefs']=staged_refs
    return _external_result('complete',cursor+1,
        instanceMap=_external_cast('JsonValue',entry['stagedRefs']),retire='notApplicable')


def _external_group_context_attributes(ctx: "CadContext",entry: "_ExternalItemState",apply: "bool"=False) -> "None":
    baseline=_external_cast('_ExternalSnapshot',entry.get('baseline'))['occurrences']
    for group in entry['staged']:
        all_occurrences=_external_items(_external_cast(
            '_CadItemCollection[adsk.fusion.Occurrence]',ctx.root.allOccurrences))
        members: list[adsk.fusion.Occurrence]=[
            o for o in all_occurrences if o.fullPathName.startswith(group.fullPathName+'+')]
        _external_require(len(members)==len(baseline),'Grouped root-context coverage changed')
        mapped: list[adsk.fusion.Occurrence]=[]
        for before in baseline:
            after=_cad_unique([o for o in members if _external_attributes(o.component)==before['componentAttrs']],
                              'grouped root-context member provenance')
            _external_require(after not in mapped,'Grouped root-context map is not bijective');mapped.append(after)
            _external_require(_external_attributes(_external_native_attributed(after))==before['nativeAttrs'],
                'Grouped native occurrence attributes changed')
            if apply:_external_ensure_attributes(after,before['attrs'])
            _external_require(_external_attributes(after)==before['attrs'],'Grouped root-context occurrence attributes differ')


def _external_group_combine_provenance(ctx: "CadContext",members: "list[adsk.fusion.Occurrence]") -> "list[_ExternalGroupCombine]":
    """Closed direct-sibling, single-body inputs; never infer a missing input."""
    result: list[_ExternalGroupCombine]=[]
    owners: list[adsk.fusion.Component]=[o.component for o in members]
    for owner_index,owner in enumerate(owners):
        for feature_index,feature in enumerate(_external_items(owner.features)):
            if _cad_type(feature)!='CombineFeature':continue
            combine=_external_cast('adsk.fusion.CombineFeature',feature)
            marker=ctx.design.timeline.markerPosition
            try:
                _external_require(combine.timelineObject.rollTo(True),'Cannot capture grouped Combine provenance')
                tool_bodies=_external_cast('_ExternalIterable[adsk.fusion.BRepBody]',combine.toolBodies)
                inputs: list[adsk.fusion.BRepBody]=[combine.targetBody]+_external_items(tool_bodies)
                mapped: list[_ExternalGroupCombineInput]=[]
                for body in inputs:
                    native=_external_cast('adsk.fusion.BRepBody',getattr(body,'nativeObject',None) or body)
                    index=_cad_unique([i for i,c in enumerate(owners) if c==native.parentComponent],
                                      'closed Combine input owner')
                    bodies=_external_items(owners[index].bRepBodies)
                    _external_require(len(bodies)==1 and bodies[0]==native,'Grouped Combine requires unambiguous single-body input provenance')
                    mapped.append({'memberIndex':index,'bodyAttrs':_external_attributes(native),
                                   'material':native.material.id})
                result.append({'memberIndex':owner_index,'featureIndex':feature_index,'name':combine.name,
                    'operation':int(_external_cast('_ExternalSupportsInt',combine.operation)),
                    'keepTools':bool(combine.isKeepToolBodies),'inputs':mapped})
            finally:
                ctx.design.timeline.markerPosition=marker
                _external_require(ctx.design.timeline.markerPosition==marker,'Group provenance marker restore failed')
    return result


def _external_group_rebind_combines(ctx: "CadContext",entry: "_ExternalItemState") -> "list[JsonObject]":
    members: list[adsk.fusion.Occurrence]=_external_physical_occurrences(ctx.root)
    baseline_value=entry.get('baseline')
    if baseline_value is None:raise ValueError('Grouped Combine baseline is unavailable')
    baseline=baseline_value['occurrences']
    _external_require(len(members)==len(baseline),'Grouped Combine occurrence provenance changed')
    identities: list[tuple[tuple[str,str,str],...]]=[tuple(row['componentAttrs']) for row in baseline]
    _external_require(all(identities) and len(set(identities))==len(identities),
        'Grouped Combine requires distinct captured component attributes for input mapping')
    members=[_cad_unique([o for o in members if _external_attributes(o.component)==before['componentAttrs']],
        'copied group member provenance') for before in baseline]
    for before,after in zip(baseline,members):
        # saveCopyAs of the enclosing component can drop occurrence attributes
        # too. Restore only after component provenance is uniquely established.
        _external_ensure_attributes(getattr(after,'nativeObject',None) or after,before['nativeAttrs'])
        _external_ensure_attributes(after,before['attrs'])
    effects: list[JsonObject]=[]
    group_combine_inputs=_external_cast('list[_ExternalGroupCombine]',entry.get('groupCombineInputs'))
    for row in group_combine_inputs:
        feature=_external_cast('adsk.fusion.CombineFeature',
            members[row['memberIndex']].component.features.item(row['featureIndex']))
        _external_require(_cad_type(feature)=='CombineFeature' and feature.name==row['name'] and
            int(_external_cast('_ExternalSupportsInt',feature.operation))==row['operation'] and
            bool(feature.isKeepToolBodies)==row['keepTools'],
            'Original grouped Combine feature identity changed')
        combine=feature
        if int(_external_cast('_ExternalSupportsInt',combine.healthState))==0:continue
        marker=ctx.design.timeline.markerPosition
        try:
            _external_require(combine.timelineObject.rollTo(True),'Cannot rebind original grouped Combine')
            bodies: list[adsk.fusion.BRepBody]=[]
            for source in row['inputs']:
                candidates=_external_items(members[source['memberIndex']].component.bRepBodies)
                _external_require(len(candidates)==1,'Grouped Combine input mapping is ambiguous')
                body=candidates[0]
                _external_require(_external_attributes(body)==source['bodyAttrs'] and body.material.id==source['material'],
                    'Grouped Combine input provenance differs')
                bodies.append(body)
            combine.targetBody=bodies[0]
            tools=adsk.core.ObjectCollection.create()
            for body in bodies[1:]:tools.add(body)
            combine.toolBodies=tools
        finally:
            ctx.design.timeline.markerPosition=marker
            _external_require(ctx.design.timeline.markerPosition==marker,'Group rebind marker restore failed')
        _external_require(ctx.design.computeAll(),'Grouped Combine rebind recompute failed')
        effects.append({'feature':row['name'],'originalTypedInputsRebound':True})
    _external_health(ctx.root)
    return effects


def _external_group_copy(runtime: "_ExternalRuntime",data: "_ExternalStepData",entry: "_ExternalItemState",cursor: "int") -> "JsonObject":
    spec=entry['spec'];ctx=runtime['source'];m=data['manifest']
    group_id=_external_cast('str',spec.get('groupId'))
    group=next(g for g in m.get('extractionGroups',[]) if g['id']==group_id)
    originals=[_external_occurrence(ctx,ref) for ref in group['members']]
    parent_path=originals[0].fullPathName.rsplit('+',1)[0] if '+' in originals[0].fullPathName else ''
    parent=ctx.root if not parent_path else _external_occurrence(ctx,{'path':parent_path}).component
    dest=_external_cast('_ExternalFileDestination',spec.get('destination'))
    stage_dest: '_ExternalFileDestination'={**dest,'fileName':dest['fileName']+'__'+data['operationId']+'__staging'}
    if cursor==0:
        effects=_external_activate(ctx)
        folder=_external_folder(ctx.app,stage_dest);_external_collision(folder,stage_dest['fileName'])
        result=_external_begin_copy(runtime,data,entry,ctx,parent,stage_dest,folder,'groupParent','groupParentFuture',cursor)
        parent_receipt=_external_result_receipt(result)
        if parent_receipt.get('accepted'):parent_receipt['isolatedParentCopyAccepted']=True
        return _external_with_lifecycle(result,effects)
    if cursor==1:
        temporary: '_ExternalFutureEntry'={
            'future':entry.get('groupParentFuture'),'futureObserver':entry.get('groupParentFutureObserver')}
        result=_external_future(temporary,1,stage_dest)
        if result['status']!='complete':return result
        parent_pin=_external_cast('_ExternalPin',temporary.get('targetPin'))
        entry['groupParentPin']=parent_pin
        return _external_with_lifecycle(_external_result('pending',2,parentCopy=_external_pin_json(parent_pin),
            parentCopyCompletion=_external_result_receipt(result).get('copyCompletion')),_external_lifecycle_effects(result))
    if cursor==2:
        doc,effect=_external_document(ctx.app,_external_cast('_ExternalPin',entry.get('groupParentPin')),allow_open=True,editable=True)
        _external_require(doc is not None,str(effect));entry['groupDoc']=doc
        doc=_external_cast('adsk.core.Document',doc)
        gd=_external_ctx(doc);activation_effects=_external_activate(gd)
        members=[_cad_unique([o for o in _external_items(gd.root.occurrences) if
            o.component.name==old.component.name and _external_attributes(o)==_external_attributes(old)],
            'isolated copied group member provenance') for old in originals]
        owners=[o.component for o in members]
        # Native Combine input getters need a rolled timeline. Inspect them in
        # the isolated parent copy, never dirty the saved original for a read.
        for member in members:_external_dependency_coverage(member.component,owners,allow_timeline=True)
        for owner in _external_own_components(gd.root):
            if owner in owners:continue
            for feature in _external_items(owner.features):
                _external_require(not any(c in owners for c in _external_feature_input_owners(feature,True)),
                    'Outside copied feature consumes the extraction group')
        entry['groupDependencyCoverage']=_external_cast('JsonObject',{'parentCopy':dict(_external_cast('_ExternalPin',entry.get('groupParentPin'))),
            'members':[gd.ref(member) for member in members]}
            )
        entry['groupCombineInputs']=_external_group_combine_provenance(gd,members)
        marker=gd.design.timeline.markerPosition
        try:
            gd.design.timeline.markerPosition=0
            enclosing=gd.root.occurrences.addNewComponent(adsk.core.Matrix3D.create())
            enclosing.component.name=group['id']
        finally:gd.design.timeline.moveToEnd()
        entry['groupOccurrence']=enclosing;entry['groupMoved']=[]
        return _external_with_lifecycle(_external_result('pending',3,createdGroup=gd.ref(enclosing),creationId=doc.creationId,
            dependencyCoverage=_external_cast('JsonValue',entry.get('groupDependencyCoverage'))),
                                        [*_external_lifecycle_effects(effect),*activation_effects])
    if cursor<3+len(originals):
        group_doc=_external_cast('adsk.core.Document',entry.get('groupDoc'))
        gd=_external_ctx(group_doc);activation_effects=_external_activate(gd)
        old=originals[cursor-3]
        candidates=[o for o in _external_items(gd.root.occurrences) if o.component.name==old.component.name and
            _external_attributes(o)==_external_attributes(old)]
        moved=_cad_unique(candidates,'isolated copied group member provenance')
        _external_require(_external_inventory(moved.component)==_external_inventory(old.component),'Isolated copy inventory changed')
        context_attributes=_external_attributes(moved)
        native_attributes=_external_attributes(_external_native_attributed(moved))
        group_occurrence=_external_cast('adsk.fusion.Occurrence',entry.get('groupOccurrence'))
        moved=_cad_require_result(moved.moveToComponent(group_occurrence),'Move isolated group member only')
        _external_ensure_attributes(getattr(moved,'nativeObject',None) or moved,native_attributes)
        _external_ensure_attributes(moved,context_attributes)
        _external_require(_external_attributes(moved)==context_attributes and
            _external_attributes(_external_native_attributed(moved))==native_attributes,
            'Moved isolated group member attributes differ')
        _external_cast('list[adsk.fusion.Occurrence]',entry.get('groupMoved')).append(moved)
        return _external_with_lifecycle(_external_result('pending',cursor+1,moved=gd.ref(moved),sourceUnchanged=True),activation_effects)
    final_cursor=3+len(originals)
    if cursor==final_cursor:
        group_doc=_external_cast('adsk.core.Document',entry.get('groupDoc'))
        gd=_external_ctx(group_doc);activation_effects=_external_activate(gd)
        _external_require(gd.design.computeAll(),'Grouped native context recompute failed')
        group_occurrence=_external_cast('adsk.fusion.Occurrence',entry.get('groupOccurrence'))
        _external_health(group_occurrence.component)
        entry['groupSaveBaseline']=int(_external_required_data_file(gd.doc).versionNumber)
        _external_require(gd.doc.save('Verified isolated extraction group'),'Save grouped staging')
        return _external_with_lifecycle(_external_result('pending',cursor+1,stagingSaveAccepted=True),activation_effects)
    if cursor==final_cursor+1:
        doc=_external_cast('adsk.core.Document',entry.get('groupDoc'))
        file=_external_required_data_file(doc)
        group_save_baseline=_external_cast('int',entry.get('groupSaveBaseline'))
        if doc.isModified or not file.isComplete or file.versionNumber<=group_save_baseline:
            _external_refresh_file(file)
            return {**_external_result('pending',cursor),'waitingPublication':True}
        entry['component']=_external_cast('adsk.fusion.Occurrence',entry.get('groupOccurrence')).component
        entry['groupParentPin']=_external_pin(file,doc.creationId)
        return _external_result('pending',cursor+1,stagingSource=_external_pin_json(entry['groupParentPin']),
            stagingComponent=_external_ctx(doc).ref(entry['component']))
    if cursor==final_cursor+2:
        folder=_external_folder(ctx.app,dest);_external_collision(folder,dest['fileName'])
        component=_external_cast('adsk.fusion.Component',entry.get('component'))
        baseline=_external_cast('_ExternalSnapshot',entry.get('baseline'))
        for check in range(len(baseline['bodies'])+1):
            _external_compare(baseline,component,check,runtime['tolerance'])
        group_doc=_external_ctx(_external_cast('adsk.core.Document',entry.get('groupDoc')))
        result=_external_begin_copy(runtime,data,entry,group_doc,component,
            dest,folder,'groupChild','future',cursor)
        child_receipt=_external_result_receipt(result)
        if child_receipt.get('accepted'):child_receipt['groupCopyAccepted']=True
        return result
    if cursor==final_cursor+3:
        result=_external_future(entry,cursor,dest)
        if result['status']=='complete' and entry.get('groupCombineInputs'):
            result['status']='pending'
        return result
    if cursor==final_cursor+4:
        doc,lifecycle=_external_document(ctx.app,_external_cast('_ExternalPin',entry.get('targetPin')),allow_open=True,editable=True)
        _external_require(doc is not None,str(lifecycle));entry['groupChildDoc']=doc
        doc=_external_cast('adsk.core.Document',doc)
        child=_external_ctx(doc);effects=[*_external_lifecycle_effects(lifecycle),*_external_activate(child)]
        rebindings=_external_group_rebind_combines(child,entry)
        baseline=_external_cast('_ExternalSnapshot',entry.get('baseline'))
        for check in range(len(baseline['bodies'])+1):
            _external_compare(baseline,child.root,check,runtime['tolerance'])
        return _external_with_lifecycle(_external_result('pending',cursor+1,typedInputRebindings=rebindings),effects)
    if cursor==final_cursor+5:
        doc=_external_cast('adsk.core.Document',entry.get('groupChildDoc'))
        entry['groupChildSaveBaseline']=int(_external_required_data_file(doc).versionNumber)
        if not doc.isModified:return _external_result('complete',cursor+1,target=_external_pin_json(entry['targetPin']),unchanged=True)
        _external_require(doc.save('Publish original grouped Combine input bindings'),'Grouped child save not accepted')
        return _external_result('pending',cursor+1,groupChildSaveAccepted=True)
    doc=_external_cast('adsk.core.Document',entry.get('groupChildDoc'))
    file=_external_required_data_file(doc)
    group_child_save_baseline=_external_cast('int',entry.get('groupChildSaveBaseline'))
    target_pin=_external_cast('_ExternalPin',entry.get('targetPin'))
    if doc.isModified or not file.isComplete or file.versionNumber<=group_child_save_baseline:
        return {**_external_result('pending',cursor),'waitingPublication':True}
    _external_require(file.id==target_pin['fileId'],'Grouped child save changed lineage')
    entry['targetPin']=_external_pin(file,doc.creationId)
    return _external_result('complete',cursor+1,target=_external_pin_json(entry['targetPin']),typedInputsPublished=True)


def _external_group_snapshot(ctx: "CadContext", roots: "list[adsk.fusion.Occurrence]") -> "_ExternalSnapshot":
    manager=adsk.fusion.TemporaryBRepManager.get()
    rows: list[_ExternalSnapshotOccurrence]=[]
    bodies: list[tuple[tuple[str, int] | tuple[str, int, int], adsk.fusion.BRepBody,
                       str, list[tuple[str, str, str]]]]=[]
    definitions:list[adsk.fusion.Component]=[]
    parent=_external_cast('adsk.fusion.Occurrence | None',getattr(roots[0],'assemblyContext',None))
    inverse=_external_entity_inverse(_external_entity_occurrence_matrix(ctx,parent)) if parent else list(adsk.core.Matrix3D.create().asArray())
    occurrences: list[adsk.fusion.Occurrence]=[]
    for root in roots:
        occurrences.append(root)
        occurrences.extend(o for o in _external_items(ctx.root.allOccurrences) if o.fullPathName.startswith(root.fullPathName+'+'))
    for index,occ in enumerate(occurrences):
        _external_health(occ.component)
        if occ.component not in definitions:definitions.append(occ.component)
        rows.append({'index':index,'componentToken':occ.component.entityToken,'token':occ.entityToken,
            'nativeToken':_external_native_occurrence_token(getattr(occ,'nativeObject',None) or occ),'path':occ.fullPathName,
            'pose':_external_entity_multiply(inverse,_external_entity_occurrence_matrix(ctx,occ)),
            'attrs':_external_attributes(occ),'nativeAttrs':_external_attributes(_external_native_attributed(occ)),
            'componentAttrs':_external_attributes(occ.component)})
        for number,body in enumerate(_external_items(occ.component.bRepBodies)):
            body_key: tuple[str, int] | tuple[str, int, int] = ('occurrence', index, number)
            bodies.append((body_key,manager.copy(body),body.material.id,_external_attributes(body)))
    inventory: _ExternalInventory={'bodies':sum(c.bRepBodies.count for c in definitions),
        'occurrences':len(occurrences),'history':sum(c.features.count+c.sketches.count for c in definitions)}
    history: list[JsonObject]=[{'features':[],'sketches':[]}]
    history.extend(_external_component_history(component) for component in definitions)
    joint_rows=_external_internal_joints(None,[None]+definitions)
    return {'inventory':inventory,'bodies':bodies,'attributes':[],'occurrences':rows,
            'history':history,'joints':joint_rows}


def _external_restore_local(ctx: "CadContext", expressions: "dict[str, str]") -> "list[JsonObject]":
    errors: list[JsonObject]=[]
    for name,expression in expressions.items():
        try:_external_required_user_parameter(ctx.design,name).expression=expression
        except Exception as error:errors.append({'parameter':name,'error':str(error)})
    try:_external_require(ctx.design.computeAll(),'Local restore recompute failed')
    except Exception as error:errors.append({'stage':'compute','error':str(error)})
    for name,expression in expressions.items():
        try:_external_require(_external_required_user_parameter(ctx.design,name).expression==expression,'Expression restore readback differs')
        except Exception as error:errors.append({'parameter':name,'stage':'readback','error':str(error)})
    return errors


def _external_source_pin(runtime: "_ExternalRuntime",source: "_ExternalProbeSource",binding: "bool"=False) -> "_ExternalPin":
    if 'itemId' in source:
        _cad_fields(source,('itemId',))
        _external_require(source['itemId'] in runtime['items'],'Unknown source itemId')
        pin=runtime['items'][source['itemId']]['targetPin']
        _external_require(pin is not None,'Source item copy/reuse not yet complete')
        if pin is None:raise ValueError('Source item copy/reuse not yet complete')
        return _external_cast('_ExternalPin',dict(pin))
    key='dataFileId' if binding else 'fileId'
    _cad_fields(source,('projectId',key,'version'),('creationId','context'))
    version=source.get('version')
    _external_require(type(version) is int and version>0,'Source version must be a positive integer')
    _external_require(source.get('context') in (None,'topLevel'),'Source context must be topLevel when specified')
    file_id=_external_cast('str',source.get('dataFileId') if binding else source.get('fileId'))
    project_id=_external_cast('str',source.get('projectId'))
    creation_id=source.get('creationId')
    context=source.get('context')
    return _external_cast('_ExternalPin',{'projectId':project_id,'fileId':file_id,'version':_external_cast('int',version),
            **({'creationId':creation_id} if creation_id else {}),
            **({'context':context} if context else {})})


def _external_probe_local_budget(remaining_ms: "float",reserve_ms: "float") -> "float | None":
    remaining=int(remaining_ms)
    reserve=int(reserve_ms)
    if remaining<=reserve:return None
    return remaining-reserve


def _external_rebind_probe_measurement(ctx: "CadContext",entry: "_ExternalItemState",check: "JsonObject",error: "Exception") -> "tuple[JsonObject, JsonObject]":
    measurement=_external_dict(check.get('measurement',{})) or {}
    data=_external_dict(measurement.get('data',{})) or {}
    ref=_external_dict(data.get('ref'))
    declared=_external_dict(ref.get('component')) if ref is not None else None
    rows=entry.get('instanceMap',[])
    definition_token=str(rows[0].get('definition')) if rows else None
    declared_token=declared.get('token') if declared is not None else None
    if (str(measurement.get('operation'))!='measure.volume' or ref is None or declared is None or
            not isinstance(declared_token,str) or declared_token!=definition_token or 'Entity token' not in str(error)):
        raise error
    components=[c for c in _external_own_components(ctx.root) if str(c.entityToken)==definition_token]
    component=_cad_unique(components,'Pinned probe definition in consumer context')
    bodies=_external_items(_external_cast('_CadItemCollection[adsk.fusion.BRepBody]',component.bRepBodies))
    baseline=_external_cast('_ExternalSnapshot',entry.get('baseline'))
    _external_require(len(bodies)==1 and baseline['inventory']['bodies']==1,
                      'Expired probe body token needs one exact selected-definition body')
    current: JsonObject=dict(check)
    current['measurement']=_external_cast('JsonObject',{
        **measurement,'data':{**data,'ref':ctx.ref(bodies[0])}})
    return current,{'method':'selectedDefinitionUniqueBody','itemId':entry['spec']['itemId'],
        'componentToken':definition_token,'bodyToken':str(bodies[0].entityToken)}


def _external_staged_probe_check(ctx: "CadContext",entry: "_ExternalItemState",check: "JsonObject") -> "JsonObject":
    measurement=_external_cast('JsonObject',check.get('measurement',{}))
    payload=_external_cast('JsonObject',measurement.get('data',{}))
    ref=payload.get('ref')
    if not isinstance(ref,dict) or 'itemId' not in ref:return check
    item_ref=_external_cast('_ExternalProbeItemReference',ref)
    _cad_fields(item_ref,('itemId','bodyIndex'),('instanceIndex',))
    _external_require(item_ref['itemId']==entry['spec']['itemId'],'Probe item ref is outside declared scope')
    index=item_ref.get('instanceIndex',0);body_index=item_ref['bodyIndex']
    refs=entry.get('stagedRefs',[])
    _external_require(type(index) is int and 0<=index<len(refs) and type(body_index) is int and body_index>=0,
                      'Probe staged instance/body index is invalid')
    occurrence_ref: _ExternalOccurrenceReference={
        'token':_external_cast('str',refs[index].get('token')),'kind':'occurrence'}
    occurrence=_external_occurrence(ctx,occurrence_ref)
    target_pin=_external_cast('_ExternalPin',entry.get('targetPin'))
    reference=occurrence.documentReference
    file=_external_reference_data_file(reference)
    _external_require(occurrence.isReferencedComponent and file is not None and file.id==target_pin['fileId'] and
        file.versionNumber==target_pin['version'],'Probe staged source version differs from confirmed receipt')
    _external_require(body_index<occurrence.component.bRepBodies.count,'Probe body index exceeds staged definition')
    body=occurrence.component.bRepBodies.item(body_index).createForAssemblyContext(occurrence)
    # Linked root component tokens may not resolve in the assembly design.
    # Pin the body token in its exact occurrence context instead of serializing
    # that redundant, unresolvable component token through ctx.ref(body).
    body_ref={'token':body.entityToken,'kind':'body',
              'occurrence':{'token':occurrence.entityToken,'kind':'occurrence'}}
    return {**check,'measurement':{**measurement,'data':{**payload,'ref':body_ref}}}


def _external_probe_measure_check(ctx: "CadContext",entry: "_ExternalItemState",check: "JsonObject") -> "JsonObject":
    check=_external_staged_probe_check(ctx,entry,check)
    try:return _measure_check(ctx,check)
    except Exception as error:
        rebound,evidence=_external_rebind_probe_measurement(ctx,entry,check,error)
        result=_measure_check(ctx,rebound);result['entityResolution']=evidence
        return result


def _external_validate_probe_checks(ctx: "CadContext",probe: "_ExternalProbeSpec",entry: "_ExternalItemState") -> "None":
    if probe.get('scope','assembly')=='assembly':
        for check in probe['checks']:
            check=_external_staged_probe_check(ctx,entry,check)
            try:_measure_validate_parameter_check(ctx,check)
            except Exception as error:
                rebound,evidence=_external_rebind_probe_measurement(ctx,entry,check,error)
                _measure_validate_parameter_check(ctx,rebound)
                entry.setdefault('probeReferenceResolutions',[]).append(evidence)


def _external_probe_refresh_bindings(derived_bindings: "list[JsonObject]",current_edges: "list[_ExternalReferenceEdge]") -> "list[JsonObject]":
    result: list[JsonObject]=[]
    drivers=_external_cast('list[_ExternalBoundDriver]',derived_bindings)
    edges=_external_cast('list[_ExternalDriverBindingEdge]',current_edges)
    for driver in drivers:
        matches: list[_ExternalDriverBindingEdge]=[]
        for current_edge in edges:
            if current_edge.get('kind')!='derive' or current_edge.get('sourceFileId')!=driver['sourceFileId'] or \
                    current_edge.get('edgeIdentityUnique') is not True:
                continue
            owner_file_id=driver.get('ownerFileId')
            if owner_file_id and current_edge.get('ownerFileId')!=owner_file_id:continue
            sources:set[str]={row['name'] for row in current_edge.get('sourceParameters',[])}
            derived:set[str]={row['name'] for row in current_edge.get('derivedParameters',[])}
            if driver['sourceParameter'] in sources and driver['nativeDerivedParameter'] in derived:
                matches.append(current_edge)
        _external_require(len(matches)==1,
                          'Saved consumer graph must uniquely identify each declared driver binding edge')
        edge=matches[0]
        result.append({'edgeId':edge['edgeId'],'sourceFileId':edge['sourceFileId'],
            'sourceParameter':driver['sourceParameter'],
            'nativeDerivedParameter':driver['nativeDerivedParameter'],
            'consumerAlias':driver['consumerAlias']})
    return result


def _external_close_probe_children(runtime: "_ExternalRuntime",manifest: "_ExternalManifest",app: "adsk.core.Application") -> "list[JsonObject]":
    effects: list[JsonObject]=[]
    item_ids: set[str]={target_item_id for binding in manifest.get('parameterBindings',[])
        if (target_item_id:=binding.get('targetItemId')) is not None}
    for item_id in sorted(item_ids):
        target_pin=runtime['items'][item_id].get('targetPin')
        _external_require(target_pin is not None,'Owned probe child has no pinned target')
        pinned_target=_external_cast('_ExternalPin',target_pin)
        pin=_external_cast('_ExternalPin',{**pinned_target,'context':'topLevel'})
        doc,observation=_external_document(app,pin,allow_open=False,editable=True)
        if doc is None:
            _external_require(observation.get('status')=='unavailable','Owned probe child editor is ambiguous')
            continue
        effects.append(_external_close_owned_clean_doc(_external_ctx(doc),pin))
    return effects


def _external_probe_validate_ui_targets(probe: "_ExternalProbeWithRefresh",pin: "_ExternalPin",doc: "adsk.core.Document") -> "None":
    refresh=probe['refresh']
    if refresh.get('nativeFallback','never')!='qualifiedOnce':return
    refresh_with_leases=_external_cast('_ExternalProbeRefreshWithLeases',refresh)
    file_id=pin['fileId'];creation_id=doc.creationId;name=doc.name
    for key,expected_name in (('driverUiLeases',name),
                              ('restoreUiLeases',_external_next_saved_name(name,pin['version']))):
        leases=(refresh_with_leases['driverUiLeases'] if key=='driverUiLeases'
                else refresh_with_leases['restoreUiLeases'])
        entry=leases.get(file_id)
        _external_require(entry is not None,'Request-bound '+key+' lacks the exact saved consumer fileId')
        lease=_external_cast('_ExternalUiLease',entry)
        target=lease['target']
        _external_require(target['fileId']==file_id and target['creationId']==creation_id and
                          target['name']==expected_name,
                          key+' target differs from the current/next exact saved consumer editor')


def _external_probe_refresh_bindings_payload(bindings: "list[JsonObject]") -> "list[JsonObject]":
    return [{name:row[name] for name in
        ('edgeId','sourceParameter','nativeDerivedParameter','consumerAlias')}
        for row in bindings]


def _external_probe_refresh_plan_request(data: "_ExternalStepData",probe: "_ExternalProbeWithRefresh",state: "_ExternalProbeState",key: "str") -> "JsonObject":
    target_value=state.get('targetPin')
    _external_require(target_value is not None,'Driver refresh requires the exact saved consumer baseline pin')
    target=_external_cast('_ExternalPin',target_value)
    source=state['source']
    published=state.get('publishedVersion')
    _external_require(all(target.get(name) for name in ('projectId','fileId')) and
                      type(target.get('version')) is int and target['version']>0,
                      'Driver refresh requires the exact saved consumer baseline pin')
    _external_require(source.get('fileId') and type(published) is int and published>0 and
                      source.get('version')==published,
                      'Driver refresh requires the exact settled producer publication receipt')
    suffix='restore' if state.get('restoring') else 'driver'
    return {'schemaVersion':1,'phase':'plan',
        'root':{name:target[name] for name in ('projectId','fileId','version')},
        'policy':'latest','lifecycle':'openOwned','durability':'cold',
        'reportPath':probe['refresh']['reportPath'],
        'nativeFallback':probe['refresh'].get('nativeFallback','never'),
        'parameterBindings':_external_probe_refresh_bindings_payload(state.get('refreshBindings',[])),
        'requestId':data['operationId']+'_'+key+'_'+suffix+'_plan'}


def _external_probe_validate_refresh_plan(state: "_ExternalProbeState",plan: "JsonObject") -> "None":
    bindings=_external_cast('list[_ExternalBoundDriver]',state.get('refreshBindings',[]))
    edges=_external_cast('list[_ExternalRefreshPlanEdge]',plan.get('edges',[]))
    baseline_edges=state.get('baselineEdges',[])
    expected:set[str]={row['edgeId'] for row in bindings
              if row.get('sourceFileId')==state['source']['fileId']}
    actual:set[str]={edge['edgeId'] for edge in edges
            if edge.get('kind')=='derive' and edge.get('sourceFileId')==state['source']['fileId']}
    _external_require(bool(expected) and actual==expected,
                      'Consumer plan omitted or changed the declared published driver binding edge')
    for edge in edges:
        if edge['sourceFileId']==state['source']['fileId']:
            _external_require(edge['targetVersion']==state['publishedVersion'],
                              'Consumer plan did not pin this exact producer publication')
        else:
            baseline=next((e for e in baseline_edges if e['edgeId']==edge['edgeId']),None)
            if baseline is None:
                _external_require(False,'Unrelated dependency drift during driver publication')
            else:
                expected_version=state.get('appliedVersions',{}).get(
                    edge['sourceFileId'],baseline['baselineVersion'])
                _external_require(expected_version==edge['targetVersion'],
                                  'Unrelated dependency drift during driver publication')


def _external_probe_refresh_apply_request(data: "_ExternalStepData",probe: "_ExternalProbeWithRefresh",state: "_ExternalProbeState",key: "str",plan: "JsonObject") -> "JsonObject":
    planned_value=state.get('refreshRequest')
    if planned_value is None:raise ValueError('Missing planned immutable consumer refresh request')
    planned=_external_cast('_ExternalProbeRefreshPlanRequest',planned_value)
    target_value=state.get('targetPin')
    if target_value is None:raise ValueError('Missing exact consumer pin for refresh apply')
    target=target_value
    _external_require(plan and plan.get('planId') and plan.get('invocationStatus')=='complete',
                      'Missing successful immutable consumer refresh plan')
    _external_require(plan.get('root')==planned.get('root') and planned.get('root')==
                      {name:target.get(name) for name in ('projectId','fileId','version')},
                      'Consumer refresh plan differs from the exact saved consumer baseline')
    suffix='restore' if state.get('restoring') else 'driver'
    request: JsonObject={'schemaVersion':1,'phase':'apply','confirm':True,
        'root':dict(planned['root']),'reportPath':planned['reportPath'],
        'planId':plan['planId'],'requestId':data['operationId']+'_'+key+'_'+suffix+'_apply',
        'policy':planned['policy'],'lifecycle':planned['lifecycle'],
        'durability':planned['durability'],'nativeFallback':planned['nativeFallback'],
        'parameterBindings':list(planned['parameterBindings'])}
    lease_key='restoreUiLeases' if state.get('restoring') else 'driverUiLeases'
    if probe['refresh'].get(lease_key):
        refresh_with_leases=_external_cast('_ExternalProbeRefreshValidation',probe['refresh'])
        leases=(refresh_with_leases['restoreUiLeases'] if lease_key=='restoreUiLeases'
                else refresh_with_leases['driverUiLeases'])
        request['uiLeases']=_external_cast('JsonValue',leases)
    return request


def _external_probe_step(runtime: "_ExternalRuntime",data: "_ExternalStepData",entry: "_ExternalItemState",cursor: "int") -> "JsonObject":
    probes=[p for p in data['manifest'].get('probes',[]) if p['itemId']==entry['spec']['itemId'] and
            p.get('scope','assembly')==data['phase'].split(':')[1]]
    completed=runtime.setdefault('completedProbes',set())
    states=runtime.setdefault('probes',{})
    probe_handles=runtime.setdefault('probeHandles',{})
    remaining=[p for p in probes if p['probeId'] not in completed]
    if not remaining:return _external_result('complete',cursor,sourceFingerprint=runtime['sourceFingerprint'],target=_external_pin_json(entry['targetPin']))
    _external_require(not data.get('outerReadOnly'),'Read-only caller forbids declared driver writes')
    probe=remaining[0];key=probe['probeId'];ctx=runtime['target'] or runtime['source']
    state=states.get(key)
    if state is None:
        probe_step_started=_external_time.monotonic()
        reserve=_EXTERNAL_PROBE_RESTORE_RESERVE_MS if probe.get('scope','assembly')=='assembly' else 0
        local_budget=_external_probe_local_budget(data['remainingMs'],reserve)
        if local_budget is None:
            return _external_result('pending',cursor,reason='budgetExhausted',stopReason='budgetExhausted',
                restorationReserveMsPlanned=reserve,restorationReserveMsUsed=0)
        try:_external_validate_probe_checks(ctx,probe,entry)
        except Exception as error:
            return {**_external_result('blocked',cursor,notStarted=True,
                reason='Probe check preflight: '+type(error).__name__+': '+str(error)),'notStarted':True}
        source=_external_source_pin(runtime,probe['source'])
        producer_file=_external_project_file(ctx.app,source['projectId'],source['fileId'],source['version'])
        if not _external_refresh_complete(producer_file):
            return {**_external_result('pending',cursor,target=_external_pin_json(_external_pin(producer_file)),reason='pendingPublication'),
                    'waitingPublication':True}
        doc,effect=_external_owned_document(runtime,source)
        _external_require(doc is not None and not doc.isModified and doc.dataFile.isReadOnly is False,
                          'Probe source must be a unique clean editable authorized owner')
        doc=_external_cast('adsk.core.Document',doc)
        source_ctx=_external_ctx(doc);parameter=_external_user_parameter(source_ctx.design,probe['parameter'])
        probe_activation=_external_activate(source_ctx)
        if probe.get('scope','assembly')=='assembly':
            context_file=_external_document_data_file(ctx.doc)
            _external_require(context_file is None or context_file.id!=source['fileId'],
                              'Cross-file probe needs a distinct producer; use scope:sources for local tests')
        _external_require(parameter is not None and parameter.unit and parameter.unit.lower()!='text',
                          'Probe requires a dimensional continuous scalar USER parameter; discrete/unitless count probes are not supported')
        parameter=_external_cast('adsk.fusion.UserParameter',parameter)
        units=source_ctx.design.unitsManager
        values=[units.evaluateExpression(probe[name],parameter.unit) for name in ('minimum','expression','maximum')]
        _external_require(all(_external_math.isfinite(v) for v in values) and values[0]<=values[1]<=values[2] and values[0]<values[2],'Probe outside declared continuous range')
        if probe.get('scope','assembly')=='assembly':
            # Even a locally restored producer edit dirties the source editor.
            # Save/capture/close the consumer BEFORE any producer setter so its
            # baseline cannot serialize a live, modified reference buffer.
            assembly_state: '_ExternalProbeState'={'stage':'baselineSave','source':_external_cast('_ExternalPin',dict(source)),
                'originalExpressions':{parameter.name:parameter.expression},'probeId':key,
                'localResult':None,'localProbeDeferred':True,'changed':False,'targetPin':None,
                'publishedVersion':None,'restorationReserveMsPlanned':reserve,'restorationReserveMsUsed':0}
            states[key]=assembly_state;probe_handles[key]=source_ctx
            runtime['compensation']=_external_cast('JsonObject',{k:v for k,v in assembly_state.items() if k!='localResult'})
            return _external_with_lifecycle(_external_result('pending',cursor+1,localProbeDeferred=True,
                compensation=runtime['compensation']),[*_external_lifecycle_effects(effect),*probe_activation])
        baseline=_external_snapshot(source_ctx.root)
        topology=lambda: [(key,body.faces.count,body.edges.count) for key,body in _external_bodies(source_ctx.root)]
        before_topology=topology();restored_checks: list[JsonObject]=[]
        def check_changed(*unused: "object") -> "bool":
            return topology()==before_topology
        def check_restored(*unused: "object") -> "bool":
            errors: list[str]=[]
            for index in range(len(baseline['bodies'])+1):
                try:restored_checks.append(_external_compare(baseline,source_ctx.root,index,runtime['tolerance']))
                except Exception as error:errors.append(str(error))
            return not errors
        local_budget=_external_probe_local_budget(data['remainingMs']-int((_external_time.monotonic()-probe_step_started)*1000),reserve)
        if local_budget is None:
            return _external_with_lifecycle(_external_result('pending',cursor,reason='budgetExhausted',stopReason='budgetExhausted',
                restorationReserveMsPlanned=reserve,restorationReserveMsUsed=0),
                [*_external_lifecycle_effects(effect),*probe_activation])
        local=_external_parameter_test(source_ctx,_external_cast('JsonObject',{'confirm':True,'timeBudgetMs':local_budget,
            'cases':[{'id':key,'assign':[{'parameter':probe['parameter'],'expression':probe['expression']}],
                      'checks':probe['checks'] if probe.get('scope')=='sources' else []}]}),
            check_changed,check_restored)
        local['restoredGeometryChecks']=restored_checks
        probe_reference_resolutions=entry.get('probeReferenceResolutions')
        if probe_reference_resolutions:
            local['probeReferenceResolutions']=list(probe_reference_resolutions)
        if local.get('status')=='partial' and local.get('restored') is True and local.get('budgetExhausted') is True:
            return _external_with_lifecycle(_external_result('pending',cursor,reason='budgetExhausted',stopReason='budgetExhausted',
                localProbe=local,restorationReserveMsPlanned=reserve,restorationReserveMsUsed=0),
                [*_external_lifecycle_effects(effect),*probe_activation])
        if local.get('passed') is not True:
            return _external_with_lifecycle(_external_result('failed',cursor,reason='Local probe/mandatory restore did not pass',localResult=local),
                [*_external_lifecycle_effects(effect),*probe_activation])
        local_state: '_ExternalProbeState'={'stage':'baselineSave','source':_external_cast('_ExternalPin',dict(source)),
            'originalExpressions':{parameter.name:parameter.expression},
            'probeId':key,'localResult':local,'changed':False,'targetPin':None,'publishedVersion':None,
            'restorationReserveMsPlanned':reserve,'restorationReserveMsUsed':0}
        states[key]=local_state;probe_handles[key]=source_ctx
        if probe.get('scope')=='sources':local_state['stage']='localSave'
        runtime['compensation']=_external_cast('JsonObject',{k:v for k,v in local_state.items() if k!='localResult'})
        return _external_with_lifecycle(_external_result('pending',cursor+1,localProbe=local,compensation=runtime['compensation']),
            [*_external_lifecycle_effects(effect),*probe_activation])
    state=states[key]
    source_ctx=probe_handles[key]
    observed=_external_observed_probe_receipt(data,entry['spec']['itemId'],data['phase'].split(':')[1])
    if state['stage'] in ('publishObserve','restoreObserve') and observed.get('producerCloseObserved') is True:
        _external_require(observed.get('publishedSource')==_external_pin_json(state['source']),
                          'Closed producer receipt identity differs')
        _external_require(not any(getattr(getattr(d,'dataFile',None),'id',None)==state['source']['fileId']
            for d in _external_items(source_ctx.app.documents)),'Producer reopened after close reconciliation')
        restoring=state['stage']=='restoreObserve';state['restoring']=restoring;state['stage']='refreshPlan'
        _external_compensation(runtime).update(stage='restorePublished' if restoring else 'published',pending=False,
            publishedVersion=state['publishedVersion'])
        return _external_result('pending',cursor+1,publishedSource=_external_pin_json(state['source']),compensation=runtime['compensation'])
    if state['stage']=='localProbe':
        _external_require(not ctx.doc.isValid,'Consumer must be closed before producer probe setters')
        _external_require(not source_ctx.doc.isModified and _external_required_data_file(source_ctx.doc).versionNumber==state['source']['version'],
                          'Producer changed before the deferred local probe')
        budget=_external_probe_local_budget(data['remainingMs'],state['restorationReserveMsPlanned'])
        if budget is None:return _external_result('pending',cursor,stopReason='budgetExhausted',reason='budgetExhausted')
        activation_effects=_external_activate(source_ctx)
        baseline=_external_snapshot(source_ctx.root)
        topology=lambda:[(key,b.faces.count,b.edges.count) for key,b in _external_bodies(source_ctx.root)]
        before=topology();restored: list[JsonObject]=[]
        def changed(*unused: "object") -> "bool":return topology()==before
        def restore(*unused: "object") -> "bool":
            errors: list[str]=[]
            for index in range(len(baseline['bodies'])+1):
                try:restored.append(_external_compare(baseline,source_ctx.root,index,runtime['tolerance']))
                except Exception as error:errors.append(str(error))
            return not errors
        local=_external_parameter_test(source_ctx,_external_cast('JsonObject',{
            'confirm':True,'timeBudgetMs':budget,'cases':[
                {'id':key,'assign':[{'parameter':probe['parameter'],'expression':probe['expression']}],
                 'checks':[]}]}),changed,restore)
        local['restoredGeometryChecks']=restored;state['localResult']=local
        if local.get('passed') is not True:
            return _external_with_lifecycle(_external_result('failed',cursor,reason='Deferred local probe/restore failed',localResult=local),activation_effects)
        state['localProbeDeferred']=False;state['stage']='publish'
        return _external_with_lifecycle(_external_result('pending',cursor+1,localProbe=local),activation_effects)
    if state['stage']=='localSave':
        activation_effects=_external_activate(source_ctx)
        state['sourceBaseline']=_external_required_data_file(source_ctx.doc).versionNumber
        if not source_ctx.doc.isModified:
            completed.add(key);runtime['compensation']=None
            return _external_with_lifecycle(_external_result('pending',cursor+1,probePassed=True,restored=True,
                localResult=state['localResult']),activation_effects)
        _external_require(source_ctx.doc.save('Restored local native driver '+key),'Local restore publication not accepted')
        state['stage']='localObserve'
        return _external_with_lifecycle(_external_result('pending',cursor+1,localRestorePublication=True),activation_effects)
    if state['stage']=='localObserve':
        file=_external_required_data_file(source_ctx.doc)
        source_baseline=_external_cast('int',state.get('sourceBaseline'))
        if source_ctx.doc.isModified or not file.isComplete or file.versionNumber<=source_baseline:
            _external_refresh_file(file)
            return {**_external_result('pending',cursor),'waitingPublication':True}
        target_pin=_external_cast('_ExternalPin',entry.get('targetPin'))
        if target_pin['fileId']==file.id:entry['targetPin']=_external_pin(file)
        completed.add(key);runtime['compensation']=None
        return _external_result('pending',cursor+1,probePassed=True,restored=True,localResult=state['localResult'],effectiveSource=_external_pin_json(_external_pin(file)))
    if state['stage']=='baselineSave':
        reserve=state.get('restorationReserveMsPlanned',0)
        if data.get('remainingMs',0)<=reserve:
            return _external_result('pending',cursor,reason='budgetExhausted',stopReason='budgetExhausted',
                restorationReserveMsPlanned=reserve,restorationReserveMsUsed=0)
        # Verification owns the explicitly authorized publication, not finalize.
        activation_effects=_external_activate(ctx)
        context_file=_external_document_data_file(ctx.doc)
        state['targetBaseline']=context_file.versionNumber if context_file is not None else 0
        state['baselineSaveSubmitted']=False
        if context_file is not None:
            if ctx.doc.isModified:
                _external_require(ctx.doc.save('Driver baseline '+key),'Save driver baseline')
                state['baselineSaveSubmitted']=True
        else:
            dest=_external_cast('_ExternalDestinationDocument',data['manifest'].get('destinationDocument'))
            folder=_external_folder(ctx.app,dest);_external_collision(folder,dest['name'])
            _external_require(ctx.doc.saveAs(dest['name'],folder,'Driver baseline '+key,''),'Save exact created driver target')
            state['baselineSaveSubmitted']=True
        state['stage']='baselineObserve'
        return _external_with_lifecycle(_external_result('pending',cursor+1,compensation=runtime['compensation']),activation_effects)
    if state['stage']=='baselineObserve':
        file=_external_document_data_file(ctx.doc)
        if file is None or ctx.doc.isModified or not file.isComplete:
            if file:_external_refresh_file(file)
            return {**_external_result('pending',cursor,compensation=runtime['compensation']),'waitingPublication':True}
        try:
            latest=_external_project_file(ctx.app,file.parentProject.id,file.id)
            # Refreshing the cloud lineage can replace the document's DataFile
            # wrapper. Re-read doc.dataFile before pinning; the prior wrapper
            # may still describe the pre-save version.
            file=ctx.doc.dataFile or file
            current_version=int(file.versionNumber);latest_version=int(latest.versionNumber)
        except Exception as error:
            if file:_external_refresh_file(file)
            return {**_external_result('pending',cursor,compensation=runtime['compensation'],
                waitingPublication=True,baselineReadError=type(error).__name__+': '+str(error))}
        target_baseline=state.get('targetBaseline',0)
        if state.get('baselineSaveSubmitted'):
            if latest_version<=target_baseline:
                _external_refresh_file(file)
                return {**_external_result('pending',cursor,compensation=runtime['compensation']),
                    'waitingPublication':True}
            if latest_version!=target_baseline+1:
                return _external_with_lifecycle(_external_result('blocked',cursor,notStarted=True,
                    reason='consumerBaselineRevisionDrift',baselineVersion=target_baseline,
                    latestVersion=latest_version),[])
        elif latest_version!=current_version:
            return _external_result('blocked',cursor,notStarted=True,reason='olderRevisionOpen',
                openVersion=current_version,latestVersion=latest_version)
        lifecycle: list[JsonObject]=[]
        if latest_version!=current_version:
            # Cloud completion can precede replacement of the editor DataFile
            # wrapper. Observe that same save; never close on a transient old pin.
            return {**_external_result('pending',cursor,baselineVersion=current_version,
                latestVersion=latest_version,reason='pendingPublication'),'waitingPublication':True}
        state['targetBaseline']=int(file.versionNumber)
        state['targetPin']=_external_pin(file,ctx.doc.creationId)
        target_pin=state.get('targetPin')
        _external_require(target_pin is not None,'Verified consumer refresh has no pinned baseline target')
        target_pin=_external_cast('_ExternalPin',target_pin)
        graph=_external_collect_graph({'root':_external_pin_object(target_pin),
            'policy':'preserve','lifecycle':'openOwned','allowedProjectIds':[target_pin['projectId']]})
        _external_require(graph.get('graphComplete') is True,'Probe baseline dependency graph is incomplete')
        lifecycle.extend(_external_graph_lifecycle_effects(graph))
        state['baselineEdges']=graph['edges']
        state['refreshBindings']=_external_probe_refresh_bindings(
            [{**row,'ownerFileId':row.get('ownerFileId',state['targetPin']['fileId'])}
             for row in runtime.get('derivedBindings',[])],state['baselineEdges'])
        _external_probe_validate_ui_targets(
            _external_cast('_ExternalProbeWithRefresh',probe),
            target_pin,ctx.doc)
        state['stage']='localProbe' if state.get('localProbeDeferred') else 'publish'
        if data['manifest']['mode'] in ('copyAndReplace','replaceFromExisting','replaceExternal') and ctx is runtime['source']:
            lifecycle.append(_external_close_owned_clean_doc(ctx,target_pin))
        elif data['manifest']['mode']=='composeNew' and ctx is runtime['target']:
            lifecycle.append(_external_close_owned_clean_doc(ctx,target_pin))
        return _external_with_lifecycle(_external_result('pending',cursor+1,
            consumerBaseline=_external_pin_json(target_pin),compensation=runtime['compensation']),lifecycle)
    if state['stage'] in ('publish','restorePublish'):
        restoring=state['stage']=='restorePublish'
        reserve=state.get('restorationReserveMsPlanned',0)
        if not restoring and data.get('remainingMs',0)<=reserve:
            return _external_result('pending',cursor,reason='budgetExhausted',stopReason='budgetExhausted',
                restorationReserveMsPlanned=reserve,restorationReserveMsUsed=0)
        if not restoring and state.get('restorationStartedAt') is None:
            state['restorationStartedAt']=_external_time.monotonic()
        forward_deadline=_external_time.monotonic()+max(0,float(data['remainingMs']))/1000.0
        activation_effects=_external_activate(source_ctx)
        original={name:_external_required_user_parameter(source_ctx.design,name).expression
                  for name in state['originalExpressions']}
        state['sourceBaseline']=_external_required_data_file(source_ctx.doc).versionNumber
        runtime['compensation']=_external_cast('JsonObject',{
            **state['source'],'probeId':key,'originalExpressions':state['originalExpressions'],
            'stage':'restorePublishing' if restoring else 'publishing','pending':True})
        entered_save=False
        try:
            assignments=state['originalExpressions'] if restoring else {probe['parameter']:probe['expression']}
            for name,expression in assignments.items():_external_required_user_parameter(source_ctx.design,name).expression=expression
            _external_require(source_ctx.design.computeAll(),'Probe recompute failed')
            _external_require(restoring or _external_time.monotonic()<forward_deadline,'budgetExhaustedBeforePublication')
            entered_save=True
            _external_require(source_ctx.doc.save('Authorized driver '+('restore ' if restoring else 'publish ')+key),'Probe save not accepted')
        except Exception as error:
            if entered_save:raise
            restore_errors=_external_restore_local(source_ctx,original)
            if str(error)=='budgetExhaustedBeforePublication' and not restore_errors:
                return _external_result('pending',cursor+1,reason='budgetExhausted',budgetExceeded=True,restored=True,
                    restorationReserveMs=state.get('restorationReserveMs',60000),restoreErrors=[])
            return _external_result('failed',cursor,primaryError=str(error),restoreErrors=restore_errors,
                compensation=runtime['compensation'],restored=not restore_errors)
        state['stage']='restoreObserve' if restoring else 'publishObserve'
        return _external_with_lifecycle(_external_result('pending',cursor+1,compensation=runtime['compensation']),activation_effects)
    if state['stage'] in ('publishObserve','restoreObserve'):
        file=source_ctx.doc.dataFile
        source_baseline=_external_cast('int',state.get('sourceBaseline'))
        if source_ctx.doc.isModified or not file.isComplete or file.versionNumber<=source_baseline:
            _external_refresh_file(file)
            return {**_external_result('pending',cursor,compensation=runtime['compensation']),'waitingPublication':True}
        state['publishedVersion']=int(file.versionNumber)
        state['source']=_external_pin(file,source_ctx.doc.creationId)
        # Independently saved versions must not share an editable producer
        # context when the consumer is cold-opened by references.refresh.
        producer_close_effect=_external_close_owned_clean_doc(source_ctx,state['source'])
        restoring=state['stage']=='restoreObserve';state['restoring']=restoring;state['stage']='refreshPlan'
        _external_compensation(runtime).update(stage='restorePublished' if restoring else 'published',pending=False,
            publishedVersion=state['publishedVersion'])
        return _external_with_lifecycle(_external_result('pending',cursor+1,publishedSource=_external_pin_json(state['source']),
            compensation=runtime['compensation']),[producer_close_effect])
    receipt=_external_observed_probe_receipt(data,entry['spec']['itemId'],data['phase'].split(':')[1])
    if state['stage']=='refreshPlan':
        refresh_probe=_external_cast('_ExternalProbeWithRefresh',probe)
        _cad_fields(refresh_probe['refresh'],('reportPath',),('nativeFallback','driverUiLeases','restoreUiLeases'))
        request=_external_probe_refresh_plan_request(data,refresh_probe,state,key)
        state['refreshRequest']=request;state['stage']='refreshApply'
        return _external_result('pending',cursor+1,refreshRequest=request,compensation=runtime['compensation'])
    if state['stage']=='refreshApply':
        plan=receipt.get('refreshReceipt')
        _external_require(plan and plan.get('planId') and plan.get('invocationStatus')=='complete',
                          'Missing successful immutable consumer refresh plan')
        plan=_external_cast('JsonObject',plan)
        _external_probe_validate_refresh_plan(state,plan)
        request=_external_probe_refresh_apply_request(
            data,_external_cast('_ExternalProbeWithRefresh',probe),state,key,plan)
        state['stage']='verifyConsumer'
        return _external_result('pending',cursor+1,refreshRequest=request,compensation=runtime['compensation'])
    if state['stage']=='verifyConsumer':
        refreshed_value=receipt.get('refreshReceipt')
        refreshed=_external_cast('_ExternalSuccessfulRefreshReceipt',refreshed_value)
        _external_require(refreshed and refreshed.get('success') is True and refreshed.get('allIntendedReferencesCurrent') is True,
                          'Actual consumer refresh did not pass; do not publish compensation while unknown')
        target_pin=_external_cast('_ExternalPin',state.get('targetPin'))
        rows=[r for r in refreshed['completed'] if r['fileId']==target_pin['fileId']]
        _external_require(len(rows)==1 and rows[0]['coldVerified'],'Driver requires separate cold consumer proof')
        target_pin['version']=rows[0]['resultingVersion']
        state['appliedVersions']={row['fileId']:row['resultingVersion'] for row in refreshed['completed']}
        for item in runtime['items'].values():
            item_target_pin=item.get('targetPin')
            if item_target_pin is not None and item_target_pin['fileId'] in state['appliedVersions']:
                item_target_pin['version']=state['appliedVersions'][item_target_pin['fileId']]
        doc,target_effect=_external_document(adsk.core.Application.get(),target_pin,allow_open=True,editable=True)
        _external_require(doc is not None,str(target_effect));doc=_external_cast('adsk.core.Document',doc)
        target=_external_ctx(doc)
        activation_effects=_external_activate(target)
        restoring=_external_probe_restoring(state)
        checks=[_external_probe_measure_check(target,entry,c) for c in probe['checks']] if not restoring else []
        _external_require(all(c.get('passed') is True for c in checks),'Independent physical driver checks failed')
        if restoring:
            runtime['target']=target if data['manifest']['mode']=='composeNew' else None
            if data['manifest']['mode']!='composeNew':runtime['source']=target
            for item in runtime['items'].values():
                staged_refs=item.get('stagedRefs',[])
                staged_occurrences: list[adsk.fusion.Occurrence]=[]
                for ref in staged_refs:
                    token_ref: _ExternalOccurrenceReference={
                        'token':_external_cast('str',ref.get('token')),'kind':'occurrence'}
                    staged_occurrences.append(_external_occurrence(target,token_ref))
                item['staged']=staged_occurrences
                if data['manifest']['mode'] in ('copyAndReplace','replaceFromExisting'):
                    extraction_groups=data['manifest'].get('extractionGroups',[])
                    original_refs=next((g['members'] for g in extraction_groups if g['id']==item['spec'].get('groupId')),None)
                    source_refs=[row.get('source') for row in item['instanceMap'] if row.get('source') is not None]
                    refs=original_refs or source_refs
                    item['originals']=[_external_occurrence(target,
                        _external_cast('_ExternalOccurrenceReference',ref)) for ref in refs]
                for occurrence in item['staged']:
                    baseline=_external_cast('_ExternalSnapshot',item.get('baseline'))
                    for check in range(len(baseline['bodies'])+1):
                        _external_compare(baseline,occurrence.component,check,runtime['tolerance'])
            runtime['sourceFingerprint']=_external_fingerprint(runtime['source'])
            restoration_started=state.get('restorationStartedAt')
            restoration_reserve_used=0
            if restoration_started is not None:
                restoration_reserve_used=max(0,int((_external_time.monotonic()-restoration_started)*1000))
            state['restorationReserveMsUsed']=restoration_reserve_used
            completed.add(key);runtime['compensation']=None
            return _external_with_lifecycle(_external_result('pending',cursor+1,probePassed=True,restored=True,checks=checks,
                restorationReserveMsPlanned=state.get('restorationReserveMsPlanned',0),
                restorationReserveMsUsed=state['restorationReserveMsUsed']),
                [*_external_lifecycle_effects(target_effect),*activation_effects])
        _external_require(not doc.isModified,'Driver consumer must remain a clean exact refreshed document')
        consumer_applied_version=state.get('publishedVersion')
        if consumer_applied_version is None:raise ValueError('Driver publication version is unavailable')
        state['consumerAppliedVersion']=consumer_applied_version
        close_effect: list[JsonObject]=[]
        if data['manifest']['mode'] in ('copyAndReplace','replaceFromExisting','replaceExternal','composeNew'):
            if data['manifest']['mode']=='composeNew':runtime['target']=target
            else:runtime['source']=target
            close_effect.append(_external_close_owned_clean_doc(target,target_pin))
        close_effect.extend(_external_close_probe_children(runtime,data['manifest'],target.app))
        source_pin=state['source']
        source,source_effect=_external_document(adsk.core.Application.get(),source_pin,allow_open=True,editable=True)
        _external_require(source is not None,str(source_effect));probe_handles[key]=_external_ctx(
            _external_cast('adsk.core.Document',source))
        state['stage']='restorePublish'
        return _external_with_lifecycle(_external_result('pending',cursor+1,driverChecks=checks,compensation=runtime['compensation']),
            [*_external_lifecycle_effects(target_effect),*_external_lifecycle_effects(source_effect),*activation_effects,*close_effect])
    raise ValueError('Unrecognized probe checkpoint; no replay')


CAD_HANDLERS['occurrence.insert_external'] = _external_insert
