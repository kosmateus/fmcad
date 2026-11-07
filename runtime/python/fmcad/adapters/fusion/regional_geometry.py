"""Fusion port: exact solid refs, copied Boolean operands, no model writes.

Composed after the retained measure adapter. No parallel comparator/store.
None and exact zero-volume output represent no positive-volume finite set for
this proof; an invalid native body is never assumed empty.
"""
import copy as _regional_copy
import math as _regional_fusion_math
from typing import TYPE_CHECKING as _REGIONAL_FUSION_TYPE_CHECKING
from typing import Literal as _RegionalFusionLiteral, Protocol as _RegionalFusionProtocol
from typing import TypedDict as _RegionalFusionTypedDict, cast as _regional_fusion_cast


if _REGIONAL_FUSION_TYPE_CHECKING:
    class _RegionalDataFile(_RegionalFusionProtocol):
        id: str | None
        versionNumber: int | None

    class _RegionalSourceBody(_RegionalFusionProtocol):
        isSolid: bool
        isValid: bool
        entityToken: str | None
        revisionId: str | None
        nativeObject: adsk.core.Base | None

    class _RegionalBoundingBox(_RegionalFusionProtocol):
        minPoint: adsk.core.Point3D
        maxPoint: adsk.core.Point3D

    class _RegionalRead(_RegionalFusionTypedDict):
        entity: CadEntity
        reference: JsonValue
        entityToken: str
        revisionId: str
        frame: JsonObject | str
        transform: list[int | float]


