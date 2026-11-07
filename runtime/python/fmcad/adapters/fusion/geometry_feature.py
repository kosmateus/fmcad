"""Fusion adapter: GM09 parameter roles, extents and marker-restoring edits.

Roles are read from the feature structure (extent definitions, start definitions,
named parameter properties), never assumed from a generic label such as AlongDistance.
Structural extent edits roll the timeline marker to the feature and always restore it;
restore replays downstream features and never deletes geometry. Cross-component
extent targets are reported with explicit ownership and refused for edit without an
explicit proxy/transform context. See docs/FEATURE.md.
"""
import json as _geometry_feature_json
import re as _geometry_feature_re

import adsk.core as _geometry_feature_core
import adsk.fusion as _geometry_feature_fusion
from typing import Literal as _GeometryFeatureLiteral
from typing import Protocol as _GeometryFeatureProtocol
from typing import TypeVar as _geometry_feature_TypeVar
from typing import cast as _geometry_feature_adapter_cast
from typing import overload as _geometry_feature_overload
from typing import TypedDict as _GeometryFeatureTypedDict


_FeatureClassResult = _geometry_feature_TypeVar('_FeatureClassResult', covariant=True)


class _FeatureParameter(_GeometryFeatureProtocol):
    @property
    def name(self) -> str: ...

    @property
    def expression(self) -> str: ...

    @expression.setter
    def expression(self, value: str) -> None: ...

    @property
    def unit(self) -> str: ...

    @property
    def value(self) -> float: ...


class _FeatureAssemblyContext(_GeometryFeatureProtocol):
    @property
    def assemblyContext(self) -> "adsk.fusion.Occurrence | None": ...


class _FeatureCaster(_GeometryFeatureProtocol[_FeatureClassResult]):
    @staticmethod
    def cast(value: object, /) -> _FeatureClassResult | None: ...


class _FeatureHoleDepthDefinition(_GeometryFeatureProtocol):
    @property
    def depth(self) -> "_FeatureParameter | None": ...


class _FeatureHoleOffsetDefinition(_GeometryFeatureProtocol):
    @property
    def offset(self) -> "_FeatureParameter | None": ...

    @property
    def entity(self) -> "CadEntity | None": ...


class _FeatureEdgeSetCollection(_GeometryFeatureProtocol):
    @property
    def count(self) -> int: ...

    def item(self, index: int, /) -> "CadEntity": ...


class _FeatureEdgeSetSource(_GeometryFeatureProtocol):
    @property
    def edgeSets(self) -> _FeatureEdgeSetCollection: ...


class _FeaturePatternElements(_GeometryFeatureProtocol):
    @property
    def patternElements(self) -> "adsk.fusion.PatternElements": ...


class _FeatureOwnedParameter(_GeometryFeatureProtocol):
    @property
    def createdBy(self) -> "CadEntity | None": ...

    @property
    def name(self) -> str: ...


class _FeatureExtrude(_GeometryFeatureProtocol):
    hasTwoExtents: bool
    symmetricExtent: object
    extentOne: object
    extentTwo: object
    startExtent: object
    taperAngleOne: object | None
    taperAngleTwo: object | None

    def setOneSideExtent(self, extent: "adsk.fusion.ExtentDefinition",
                         direction: "adsk.fusion.ExtentDirections",
                         taperAngle: "adsk.core.ValueInput | None" = None) -> bool: ...

    def setSymmetricExtent(self, distance: "adsk.core.ValueInput", isFullLength: bool,
                           taperAngle: "adsk.core.ValueInput | None" = None) -> bool: ...

    def setTwoSidesExtent(self, sideOneExtent: "adsk.fusion.ExtentDefinition",
                          sideTwoExtent: "adsk.fusion.ExtentDefinition",
                          sideOneTaperAngle: "adsk.core.ValueInput | None" = None,
                          sideTwoTaperAngle: "adsk.core.ValueInput | None" = None) -> bool: ...


class _FeatureRevolve(_GeometryFeatureProtocol):
    extentDefinition: object

    def setAngleExtent(self, isSymmetric: bool, angle: "adsk.core.ValueInput") -> bool: ...

    def setTwoSideAngleExtent(self, angleOne: "adsk.core.ValueInput",
                              angleTwo: "adsk.core.ValueInput") -> bool: ...

    def setOneSideToExtent(self, toEntity: "adsk.core.Base",
                           directionHint: "adsk.core.Vector3D | None" = None) -> bool: ...


class _FeatureHole(_GeometryFeatureProtocol):
    extentDefinition: object
    holeDiameter: object
    holeTapType: object
    holeType: object
    isDefaultDirection: bool
    participantBodies: list["adsk.fusion.BRepBody"]

    def __getattr__(self, name: str, /) -> object: ...

    def setDistanceExtent(self, distance: "adsk.core.ValueInput") -> bool: ...

    def setAllExtent(self, direction: "adsk.fusion.ExtentDirections") -> bool: ...

    def setOneSideToExtent(self, toEntity: "adsk.core.Base", matchShape: bool,
                           directionHint: "adsk.core.Vector3D | None" = None) -> bool: ...

    def setToSimple(self) -> bool: ...

    def setToCounterbore(self, counterboreDiameter: "adsk.core.ValueInput",
                         counterboreDepth: "adsk.core.ValueInput") -> bool: ...

    def setToCountersink(self, countersinkDiameter: "adsk.core.ValueInput",
                         countersinkAngle: "adsk.core.ValueInput") -> bool: ...

    def setPositionBySketchPoint(self, sketchPoint: "adsk.fusion.SketchPoint") -> bool: ...

    def setPositionBySketchPoints(self, sketchPoints: "adsk.core.ObjectCollection") -> bool: ...

    def setPositionByPoint(self, planarEntity: "adsk.core.Base", point: "adsk.core.Base") -> bool: ...

    def setPositionAtCenter(self, planarEntity: "adsk.core.Base", centerEdge: "adsk.fusion.BRepEdge") -> bool: ...

    def setPositionByPlaneAndOffsets(self, planarEntity: "adsk.core.Base", point: "adsk.core.Point3D",
                                     edgeOne: "adsk.fusion.BRepEdge", offsetOne: "adsk.core.ValueInput",
                                     edgeTwo: "adsk.fusion.BRepEdge | None" = None,
                                     offsetTwo: "adsk.core.ValueInput | None" = None) -> bool: ...

    def setPositionOnEdge(self, planarEntity: "adsk.core.Base", edge: "adsk.fusion.BRepEdge",
                          position: "adsk.fusion.HoleEdgePositions") -> bool: ...


class _FeatureFillet(_GeometryFeatureProtocol):
    edgeSets: _FeatureEdgeSetCollection
    fullRoundFilletFaceSets: "adsk.fusion.FullRoundFilletFaceSets"
    isRollingBallCorner: bool


class _FeatureChamfer(_GeometryFeatureProtocol):
    edgeSets: _FeatureEdgeSetCollection
    cornerType: "adsk.fusion.ChamferCornerTypes"


class _FeatureShell(_GeometryFeatureProtocol):
    inputEntities: "adsk.core.ObjectCollection"
    insideThickness: _FeatureParameter
    outsideThickness: _FeatureParameter

    def setInputEntities(self, entities: "adsk.core.ObjectCollection", isTangentChain: bool = True) -> bool: ...

    def setThicknesses(self, insideThickness: "adsk.core.ValueInput | None",
                       outsideThickness: "adsk.core.ValueInput | None") -> bool: ...


class _FeatureThicken(_GeometryFeatureProtocol):
    inputFaces: "adsk.core.ObjectCollection"

    def setInputEntities(self, inputFaces: "adsk.core.ObjectCollection",
                         isChainSelection: bool = True) -> bool: ...


class _FeatureLoft(_GeometryFeatureProtocol):
    loftSections: "adsk.fusion.LoftSections"
    centerLineOrRails: "adsk.fusion.LoftCenterLineOrRails"
    startLoftEdgeAlignment: "adsk.fusion.LoftEdgeAlignments"
    endLoftEdgeAlignment: "adsk.fusion.LoftEdgeAlignments"


class _FeatureTimelineIndex(_GeometryFeatureProtocol):
    @property
    def index(self) -> int: ...


class _FeatureExtentPlan(_GeometryFeatureTypedDict):
    kind: str
    mode: str
    target: "CadEntity | None"


class _FeatureNativePlan(_GeometryFeatureTypedDict):
    kind: str
    resolved: dict[str, object]
    summary: "JsonObject"


class _FeatureOperationPlan(_GeometryFeatureTypedDict):
    kind: str
    expected: str
    value: str
    expectedResultBodyCount: int
    participants: list["adsk.fusion.BRepBody"]
    target: object | None


class _FeatureDynamicAccess(_GeometryFeatureProtocol):
    def __getattr__(self, name: str, /) -> object: ...

    def __setattr__(self, name: str, value: object, /) -> None: ...


class _FeatureRename(_GeometryFeatureProtocol):
    @property
    def name(self) -> str: ...

    @name.setter
    def name(self, value: str) -> None: ...


class _FeatureOperationMutable(_GeometryFeatureProtocol):
    operation: object
    participantBodies: list["adsk.fusion.BRepBody"]


class _FeatureExpression(_GeometryFeatureProtocol):
    def expression(self, expression: str, units: str | None = None, unitless: bool = False, /) -> object: ...


class _FeatureEntityCollection(_GeometryFeatureProtocol):
    @property
    def count(self) -> int: ...

    def item(self, index: int, /) -> "adsk.core.Base": ...


class _FeatureObjectCollection(_GeometryFeatureProtocol):
    @property
    def count(self) -> int: ...

    def item(self, index: int, /) -> object: ...


class _FeatureToEntityExtent(_GeometryFeatureProtocol):
    @property
    def offset(self) -> "adsk.core.Base": ...

    @offset.setter
    def offset(self, value: "adsk.core.ValueInput") -> None: ...


class _FeatureTimelineItem(_GeometryFeatureProtocol):
    @property
    def name(self) -> str: ...

    @property
    def healthState(self) -> object: ...

    @property
    def errorOrWarningMessage(self) -> str: ...


class _FeatureTimeline(_GeometryFeatureProtocol):
    @property
    def count(self) -> int: ...

    def item(self, index: int, /) -> _FeatureTimelineItem: ...


class _FeatureMutableTimeline(_GeometryFeatureProtocol):
    @property
    def markerPosition(self) -> int: ...

    @markerPosition.setter
    def markerPosition(self, value: int) -> None: ...

    @property
    def count(self) -> int: ...


class _FeatureOccurrenceCollection(_GeometryFeatureProtocol):
    @property
    def count(self) -> int: ...

    def item(self, index: int, /) -> "adsk.fusion.Occurrence": ...


class _FeatureOccurrenceMatrix(_GeometryFeatureProtocol):
    def asArray(self) -> list[float]: ...


class _FeatureBRepEdgeCaster(_GeometryFeatureProtocol):
    @staticmethod
    def cast(value: object, /) -> "adsk.fusion.BRepEdge | None": ...


class _FeatureBRepBodyCaster(_GeometryFeatureProtocol):
    @staticmethod
    def cast(value: object, /) -> "adsk.fusion.BRepBody | None": ...


class _FeatureBRepFaceCaster(_GeometryFeatureProtocol):
    @staticmethod
    def cast(value: object, /) -> "adsk.fusion.BRepFace | None": ...


class _FeatureSketchPointCaster(_GeometryFeatureProtocol):
    @staticmethod
    def cast(value: object, /) -> "adsk.fusion.SketchPoint | None": ...


class _FeatureLine3DCaster(_GeometryFeatureProtocol):
    @staticmethod
    def cast(value: object, /) -> "adsk.core.Line3D | None": ...


class _FeatureCircle3DCaster(_GeometryFeatureProtocol):
    @staticmethod
    def cast(value: object, /) -> "adsk.core.Circle3D | None": ...


class _FeatureEllipse3DCaster(_GeometryFeatureProtocol):
    @staticmethod
    def cast(value: object, /) -> "adsk.core.Ellipse3D | None": ...


class _FeatureHolePositionData(_GeometryFeatureProtocol):
    def __getattr__(self, name: str, /) -> object: ...


def _feature_record_text(result: "JsonObject", key: str, default: str) -> str:
    value = result.pop(key, default)
    if not isinstance(value, str):
        raise ValueError(key + ' must be text')
    return value


def _feature_record_string_list(result: "JsonObject", key: str, default: list[str] | None) -> list[str]:
    value = result.pop(key, default or [])
    if not isinstance(value, list):
        raise ValueError(key + ' must be an array of text values')
    items: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError(key + ' must be an array of text values')
        items.append(item)
    return items


def _feature_record_value_list(result: "JsonObject", key: str, default: list["JsonValue"]) -> list["JsonValue"]:
    value = result.pop(key, default)
    if not isinstance(value, list):
        raise ValueError(key + ' must be an array')
    return value


def _feature_json_object(value: object, label: str) -> "JsonObject":
    if not isinstance(value, dict):
        raise ValueError(label + ' must be an object')
    entries = _geometry_feature_adapter_cast("dict[object, object]", value)
    if any(not isinstance(key, str) for key in entries):
        raise ValueError(label + ' keys must be strings')
    return _geometry_feature_adapter_cast("JsonObject", entries)


def _feature_json_object_or_none(value: object, label: str) -> "JsonObject | None":
    if not isinstance(value, dict):
        return None
    entries = _geometry_feature_adapter_cast("dict[object, object]", value)
    if any(not isinstance(key, str) for key in entries):
        raise ValueError(label + ' keys must be strings')
    return _geometry_feature_adapter_cast("JsonObject", entries)


def _feature_identity(ctx: "CadContext") -> "JsonObject":
    ctx.assert_identity()
    return {'creationId': getattr(ctx.doc, 'creationId', None), 'name': ctx.doc.name}


def _feature_contract(ctx: "CadContext", operation: str, result: "JsonObject", status: str = 'pass',
    associativity: str | None = None, warnings: list[str] | None = None,
                      limitations: list[str] | None = None, **extra: "JsonValue") -> "JsonObject":
    ctx.assert_identity()
    return dict(schemaVersion=1, operation=operation, status=status, success=status == 'pass',
                documentIdentity=_feature_identity(ctx),
                units={'length': 'cm', 'angle': 'rad'}, frame={'space': 'component', 'component': ctx.ref(ctx.component)},
                 associativity=_feature_record_text(result, 'associativity', associativity or 'snapshot'),
                 warnings=_feature_record_string_list(result, 'warnings', warnings),
                method='Feature structure readback and marker-restoring edits (GM09)',
                 limitations=_feature_record_string_list(result, 'limitations', limitations),
                provenance={'requirement': 'GM09', 'source': 'docs/FEATURE.md'},
                 affected=_feature_record_value_list(result, 'affected', []), **extra, **result)


def _feature_owner_check(ctx: "CadContext", feature: "CadEntity") -> None:
    if getattr(feature, 'assemblyContext', None) is not None or (_cad_owner(feature) is not None and _cad_owner(feature) != ctx.component):
        raise ValueError('Feature commands require a native feature in the selected component')


def _feature_parameter(parameter: "_FeatureParameter", role: str,
                       target: "JsonValue | None" = None,
                       ownership: "JsonValue | None" = None) -> "JsonObject":
    row: "JsonObject" = {'role': role, 'name': parameter.name, 'expression': parameter.expression,
                          'unit': parameter.unit, 'value': parameter.value}
    if target is not None:
        row['target'] = target
    if ownership is not None:
        row['ownership'] = ownership
    return row


def _feature_parameter_value(parameter: object, role: str) -> "JsonObject":
    return _feature_parameter(_geometry_feature_adapter_cast(_FeatureParameter, parameter), role)


def _feature_target(ctx: "CadContext", entity: "CadEntity | None") -> "JsonObject":
    if entity is None:
        return {'status': 'none'}
    owner = _cad_owner(entity)
    occurrence = ( _geometry_feature_adapter_cast(_FeatureAssemblyContext, entity).assemblyContext
                   if hasattr(entity, 'assemblyContext') else None)
    reference = ctx.ref(entity)
    if owner is None:
        return {'ref': reference, 'ownership': 'unknown', 'associativity': 'unknown', 'editable': False}
    if owner == ctx.component and occurrence is None:
        return {'ref': reference, 'ownership': 'local', 'associativity': 'nativeReference', 'editable': True}
    return {'ref': reference, 'ownership': 'foreign', 'associativity': 'nativeReference', 'editable': False,
            'occurrence': ctx.ref(occurrence) if occurrence is not None else None,
            'transform': 'not evaluated',
            'message': 'Cross-component entity: explicit proxy/transform/ownership is required; no fake associative copy is reported'}


@_geometry_feature_overload
def _feature_cast(name: _GeometryFeatureLiteral['SymmetricExtentDefinition'], value: object) -> "adsk.fusion.SymmetricExtentDefinition | None": ...


@_geometry_feature_overload
def _feature_cast(name: _GeometryFeatureLiteral['DistanceExtentDefinition'], value: object) -> "adsk.fusion.DistanceExtentDefinition | None": ...


@_geometry_feature_overload
def _feature_cast(name: _GeometryFeatureLiteral['ToEntityExtentDefinition'], value: object) -> "adsk.fusion.ToEntityExtentDefinition | None": ...


@_geometry_feature_overload
def _feature_cast(name: _GeometryFeatureLiteral['OffsetStartDefinition'], value: object) -> "adsk.fusion.OffsetStartDefinition | None": ...


@_geometry_feature_overload
def _feature_cast(name: _GeometryFeatureLiteral['FromEntityStartDefinition'], value: object) -> "adsk.fusion.FromEntityStartDefinition | None": ...