class RegionalGeometryFusionPort:
    def __init__(self, ctx: "CadContext") -> None:
        self.ctx = ctx
        self.manager = adsk.fusion.TemporaryBRepManager.get()
        self.reads: list[_RegionalRead] = []
        self.document: "adsk.core.Document" = ctx.doc
        self.initial_identity = self._identity()

    def _identity(self) -> "JsonRecord":
        file_value: object = getattr(self.document, 'dataFile', None)
        file = _regional_fusion_cast('_RegionalDataFile | None', file_value)
        return {'name': self.document.name,
                'fileId': file.id if file is not None else None,
                'version': file.versionNumber if file is not None else None,
                'isModified': bool(_regional_fusion_cast(
                    'bool', getattr(self.document, 'isModified', False)))}

    def identity(self) -> "JsonRecord":
        self.verify()
        return self.initial_identity.copy()

    def read(self, ref: "JsonValue", frame: "JsonValue") -> "_MeasureTemporaryBody":
        entity = self.ctx.resolve(ref, 'body')
        source_body = _regional_fusion_cast('_RegionalSourceBody', entity)
        if not source_body.isSolid or source_body.isValid is not True:
            raise RegionalGeometryUnavailable('incomplete-input', 'Regional input must be a valid finite solid')
        token = source_body.entityToken
        if not isinstance(token, str) or not token:
            raise RegionalGeometryUnavailable('missing-provenance', 'Regional body requires a native entity token')
        revision = source_body.revisionId
        if not isinstance(revision, str) or not revision:
            raise RegionalGeometryUnavailable('missing-provenance', 'Regional body requires a native revisionId')
        temporary = _measure_temporary_body(self.ctx, ref, frame)
        if self.reads and self.reads[0]['frame'] != temporary.frame:
            raise RegionalGeometryUnavailable('frame-mismatch', 'All regional operands must share one explicit frame')
        read: _RegionalRead = {
            'entity': entity, 'reference': _regional_copy.deepcopy(ref), 'entityToken': token,
            'revisionId': revision, 'frame': _regional_copy.deepcopy(temporary.frame),
            'transform': list(temporary.transform)}
        self.reads.append(read)
        return temporary

    def _copy(self, value: "_MeasureTemporaryBody") -> "_MeasureTemporaryBody":
        if value.body.isValid is not True:
            raise RegionalGeometryUnavailable('invalid-body', 'Invalid temporary BRep is not an empty-set proof')
        def copy_body(source: "adsk.fusion.BRepBody") -> "adsk.fusion.BRepBody | None":
            return self.manager.copy(source)

        body = copy_body(value.body)
        if body is None or body.isValid is not True:
            raise RegionalGeometryUnavailable('kernel-failure', 'Temporary regional copy failed')
        return _MeasureTemporaryBody(body, value.frame, list(value.transform))

    def _volume(self, value: "_MeasureTemporaryBody | None") -> float:
        if value is None:
            return 0.0
        if value.body.isValid is not True:
            raise RegionalGeometryUnavailable('invalid-body', 'Invalid BRep cannot certify emptiness')
        return regional_geometry_nonnegative(float(value.body.volume))

    def boolean(self, left: "object | None", right: "object | None",
                operation: str) -> "_MeasureTemporaryBody | None":
        if operation not in ('union', 'difference', 'intersection'):
            raise ValueError('Unknown regional Boolean operation')
        left_body = _regional_fusion_cast('_MeasureTemporaryBody', left) if left is not None else None
        right_body = _regional_fusion_cast('_MeasureTemporaryBody', right) if right is not None else None
        if left_body is None:
            if operation == 'intersection' or operation == 'difference' or right_body is None:
                return None
            return self._copy(right_body)
        if right_body is None:
            if operation == 'intersection':
                return None
            return self._copy(left_body)
        target, tool = self._copy(left_body), self._copy(right_body)
        kinds = adsk.fusion.BooleanTypes
        kind = _regional_fusion_cast('adsk.fusion.BooleanTypes', {
            'union': kinds.UnionBooleanType, 'difference': kinds.DifferenceBooleanType,
            'intersection': kinds.IntersectionBooleanType}[operation])
        if self.manager.booleanOperation(target.body, tool.body, kind) is not True:
            raise RegionalGeometryUnavailable('kernel-failure', 'Regional temporary Boolean failed')
        # Do not inherit the comparator's invalid-body-as-empty heuristic.
        # Until qualified natively an invalid result remains unknown.
        volume = self._volume(target)
        return None if volume == 0 else target

    def describe(self, body: "object | None") -> "JsonRecord":
        value = _regional_fusion_cast('_MeasureTemporaryBody', body) if body is not None else None
        volume = self._volume(value)
        if volume == 0:
            return {'empty': True, 'volume': 0.0, 'bounds': None}
        if value is None:
            raise RegionalGeometryUnavailable('invalid-measurement', 'Nonempty regional volume has no body')
        box = _regional_fusion_cast('_RegionalBoundingBox', value.body.boundingBox)
        bounds: list[list[float]] = [
            [float(point.x), float(point.y), float(point.z)]
            for point in (box.minPoint, box.maxPoint)]
        if any(not _regional_fusion_math.isfinite(number) for point in bounds for number in point):
            raise RegionalGeometryUnavailable('invalid-measurement', 'Non-finite regional bounds')
        return {'empty': False, 'volume': volume, 'bounds': bounds}

    def compare(self, before: object, after: object,
                frame: "JsonValue") -> "JsonRecord":
        before_body = _regional_fusion_cast('_MeasureTemporaryBody', before)
        after_body = _regional_fusion_cast('_MeasureTemporaryBody', after)
        return _measure_compare_bodies(self.ctx, before_body, after_body, frame,
                                       '0 cm^3', '0 cm', '0 rad')

    def verify(self) -> None:
        if hasattr(self.ctx, 'assert_identity'):
            self.ctx.assert_identity()
        if (_regional_fusion_cast('bool', getattr(self.document, 'isValid', False)) is not True or
                self.ctx.doc != self.document or self._identity() != self.initial_identity):
            raise RegionalGeometryUnavailable('stale', 'Regional document identity changed')
        for row in self.reads:
            entity = row['entity']
            if self.ctx.resolve(row['reference'], 'body') != entity:
                raise RegionalGeometryUnavailable('stale', 'Regional reference resolved to a different body')
            source_body = _regional_fusion_cast('_RegionalSourceBody', entity)
            if (source_body.isValid is not True or not source_body.isSolid or
                    source_body.entityToken != row['entityToken'] or
                    source_body.revisionId != row['revisionId']):
                raise RegionalGeometryUnavailable('stale', 'Regional body identity changed')
            frame = _measure_frame(self.ctx, entity, row['frame'])
            if list(_measure_transform_values(entity, frame)) != row['transform']:
                raise RegionalGeometryUnavailable('stale', 'Regional occurrence transform changed')

    def provenance(self) -> "list[JsonRecord]":
        return [{'reference': row['reference'], 'entityToken': row['entityToken'],
                 'revisionId': row['revisionId'], 'frame': row['frame'], 'transform': row['transform'],
                 'ownership': 'read-only source; private temporary BRep copy'} for row in self.reads]


def regional_geometry_fusion_handler(ctx: "CadContext", data: "JsonObject", operation: str) -> "JsonRecord":
    # Construction can fail before the application obtains its port.
    regional_geometry_request(data, operation)
    try:
        port = RegionalGeometryFusionPort(ctx)
    except Exception as exc:
        result = regional_geometry_contract(operation, data['frame'])
        result.update(reason='kernel-or-input-failure', message=str(exc))
        return result
    return regional_geometry_compare(data, port, operation)


def regional_geometry_register(registry: "HandlerRegistry") -> None:
    """Called by the canonical application unit to register its public handlers."""
    def geometry_delta(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
        return regional_geometry_fusion_handler(ctx, data, 'geometry.delta')

    def geometry_compare_region(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
        return regional_geometry_fusion_handler(ctx, data, 'geometry.compare-region')

    registry.update({
        'geometry.delta': geometry_delta,
        'geometry.compare-region': geometry_compare_region,
    })