@_geometry_feature_overload
def _feature_cast(name: _GeometryFeatureLiteral['AngleExtentDefinition'], value: object) -> "adsk.fusion.AngleExtentDefinition | None": ...


@_geometry_feature_overload
def _feature_cast(name: _GeometryFeatureLiteral['TwoSidesAngleExtentDefinition'], value: object) -> "adsk.fusion.TwoSidesAngleExtentDefinition | None": ...


@_geometry_feature_overload
def _feature_cast(name: str, value: object) -> "CadEntity | None": ...


def _feature_cast(name: str, value: object) -> "CadEntity | None":
    candidate: object | None = getattr(_geometry_feature_fusion, name, None)
    if candidate is None or value is None:
        return None
    caster = _geometry_feature_adapter_cast(_FeatureCaster["CadEntity"], candidate)
    return caster.cast(value)


def _feature_sdk_object(name: str, value: object) -> object:
    candidate: object | None = getattr(_geometry_feature_fusion, name, None)
    if candidate is None:
        entity = _feature_cad_entity(value)
        if entity is None or _cad_type(entity) != name:
            raise ValueError('Expected native ' + name)
        return entity
    caster = _geometry_feature_adapter_cast(_FeatureCaster["CadEntity"], candidate)
    typed = caster.cast(value)
    if typed is None:
        raise ValueError('Expected native ' + name)
    return typed


def _feature_cad_entity(value: object) -> "CadEntity | None":
    base_class: object | None = getattr(_geometry_feature_core, 'Base', None)
    if base_class is not None:
        caster = _geometry_feature_adapter_cast(_FeatureCaster["CadEntity"], base_class)
        return caster.cast(value)
    if hasattr(value, 'objectType') and hasattr(value, 'entityToken'):
        return _geometry_feature_adapter_cast("CadEntity", value)
    return None


def _feature_extrude_bindings(ctx: "CadContext", feature: object) -> "list[tuple[JsonObject, _FeatureParameter]]":
    feature = _geometry_feature_adapter_cast(_FeatureDynamicAccess, feature)
    bindings: list[tuple["JsonObject", "_FeatureParameter"]] = []
    symmetric = _feature_cast('SymmetricExtentDefinition', getattr(feature, 'symmetricExtent', None))
    if symmetric is not None:
        distance_value = _geometry_feature_adapter_cast(object, getattr(symmetric, 'distance', None))
        if distance_value is not None:
            distance_parameter = _geometry_feature_adapter_cast(_FeatureParameter, distance_value)
            bindings.append((_feature_parameter(distance_parameter, 'distance'), distance_parameter))
        taper_value = _geometry_feature_adapter_cast(object, getattr(symmetric, 'taperAngle', None))
        if taper_value is not None:
            taper_parameter = _geometry_feature_adapter_cast(_FeatureParameter, taper_value)
            bindings.append((_feature_parameter(taper_parameter, 'taperAngle'), taper_parameter))
    for side, role in (('One', 'distance'), ('Two', 'distanceTwo')):
        extent = getattr(feature, 'extent' + side, None)
        distance = _feature_cast('DistanceExtentDefinition', extent)
        distance_value = (_geometry_feature_adapter_cast(object, getattr(distance, 'distance', None))
                          if distance is not None else None)
        if distance_value is not None:
            distance_parameter = _geometry_feature_adapter_cast(_FeatureParameter, distance_value)
            bindings.append((_feature_parameter(distance_parameter, role), distance_parameter))
        to_entity = _feature_cast('ToEntityExtentDefinition', extent)
        if to_entity is not None:
            offset_value = _geometry_feature_adapter_cast(object, getattr(to_entity, 'offset', None))
            if offset_value is not None:
                offset_parameter = _geometry_feature_adapter_cast(_FeatureParameter, offset_value)
                bindings.append((_feature_parameter(offset_parameter, 'offset' if side == 'One' else 'offsetTwo',
                    target=_feature_target(ctx, getattr(to_entity, 'entity', None))), offset_parameter))
    start = getattr(feature, 'startExtent', None)
    offset_start = _feature_cast('OffsetStartDefinition', start)
    offset_value = (_geometry_feature_adapter_cast(object, getattr(offset_start, 'offset', None))
                    if offset_start is not None else None)
    if offset_value is not None:
        offset_parameter = _geometry_feature_adapter_cast(_FeatureParameter, offset_value)
        bindings.append((_feature_parameter(offset_parameter, 'startOffset'), offset_parameter))
    from_entity = _feature_cast('FromEntityStartDefinition', start)
    from_offset_value = (_geometry_feature_adapter_cast(object, getattr(from_entity, 'offset', None))
                         if from_entity is not None else None)
    if from_offset_value is not None:
        from_offset = _geometry_feature_adapter_cast(_FeatureParameter, from_offset_value)
        bindings.append((_feature_parameter(from_offset, 'startEntityOffset',
            target=_feature_target(ctx, getattr(from_entity, 'entity', None))), from_offset))
    for prop, role in (('taperAngleOne', 'taperAngle'), ('taperAngleTwo', 'taperAngleTwo')):
        parameter = getattr(feature, prop, None)
        if parameter is not None:
            feature_parameter = _geometry_feature_adapter_cast(_FeatureParameter, parameter)
            bindings.append((_feature_parameter(feature_parameter, role), feature_parameter))
    return bindings


def _feature_revolve_bindings(ctx: "CadContext", feature: object) -> "list[tuple[JsonObject, _FeatureParameter]]":
    feature = _geometry_feature_adapter_cast(_FeatureDynamicAccess, feature)
    extent_definition = getattr(feature, 'extentDefinition', None)
    extent = _feature_cast('AngleExtentDefinition', extent_definition)
    angle_value = (_geometry_feature_adapter_cast(object, getattr(extent, 'angle', None))
                   if extent is not None else None)
    if angle_value is not None:
        angle = _geometry_feature_adapter_cast(_FeatureParameter, angle_value)
        return [(_feature_parameter(angle, 'angle'), angle)]
    two_sided = _feature_cast('TwoSidesAngleExtentDefinition', extent_definition)
    if two_sided is not None:
        return [(_feature_parameter(two_sided.angleOne, 'angle'), two_sided.angleOne),
                (_feature_parameter(two_sided.angleTwo, 'angleTwo'), two_sided.angleTwo)]
    return []


def _feature_hole_bindings(ctx: "CadContext", feature: object) -> "list[tuple[JsonObject, _FeatureParameter]]":
    feature = _geometry_feature_adapter_cast(_FeatureDynamicAccess, feature)
    bindings: list[tuple["JsonObject", "_FeatureParameter"]] = []
    for prop, role in (('holeDiameter', 'diameter'), ('tipAngle', 'tipAngle'),
                       ('counterboreDiameter', 'counterboreDiameter'), ('counterboreDepth', 'counterboreDepth'),
                       ('countersinkDiameter', 'countersinkDiameter'), ('countersinkAngle', 'countersinkAngle')):
        parameter_value = _geometry_feature_adapter_cast(object, getattr(feature, prop, None))
        if parameter_value is not None:
            parameter = _geometry_feature_adapter_cast(_FeatureParameter, parameter_value)
            bindings.append((_feature_parameter(parameter, role), parameter))
    extent = getattr(feature, 'extentDefinition', None)
    distance = _feature_cast('DistanceHoleExtentDefinition', extent)
    depth = (_geometry_feature_adapter_cast(_FeatureHoleDepthDefinition, distance).depth
             if distance is not None else None)
    if depth is not None:
        bindings.append((_feature_parameter(depth, 'depth'), depth))
    to_entity = _feature_cast('ToEntityHoleExtentDefinition', extent)
    hole_offset = (_geometry_feature_adapter_cast(_FeatureHoleOffsetDefinition, to_entity)
                   if to_entity is not None else None)
    if hole_offset is not None and hole_offset.offset is not None:
        bindings.append((_feature_parameter(hole_offset.offset, 'offset',
            target=_feature_target(ctx, hole_offset.entity)), hole_offset.offset))
    return bindings


def _feature_edge_set_parameters(ctx: "CadContext", feature: object,
                                 types: "Sequence[tuple[str, Sequence[tuple[str, str]]]]") -> "list[tuple[JsonObject, _FeatureParameter]]":
    bindings: list[tuple["JsonObject", "_FeatureParameter"]] = []
    edge_sets_value: object | None = getattr(feature, 'edgeSets', None)
    if edge_sets_value is None:
        return bindings
    edge_sets = _geometry_feature_adapter_cast(_FeatureEdgeSetSource, feature).edgeSets
    for index in range(edge_sets.count):
        edge_set = edge_sets.item(index)
        for class_name, properties in types:
            typed = _feature_cast(class_name, edge_set)
            if typed is None:
                continue
            for prop, role in properties:
                parameter_value = _geometry_feature_adapter_cast(object, getattr(typed, prop, None))
                if parameter_value is not None and hasattr(parameter_value, 'expression'):
                    parameter = _geometry_feature_adapter_cast(_FeatureParameter, parameter_value)
                    bindings.append((_feature_parameter(parameter, role), parameter))
            break
    return bindings


def _feature_fillet_bindings(ctx: "CadContext", feature: object) -> "list[tuple[JsonObject, _FeatureParameter]]":
    return _feature_edge_set_parameters(ctx, feature, (
        ('ConstantRadiusFilletEdgeSet', (('radius', 'radius'),)),
        ('ChordLengthFilletEdgeSet', (('chordLength', 'chordLength'),)),
        ('AsymmetricFilletEdgeSet', (('offsetOne', 'offsetOne'), ('offsetTwo', 'offsetTwo'))),
        ('VariableRadiusFilletEdgeSet', (('startRadius', 'startRadius'), ('endRadius', 'endRadius')))))


def _feature_chamfer_bindings(ctx: "CadContext", feature: object) -> "list[tuple[JsonObject, _FeatureParameter]]":
    return _feature_edge_set_parameters(ctx, feature, (
        ('EqualDistanceChamferEdgeSet', (('distance', 'distance'),)),
        ('TwoDistancesChamferEdgeSet', (('distanceOne', 'distanceOne'), ('distanceTwo', 'distanceTwo'))),
        ('DistanceAndAngleChamferEdgeSet', (('distance', 'distance'), ('angle', 'angle')))))


def _feature_misc_bindings(feature: object, fields: "Sequence[tuple[str, str]]") -> "list[tuple[JsonObject, _FeatureParameter]]":
    bindings: list[tuple["JsonObject", "_FeatureParameter"]] = []
    for prop, role in fields:
        parameter_value = _geometry_feature_adapter_cast(object, getattr(feature, prop, None))
        parameter = (_geometry_feature_adapter_cast(_FeatureParameter, parameter_value)
                     if parameter_value is not None else None)
        if parameter is not None and hasattr(parameter, 'expression'):
            bindings.append((_feature_parameter(parameter, role), parameter))
    return bindings


def _feature_pattern_bindings(feature: object, kind: str) -> "list[tuple[JsonObject, _FeatureParameter]]":
    fields = {
        'CircularPatternFeature': (('quantity', 'quantity'), ('totalAngle', 'angle')),
        'RectangularPatternFeature': (('quantityOne', 'quantity'), ('quantityTwo', 'quantityTwo'),
                                      ('distanceOne', 'distance'), ('distanceTwo', 'distanceTwo')),
        'PathPatternFeature': (('quantity', 'quantity'), ('distance', 'distance')),
    }
    return _feature_misc_bindings(feature, fields.get(kind, ()))


def _feature_sweep_bindings(ctx: "CadContext", feature: object) -> "list[tuple[JsonObject, _FeatureParameter]]":
    feature = _geometry_feature_adapter_cast(_FeatureDynamicAccess, feature)
    bindings: list[tuple["JsonObject", "_FeatureParameter"]] = []
    for prop, role in (('twistAngle', 'twistAngle'), ('taperAngle', 'taperAngle')):
        parameter_value: object | None = getattr(feature, prop, None)
        if parameter_value is not None:
            parameter = _geometry_feature_adapter_cast(_FeatureParameter, parameter_value)
            bindings.append((_feature_parameter(parameter, role), parameter))
    return bindings


def _feature_bindings(ctx: "CadContext", feature: "adsk.fusion.Feature") -> "tuple[list[tuple[JsonObject, _FeatureParameter]], bool]":
    kind = _cad_type(feature)
    bindings: list[tuple["JsonObject", "_FeatureParameter"]]
    if kind == 'ExtrudeFeature':
            bindings = _feature_extrude_bindings(ctx, feature)
    elif kind == 'RevolveFeature':
        bindings = _feature_revolve_bindings(ctx, feature)
    elif kind == 'HoleFeature':
        bindings = _feature_hole_bindings(ctx, feature)
    elif kind == 'SweepFeature':
        bindings = _feature_sweep_bindings(ctx, feature)
    elif kind == 'FilletFeature':
        bindings = _feature_fillet_bindings(ctx, feature)
    elif kind == 'ChamferFeature':
        bindings = _feature_chamfer_bindings(ctx, feature)
    elif kind == 'ShellFeature':
        bindings = _feature_misc_bindings(
            feature, (('insideThickness', 'insideThickness'), ('outsideThickness', 'outsideThickness')))
    elif kind == 'ThickenFeature':
        bindings = _feature_misc_bindings(feature, (('thickness', 'thickness'),))
    elif kind in ('CircularPatternFeature', 'RectangularPatternFeature', 'PathPatternFeature'):
        bindings = _feature_pattern_bindings(feature, kind)
    else:
        bindings = []
    covered: set[str] = set()
    for row, unused in bindings:
        name = row.get('name')
        if isinstance(name, str):
            covered.add(name)
    for value in _cad_items(ctx.design.allParameters):
        if not hasattr(value, 'createdBy'):
            continue
        parameter = _geometry_feature_adapter_cast(_FeatureOwnedParameter, value)
        if parameter.createdBy != feature or parameter.name in covered:
            continue
        feature_parameter = _geometry_feature_adapter_cast(_FeatureParameter, parameter)
        bindings.append((_feature_parameter(feature_parameter, 'unknown'), feature_parameter))
    recognized = ('ExtrudeFeature', 'RevolveFeature', 'HoleFeature', 'SweepFeature',
                  'FilletFeature', 'ChamferFeature', 'ShellFeature', 'ThickenFeature',
                  'CircularPatternFeature', 'RectangularPatternFeature', 'PathPatternFeature')
    return bindings, kind in recognized or kind in ('MirrorFeature', 'LoftFeature')


def _feature_capability_parameters(
        bindings: "Sequence[tuple[JsonObject, _FeatureParameter]]") -> "list[dict[str, str]]":
    rows: list[dict[str, str]] = []
    for row, _ in bindings:
        name = row['name']
        role = row['role']
        unit = row['unit']
        if not isinstance(name, str) or not isinstance(role, str) or not isinstance(unit, str):
            raise TypeError('Feature parameter names, roles, and units must be text')
        rows.append({'name': name, 'role': role, 'unit': unit})
    return rows


def _feature_snapshot_capability_parameters(snapshot: "JsonObject") -> "list[dict[str, str]]":
    parameter_values = snapshot.get('parameters')
    if not isinstance(parameter_values, list):
        raise TypeError('Feature snapshot parameters must be an array')
    rows: list[dict[str, str]] = []
    for value in parameter_values:
        row = _feature_json_object(value, 'feature parameter snapshot')
        name = _feature_record_text(row, 'name', '')
        role = _feature_record_text(row, 'role', '')
        unit = _feature_record_text(row, 'unit', '')
        rows.append({'name': name, 'role': role, 'unit': unit})
    return rows


def _feature_supported_capabilities(kind: str, parameters: "list[dict[str, str]]") -> list[str]:
    capabilities = _feature_edit_capabilities(kind, parameters)
    supported = capabilities.get('supported')
    if not isinstance(supported, list):
        raise TypeError('Feature edit capabilities must provide a supported array')
    rows: list[str] = []
    for value in supported:
        if not isinstance(value, str):
            raise TypeError('Feature capability names must be text')
        rows.append(value)
    return rows


def _feature_extent_summary(ctx: "CadContext", feature: "adsk.fusion.Feature", kind: str) -> "JsonObject":
    summary: "JsonObject" = {}
    if kind == 'ExtrudeFeature':
        extrude = _geometry_feature_adapter_cast(_FeatureDynamicAccess, feature)
        has_two_extents = bool(getattr(extrude, 'hasTwoExtents', False))
        extent_one: object | None = getattr(extrude, 'extentOne', None)
        if has_two_extents:
            summary['mode'] = 'twoSides'
            summary['distance'] = _feature_binding_row(ctx, feature, 'distance')
            summary['distanceTwo'] = _feature_binding_row(ctx, feature, 'distanceTwo')
        else:
            symmetric = _feature_cast('SymmetricExtentDefinition', getattr(extrude, 'symmetricExtent', None))
            distance = _feature_cast('DistanceExtentDefinition', extent_one)
            to_entity = _feature_cast('ToEntityExtentDefinition', extent_one)
            through = _feature_cast('ThroughAllExtentDefinition', extent_one)
            if symmetric is not None:
                summary['mode'] = 'symmetric'
                distance_value = _geometry_feature_adapter_cast(object, getattr(symmetric, 'distance', None))
                taper_value = _geometry_feature_adapter_cast(object, getattr(symmetric, 'taperAngle', None))
                summary['distance'] = _feature_parameter_value(distance_value, 'distance') if distance_value is not None else None
                summary['taperAngle'] = _feature_parameter_value(taper_value, 'taperAngle') if taper_value is not None else None
            elif distance is not None:
                summary['mode'] = 'distance'
                distance_value = _geometry_feature_adapter_cast(object, getattr(distance, 'distance', None))
                summary['distance'] = _feature_parameter_value(distance_value, 'distance') if distance_value is not None else None
            elif to_entity is not None:
                summary['mode'] = 'toEntity'
                summary['target'] = _feature_target(ctx, getattr(to_entity, 'entity', None))
                offset_value = _geometry_feature_adapter_cast(object, getattr(to_entity, 'offset', None))
                summary['offset'] = _feature_parameter_value(offset_value, 'offset') if offset_value is not None else None
            elif through is not None:
                summary['mode'] = 'throughAll'
            else:
                summary['mode'] = 'unknown'
        offset_start = _feature_cast('OffsetStartDefinition', getattr(extrude, 'startExtent', None))
        offset_value = (_geometry_feature_adapter_cast(object, getattr(offset_start, 'offset', None))
                        if offset_start is not None else None)
        if offset_value is not None:
            summary['startOffset'] = _feature_parameter_value(offset_value, 'startOffset')
    elif kind == 'RevolveFeature':
        revolve = _geometry_feature_adapter_cast(_FeatureDynamicAccess, feature)
        extent_definition: object | None = getattr(revolve, 'extentDefinition', None)
        extent = _feature_cast('AngleExtentDefinition', extent_definition)
        angle_value = (_geometry_feature_adapter_cast(object, getattr(extent, 'angle', None))
                       if extent is not None else None)
        two_sided = _feature_cast('TwoSidesAngleExtentDefinition', extent_definition)
        to_entity = _feature_cast('ToEntityExtentDefinition', extent_definition)
        if angle_value is not None:
            summary['mode'] = 'angle'
            summary['angle'] = _feature_parameter_value(angle_value, 'angle')
        elif two_sided is not None:
            summary['mode'] = 'twoSideAngle'
            summary['angle'] = _feature_parameter_value(two_sided.angleOne, 'angle')
            summary['angleTwo'] = _feature_parameter_value(two_sided.angleTwo, 'angleTwo')
        elif to_entity is not None:
            summary['mode'] = 'toEntity'
            summary['target'] = _feature_target(ctx, getattr(to_entity, 'entity', None))
        else:
            summary['mode'] = 'unknown'
    elif kind == 'HoleFeature':
        hole = _geometry_feature_adapter_cast(_FeatureDynamicAccess, feature)
        diameter = _geometry_feature_adapter_cast(object, getattr(hole, 'holeDiameter', None))
        if diameter is not None:
            summary['diameter'] = _feature_parameter_value(diameter, 'diameter')
        extent = getattr(hole, 'extentDefinition', None)
        if _feature_cast('DistanceHoleExtentDefinition', extent) is not None:
            summary['mode'] = 'distance'
            depth = _geometry_feature_adapter_cast(_FeatureHoleDepthDefinition, extent).depth
            if depth is not None:
                summary['depth'] = _feature_parameter_value(depth, 'depth')
        elif _feature_cast('ThroughAllHoleExtentDefinition', extent) is not None:
            summary['mode'] = 'throughAll'
        elif (to_entity := _feature_cast('ToEntityHoleExtentDefinition', extent)) is not None:
            summary['mode'] = 'toEntity'
            summary['target'] = _feature_target(
                ctx, _geometry_feature_adapter_cast(_FeatureHoleOffsetDefinition, to_entity).entity)
        else:
            summary['mode'] = 'unknown'
    else:
        summary['mode'] = 'unsupported'
    return summary


def _feature_binding_row(ctx: "CadContext", feature: "adsk.fusion.Feature", role: str) -> "JsonObject | None":
    for row, unused in _feature_extrude_bindings(ctx, feature):
        if row['role'] == role:
            return row
    return None


def _feature_snapshot(ctx: "CadContext", feature: "adsk.fusion.Feature") -> "JsonObject":
    kind = _cad_type(feature)
    bindings, structured = _feature_bindings(ctx, feature)
    timeline_object = feature.timelineObject
    snapshot: "JsonObject" = {'feature': ctx.ref(feature), 'name': feature.name, 'type': kind,
                'healthState': int(_geometry_feature_adapter_cast(int, feature.healthState)),
                'message': feature.errorOrWarningMessage,
                'isParametric': getattr(feature, 'isParametric', None), 'isSuppressed': getattr(feature, 'isSuppressed', None),
                'isSolid': getattr(feature, 'isSolid', None)}
    if hasattr(timeline_object, 'index'):
        snapshot['timelineIndex'] = _geometry_feature_adapter_cast(
            _FeatureTimelineIndex, timeline_object).index
    snapshot['parameters'] = [row for row, unused in bindings]
    snapshot['extent'] = _feature_extent_summary(ctx, feature, kind)
    snapshot['roleSource'] = 'feature structure' if structured else 'unknown'
    capabilities = _feature_edit_capabilities(kind, _feature_capability_parameters(bindings))
    if kind == 'FilletFeature':
        variant: object | None = getattr(feature, 'filletFeatureType', None)
        full_round: object | None = getattr(
            _geometry_feature_fusion.FilletFeatureTypes, 'FullRoundFilletFeatureType', None)
        capabilities['featureVariant'] = _cad_json(variant) if variant is not None else None
        if variant != full_round:
            supported = capabilities['supported']
            if isinstance(supported, list):
                capabilities['supported'] = [name for name in supported
                                             if isinstance(name, str) and name != 'full-round face sets']
    snapshot['editCapabilities'] = capabilities
    snapshot['limitations'] = ['Roles are structural positions on this feature type; parameters the structure does not expose remain role unknown.',
                               'Target ownership is classified but foreign transforms are not evaluated.']
    return snapshot









@_cad_scoped_step('feature.inspect', native_only=True)
def _feature_inspect(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    _cad_fields(data, ('schemaVersion', 'frame', 'feature'), ())
    if data['schemaVersion'] != 1 or data['frame'] != 'component':
        raise ValueError('GM09 feature commands require schemaVersion:1 and frame:component')
    feature = ctx.resolve(data['feature'], 'feature')
    _feature_owner_check(ctx, feature)
    return _feature_contract(ctx, 'feature.inspect', _feature_snapshot(ctx, feature), associativity='nativeReference')


def _feature_extent_plan(ctx: "CadContext", feature: "adsk.fusion.Feature",
                         before: "JsonObject", spec: "JsonObject") -> "_FeatureExtentPlan":
    kind = _cad_type(feature)
    if kind == 'ExtrudeFeature':
        _cad_fields(spec, ('mode',), ('distance', 'distanceTwo', 'startOffset', 'taper', 'taperTwo', 'target', 'offset', 'direction', 'isFullLength'))
        mode_value = spec['mode']
        if not isinstance(mode_value, str) or mode_value not in ('distance', 'throughAll', 'toEntity', 'symmetric', 'twoSides'):
            raise ValueError('Extrude extent mode must be distance, throughAll, toEntity, symmetric or twoSides')
        mode = mode_value
        if (mode in ('distance', 'symmetric', 'twoSides')) != ('distance' in spec):
            raise ValueError('distance is required for distance/symmetric/twoSides and forbidden otherwise')
        if (mode == 'twoSides') != ('distanceTwo' in spec):
            raise ValueError('distanceTwo is required for twoSides and forbidden otherwise')
        if (mode == 'toEntity') != ('target' in spec):
            raise ValueError('target is required for toEntity and forbidden otherwise')
        if mode != 'twoSides' and 'taperTwo' in spec:
            raise ValueError('taperTwo requires twoSides')
        if 'direction' in spec:
            direction = spec['direction']
            if not isinstance(direction, str) or direction not in ('positive', 'negative'):
                raise ValueError('direction must be positive or negative')
        for key in ('distance', 'distanceTwo', 'startOffset', 'offset'):
            if key in spec:
                ctx.length(spec[key])
        for key in ('taper', 'taperTwo'):
            if key in spec:
                ctx.angle(spec[key])
        if 'isFullLength' in spec and mode != 'symmetric':
            raise ValueError('isFullLength requires symmetric mode')
        if 'isFullLength' in spec and type(spec['isFullLength']) is not bool:
            raise TypeError('isFullLength must be boolean')
        plan: _FeatureExtentPlan = {'kind': kind, 'mode': mode, 'target': None}
        if mode == 'toEntity':
            target = ctx.resolve(spec['target'])
            if not _feature_target_matches(target, ('ConstructionPlane', 'BRepFace', 'BRepBody')):
                raise ValueError('toEntity target must be a construction plane, face or body')
            ownership = _feature_target(ctx, target)
            if ownership.get('ownership') != 'local':
                raise ValueError('Cross-component extent target is refused: explicit proxy/transform/ownership is required, no fake associative copy is created')
            # Keep the already-resolved native entity, not a ref/token: the
            # token is invalidated by timelineObject.rollTo before apply runs.
            plan['target'] = target
        return plan
    if kind == 'RevolveFeature':
        _cad_fields(spec, ('mode',), ('angle', 'angleTwo', 'target', 'symmetric'))
        mode_value = spec['mode']
        if not isinstance(mode_value, str):
            raise ValueError('Revolve extent mode must be text')
        mode = mode_value
        allowed_modes = ('angle', 'twoSideAngle', 'toEntity')
        if mode not in allowed_modes:
            raise ValueError('Revolve extent mode must be angle, twoSideAngle or toEntity')
        if 'symmetric' in spec and (mode != 'angle' or type(spec['symmetric']) is not bool):
            raise ValueError('symmetric is a boolean for angle revolve extent only')
        for key in ('angle', 'angleTwo'):
            if key in spec:
                ctx.angle(spec[key])
        if (mode in ('angle', 'twoSideAngle')) != ('angle' in spec):
            raise ValueError('angle is required for angle/twoSideAngle revolve extent')
        if (mode == 'twoSideAngle') != ('angleTwo' in spec):
            raise ValueError('angleTwo is required for twoSideAngle extent')
        if mode == 'toEntity':
            if 'target' not in spec:
                raise ValueError('target is required for toEntity revolve extent')
            target = ctx.resolve(spec['target'])
            if not _feature_target_matches(
                    target, ('BRepBody', 'BRepFace', 'BRepVertex', 'ConstructionPlane', 'ConstructionPoint')):
                raise ValueError('Revolve target must be a body, face, vertex, plane or point')
            if _feature_target(ctx, target).get('ownership') != 'local':
                raise ValueError('Cross-component revolve targets are refused')
            return {'kind': kind, 'mode': mode, 'target': target}
        return {'kind': kind, 'mode': mode, 'target': None}
    if kind == 'HoleFeature':
        _cad_fields(spec, ('mode',), ('distance', 'target', 'reverse', 'matchShape'))
        mode_value = spec['mode']
        if not isinstance(mode_value, str):
            raise ValueError('Hole extent mode must be text')
        mode = mode_value
        if mode not in ('distance', 'throughAll', 'toEntity'):
            raise ValueError('Hole extent mode must be distance, throughAll or toEntity')
        if (mode == 'distance') != ('distance' in spec):
            raise ValueError('distance is required only for distance hole extent')
        if 'distance' in spec:
            ctx.length(spec['distance'])
        if (mode == 'toEntity') != ('target' in spec):
            raise ValueError('target is required only for toEntity hole extent')
        if 'reverse' in spec and type(spec['reverse']) is not bool:
            raise TypeError('Hole reverse must be boolean')
        if mode == 'toEntity' and 'reverse' in spec:
            raise ValueError('toEntity hole extent infers direction; reverse is unsupported')
        if 'matchShape' in spec and (mode != 'toEntity' or type(spec['matchShape']) is not bool):
            raise ValueError('matchShape is a boolean for toEntity hole extent only')
        if mode == 'toEntity':
            target = ctx.resolve(spec['target'])
            if not _feature_target_matches(
                    target, ('BRepBody', 'BRepFace', 'BRepVertex', 'ConstructionPlane', 'ConstructionPoint')):
                raise ValueError('Hole target must be a body, face, vertex, plane or point')
            if _feature_target(ctx, target).get('ownership') != 'local':
                raise ValueError('Cross-component hole targets are refused')
            return {'kind': kind, 'mode': mode, 'target': target}
        return {'kind': kind, 'mode': mode, 'target': None}
    raise ValueError('Extent editing is unsupported for feature type ' + kind + '; use parameter entries')


def _feature_target_matches(target: "CadEntity", class_names: "Sequence[str]") -> bool:
    return any(_feature_cast(class_name, target) is not None for class_name in class_names)


def _feature_plan_target(plan: "_FeatureExtentPlan") -> "CadEntity":
    target = plan['target']
    if target is None:
        raise RuntimeError('Extent plan is missing its validated target')
    return target


def _feature_text(value: "JsonValue", label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(label + ' must be text')
    return value


def _feature_boolean(value: "JsonValue", label: str) -> bool:
    if type(value) is not bool:
        raise ValueError(label + ' must be boolean')
    return value


def _feature_apply_extent(ctx: "CadContext", feature: "adsk.fusion.Feature",
                          spec: "JsonObject", plan: "_FeatureExtentPlan") -> None:
    kind = plan['kind']
    if kind == 'ExtrudeFeature':
        extrude = _geometry_feature_adapter_cast(_FeatureExtrude, _feature_sdk_object('ExtrudeFeature', feature))
        direction = _geometry_feature_adapter_cast(
            _geometry_feature_fusion.ExtentDirections,
            _geometry_feature_fusion.ExtentDirections.PositiveExtentDirection
            if _feature_text(spec.get('direction', 'positive'), 'direction') == 'positive'
            else _geometry_feature_fusion.ExtentDirections.NegativeExtentDirection)
        if plan['mode'] == 'distance':
            definition = _geometry_feature_fusion.DistanceExtentDefinition.create(ctx.value(spec['distance']))
            _cad_require_result(extrude.setOneSideExtent(definition, direction, ctx.value(spec.get('taper', '0 deg'))), 'setOneSideExtent')
        elif plan['mode'] == 'throughAll':
            definition = _geometry_feature_fusion.ThroughAllExtentDefinition.create()
            _cad_require_result(extrude.setOneSideExtent(definition, direction, ctx.value(spec.get('taper', '0 deg'))), 'setOneSideExtent')
        elif plan['mode'] == 'toEntity':
            definition = _geometry_feature_fusion.ToEntityExtentDefinition.create(
                _feature_plan_target(plan), False)
            if 'offset' in spec:
                _geometry_feature_adapter_cast(_FeatureToEntityExtent, definition).offset = ctx.value(spec['offset'])
            _cad_require_result(extrude.setOneSideExtent(definition, direction, ctx.value(spec.get('taper', '0 deg'))), 'setOneSideExtent')
        elif plan['mode'] == 'symmetric':
            _cad_require_result(extrude.setSymmetricExtent(
                ctx.value(spec['distance']), _feature_boolean(spec.get('isFullLength', True), 'isFullLength'),
                ctx.value(spec.get('taper', '0 deg'))), 'setSymmetricExtent')
        else:
            one = _geometry_feature_fusion.DistanceExtentDefinition.create(ctx.value(spec['distance']))
            two = _geometry_feature_fusion.DistanceExtentDefinition.create(ctx.value(spec['distanceTwo']))
            _cad_require_result(extrude.setTwoSidesExtent(
                one, two, ctx.value(spec.get('taper', '0 deg')),
                ctx.value(spec.get('taperTwo', '0 deg'))), 'setTwoSidesExtent')
        if 'startOffset' in spec:
            extrude.startExtent = _geometry_feature_fusion.OffsetStartDefinition.create(ctx.value(spec['startOffset']))
    elif kind == 'RevolveFeature':
        revolve = _geometry_feature_adapter_cast(_FeatureRevolve, _feature_sdk_object('RevolveFeature', feature))
        if plan['mode'] == 'angle':
            _cad_require_result(revolve.setAngleExtent(
                _feature_boolean(spec.get('symmetric', False), 'symmetric'), ctx.value(spec['angle'])), 'setAngleExtent')
        elif plan['mode'] == 'twoSideAngle':
            _cad_require_result(revolve.setTwoSideAngleExtent(
                ctx.value(spec['angle']), ctx.value(spec['angleTwo'])), 'setTwoSideAngleExtent')
        elif plan['mode'] == 'toEntity':
            _cad_require_result(revolve.setOneSideToExtent(_feature_plan_target(plan)), 'setOneSideToExtent')
        else:
            _cad_require_result(revolve.setOneSideToExtent(_feature_plan_target(plan)), 'setOneSideToExtent')
    elif kind == 'HoleFeature':
        hole = _geometry_feature_adapter_cast(_FeatureHole, _feature_sdk_object('HoleFeature', feature))
        if plan['mode'] == 'distance':
            _cad_require_result(hole.setDistanceExtent(ctx.value(spec['distance'])), 'setDistanceExtent')
            hole.isDefaultDirection = not _feature_boolean(spec.get('reverse', False), 'reverse')
        elif plan['mode'] == 'throughAll':
            direction = _geometry_feature_adapter_cast(
                _geometry_feature_fusion.ExtentDirections,
                _geometry_feature_fusion.ExtentDirections.PositiveExtentDirection
                if _feature_boolean(spec.get('reverse', False), 'reverse')
                else _geometry_feature_fusion.ExtentDirections.NegativeExtentDirection)
            _cad_require_result(hole.setAllExtent(direction), 'setAllExtent')
            hole.isDefaultDirection = not _feature_boolean(spec.get('reverse', False), 'reverse')
        else:
            _cad_require_result(hole.setOneSideToExtent(
                _feature_plan_target(plan), _feature_boolean(spec.get('matchShape', False), 'matchShape')),
                'setOneSideToExtent')
    else:
        raise ValueError('Unsupported extent application for feature type ' + kind)


def _feature_downstream(ctx: "CadContext", feature: "adsk.fusion.Feature") -> "JsonObject":
    timeline_value: object | None = getattr(ctx.design, 'timeline', None)
    if timeline_value is None:
        return {'status': 'unknown', 'scanned': 0, 'unhealthy': [], 'limitation': 'timeline not exposed by the installed SDK'}
    timeline = _geometry_feature_adapter_cast(_FeatureTimeline, timeline_value)
    raw_index: object | None = getattr(feature.timelineObject, 'index', None)
    index = raw_index if isinstance(raw_index, int) else None
    unhealthy: list["JsonValue"] = []
    scanned = 0
    for i in range(timeline.count):
        if index is not None and i <= index:
            continue
        scanned += 1
        item = timeline.item(i)
        health_state = _geometry_feature_adapter_cast(int, item.healthState)
        if health_state != 0:
            unhealthy.append({'name': item.name, 'healthState': int(health_state), 'message': item.errorOrWarningMessage})
    return {'status': 'fail' if unhealthy else ('pass' if index is not None else 'unknown'), 'scanned': scanned, 'unhealthy': unhealthy}


def _feature_operation_pose_snapshot(
        ctx: "CadContext") -> "list[tuple[adsk.fusion.Occurrence, tuple[float, ...]]] | None":
    root: object | None = getattr(ctx.design, 'rootComponent', None)
    occurrences_value: object | None = getattr(root, 'allOccurrences', None) if root is not None else None
    if occurrences_value is None:
        return None
    occurrences = _geometry_feature_adapter_cast(_FeatureOccurrenceCollection, occurrences_value)
    rows: list[tuple["adsk.fusion.Occurrence", tuple[float, ...]]] = []
    for index in range(occurrences.count):
        occurrence = occurrences.item(index)
        if occurrence.component != ctx.component:
            continue
        transform_value: object | None = getattr(occurrence, 'transform2', None)
        if transform_value is None or not hasattr(transform_value, 'asArray'):
            return None
        transform = _geometry_feature_adapter_cast(_FeatureOccurrenceMatrix, transform_value)
        rows.append((occurrence, tuple(transform.asArray())))
    return rows




def _feature_native_ref(ctx: "CadContext", ref: object, kind: str | None = None) -> "CadEntity":
    entity = ctx.resolve(ref, kind)
    if getattr(entity, 'assemblyContext', None) is not None or (_cad_owner(entity) is not None and _cad_owner(entity) != ctx.component):
        raise ValueError('Native feature edits require references owned by the selected component')
    return entity


def _feature_native_path(ctx: "CadContext", value: object) -> "CadEntity":
    descriptor = _feature_json_object_or_none(value, 'path descriptor')
    if descriptor is not None and 'curves' in descriptor:
        return _model_path(ctx, descriptor)
    path = _feature_native_ref(ctx, value)
    if _cad_type(path) != 'Path':
        raise ValueError('Path refs must resolve to a native Path or explicit curve-path descriptor')
    return path


def _feature_native_collection(ctx: "CadContext", refs: object, kind: str | None = None,
                               expected_type: object | None = None) -> "list[CadEntity]":
    if not isinstance(refs, list) or not refs:
        raise ValueError('Native selection must be a nonempty reference array')
    references = _geometry_feature_adapter_cast("list[JsonValue]", refs)
    entities = [_feature_native_ref(ctx, ref, kind) for ref in references]
    kinds = {_cad_type(entity) for entity in entities}
    if expected_type is not None:
        caster = _geometry_feature_adapter_cast("_FeatureCaster[CadEntity]", expected_type)
        if any(caster.cast(entity) is None for entity in entities):
            raise ValueError('Native selection contains an unsupported reference type')
    if expected_type is None and len(kinds) > 1:
        raise ValueError('Native selections must contain a homogeneous entity type')
    if len(entities) > 1 and kinds <= {'ConstructionAxis', 'ConstructionPlane', 'ConstructionPoint'}:
        raise ValueError('Only one construction entity can be selected')
    return entities


def _feature_native_object_collection(entities: "Sequence[CadEntity]") -> "adsk.core.ObjectCollection":
    collection = _geometry_feature_core.ObjectCollection.create()
    for entity in entities:
        collection.add(entity)
    return collection


def _feature_native_is(entity: "CadEntity", names: "Sequence[str]") -> bool:
    return any(_feature_cast(name, entity) is not None for name in names)


def _feature_validate_hole_position(ctx: "CadContext", value: object) -> "dict[str, object]":
    spec = _feature_json_object(value, 'hole position')
    mode_value = spec.get('mode')
    if not isinstance(mode_value, str):
        raise ValueError('hole position requires a mode')
    mode = mode_value
    if mode == 'point':
        raise ValueError('Point3D hole positions are non-associative and unsupported; use native sketch/edge reference modes')
    fields = {
        'sketchPoint': (('point',), ()),
        'sketchPoints': (('points',), ()),
        'point': (('plane', 'point'), ()),
        'center': (('plane', 'edge'), ()),
        'offsets': (('plane', 'point', 'edgeOne', 'offsetOne'), ('edgeTwo', 'offsetTwo')),
        'onEdge': (('plane', 'edge', 'position'), ()),
    }
    if mode not in fields:
        raise ValueError('Unsupported hole position mode: ' + mode)
    required, optional = fields[mode]
    _cad_fields(spec, ('mode',) + required, optional)
    if mode == 'offsets' and (('edgeTwo' in spec) != ('offsetTwo' in spec)):
        raise ValueError('edgeTwo and offsetTwo must be supplied together')
    resolved: dict[str, object] = {'mode': mode}
    kind_by_key = {'point': 'point', 'points': 'point', 'plane': None, 'edge': 'edge',
                   'edgeOne': 'edge', 'edgeTwo': 'edge'}
    for key in required + optional:
        if key not in spec:
            continue
        if key in ('point',) and mode == 'point':
            coordinates_value = spec[key]
            if not isinstance(coordinates_value, list) or len(coordinates_value) != 3:
                raise ValueError('point must be a three-coordinate array')
            for coordinate in coordinates_value:
                ctx.length(coordinate)
            resolved[key] = coordinates_value
        elif key in ('offsetOne', 'offsetTwo'):
            ctx.length(spec[key])
            resolved[key] = spec[key]
        elif key == 'position':
            position = spec[key]
            if not isinstance(position, str) or position not in ('start', 'end', 'middle'):
                raise ValueError('onEdge position must be start, end or middle')
            resolved[key] = position
        elif key == 'points':
            points = _feature_native_collection(ctx, spec[key], 'point')
            if any(not _feature_native_is(point, ('SketchPoint',)) for point in points):
                raise ValueError('Hole sketchPoints position requires native SketchPoint refs')
            resolved[key] = points
        else:
            entity = _feature_native_ref(ctx, spec[key], kind_by_key.get(key))
            if key == 'point' and mode == 'sketchPoint' and not _feature_native_is(entity, ('SketchPoint',)):
                raise ValueError('sketchPoint position requires a SketchPoint ref')
            if key == 'plane' and not _feature_native_is(entity, ('ConstructionPlane', 'BRepFace')):
                raise ValueError('Hole position plane must be a construction plane or planar face')
            if key in ('edge', 'edgeOne', 'edgeTwo') and not _feature_native_is(entity, ('BRepEdge',)):
                raise ValueError('Hole position edge refs must be BRepEdge objects')
            if key in ('edgeOne', 'edgeTwo'):
                edge = _geometry_feature_adapter_cast(_FeatureBRepEdgeCaster, _geometry_feature_fusion.BRepEdge).cast(entity)
                if edge is None or _geometry_feature_adapter_cast(
                        _FeatureLine3DCaster, _geometry_feature_core.Line3D).cast(edge.geometry) is None:
                    raise ValueError('Hole offset edges must be linear BRepEdges')
            if key == 'edge' and mode == 'center':
                edge = _geometry_feature_adapter_cast(_FeatureBRepEdgeCaster, _geometry_feature_fusion.BRepEdge).cast(entity)
                if edge is None:
                    raise ValueError('Hole center position requires a circular or elliptical edge')
                geometry = edge.geometry
                if (_geometry_feature_adapter_cast(
                        _FeatureCircle3DCaster, _geometry_feature_core.Circle3D).cast(geometry) is None
                        and _geometry_feature_adapter_cast(
                            _FeatureEllipse3DCaster, _geometry_feature_core.Ellipse3D).cast(geometry) is None):
                    raise ValueError('Hole center position requires a circular or elliptical edge')
            resolved[key] = entity
    return resolved


def _feature_native_enum(enum_class: object, name_map: "Mapping[str, str]",
                         value: object, label: str) -> object:
    if not isinstance(value, str) or value not in name_map:
        raise ValueError(label + ' must be one of ' + ', '.join(sorted(name_map)))
    member: object | None = getattr(enum_class, name_map[value], None)
    if member is None:
        raise ValueError(label + ' value is unavailable in this Fusion SDK: ' + value)
    return member


def _feature_native_plan(ctx: "CadContext", feature: "adsk.fusion.Feature",
                         spec: "JsonObject") -> "_FeatureNativePlan":
    kind = _cad_type(feature)
    if kind not in _FEATURE_NATIVE_FIELDS:
        raise ValueError('nativeEdits is unsupported for feature type ' + kind)
    if not spec:
        raise ValueError('nativeEdits must be a nonempty object')
    unknown = [key for key in spec if key not in _FEATURE_NATIVE_FIELDS[kind]]
    if unknown:
        raise ValueError('Unsupported nativeEdits for ' + kind + ': ' + ', '.join(unknown))
    if kind == 'FilletFeature':
        full_round: object | None = getattr(
            _geometry_feature_fusion.FilletFeatureTypes, 'FullRoundFilletFeatureType', None)
        feature_variant: object | None = getattr(feature, 'filletFeatureType', None)
        is_full_round = feature_variant == full_round
        if is_full_round and 'edgeSets' in spec:
            raise ValueError('Existing full-round fillets use fullRoundFaceSets, not edgeSets')
        if not is_full_round and 'fullRoundFaceSets' in spec:
            raise ValueError('fullRoundFaceSets applies only to an existing full-round FilletFeature')
    resolved: dict[str, object] = {}
    summary: "JsonObject" = {}
    ref_fields = {'axis', 'directionOneEntity', 'directionTwoEntity', 'mirrorPlane', 'solidAlignedAxis', 'solidTwistAxis'}
    for key, value in spec.items():
        if key in ('entities', 'participants', 'guideSurfaces'):
            required_kind = 'body' if key == 'participants' else ('face' if key == 'guideSurfaces' else None)
            if kind in ('ShellFeature', 'ThickenFeature') and key == 'entities':
                if not isinstance(value, list) or not value:
                    raise ValueError('entities must be a nonempty reference array')
                selected_entities = [_feature_native_ref(ctx, ref) for ref in value]
                body_caster = _geometry_feature_adapter_cast(
                    _FeatureBRepBodyCaster, _geometry_feature_fusion.BRepBody)
                face_caster = _geometry_feature_adapter_cast(
                    _FeatureBRepFaceCaster, _geometry_feature_fusion.BRepFace)
                if kind == 'ShellFeature' and any(
                        body_caster.cast(item) is None and face_caster.cast(item) is None
                        for item in selected_entities):
                    raise ValueError('Shell entities must be bodies and/or faces')
                if kind == 'ShellFeature':
                    bodies = [body for selected_entity in selected_entities
                              if (body := body_caster.cast(selected_entity)) is not None]
                    faces = [face for selected_entity in selected_entities
                             if (face := face_caster.cast(selected_entity)) is not None]
                    if any(face.body == body for face in faces for body in bodies):
                        raise ValueError('Shell selections cannot include both a body and one of its faces')
                if kind == 'ThickenFeature' and any(
                        body_caster.cast(item) is None and face_caster.cast(item) is None
                        for item in selected_entities):
                    raise ValueError('Thicken entities must be faces or patch bodies')
            else:
                selected_entities = _feature_native_collection(ctx, value, required_kind)
            resolved[key] = selected_entities
            summary[key] = [ctx.ref(entity) for entity in selected_entities]
        elif key in ref_fields:
            entity = None if value is None and key == 'directionTwoEntity' else _feature_native_ref(ctx, value)
            expected = {
                'axis': ('ConstructionAxis', 'SketchLine', 'BRepEdge', 'BRepFace'),
                'directionOneEntity': ('ConstructionAxis', 'SketchLine', 'BRepEdge', 'RectangularPatternFeature'),
                'directionTwoEntity': ('ConstructionAxis', 'SketchLine', 'BRepEdge', 'RectangularPatternFeature'),
                'mirrorPlane': ('ConstructionPlane', 'BRepFace'),
                'solidAlignedAxis': ('ConstructionAxis', 'SketchLine', 'BRepEdge'),
                'solidTwistAxis': ('ConstructionAxis', 'SketchLine', 'BRepEdge', 'BRepFace'),
            }.get(key)
            if entity is not None and expected is not None and not _feature_native_is(entity, expected):
                raise ValueError(key + ' has an unsupported reference type for ' + kind)
            resolved[key] = entity
            summary[key] = ctx.ref(entity) if entity is not None else None
        elif key in ('profile', 'solidBody'):
            entity = _feature_native_ref(ctx, value, 'body' if key == 'solidBody' else None)
            if key == 'profile' and not _feature_native_is(entity, ('Profile', 'BRepFace')):
                raise ValueError('profile must resolve to a Profile or planar face')
            resolved[key] = entity
            summary[key] = ctx.ref(entity)
        elif key in ('path', 'guideRail'):
            if value is None and key == 'guideRail':
                path = None
            else:
                path = _feature_native_path(ctx, value)
            resolved[key] = path
            path_descriptor = (_feature_json_object(value, 'path descriptor')
                               if isinstance(value, dict) and 'curves' in value else None)
            if path_descriptor is not None:
                curve_values = path_descriptor['curves']
                if not isinstance(curve_values, list):
                    raise ValueError('Path curves must be a nonempty reference array')
                summary[key] = {'kind': 'path', 'curves': len(curve_values)}
            else:
                summary[key] = ctx.ref(path) if path is not None else None
        elif key == 'suppressedElementsIds':
            if not isinstance(value, list):
                raise ValueError('suppressedElementsIds must be an array of nonnegative integers')
            identifiers: list[int] = []
            for identifier_value in value:
                if type(identifier_value) is not int:
                    raise ValueError('suppressedElementsIds must be an array of nonnegative integers')
                identifier = identifier_value
                if identifier < 0:
                    raise ValueError('suppressedElementsIds must be an array of nonnegative integers')
                identifiers.append(identifier)
            pattern_elements = _geometry_feature_adapter_cast(
                _FeaturePatternElements, feature).patternElements
            current_ids = {int(item.id) for item in _cad_items(pattern_elements)}
            if any(item not in current_ids for item in identifiers):
                raise ValueError('suppressedElementsIds must refer to existing pattern element ids')
            resolved[key] = identifiers
            summary[key] = identifiers
        elif key == 'startPoint':
            if type(value) is int:
                numeric_value = value
            elif type(value) is float:
                numeric_value = value
            else:
                raise ValueError('startPoint must be a number between 0 and 1')
            if not 0 <= numeric_value <= 1:
                raise ValueError('startPoint must be a number between 0 and 1')
            resolved[key] = float(numeric_value)
            summary[key] = float(numeric_value)
        elif key in ('operation', 'cornerType', 'patternDistanceType', 'shellType', 'orientation', 'solidOrientation', 'thickenType', 'startLoftEdgeAlignment', 'endLoftEdgeAlignment', 'patternComputeOption'):
            enums = {
                'operation': ('FeatureOperations', {'newBody': 'NewBodyFeatureOperation', 'join': 'JoinFeatureOperation', 'cut': 'CutFeatureOperation', 'intersect': 'IntersectFeatureOperation'}),
                'cornerType': ('ChamferCornerTypes', {'chamfer': 'ChamferCornerType', 'miter': 'MiterCornerType', 'blend': 'BlendCornertype'}),
                'patternDistanceType': ('PatternDistanceType', {'spacing': 'SpacingPatternDistanceType', 'extent': 'ExtentPatternDistanceType'}),
                'shellType': ('ShellTypes', {'sharpOffset': 'SharpOffsetShellType', 'roundedOffset': 'RoundedOffsetShellType'}),
                'orientation': ('SweepOrientationTypes', {'perpendicular': 'PerpendicularOrientationType', 'parallel': 'ParallelOrientationType'}),
                'solidOrientation': ('SweepSolidOrientationTypes', {'perpendicular': 'PerpendicularSolidOrientationType', 'aligned': 'AlignedSolidOrientationType'}),
                'thickenType': ('ThickenTypes', {'sharp': 'SharpThickenType', 'rounded': 'RoundedThickenType'}),
                'startLoftEdgeAlignment': ('LoftEdgeAlignments', {'free': 'FreeEdgesLoftEdgeAlignment', 'align': 'AlignEdgesLoftEdgeAlignment', 'alignToSurface': 'AlignToSurfaceLoftEdgeAlignment'}),
                'endLoftEdgeAlignment': ('LoftEdgeAlignments', {'free': 'FreeEdgesLoftEdgeAlignment', 'align': 'AlignEdgesLoftEdgeAlignment', 'alignToSurface': 'AlignToSurfaceLoftEdgeAlignment'}),
                'patternComputeOption': ('PatternComputeOptions', {'optimized': 'OptimizedPatternCompute', 'identical': 'IdenticalPatternCompute', 'adjust': 'AdjustPatternCompute'}),
            }
            enum_name, names = enums[key]
            enum_class: object | None = getattr(_geometry_feature_fusion, enum_name, None)
            if enum_class is None:
                raise ValueError(key + ' is not supported by this Fusion SDK')
            resolved[key] = _feature_native_enum(enum_class, names, value, key)
            summary[key] = value
        elif key in ('isSymmetric', 'isSymmetricInDirectionOne', 'isSymmetricInDirectionTwo', 'isClosed', 'isTangentEdgesMerged', 'isTangentChain', 'isChainSelection', 'isDirectionFlipped', 'isRollingBallCorner'):
            if type(value) is not bool:
                raise TypeError(key + ' must be boolean')
            resolved[key] = value
            summary[key] = value
        elif key == 'edgeSets':
            if not isinstance(value, list) or not value:
                raise ValueError('edgeSets must be a nonempty array')
            existing_sets = _geometry_feature_adapter_cast(_FeatureEdgeSetSource, feature).edgeSets
            edge_set_rows: list[dict[str, object]] = []
            edge_set_summaries: list["JsonValue"] = []
            seen_indices: set[int] = set()
            for row_value in value:
                row = _feature_json_object(row_value, 'edgeSets row')
                index_value = row.get('index')
                if type(index_value) is not int:
                    raise ValueError('each edgeSets row requires a nonnegative index')
                index = index_value
                if index < 0:
                    raise ValueError('each edgeSets row requires a nonnegative index')
                if index >= existing_sets.count:
                    raise ValueError('edgeSets index is outside the existing feature edge sets')
                if index in seen_indices:
                    raise ValueError('edgeSets indices must be unique')
                seen_indices.add(index)
                allowed = {'index', 'edges', 'tangentChain', 'continuity', 'tangencyWeight', 'radius', 'chordLength', 'startRadius', 'endRadius', 'offsetOne', 'offsetTwo', 'midRadii', 'midPositions', 'distance', 'distanceOne', 'distanceTwo', 'angle', 'isFlipped'}
                unexpected = set(row) - allowed
                if unexpected:
                    raise ValueError('Unsupported edgeSets fields: ' + ', '.join(sorted(unexpected)))
                existing_set = existing_sets.item(index)
                edge_set_type = _cad_type(existing_set)
                field_variants = ({'radius': ('ConstantRadiusFilletEdgeSet',), 'chordLength': ('ChordLengthFilletEdgeSet',),
                                   'startRadius': ('VariableRadiusFilletEdgeSet',), 'endRadius': ('VariableRadiusFilletEdgeSet',),
                                   'offsetOne': ('AsymmetricFilletEdgeSet',), 'offsetTwo': ('AsymmetricFilletEdgeSet',),
                                   'isFlipped': ('AsymmetricFilletEdgeSet',),
                                   'midRadii': ('VariableRadiusFilletEdgeSet',), 'midPositions': ('VariableRadiusFilletEdgeSet',)}
                                  if kind == 'FilletFeature' else
                                  {'distance': ('EqualDistanceChamferEdgeSet', 'DistanceAndAngleChamferEdgeSet'),
                                   'distanceOne': ('TwoDistancesChamferEdgeSet',), 'distanceTwo': ('TwoDistancesChamferEdgeSet',),
                                   'angle': ('DistanceAndAngleChamferEdgeSet',), 'isFlipped': ('TwoDistancesChamferEdgeSet', 'DistanceAndAngleChamferEdgeSet')})
                for field, allowed_types in field_variants.items():
                    if field in row and edge_set_type not in allowed_types:
                        raise ValueError(field + ' is unsupported for existing edge-set variant ' + edge_set_type)
                item: dict[str, object] = {field: field_value for field, field_value in row.items()}
                summary_row: "JsonObject" = {'index': index}
                if 'edges' in row:
                    edge_refs = row['edges']
                    if not isinstance(edge_refs, list) or not edge_refs:
                        raise ValueError('edgeSets.edges must be a nonempty reference array')
                    edges = [_feature_native_ref(ctx, ref) for ref in edge_refs]
                    item['edges'] = edges
                    summary_row['edges'] = [ctx.ref(edge) for edge in edges]
                    if kind == 'FilletFeature' and any(
                            not (_feature_native_is(edge, ('BRepEdge', 'BRepFace'))
                                 or _cad_type(edge).endswith('Feature')) for edge in edges):
                        raise ValueError('Fillet edge sets accept BRepEdge, BRepFace or feature refs')
                    if kind == 'ChamferFeature' and any(
                            not (_feature_native_is(edge, ('BRepEdge', 'BRepFace'))
                                 or _cad_type(edge).endswith('Feature')) for edge in edges):
                        raise ValueError('Chamfer edge sets accept BRepEdge, BRepFace or feature refs')
                for field in ('radius', 'chordLength', 'startRadius', 'endRadius', 'offsetOne', 'offsetTwo', 'distance', 'distanceOne', 'distanceTwo'):
                    if field in row:
                        ctx.length(row[field])
                for field in ('angle',):
                    if field in row:
                        ctx.angle(row[field])
                if 'continuity' in row:
                    continuity = row['continuity']
                    if not isinstance(continuity, str) or continuity not in ('tangent', 'curvature'):
                        raise ValueError('continuity must be tangent or curvature')
                    item['continuity'] = _feature_native_enum(
                        _geometry_feature_fusion.SurfaceContinuityTypes,
                        {'tangent': 'TangentSurfaceContinuityType',
                         'curvature': 'CurvatureSurfaceContinuityType'}, continuity, 'continuity')
                if 'tangencyWeight' in row:
                    weight_value = row['tangencyWeight']
                    if type(weight_value) is int:
                        weight = float(weight_value)
                    elif type(weight_value) is float:
                        weight = weight_value
                    else:
                        raise ValueError('tangencyWeight must be unitless in range 0.1..2.0')
                    if not 0.1 <= weight <= 2.0:
                        raise ValueError('tangencyWeight must be unitless in range 0.1..2.0')
                if 'midRadii' in row or 'midPositions' in row:
                    radii, positions = row.get('midRadii'), row.get('midPositions')
                    if not isinstance(radii, list) or not isinstance(positions, list) or len(radii) != len(positions):
                        raise ValueError('midRadii and midPositions must be equally sized arrays')
                    for radius in radii:
                        ctx.length(radius)
                    for position_value in positions:
                        if type(position_value) is int:
                            numeric_position = float(position_value)
                        elif type(position_value) is float:
                            numeric_position = position_value
                        else:
                            raise ValueError('midPositions values must be numeric and strictly between 0 and 1')
                        if not 0 < numeric_position < 1:
                            raise ValueError('midPositions values must be numeric and strictly between 0 and 1')
                for field in ('tangentChain', 'isFlipped'):
                    if field in row and type(row[field]) is not bool:
                        raise TypeError(field + ' must be boolean')
                for field, field_value in item.items():
                    if field != 'edges':
                        summary_row[field] = _feature_native_value(ctx, field_value)
                edge_set_rows.append(item)
                edge_set_summaries.append(summary_row)
            resolved[key] = edge_set_rows
            summary[key] = edge_set_summaries
        elif key == 'fullRoundFaceSets':
            if not isinstance(value, list) or not value:
                raise ValueError('fullRoundFaceSets must be a nonempty array')
            expected_full_round_variant: object | None = getattr(
                _geometry_feature_fusion.FilletFeatureTypes, 'FullRoundFilletFeatureType', None)
            current_feature_variant: object | None = getattr(feature, 'filletFeatureType', None)
            if current_feature_variant != expected_full_round_variant:
                raise ValueError('fullRoundFaceSets applies only to an existing full-round FilletFeature; variant conversion is refused')
            full_round_rows: list[dict[str, object]] = []
            full_round_summaries: list["JsonValue"] = []
            for row_value in value:
                row = _feature_json_object(row_value, 'fullRoundFaceSets entry')
                _cad_fields(row, ('centerFace', 'sideOneFaces', 'sideTwoFaces'), ('automaticSideFaces',))
                center = _feature_native_ref(ctx, row['centerFace'], 'face')
                side_one = _feature_native_collection(ctx, row['sideOneFaces'], 'face')
                side_two = _feature_native_collection(ctx, row['sideTwoFaces'], 'face')
                automatic = row.get('automaticSideFaces', True)
                if type(automatic) is not bool:
                    raise TypeError('automaticSideFaces must be boolean')
                full_round_rows.append({'centerFace': center, 'sideOneFaces': side_one, 'sideTwoFaces': side_two,
                                        'automaticSideFaces': automatic})
                full_round_summaries.append({'centerFace': ctx.ref(center),
                                             'sideOneFaces': [ctx.ref(face) for face in side_one],
                                             'sideTwoFaces': [ctx.ref(face) for face in side_two],
                                             'automaticSideFaces': automatic})
            resolved[key] = full_round_rows
            summary[key] = full_round_summaries
        elif key in ('sections', 'rails'):
            if not isinstance(value, list) or not value:
                raise ValueError(key + ' must be a nonempty array')
            loft_items: list[object] = []
            loft_summaries: list["JsonValue"] = []
            for item_value in value:
                item_object = _feature_json_object_or_none(item_value, 'loft section or rail')
                ref = (item_object['entity']
                       if item_object is not None and 'entity' in item_object else item_value)
                ref_object = _feature_json_object_or_none(ref, 'loft path descriptor')
                is_path_descriptor = ref_object is not None and 'curves' in ref_object
                entity = (_feature_native_path(ctx, ref)
                          if key == 'rails' or is_path_descriptor
                          else _feature_native_ref(ctx, ref))
                if key == 'rails' and not _feature_native_is(entity, ('SketchCurve', 'BRepEdge', 'Path')):
                    raise ValueError('Loft rails must be sketch curves, BRepEdge or Path refs')
                if key == 'sections' and not _feature_native_is(
                        entity, ('Profile', 'BRepFace', 'Path', 'SketchPoint', 'ConstructionPoint')):
                    raise ValueError('Loft sections must be profiles, faces, paths or supported point sections')
                if key == 'rails' and item_object is not None and 'edgeCondition' in item_object:
                    if not _feature_native_is(entity, ('BRepEdge',)):
                        raise ValueError('Loft rail edgeCondition applies only to BRepEdge rails')
                    edge_condition = _feature_native_enum(_geometry_feature_fusion.LoftRailEdgeConditions,
                        {'G0': 'G0LoftRailEdgeCondition', 'G1': 'G1LoftRailEdgeCondition', 'G2': 'G2LoftRailEdgeCondition'},
                        item_object['edgeCondition'], 'edgeCondition')
                    loft_items.append({'entity': entity, 'edgeCondition': edge_condition})
                    loft_summaries.append({'entity': ctx.ref(entity),
                                           'edgeCondition': _feature_native_value(ctx, edge_condition)})
                else:
                    if key == 'rails':
                        loft_items.append({'entity': entity})
                        loft_summaries.append({'entity': ctx.ref(entity)})
                    else:
                        loft_items.append(entity)
                        loft_summaries.append(ctx.ref(entity))
            resolved[key] = loft_items
            summary[key] = loft_summaries
        elif key == 'centerLine':
            center_line = _feature_native_path(ctx, value)
            if not _feature_native_is(center_line, ('SketchCurve', 'BRepEdge', 'Path')):
                raise ValueError('Loft centerLine must be a sketch curve, BRepEdge or Path ref')
            resolved[key] = center_line
            summary[key] = ctx.ref(center_line)
        elif key == 'sectionConditions':
            if not isinstance(value, list) or not value:
                raise ValueError('sectionConditions must be a nonempty array')
            conditions: list["JsonObject"] = []
            for condition_value in value:
                condition = _feature_json_object(condition_value, 'section condition')
                index_value = condition.get('index')
                if type(index_value) is not int:
                    raise ValueError('sectionConditions rows require a nonnegative index')
                if index_value < 0:
                    raise ValueError('sectionConditions rows require a nonnegative index')
                _cad_fields(condition, ('index', 'type'), ('angle', 'weight'))
                condition_type = condition['type']
                if not isinstance(condition_type, str) or condition_type not in (
                        'free', 'direction', 'tangent', 'smooth', 'pointSharp', 'pointTangent'):
                    raise ValueError('Unsupported loft end-condition type: ' + str(condition_type))
                if 'angle' in condition:
                    ctx.angle(condition['angle'])
                if 'weight' in condition:
                    weight_value = condition['weight']
                    if type(weight_value) is int:
                        weight = float(weight_value)
                    elif type(weight_value) is float:
                        weight = weight_value
                    else:
                        raise ValueError('Loft end-condition weight must be positive and unitless')
                    if weight <= 0:
                        raise ValueError('Loft end-condition weight must be positive and unitless')
                conditions.append(dict(condition))
            resolved[key] = conditions
            summary[key] = list(conditions)
        elif key in ('insideThickness', 'outsideThickness'):
            ctx.length(value)
            resolved[key] = value
            summary[key] = value
        elif key == 'position':
            resolved[key] = _feature_validate_hole_position(ctx, value)
            summary[key] = value
        elif key == 'holeType':
            hole_type = _feature_json_object(value, 'holeType')
            hole_type_value = hole_type.get('type')
            if not isinstance(hole_type_value, str) or hole_type_value not in ('simple', 'counterbore', 'countersink'):
                raise ValueError('holeType.type must be simple, counterbore or countersink')
            required = {'simple': (), 'counterbore': ('diameter', 'depth'), 'countersink': ('diameter', 'angle')}[hole_type_value]
            _cad_fields(hole_type, ('type',) + required, ())
            for field in ('diameter', 'depth'):
                if field in hole_type:
                    ctx.length(hole_type[field])
            if 'angle' in hole_type:
                ctx.angle(hole_type['angle'])
            resolved[key] = dict(hole_type)
            summary[key] = dict(hole_type)
        else:
            raise ValueError('Unsupported nativeEdits property: ' + key)
    if kind == 'LoftFeature':
        loft = _geometry_feature_adapter_cast(_FeatureLoft, _feature_sdk_object('LoftFeature', feature))
        for key in ('sections', 'rails'):
            if key in resolved:
                requested = resolved[key]
                if not isinstance(requested, list):
                    raise RuntimeError('Loft plan collection must be an array')
                requested_items = _geometry_feature_adapter_cast("Sequence[object]", requested)
                current_count = (loft.loftSections.count if key == 'sections'
                                 else loft.centerLineOrRails.count)
                if len(requested_items) != current_count:
                    raise ValueError('Loft ' + key + ' edits must preserve collection cardinality')
    return {'kind': kind, 'resolved': resolved, 'summary': summary}


def _feature_entity_refs(ctx: "CadContext", collection: object | None) -> "list[JsonValue] | None":
    if collection is None:
        return None
    if isinstance(collection, (list, tuple)):
        entities = _geometry_feature_adapter_cast("Sequence[adsk.core.Base]", collection)
        return [ctx.ref(entity) for entity in entities]
    entities = _geometry_feature_adapter_cast(_FeatureEntityCollection, collection)
    return [ctx.ref(entities.item(index)) for index in range(entities.count)]


def _feature_object_sequence(value: object, label: str) -> "list[object]":
    if not isinstance(value, list):
        raise RuntimeError(label + ' plan must be an array')
    values = _geometry_feature_adapter_cast("Sequence[object]", value)
    return list(values)


def _feature_plan_text(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise RuntimeError(label + ' plan value must be text')
    return value


def _feature_json_array(value: object, label: str) -> "list[JsonValue]":
    if not isinstance(value, list):
        raise ValueError(label + ' must be an array')
    return _geometry_feature_adapter_cast("list[JsonValue]", value)


def _feature_json_text(record: "JsonObject", key: str, label: str) -> str:
    value = record.get(key)
    if not isinstance(value, str):
        raise ValueError(label + ' must be text')
    return value


def _feature_object_records(value: object, label: str) -> "list[dict[str, object]]":
    records: list[dict[str, object]] = []
    for item in _feature_object_sequence(value, label):
        record = _feature_json_object(item, label + ' item')
        records.append({key: member for key, member in record.items()})
    return records


def _feature_object_record(value: object, label: str) -> "dict[str, object]":
    if not isinstance(value, dict):
        raise RuntimeError(label + ' plan item must be an object')
    entries = _geometry_feature_adapter_cast("dict[object, object]", value)
    record: dict[str, object] = {}
    for key, member in entries.items():
        if not isinstance(key, str):
            raise RuntimeError(label + ' plan keys must be strings')
        record[key] = member
    return record


def _feature_object_record_or_none(value: object, label: str) -> "dict[str, object] | None":
    if not isinstance(value, dict):
        return None
    entries = _geometry_feature_adapter_cast("dict[object, object]", value)
    record: dict[str, object] = {}
    for key, member in entries.items():
        if not isinstance(key, str):
            raise RuntimeError(label + ' plan keys must be strings')
        record[key] = member
    return record


def _feature_entity_values(value: object, label: str) -> "list[CadEntity]":
    entities: list["CadEntity"] = []
    for item in _feature_object_sequence(value, label):
        entity = _feature_cad_entity(item)
        if entity is None:
            raise RuntimeError(label + ' plan contains a non-entity')
        entities.append(entity)
    return entities


def _feature_entity_value(value: object, label: str) -> "CadEntity":
    entity = _feature_cad_entity(value)
    if entity is None:
        raise RuntimeError(label + ' plan value is not a Fusion entity')
    return entity


def _feature_body_values(value: object, label: str) -> "list[adsk.fusion.BRepBody]":
    body_caster = _geometry_feature_adapter_cast(
        _FeatureBRepBodyCaster, _geometry_feature_fusion.BRepBody)
    bodies: list["adsk.fusion.BRepBody"] = []
    for entity in _feature_entity_values(value, label):
        body = body_caster.cast(entity)
        if body is None:
            raise RuntimeError(label + ' plan value is not a BRepBody')
        bodies.append(body)
    return bodies


def _feature_face_values(value: object, label: str) -> "list[adsk.fusion.BRepFace]":
    face_caster = _geometry_feature_adapter_cast(
        _FeatureBRepFaceCaster, _geometry_feature_fusion.BRepFace)
    faces: list["adsk.fusion.BRepFace"] = []
    for entity in _feature_entity_values(value, label):
        face = face_caster.cast(entity)
        if face is None:
            raise RuntimeError(label + ' plan value is not a BRepFace')
        faces.append(face)
    return faces


def _feature_object_items(value: object, label: str) -> "list[object]":
    if isinstance(value, (list, tuple)):
        return list(_geometry_feature_adapter_cast("Sequence[object]", value))
    if not hasattr(value, 'count') or not hasattr(value, 'item'):
        raise RuntimeError(label + ' must be a Fusion collection')
    collection = _geometry_feature_adapter_cast(_FeatureObjectCollection, value)
    return [collection.item(index) for index in range(collection.count)]


def _feature_native_value(ctx: "CadContext", value: object) -> "JsonValue":
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (list, tuple)):
        values = _geometry_feature_adapter_cast("Sequence[object]", value)
        return [_feature_native_value(ctx, item) for item in values]
    entity = _feature_cad_entity(value)
    if entity is not None:
        return ctx.ref(entity)
    return _cad_json(value)


def _feature_hole_position_snapshot(ctx: "CadContext", feature: object) -> "JsonObject":
    definition: object | None = getattr(feature, 'holePositionDefinition', None)
    position_maps: "Sequence[tuple[str, Mapping[str, str]]]" = (
        ('SketchPointHolePositionDefinition', {'sketchPoint': 'sketchPoint'}),
        ('SketchPointsHolePositionDefinition', {'sketchPoints': 'sketchPoints'}),
        ('AtCenterHolePositionDefinition', {'plane': 'planarEntity', 'edge': 'centerEdge'}),
        ('OnEdgeHolePositionDefinition', {'plane': 'planarEntity', 'edge': 'edge', 'position': 'position'}),
        ('PlaneAndOffsetsHolePositionDefinition', {'plane': 'planarEntity', 'edgeOne': 'edgeOne', 'offsetOne': 'offsetOne',
                                                   'edgeTwo': 'edgeTwo', 'offsetTwo': 'offsetTwo'}),
        ('PointHolePositionDefinition', {'plane': 'planarEntity', 'point': 'point'}))
    for class_name, key_map in position_maps:
        caster_value: object | None = getattr(_geometry_feature_fusion, class_name, None)
        if caster_value is None:
            continue
        caster = _geometry_feature_adapter_cast(
            _FeatureCaster[_FeatureHolePositionData], caster_value)
        typed = caster.cast(definition)
        if typed is None:
            continue
        result: "JsonObject" = {'definitionType': class_name}
        for out_key, prop in key_map.items():
            value: object | None = getattr(typed, prop, None)
            if value is None:
                result[out_key] = None
            elif hasattr(value, 'expression'):
                result[out_key] = _feature_parameter(
                    _geometry_feature_adapter_cast(_FeatureParameter, value), out_key)
            else:
                result[out_key] = _feature_native_value(ctx, value)
        return result
    return {'definitionType': 'unsupportedOrUnknown'}


def _feature_native_read(ctx: "CadContext", feature: "adsk.fusion.Feature",
                         plan: "_FeatureNativePlan") -> "JsonObject":
    kind = plan['kind']
    rows: "JsonObject" = {}
    feature_view = _geometry_feature_adapter_cast(_FeatureDynamicAccess, feature)
    for key in plan['resolved']:
        if key == 'entities':
            prop = 'inputFaces' if kind == 'ThickenFeature' else 'inputEntities'
            collection: object | None = getattr(feature_view, prop, None)
            rows[key] = _feature_entity_refs(ctx, collection)
        elif key == 'participants':
            rows[key] = _feature_entity_refs(ctx, feature_view.participantBodies)
        elif key == 'edgeSets':
            collection = _geometry_feature_adapter_cast(_FeatureEdgeSetSource, feature).edgeSets
            planned_value = plan['resolved'][key]
            if not isinstance(planned_value, list):
                raise RuntimeError('Native edge-set plan must be an array')
            planned_items = _geometry_feature_adapter_cast("Sequence[object]", planned_value)
            edge_set_readbacks: list["JsonValue"] = []
            for planned_item in planned_items:
                item = _feature_json_object(planned_item, 'edge-set plan item')
                index_value = item.get('index')
                if type(index_value) is not int:
                    raise RuntimeError('Native edge-set plan index must be an integer')
                index = index_value
                if index >= collection.count:
                    raise ValueError('edgeSets index is outside the existing feature edge sets')
                edge_set = _geometry_feature_adapter_cast(
                    _FeatureDynamicAccess, collection.item(index))
                edge_collection: object | None = getattr(edge_set, 'edges', None)
                edge_set_readbacks.append({'index': index, 'type': _cad_type(collection.item(index)),
                                           'edges': _feature_entity_refs(ctx, edge_collection) or []})
            rows[key] = edge_set_readbacks
        elif key == 'fullRoundFaceSets':
            fillet = _geometry_feature_adapter_cast(_FeatureFillet, _feature_sdk_object('FilletFeature', feature))
            face_sets = fillet.fullRoundFilletFaceSets
            face_set_readbacks: list["JsonValue"] = []
            for index in range(face_sets.count):
                item = face_sets.item(index)
                face_set_readbacks.append({'centerFace': ctx.ref(item.centerFace),
                                           'sideOneFaces': _feature_entity_refs(ctx, item.sideOneFaces) or [],
                                           'sideTwoFaces': _feature_entity_refs(ctx, item.sideTwoFaces) or [],
                                           'automaticSideFaces': bool(item.areAutomaticSideFaces)})
            rows[key] = face_set_readbacks
        elif key == 'sections':
            loft = _geometry_feature_adapter_cast(_FeatureLoft, _feature_sdk_object('LoftFeature', feature))
            rows[key] = [ctx.ref(loft.loftSections.item(index).entity)
                         for index in range(loft.loftSections.count)]
        elif key == 'rails':
            loft = _geometry_feature_adapter_cast(_FeatureLoft, _feature_sdk_object('LoftFeature', feature))
            rows[key] = [{'entity': ctx.ref(loft.centerLineOrRails.item(index).entity),
                          'isCenterLine': bool(loft.centerLineOrRails.item(index).isCenterLine),
                          'edgeCondition': _feature_native_value(
                              ctx, loft.centerLineOrRails.item(index).edgeCondition)}
                         for index in range(loft.centerLineOrRails.count)]
        elif key == 'sectionConditions':
            loft = _geometry_feature_adapter_cast(_FeatureLoft, _feature_sdk_object('LoftFeature', feature))
            planned_value = plan['resolved'][key]
            if not isinstance(planned_value, list):
                raise RuntimeError('Native section-condition plan must be an array')
            planned_items = _geometry_feature_adapter_cast("Sequence[object]", planned_value)
            condition_readbacks: list["JsonValue"] = []
            for planned_item in planned_items:
                item = _feature_json_object(planned_item, 'section-condition plan item')
                index_value = item.get('index')
                if type(index_value) is not int:
                    raise RuntimeError('Native section-condition index must be an integer')
                end_condition: object = loft.loftSections.item(index_value).endCondition
                object_type: object = getattr(end_condition, 'objectType', 'unknown')
                condition_readbacks.append({'index': index_value, 'type': str(object_type)})
            rows[key] = condition_readbacks
        elif key == 'position':
            hole = _geometry_feature_adapter_cast(_FeatureHole, _feature_sdk_object('HoleFeature', feature))
            rows[key] = _feature_hole_position_snapshot(ctx, hole)
        elif key == 'holeType':
            hole = _geometry_feature_adapter_cast(
                _FeatureDynamicAccess, _feature_sdk_object('HoleFeature', feature))
            hole_type: object | None = getattr(hole, 'holeType', None)
            tap_type: object | None = getattr(hole, 'holeTapType', None)
            rows[key] = {'type': _feature_native_value(ctx, hole_type),
                         'tapType': _feature_native_value(ctx, tap_type)}
        elif key in ('insideThickness', 'outsideThickness'):
            parameter_value: object | None = getattr(feature_view, key, None)
            rows[key] = (_feature_parameter(
                _geometry_feature_adapter_cast(_FeatureParameter, parameter_value), key)
                if parameter_value is not None else None)
        elif key in ('startLoftEdgeAlignment', 'endLoftEdgeAlignment'):
            loft = _geometry_feature_adapter_cast(_FeatureLoft, _feature_sdk_object('LoftFeature', feature))
            if key == 'startLoftEdgeAlignment':
                rows[key] = _feature_native_value(ctx, loft.startLoftEdgeAlignment)
            else:
                rows[key] = _feature_native_value(ctx, loft.endLoftEdgeAlignment)
        elif key == 'centerLine':
            loft = _geometry_feature_adapter_cast(_FeatureLoft, _feature_sdk_object('LoftFeature', feature))
            rows[key] = [{'entity': ctx.ref(loft.centerLineOrRails.item(index).entity),
                          'isCenterLine': bool(loft.centerLineOrRails.item(index).isCenterLine)}
                         for index in range(loft.centerLineOrRails.count)]
        else:
            prop = {'isTangentChain': 'isTangentChain', 'isChainSelection': 'isChainSelection'}.get(key, key)
            value: object | None = getattr(feature_view, prop, None)
            rows[key] = _feature_native_value(ctx, value)
    return rows


def _feature_native_set_parameter(parameter: "_FeatureParameter", value: str, unit_kind: str,
                                   ctx: "CadContext", label: str) -> None:
    if unit_kind == 'length':
        ctx.length(value)
    elif unit_kind == 'angle':
        ctx.angle(value)
    parameter.expression = value


def _feature_native_apply(ctx: "CadContext", feature: "adsk.fusion.Feature",
                          plan: "_FeatureNativePlan") -> None:
    kind, edits = plan['kind'], plan['resolved']
    feature_view = _geometry_feature_adapter_cast(_FeatureDynamicAccess, feature)
    for key, value in edits.items():
        if key == 'edgeSets':
            collection = _geometry_feature_adapter_cast(_FeatureEdgeSetSource, feature).edgeSets
            edge_rows = _feature_object_records(value, 'edgeSets')
            for row in edge_rows:
                index = row.get('index')
                if type(index) is not int:
                    raise RuntimeError('Native edge-set edit index must be an integer')
                if index >= collection.count:
                    raise ValueError('edgeSets index is outside the existing feature edge sets')
            for row in edge_rows:
                if 'midRadii' in row:
                    index = row['index']
                    if type(index) is not int:
                        raise RuntimeError('Native edge-set edit index must be an integer')
                    edge_set = _geometry_feature_adapter_cast(
                        _FeatureDynamicAccess, collection.item(index))
                    mid_radii = _feature_object_items(edge_set.midRadii, 'midRadii')
                    mid_positions = _feature_object_items(edge_set.midPositions, 'midPositions')
                    planned_radii = _feature_object_sequence(row['midRadii'], 'midRadii')
                    planned_positions = _feature_object_sequence(row['midPositions'], 'midPositions')
                    if len(planned_radii) != len(mid_radii) or len(planned_positions) != len(mid_positions):
                        raise ValueError('Variable fillet mid-point cardinality must be preserved')
            for row in edge_rows:
                index = row.get('index')
                if type(index) is not int:
                    raise RuntimeError('Native edge-set edit index must be an integer')
                edge_set = _geometry_feature_adapter_cast(
                    _FeatureDynamicAccess, collection.item(index))
                if 'edges' in row:
                    edge_set.edges = _feature_native_object_collection(
                        _feature_entity_values(row['edges'], 'edge-set edges'))
                    edge_set = _geometry_feature_adapter_cast(
                        _FeatureDynamicAccess, collection.item(index))
                for prop, unit_kind in (('radius', 'length'), ('chordLength', 'length'), ('startRadius', 'length'),
                                        ('endRadius', 'length'), ('offsetOne', 'length'), ('offsetTwo', 'length'),
                                        ('distance', 'length'), ('distanceOne', 'length'),
                                        ('distanceTwo', 'length'), ('angle', 'angle')):
                    if prop in row:
                        parameter_value: object | None = getattr(edge_set, prop, None)
                        if parameter_value is None:
                            raise ValueError('Existing edge-set variant does not expose ' + prop)
                        parameter = _geometry_feature_adapter_cast(_FeatureParameter, parameter_value)
                        expression = _feature_plan_text(row[prop], prop)
                        _feature_native_set_parameter(parameter, expression, unit_kind, ctx, prop)
                if 'midRadii' in row:
                    mid_radii = _feature_object_items(edge_set.midRadii, 'midRadii')
                    mid_positions = _feature_object_items(edge_set.midPositions, 'midPositions')
                    planned_radii = _feature_object_sequence(row['midRadii'], 'midRadii')
                    planned_positions = _feature_object_sequence(row['midPositions'], 'midPositions')
                    for parameter_value, expression_value in zip(mid_radii, planned_radii):
                        parameter = _geometry_feature_adapter_cast(_FeatureParameter, parameter_value)
                        expression = _feature_plan_text(expression_value, 'midRadius')
                        _feature_native_set_parameter(parameter, expression, 'length', ctx, 'midRadius')
                    for parameter_value, position in zip(mid_positions, planned_positions):
                        parameter = _geometry_feature_adapter_cast(_FeatureParameter, parameter_value)
                        parameter.expression = str(position)
                if 'tangentChain' in row:
                    tangent_chain = row['tangentChain']
                    if type(tangent_chain) is not bool:
                        raise RuntimeError('Native tangentChain value must be boolean')
                    edge_set.isTangentChain = tangent_chain
                if 'isFlipped' in row:
                    is_flipped = row['isFlipped']
                    if type(is_flipped) is not bool:
                        raise RuntimeError('Native isFlipped value must be boolean')
                    edge_set.isFlipped = is_flipped
                if 'continuity' in row:
                    edge_set.continuity = row['continuity']
                if 'tangencyWeight' in row:
                    edge_set.tangencyWeight = ctx.value(str(row['tangencyWeight']))
        elif key == 'fullRoundFaceSets':
            fillet = _geometry_feature_adapter_cast(_FeatureFillet, _feature_sdk_object('FilletFeature', feature))
            collection = fillet.fullRoundFilletFaceSets
            for index in range(collection.count - 1, -1, -1):
                _cad_require_result(collection.item(index).deleteMe(), 'FullRoundFilletFaceSet.deleteMe')
            for row in _feature_object_records(value, 'fullRoundFaceSets'):
                center_face = _geometry_feature_adapter_cast(
                    _FeatureBRepFaceCaster, _geometry_feature_fusion.BRepFace).cast(
                        _feature_entity_value(row['centerFace'], 'centerFace'))
                if center_face is None:
                    raise RuntimeError('centerFace plan value is not a BRepFace')
                side_one = _feature_face_values(row['sideOneFaces'], 'sideOneFaces')
                side_two = _feature_face_values(row['sideTwoFaces'], 'sideTwoFaces')
                automatic = row['automaticSideFaces']
                if type(automatic) is not bool:
                    raise RuntimeError('automaticSideFaces plan value must be boolean')
                _cad_require_result(collection.add(center_face, side_one, side_two, automatic),
                                    'FullRoundFilletFaceSets.add')
        elif key == 'isRollingBallCorner':
            rolling_ball = value
            if type(rolling_ball) is not bool:
                raise RuntimeError('isRollingBallCorner plan value must be boolean')
            _geometry_feature_adapter_cast(_FeatureFillet, _feature_sdk_object('FilletFeature', feature)).isRollingBallCorner = rolling_ball
        elif key == 'cornerType':
            chamfer = _geometry_feature_adapter_cast(_FeatureChamfer, _feature_sdk_object('ChamferFeature', feature))
            chamfer.cornerType = _geometry_feature_adapter_cast(
                _geometry_feature_fusion.ChamferCornerTypes, value)
        elif key == 'holeType':
            hole = _geometry_feature_adapter_cast(_FeatureHole, _feature_sdk_object('HoleFeature', feature))
            hole_data = _feature_json_object(value, 'holeType')
            hole_type = _feature_plan_text(hole_data.get('type'), 'holeType.type')
            if hole_type == 'simple':
                _cad_require_result(hole.setToSimple(), 'HoleFeature.setToSimple')
            elif hole_type == 'counterbore':
                _cad_require_result(hole.setToCounterbore(
                    ctx.value(hole_data['diameter']), ctx.value(hole_data['depth'])), 'HoleFeature.setToCounterbore')
            else:
                _cad_require_result(hole.setToCountersink(
                    ctx.value(hole_data['diameter']), ctx.value(hole_data['angle'])), 'HoleFeature.setToCountersink')
        elif key == 'position':
            hole = _geometry_feature_adapter_cast(_FeatureHole, _feature_sdk_object('HoleFeature', feature))
            position_data = _feature_object_record(value, 'hole position')
            mode = _feature_plan_text(position_data.get('mode'), 'hole position mode')
            if mode == 'sketchPoint':
                point = _geometry_feature_adapter_cast(
                    _FeatureSketchPointCaster, _geometry_feature_fusion.SketchPoint).cast(
                        _feature_entity_value(position_data['point'], 'hole sketch point'))
                if point is None:
                    raise RuntimeError('Hole sketchPoint plan value is not a SketchPoint')
                _cad_require_result(hole.setPositionBySketchPoint(point), 'HoleFeature.setPositionBySketchPoint')
            elif mode == 'sketchPoints':
                points = _feature_entity_values(position_data['points'], 'hole sketch points')
                sketch_points: list["adsk.fusion.SketchPoint"] = []
                point_caster = _geometry_feature_adapter_cast(
                    _FeatureSketchPointCaster, _geometry_feature_fusion.SketchPoint)
                for point_entity in points:
                    sketch_point = point_caster.cast(point_entity)
                    if sketch_point is None:
                        raise RuntimeError('Hole sketchPoints plan contains a non-SketchPoint')
                    sketch_points.append(sketch_point)
                _cad_require_result(hole.setPositionBySketchPoints(ctx.collection(sketch_points)),
                                    'HoleFeature.setPositionBySketchPoints')
            elif mode == 'point':
                coordinates = _feature_object_sequence(position_data['point'], 'hole point coordinates')
                if len(coordinates) != 3:
                    raise RuntimeError('Hole point plan must have three coordinates')
                point = _geometry_feature_core.Point3D.create(
                    ctx.length(coordinates[0]), ctx.length(coordinates[1]), ctx.length(coordinates[2]))
                if point is None:
                    raise RuntimeError('Fusion could not create a hole-position point')
                plane = _feature_entity_value(position_data['plane'], 'hole plane')
                _cad_require_result(hole.setPositionByPoint(plane, point), 'HoleFeature.setPositionByPoint')
            elif mode == 'center':
                plane = _feature_entity_value(position_data['plane'], 'hole plane')
                edge = _geometry_feature_adapter_cast(
                    _FeatureBRepEdgeCaster, _geometry_feature_fusion.BRepEdge).cast(
                        _feature_entity_value(position_data['edge'], 'hole center edge'))
                if edge is None:
                    raise RuntimeError('Hole center-edge plan value is not a BRepEdge')
                _cad_require_result(hole.setPositionAtCenter(plane, edge), 'HoleFeature.setPositionAtCenter')
            elif mode == 'offsets':
                coordinates = _feature_object_sequence(position_data['point'], 'hole point coordinates')
                if len(coordinates) != 3:
                    raise RuntimeError('Hole point plan must have three coordinates')
                point = _geometry_feature_core.Point3D.create(
                    ctx.length(coordinates[0]), ctx.length(coordinates[1]), ctx.length(coordinates[2]))
                if point is None:
                    raise RuntimeError('Fusion could not create a hole-position point')
                plane = _feature_entity_value(position_data['plane'], 'hole plane')
                edge_one = _geometry_feature_adapter_cast(
                    _FeatureBRepEdgeCaster, _geometry_feature_fusion.BRepEdge).cast(
                        _feature_entity_value(position_data['edgeOne'], 'hole edgeOne'))
                if edge_one is None:
                    raise RuntimeError('Hole edgeOne plan value is not a BRepEdge')
                offset_one = ctx.value(position_data['offsetOne'])
                if 'edgeTwo' in position_data:
                    edge_two = _geometry_feature_adapter_cast(
                        _FeatureBRepEdgeCaster, _geometry_feature_fusion.BRepEdge).cast(
                            _feature_entity_value(position_data['edgeTwo'], 'hole edgeTwo'))
                    if edge_two is None:
                        raise RuntimeError('Hole edgeTwo plan value is not a BRepEdge')
                    _cad_require_result(hole.setPositionByPlaneAndOffsets(
                        plane, point, edge_one, offset_one, edge_two, ctx.value(position_data['offsetTwo'])),
                        'HoleFeature.setPositionByPlaneAndOffsets')
                else:
                    _cad_require_result(hole.setPositionByPlaneAndOffsets(
                        plane, point, edge_one, offset_one), 'HoleFeature.setPositionByPlaneAndOffsets')
            else:
                plane = _feature_entity_value(position_data['plane'], 'hole plane')
                edge = _geometry_feature_adapter_cast(
                    _FeatureBRepEdgeCaster, _geometry_feature_fusion.BRepEdge).cast(
                        _feature_entity_value(position_data['edge'], 'hole edge'))
                if edge is None:
                    raise RuntimeError('Hole edge plan value is not a BRepEdge')
                position_name = _feature_plan_text(position_data['position'], 'hole edge position')
                if position_name == 'start':
                    edge_position = _geometry_feature_fusion.HoleEdgePositions.EdgeStartPointPosition
                elif position_name == 'end':
                    edge_position = _geometry_feature_fusion.HoleEdgePositions.EdgeEndPointPosition
                else:
                    edge_position = _geometry_feature_fusion.HoleEdgePositions.EdgeMidPointPosition
                edge_position = _geometry_feature_adapter_cast(
                    _geometry_feature_fusion.HoleEdgePositions, edge_position)
                _cad_require_result(hole.setPositionOnEdge(plane, edge, edge_position),
                                    'HoleFeature.setPositionOnEdge')
        elif key == 'participants':
            participants = _feature_body_values(value, 'participants')
            feature_view.participantBodies = participants
        elif key == 'entities':
            entities = _feature_entity_values(value, 'entities')
            collection = _feature_native_object_collection(entities)
            if kind == 'ShellFeature':
                shell = _geometry_feature_adapter_cast(_FeatureShell, _feature_sdk_object('ShellFeature', feature))
                tangent_chain = edits.get('isTangentChain', True)
                if type(tangent_chain) is not bool:
                    raise RuntimeError('Shell isTangentChain plan value must be boolean')
                _cad_require_result(shell.setInputEntities(collection, tangent_chain), 'ShellFeature.setInputEntities')
            elif kind == 'ThickenFeature':
                thicken = _geometry_feature_adapter_cast(_FeatureThicken, _feature_sdk_object('ThickenFeature', feature))
                chain_selection = edits.get('isChainSelection', True)
                if type(chain_selection) is not bool:
                    raise RuntimeError('Thicken isChainSelection plan value must be boolean')
                _cad_require_result(thicken.setInputEntities(collection, chain_selection), 'ThickenFeature.setInputEntities')
            else:
                feature_view.inputEntities = collection
        elif key in ('insideThickness', 'outsideThickness'):
            if key == 'outsideThickness' and 'insideThickness' in edits:
                continue
            inside = edits.get('insideThickness')
            outside = edits.get('outsideThickness')
            if inside is None:
                inside_parameter: object | None = getattr(feature_view, 'insideThickness', None)
                inside = (_geometry_feature_adapter_cast(_FeatureParameter, inside_parameter).expression
                          if inside_parameter is not None else None)
            if outside is None:
                outside_parameter: object | None = getattr(feature_view, 'outsideThickness', None)
                outside = (_geometry_feature_adapter_cast(_FeatureParameter, outside_parameter).expression
                           if outside_parameter is not None else None)
            shell = _geometry_feature_adapter_cast(_FeatureShell, _feature_sdk_object('ShellFeature', feature))
            inside_input = ctx.value(inside) if inside is not None else None
            outside_input = ctx.value(outside) if outside is not None else None
            if inside_input is None or outside_input is None:
                raise RuntimeError('Shell feature did not expose both thickness values')
            _cad_require_result(shell.setThicknesses(inside_input, outside_input),
                                'ShellFeature.setThicknesses')
        elif key == 'centerLine':
            loft = _geometry_feature_adapter_cast(_FeatureLoft, _feature_sdk_object('LoftFeature', feature))
            center_line = _feature_entity_value(value, 'centerLine')
            _cad_require_result(loft.centerLineOrRails.addCenterLine(center_line), 'LoftFeature.addCenterLine')
        elif key in ('sections', 'rails'):
            loft = _geometry_feature_adapter_cast(_FeatureLoft, _feature_sdk_object('LoftFeature', feature))
            loft_values = _feature_object_sequence(value, key)
            if key == 'rails':
                collection = loft.centerLineOrRails
                if collection.count != len(loft_values):
                    raise ValueError('Loft rails collection cardinality changed before edit')
                for index, entity_value in enumerate(loft_values):
                    item = collection.item(index)
                    if bool(item.isCenterLine):
                        raise ValueError('Loft rails edit cannot replace a centerline with a rail')
                    row = _feature_object_record_or_none(entity_value, 'loft rail')
                    if row is None:
                        row = {'entity': entity_value}
                    item.entity = _feature_entity_value(row['entity'], 'loft rail entity')
                    if 'edgeCondition' in row:
                        item.edgeCondition = _geometry_feature_adapter_cast(
                            _geometry_feature_fusion.LoftRailEdgeConditions, row['edgeCondition'])
            else:
                collection = loft.loftSections
                if collection.count != len(loft_values):
                    raise ValueError('Loft sections collection cardinality changed before edit')
                for index, entity_value in enumerate(loft_values):
                    collection.item(index).entity = _feature_entity_value(entity_value, 'loft section')
        elif key == 'sectionConditions':
            loft = _geometry_feature_adapter_cast(_FeatureLoft, _feature_sdk_object('LoftFeature', feature))
            collection = loft.loftSections
            for condition in _feature_object_records(value, 'sectionConditions'):
                index = condition.get('index')
                mode = _feature_plan_text(condition.get('type'), 'section condition type')
                if type(index) is not int:
                    raise RuntimeError('Section-condition index must be an integer')
                if index >= collection.count or index not in (0, collection.count - 1):
                    raise ValueError('Loft end conditions apply only to the first or last section')
                section = collection.item(index)
                weight = ctx.value(str(condition.get('weight', 1)))
                if mode == 'free':
                    result = section.setFreeEndCondition()
                elif mode == 'direction':
                    result = section.setDirectionEndCondition(ctx.value(condition.get('angle', '0 deg')), weight)
                elif mode == 'tangent':
                    result = section.setTangentEndCondition(weight)
                elif mode == 'smooth':
                    result = section.setSmoothEndCondition(weight)
                elif mode == 'pointSharp':
                    result = section.setPointSharpEndCondition()
                else:
                    result = section.setPointTangentEndCondition(weight)
                _cad_require_result(result, 'LoftSection end condition')
        elif key == 'path' or key == 'guideRail' or key == 'profile' or key == 'solidBody' or key in ('axis', 'directionOneEntity', 'directionTwoEntity', 'mirrorPlane', 'solidAlignedAxis', 'solidTwistAxis'):
            setattr(feature, key, value)
        elif key in ('suppressedElementsIds', 'startPoint', 'isFlipDirection', 'isSymmetric', 'isSymmetricInDirectionOne', 'isSymmetricInDirectionTwo', 'patternDistanceType', 'patternComputeOption', 'orientation', 'isDirectionFlipped', 'guideSurfaces', 'isChainSelection', 'solidOrientation', 'isClosed', 'isTangentEdgesMerged', 'startLoftEdgeAlignment', 'endLoftEdgeAlignment', 'thickenType'):
            setattr(feature, key, value)
        elif key == 'isTangentChain':
            if kind == 'ShellFeature':
                if 'entities' in edits:
                    continue
                shell = _geometry_feature_adapter_cast(_FeatureShell, _feature_sdk_object('ShellFeature', feature))
                tangent_chain = value
                if type(tangent_chain) is not bool:
                    raise RuntimeError('Shell isTangentChain plan value must be boolean')
                _cad_require_result(shell.setInputEntities(shell.inputEntities, tangent_chain),
                                    'ShellFeature.setInputEntities')
            elif kind == 'ThickenFeature':
                if 'entities' in edits:
                    continue
                thicken = _geometry_feature_adapter_cast(_FeatureThicken, _feature_sdk_object('ThickenFeature', feature))
                chain_selection = value
                if type(chain_selection) is not bool:
                    raise RuntimeError('Thicken isTangentChain plan value must be boolean')
                _cad_require_result(thicken.setInputEntities(thicken.inputFaces, chain_selection),
                                    'ThickenFeature.setInputEntities')
            else:
                raise ValueError('isTangentChain is not applicable to ' + kind)


def _feature_native_edit(ctx: "CadContext", data: "JsonObject",
                         feature: "adsk.fusion.Feature") -> "JsonValue":
    before = _feature_snapshot(ctx, feature)
    native_edits = _feature_json_object(data['nativeEdits'], 'nativeEdits')
    plan = _feature_native_plan(ctx, feature, native_edits)
    request: "JsonObject" = {
        'featureType': plan['kind'], 'properties': plan['summary'],
        'supportedProperties': _feature_supported_capabilities(
            plan['kind'], _feature_snapshot_capability_parameters(before)),
        'unsupportedProperties': _FEATURE_UNSUPPORTED_NATIVE.get(plan['kind'], []),
    }
    if data.get('preview') is True:
        return _feature_contract(ctx, 'feature.edit', {'applied': False, 'before': before,
            'after': dict(before), 'nativeEdits': request, 'preview': True, 'mutation': False,
            'skippedFields': [], 'unsupportedFields': request['unsupportedProperties']},
            status='pass', associativity='snapshot')
    if data.get('confirm') is not True:
        return _feature_contract(ctx, 'feature.edit', {'applied': False, 'before': before,
            'after': dict(before), 'nativeEdits': request,
            'reason': 'nativeEdits requires confirm:true', 'mutation': False,
            'skippedFields': [], 'unsupportedFields': request['unsupportedProperties']},
            status='blocked', associativity='snapshot')
    timeline = _geometry_feature_adapter_cast(_FeatureMutableTimeline, ctx.design.timeline)
    marker: int | None = timeline.markerPosition
    if marker != timeline.count:
        raise ValueError('nativeEdits requires the timeline marker at the end')
    poses_before = _feature_operation_pose_snapshot(ctx)
    rolled = False
    primary_error: str | None = None
    restore_error: str | None = None
    native_before: "JsonObject | None" = None
    native_after: "JsonObject | None" = None
    try:
        rolled = True
        _cad_require_result(feature.timelineObject.rollTo(True), 'TimelineObject.rollTo')
        native_before = _feature_native_read(ctx, feature, plan)
        _feature_native_apply(ctx, feature, plan)
        native_after = _feature_native_read(ctx, feature, plan)
    except Exception as exc:
        primary_error = str(exc)
        try:
            native_after = _feature_native_read(ctx, feature, plan)
        except Exception as read_error:
            request['afterReadError'] = str(read_error)
    finally:
        marker_restored = True
        if rolled:
            try:
                timeline = _geometry_feature_adapter_cast(
                    _FeatureMutableTimeline, ctx.design.timeline)
                timeline.markerPosition = marker
                marker_restored = timeline.markerPosition == marker
                if not marker_restored:
                    raise RuntimeError('Timeline marker readback did not match captured position')
            except Exception as exc:
                restore_error = str(exc)
                marker_restored = False
    try:
        after = _feature_snapshot(ctx, feature)
    except Exception as read_error:
        after: "JsonObject" = {'status': 'unknown', 'error': str(read_error)}
    poses_after = _feature_operation_pose_snapshot(ctx)
    poses_preserved = (poses_before is not None and poses_after is not None and
                       [(row[0], row[1]) for row in poses_before] == [(row[0], row[1]) for row in poses_after])
    identity_preserved = ctx.resolve(data['feature'], 'feature') == feature
    health = int(_geometry_feature_adapter_cast(int, getattr(feature, 'healthState', -1)))
    status = 'pass' if not primary_error and not restore_error and marker_restored and poses_preserved and identity_preserved and health == 0 else 'fail'
    result: "JsonObject" = {'applied': True, 'before': before, 'after': after, 'nativeEdits': request,
              'nativeBefore': native_before, 'nativeAfter': native_after,
              'featureIdentityPreserved': identity_preserved, 'health': health,
              'timelinePositionBefore': marker, 'timelinePositionAfter': getattr(ctx.design.timeline, 'markerPosition', None),
              'markerRestored': marker_restored, 'posesPreserved': poses_preserved,
              'skippedFields': [], 'unsupportedFields': request['unsupportedProperties'],
              'partialEffectsUnknown': bool(primary_error or restore_error), 'atomic': False,
              'geometryDeleted': False, 'affected': [ctx.ref(feature)]}
    if primary_error:
        result['primaryError'] = primary_error
    if restore_error:
        result['restoreError'] = restore_error
    return _feature_contract(ctx, 'feature.edit', result, status=status, associativity='nativeReference')


@_cad_scoped_step('feature.edit', native_only=True)
def _feature_edit(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    _cad_fields(data, ('schemaVersion', 'frame', 'feature'), ('name', 'entries', 'extent', 'operationChange', 'nativeEdits', 'preview', 'confirm'))
    if data['schemaVersion'] != 1 or data['frame'] != 'component':
        raise ValueError('GM09 feature commands require schemaVersion:1 and frame:component')
    if 'preview' in data and type(data['preview']) is not bool:
        raise ValueError('preview must be boolean')
    if 'confirm' in data and type(data['confirm']) is not bool:
        raise ValueError('confirm must be boolean')
    if not any(key in data for key in ('name', 'entries', 'extent', 'operationChange', 'nativeEdits')):
        raise ValueError('Provide at least one of name, entries, extent, operationChange or nativeEdits')
    if 'operationChange' in data and any(key in data for key in ('name', 'entries', 'extent')):
        raise ValueError('operationChange cannot be combined with other feature edits')
    if 'nativeEdits' in data and any(key in data for key in ('name', 'entries', 'extent', 'operationChange')):
        raise ValueError('nativeEdits cannot be combined with name, entries, extent or operationChange')
    feature = ctx.resolve(data['feature'], 'feature')
    _feature_owner_check(ctx, feature)
    if 'nativeEdits' in data:
        return _feature_native_edit(ctx, data, feature)
    before = _feature_snapshot(ctx, feature)
    operation_plan: _FeatureOperationPlan | None = None
    operation_names: list[tuple[object, str]] = []
    if 'operationChange' in data:
        operation_kind = _cad_type(feature)
        if operation_kind not in _FEATURE_OPERATION_CHANGE_TYPES or not hasattr(type(feature), 'operation'):
            raise ValueError('operationChange is unsupported for feature type ' + operation_kind)
        spec = _feature_json_object(data['operationChange'], 'operationChange')
        _cad_fields(spec, ('expected', 'value', 'expectedResultBodyCount'), ('participants',))
        expected = _feature_json_text(spec, 'expected', 'operationChange.expected')
        requested_operation = _feature_json_text(spec, 'value', 'operationChange.value')
        supported_operations = ('newBody', 'join', 'cut') if operation_kind == 'ExtrudeFeature' else ('newBody', 'join', 'cut', 'intersect')
        if expected not in supported_operations or requested_operation not in supported_operations:
            raise ValueError('operationChange expected/value must be ' + ', '.join(supported_operations))
        body_count_value = spec['expectedResultBodyCount']
        if type(body_count_value) is not int or body_count_value < 1:
            raise ValueError('expectedResultBodyCount must be an integer >= 1')
        expected_result_body_count = body_count_value
        if requested_operation == 'newBody':
            if 'participants' in spec:
                raise ValueError('newBody forbids participants')
            participants: list["adsk.fusion.BRepBody"] = []
        else:
            refs = spec.get('participants')
            if not isinstance(refs, list) or not refs:
                raise ValueError('join/cut/intersect require explicit nonempty participants')
            participant_refs = refs
            participants = _feature_body_values(
                [ctx.resolve(ref, 'body') for ref in participant_refs], 'operationChange participants')
            if any(_cad_owner(body) != ctx.component or getattr(body, 'assemblyContext', None) is not None for body in participants):
                raise ValueError('operationChange participants must be native bodies owned by the selected component')
        operation_names = [(getattr(_geometry_feature_fusion.FeatureOperations, key), value) for key, value in (
            ('NewBodyFeatureOperation', 'newBody'), ('JoinFeatureOperation', 'join'), ('CutFeatureOperation', 'cut'),
            ('IntersectFeatureOperation', 'intersect'))
            if hasattr(_geometry_feature_fusion.FeatureOperations, key)]
        feature_view = _geometry_feature_adapter_cast(_FeatureDynamicAccess, feature)
        current_operation: object | None = getattr(feature_view, 'operation', None)
        actual = next((name for operation_value, name in operation_names
                       if operation_value == current_operation), None)
        if actual is None:
            raise ValueError('Current ' + operation_kind + ' operation is unsupported or unknown')
        if actual != expected:
            raise ValueError('Expected operation does not match current operation')
        if requested_operation != 'newBody' and not hasattr(type(feature), 'participantBodies'):
            raise ValueError('This SDK does not expose participantBodies for ' + operation_kind)
        operation_target = next((operation_value for operation_value, name in operation_names
                                 if name == requested_operation), None)
        if operation_target is None:
            raise ValueError('Requested operation is unavailable in this Fusion SDK: ' + requested_operation)
        operation_plan = {'kind': operation_kind, 'expected': expected, 'value': requested_operation,
                          'expectedResultBodyCount': expected_result_body_count,
                          'participants': participants, 'target': operation_target}
    name: str | None = None
    if 'name' in data:
        name_value = data['name']
        if not isinstance(name_value, str) or not name_value.strip():
            raise ValueError('Feature name must be nonempty')
        name = name_value
        if any(candidate.name == name for candidate in _cad_items(ctx.component.features) if candidate != feature):
            raise ValueError('Feature name collision: ' + name)
    resolved: list[tuple[JsonObject, _FeatureParameter, str]] = []
    if 'entries' in data:
        entries = _feature_json_array(data['entries'], 'entries')
        if not entries:
            raise ValueError('entries must be a nonempty array')
        bindings, _ = _feature_bindings(ctx, feature)
        for entry_value in entries:
            entry = _feature_json_object(entry_value, 'feature parameter entry')
            _cad_fields(entry, ('expression',), ('name', 'role'))
            name_selector: str | None = None
            role_selector: str | None = None
            if 'name' in entry:
                name_value = entry['name']
                if not isinstance(name_value, str) or not name_value.strip():
                    raise ValueError('Entry name must be a nonempty string')
                name_selector = name_value
            if 'role' in entry:
                role_value = entry['role']
                if not isinstance(role_value, str) or not role_value.strip():
                    raise ValueError('Entry role must be a nonempty string')
                role_selector = role_value
            if name_selector is None and role_selector is None:
                raise ValueError('Each entry needs a name and/or role selector')
            expression_value = entry['expression']
            if not isinstance(expression_value, str) or not expression_value.strip():
                raise ValueError('Entry expression must be a nonempty string')
            expression = expression_value
            matches: list[tuple[JsonObject, _FeatureParameter]] = []
            for row, parameter in bindings:
                if name_selector is not None and row['name'] != name_selector:
                    continue
                if role_selector is not None and row['role'] != role_selector:
                    continue
                matches.append((row, parameter))
            if not matches:
                raise ValueError('No feature parameter matches the selector ' + _geometry_feature_json.dumps({k: v for k, v in entry.items() if k != 'expression'}))
            if len(matches) > 1:
                raise ValueError('Ambiguous role selector; supply the unique parameter name: ' + str(role_selector))
            row, parameter = matches[0]
            unit_value = row.get('unit')
            if unit_value is None:
                unit = None
            elif isinstance(unit_value, str):
                unit = unit_value if unit_value not in ('', 'text') else None
            else:
                raise ValueError('Feature parameter unit must be text')
            _geometry_feature_adapter_cast(_FeatureExpression, ctx).expression(expression, unit)
            resolved.append((row, parameter, expression))
    extent_plan: _FeatureExtentPlan | None = None
    extent_spec: JsonObject | None = None
    if 'extent' in data:
        extent_spec = _feature_json_object(data['extent'], 'extent')
        extent_plan = _feature_extent_plan(ctx, feature, before, extent_spec)
    projected = dict(before)
    projected_parameters: list[JsonValue] = []
    for parameter_value in _feature_json_array(before['parameters'], 'feature snapshot parameters'):
        parameter_row = _feature_json_object(parameter_value, 'feature snapshot parameter')
        projected_row = dict(parameter_row)
        for resolved_row, _, expression in resolved:
            if resolved_row is parameter_row:
                projected_row['expression'] = expression
                break
        projected_parameters.append(projected_row)
    projected['parameters'] = projected_parameters
    plan: JsonObject = {'applied': False, 'before': before, 'after': projected, 'atomic': False,
                        'requiresMarkerRoll': extent_plan is not None, 'steps': []}
    steps: list[JsonValue] = []
    if name is not None:
        steps.append({'kind': 'rename', 'name': name})
    for row, _, expression in resolved:
        steps.append({'kind': 'parameter', 'name': row['name'], 'role': row['role'],
                      'expression': expression})
    if extent_plan is not None:
        if extent_spec is None:
            raise RuntimeError('Validated extent plan has no spec')
        steps.append({'kind': 'extent', 'mode': extent_plan['mode'], 'data': extent_spec})
    plan['steps'] = steps
    if data.get('preview') is True:
        plan['preview'] = True
        return _feature_contract(ctx, 'feature.edit', plan, status='pass', associativity='snapshot')
    risky_confirmation = ((operation_plan is not None and operation_plan['kind'] != 'ExtrudeFeature'
                           and operation_plan['expected'] != operation_plan['value'])
                          or (extent_plan is not None and extent_plan['kind'] == 'HoleFeature'))
    if risky_confirmation and data.get('confirm') is not True:
        return _feature_contract(ctx, 'feature.edit', {'applied': False, 'before': before,
            'after': dict(before), 'plan': plan, 'reason': 'This native edit requires confirm:true',
            'mutation': False, 'skippedFields': [], 'unsupportedFields': []},
            status='blocked', associativity='snapshot')
    timeline = _geometry_feature_adapter_cast(_FeatureMutableTimeline, ctx.design.timeline)
    marker: int | None = timeline.markerPosition
    if operation_plan is not None and marker != timeline.count:
        raise ValueError('operationChange requires the timeline marker at the end')
    poses_before = _feature_operation_pose_snapshot(ctx) if operation_plan is not None else None
    rolled = False
    primary_error: Exception | None = None
    marker_restored = True
    applied: list[JsonValue] = []
    try:
        for row, parameter, expression in resolved:
            before_row: JsonObject = {'name': row['name'], 'role': row['role'], 'expression': row['expression'],
                                      'unit': row['unit'], 'value': row['value']}
            parameter.expression = expression
            applied.append({'name': row['name'], 'role': row['role'], 'before': before_row, 'requested': expression})
        if 'name' in data:
            if name is None:
                raise RuntimeError('Validated feature name was not retained')
            _geometry_feature_adapter_cast(_FeatureRename, feature).name = name
        if extent_plan is not None:
            rolled = True
            _cad_require_result(feature.timelineObject.rollTo(True), 'TimelineObject.rollTo')
            if extent_spec is None:
                raise RuntimeError('Validated extent spec was not retained')
            _feature_apply_extent(ctx, feature, extent_spec, extent_plan)
        if operation_plan is not None and operation_plan['expected'] != operation_plan['value']:
            rolled = True
            _cad_require_result(feature.timelineObject.rollTo(True), 'TimelineObject.rollTo')
            operation_target = operation_plan['target']
            if operation_target is None:
                raise ValueError('Requested extrude operation is unavailable in this SDK')
            mutable_feature = _geometry_feature_adapter_cast(_FeatureOperationMutable, feature)
            if operation_plan['value'] != 'newBody':
                mutable_feature.participantBodies = operation_plan['participants']
            mutable_feature.operation = operation_target
        if operation_plan is None or operation_plan['expected'] != operation_plan['value']:
            ctx.design.timeline.moveToEnd()
    except Exception as exc:
        primary_error = exc
    finally:
        restore_error = None
        if rolled:
            try:
                if operation_plan is not None:
                    timeline.markerPosition = marker
                else:
                    ctx.design.timeline.moveToEnd()
                marker_restored = (timeline.markerPosition == marker
                                   if operation_plan is not None else True)
                if not marker_restored:
                    raise RuntimeError('Timeline marker readback did not match captured position')
            except Exception as exc:
                restore_error = str(exc)
                marker_restored = False
        elif operation_plan is not None:
            marker_restored = timeline.markerPosition == marker
    if primary_error is not None:
        message = str(primary_error)
        if restore_error:
            message += '; timeline marker restore failed: ' + restore_error
        if operation_plan is not None and operation_plan['kind'] != 'ExtrudeFeature':
            after = _feature_snapshot(ctx, feature)
            mutable_feature = _geometry_feature_adapter_cast(_FeatureOperationMutable, feature)
            current_operation = mutable_feature.operation
            actual = next((operation_name for operation_value, operation_name in operation_names
                           if operation_value == current_operation), None)
            bodies = [body for body in _cad_items(ctx.component.bRepBodies) if body.isSolid]
            identity_ok = ctx.resolve(data['feature'], 'feature') == feature
            poses_after = _feature_operation_pose_snapshot(ctx)
            poses_preserved = (poses_before is not None and poses_after is not None and
                               [(row[0], row[1]) for row in poses_before] == [(row[0], row[1]) for row in poses_after])
            operation_error_result: JsonObject = {'actualOperation': actual, 'directSolidBodyCount': len(bodies),
                                'featureIdentityPreserved': identity_ok,
                                'health': int(_geometry_feature_adapter_cast(int, feature.healthState)),
                                'markerRestored': marker_restored, 'posesPreserved': poses_preserved,
                                'expectedResultBodyCount': operation_plan['expectedResultBodyCount']}
            operation_error_contract: JsonObject = {'applied': True, 'before': before, 'after': after,
                      'operationChange': operation_error_result,
                      'primaryError': str(primary_error), 'restoreError': restore_error,
                      'markerRestored': marker_restored, 'posesPreserved': poses_preserved,
                      'featureIdentityPreserved': identity_ok, 'featureTypeBefore': before['type'],
                      'featureTypeAfter': after['type'], 'timelinePositionBefore': marker,
                      'timelinePositionAfter': getattr(ctx.design.timeline, 'markerPosition', None),
                      'directSolidBodyCount': len(bodies),
                      'health': int(_geometry_feature_adapter_cast(int, feature.healthState)),
                      'skippedFields': [], 'unsupportedFields': [], 'partialEffectsUnknown': True,
                      'atomic': False, 'geometryDeleted': False, 'affected': [ctx.ref(feature)]}
            if restore_error:
                operation_error_contract['warnings'] = ['timeline marker restore failed: ' + restore_error]
            return _feature_contract(ctx, 'feature.edit', operation_error_contract,
                                     status='fail', associativity='nativeExpression')
        if extent_plan is not None and extent_plan['kind'] in ('RevolveFeature', 'HoleFeature'):
            try:
                after = _feature_snapshot(ctx, feature)
            except Exception as read_error:
                after = {'status': 'unknown', 'error': str(read_error)}
            extent_error_result: JsonObject = {'applied': True, 'before': before, 'after': after, 'plan': plan,
                      'primaryError': str(primary_error), 'restoreError': restore_error,
                      'markerRestored': marker_restored, 'timelinePositionBefore': marker,
                      'timelinePositionAfter': getattr(ctx.design.timeline, 'markerPosition', None),
                      'featureTypeBefore': before.get('type'), 'featureTypeAfter': after.get('type'),
                      'featureIdentityPreserved': ctx.resolve(data['feature'], 'feature') == feature,
                      'health': int(_geometry_feature_adapter_cast(int, feature.healthState)),
                      'skippedFields': [], 'unsupportedFields': [],
                      'partialEffectsUnknown': True, 'atomic': False, 'geometryDeleted': False,
                      'affected': [ctx.ref(feature)]}
            return _feature_contract(ctx, 'feature.edit', extent_error_result,
                                     status='fail', associativity='nativeExpression')
        raise RuntimeError('feature.edit failed; no feature was deleted, partial changes may remain: ' + message) from primary_error
    after = _feature_snapshot(ctx, feature)
    conflicts: list[JsonValue] = []
    after_parameters = _feature_json_array(after.get('parameters'), 'feature snapshot parameters')
    for entry in applied:
        applied_entry = _feature_json_object(entry, 'applied feature edit')
        applied_name = _feature_json_text(applied_entry, 'name', 'Applied feature parameter name')
        applied_role = _feature_json_text(applied_entry, 'role', 'Applied feature parameter role')
        requested_expression = _feature_json_text(applied_entry, 'requested', 'Requested parameter expression')
        current: JsonObject | None = None
        for row_value in after_parameters:
            row = _feature_json_object(row_value, 'feature parameter snapshot')
            if row.get('name') == applied_name and row.get('role') == applied_role:
                current = row
                break
        actual_value = current.get('expression') if current is not None else None
        if (not isinstance(actual_value, str)
                or _geometry_feature_re.sub(r'\s+', '', actual_value)
                != _geometry_feature_re.sub(r'\s+', '', requested_expression)):
            conflicts.append({'name': applied_name, 'role': applied_role,
                              'requested': requested_expression,
                              'actual': actual_value if isinstance(actual_value, str) else None})
    downstream = _feature_downstream(ctx, feature)
    if conflicts or downstream['status'] == 'fail' or _geometry_feature_adapter_cast(int, feature.healthState) != 0:
        status = 'fail'
    else:
        status = 'pass'
    identity_preserved = ctx.resolve(data['feature'], 'feature') == feature
    if not identity_preserved:
        status = 'fail'
    warnings: list["JsonValue"] = []
    result: JsonObject = {'applied': True, 'before': before, 'after': after, 'plan': plan, 'conflicts': conflicts,
              'downstream': downstream, 'markerRestored': marker_restored, 'atomic': False,
              'geometryDeleted': False, 'affected': [ctx.ref(feature)],
              'featureTypeBefore': before['type'], 'featureTypeAfter': after.get('type'),
              'timelinePositionBefore': marker,
              'timelinePositionAfter': getattr(ctx.design.timeline, 'markerPosition', None),
              'featureIdentityPreserved': identity_preserved, 'skippedFields': [], 'unsupportedFields': [],
              'warnings': warnings}
    if feature.errorOrWarningMessage:
        warnings.append(feature.errorOrWarningMessage)
    if restore_error:
        warnings.append('timeline marker restore failed: ' + restore_error)
    if operation_plan is not None:
        mutable_feature = _geometry_feature_adapter_cast(_FeatureOperationMutable, feature)
        current_operation = mutable_feature.operation
        actual = next((operation_name for operation_value, operation_name in operation_names
                       if operation_value == current_operation), None)
        bodies = [body for body in _cad_items(ctx.component.bRepBodies) if body.isSolid]
        identity_ok = ctx.resolve(data['feature'], 'feature') == feature
        poses_after = _feature_operation_pose_snapshot(ctx)
        poses_preserved = (poses_before is not None and poses_after is not None and
                           [(row[0], row[1]) for row in poses_before] == [(row[0], row[1]) for row in poses_after])
        if (actual != operation_plan['value'] or len(bodies) != operation_plan['expectedResultBodyCount']
                or not identity_ok or not poses_preserved or not marker_restored
                or _geometry_feature_adapter_cast(int, feature.healthState) != 0):
            status = 'fail'
        result.update(operationChange={'actualOperation': actual, 'directSolidBodyCount': len(bodies),
            'featureIdentityPreserved': identity_ok,
            'health': int(_geometry_feature_adapter_cast(int, feature.healthState)),
            'markerRestored': marker_restored, 'posesPreserved': poses_preserved,
            'expectedResultBodyCount': operation_plan['expectedResultBodyCount']})
    return _feature_contract(ctx, 'feature.edit', result, status=status, associativity='nativeExpression')
