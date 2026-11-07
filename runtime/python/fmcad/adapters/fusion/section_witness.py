"""Temporary BRep evidence. Reuses measure frame/copy policy, never document writes."""
import math as _section_witness_math
from typing import Protocol as _SectionWitnessProtocol, cast as _section_witness_cast
from typing import TYPE_CHECKING as _SECTION_WITNESS_TYPE_CHECKING


if _SECTION_WITNESS_TYPE_CHECKING:
    class _SectionWitnessOccurrence(_SectionWitnessProtocol):
        assemblyContext: adsk.fusion.Occurrence | None
        nativeObject: adsk.core.Base | None

    class _SectionWitnessNativeOccurrence(_SectionWitnessProtocol):
        nativeObject: adsk.fusion.Occurrence | None

def _section_witness_operands(ctx: "CadContext", refs: "Sequence[JsonValue]", frame: "JsonValue",
                              budget: "_SectionWitnessBudget") -> "tuple[JsonRecord, list[adsk.fusion.BRepBody]]":
    entities: list[adsk.fusion.BRepBody] = [ctx.resolve(ref, 'body') for ref in refs]
    actual = _measure_space(ctx, entities)
    _measure_frame_context(ctx, frame, actual)
    if any(not entity.isSolid for entity in entities):
        raise ValueError('Section/witness requires finite solid BRep bodies')
    # Existing helper performs copy plus optional assembly transform. Charge both
    # individually, rather than bypassing its validated occurrence/frame policy.
    manager = adsk.fusion.TemporaryBRepManager.get()
    bodies: list[adsk.fusion.BRepBody] = []
    for entity in entities:
        entity_context = _section_witness_cast('_SectionWitnessOccurrence', entity)
        native = entity_context.nativeObject or entity
        def copy_body(value: "adsk.core.Base") -> "adsk.fusion.BRepBody | None":
            return manager.copy(value)

        copied_body = budget.call(copy_body, native)
        if copied_body is None:
            raise RuntimeError('Temporary body copy failed')
        body = copied_body
        if not body.isValid:
            raise RuntimeError('Temporary body copy failed')
        occurrence = entity_context.assemblyContext
        if occurrence is not None:
            occurrence_transform = _section_witness_cast(
                '_SectionWitnessNativeOccurrence', occurrence).nativeObject
            transform_source = occurrence_transform if occurrence_transform is not None else occurrence
            if budget.call(manager.transform, body, transform_source.transform2) is not True:
                raise RuntimeError('Temporary body transform failed')
        bodies.append(body)
    return actual, bodies


def _section_witness_area(manager: "adsk.fusion.TemporaryBRepManager",
                          edges: "Sequence[adsk.fusion.BRepEdge]",
                          budget: "_SectionWitnessBudget") -> float:
    # Omit optional output/allowSelfIntersections arguments: Python wrappers
    # differ in their published optional signature; default is False.
    def create_wire(curves: "list[adsk.core.Curve3D]") -> "tuple[adsk.fusion.BRepBody | None, list[adsk.fusion.BRepEdge]] | None":
        wire_body, edge_map = manager.createWireFromCurves(curves)
        return wire_body, edge_map

    wire_result = budget.call(create_wire, [edge.geometry for edge in edges])
    if not wire_result or wire_result[0] is None or getattr(wire_result[0], 'isValid', True) is False:
        raise RuntimeError('Closed loop wire creation failed')
    def create_face(wire_bodies: "list[adsk.fusion.BRepBody]") -> "adsk.fusion.BRepBody | None":
        return manager.createFaceFromPlanarWires(wire_bodies)

    surface = budget.call(create_face, [wire_result[0]])
    if surface is None or not surface.isValid:
        raise RuntimeError('Closed loop area construction failed')
    value = _section_witness_number(surface.area, 'Loop area')
    if value <= 0:
        raise RuntimeError('Loop area is not positive')
    return value


def _section_witness_station(manager: "adsk.fusion.TemporaryBRepManager",
                             body: "adsk.fusion.BRepBody", plane: "adsk.core.Plane",
                             budget: "_SectionWitnessBudget") -> "JsonRecord":
    def plane_intersection(target_body: "adsk.fusion.BRepBody",
                           section_plane: "adsk.core.Plane") -> "adsk.fusion.BRepBody | None":
        return manager.planeIntersection(target_body, section_plane)

    wire = budget.call(plane_intersection, body, plane)
    if wire is None or not wire.isValid:
        raise RuntimeError('SDK returned no valid wire; empty or kernel failure is unknown')
    count = len(wire.edges) if isinstance(wire.edges, (list, tuple)) else wire.edges.count
    if count > budget.limits['edges']:
        raise RuntimeError('Section edge limit exceeded')
    edges = _cad_items(wire.edges)
    if not edges:
        raise RuntimeError('No section edges; not a verified empty section')
    def create_face(wire_bodies: "list[adsk.fusion.BRepBody]") -> "adsk.fusion.BRepBody | None":
        return manager.createFaceFromPlanarWires(wire_bodies)

    surface = budget.call(create_face, [wire])
    if surface is None or not surface.isValid:
        raise RuntimeError('Section does not form closed non-overlapping planar loops')
    loops: list[JsonRecord] = []
    for face in _cad_items(surface.faces):
        for loop in _cad_items(face.loops):
            loop_edges = _cad_items(loop.edges)
            area = _section_witness_area(manager, loop_edges, budget)
            curves = [_cad_geometry(edge.geometry) for edge in loop_edges]
            diameter: float | None = None
            if len(loop_edges) == 1 and _cad_type(loop_edges[0].geometry) == 'Circle3D':
                circle = _section_witness_cast('adsk.core.Circle3D', loop_edges[0].geometry)
                diameter = 2 * circle.radius
            loops.append({'role': 'outer' if loop.isOuter else 'inner', 'closed': True,
                          'area': area, 'diameter': diameter,
                          'equivalentAreaDiameter': _section_witness_math.sqrt(4 * area / _section_witness_math.pi),
                          'curves': curves})
    if not loops or sum(len(_cad_items(loop.edges)) for face in _cad_items(surface.faces)
                        for loop in _cad_items(face.loops)) != len(edges):
        raise RuntimeError('Section loop coverage is incomplete')
    area = _section_witness_number(surface.area, 'Section area')
    if area <= 0:
        raise RuntimeError('Section area is not positive')
    return {'status': 'complete', 'loops': loops, 'area': area,
            'equivalentAreaDiameter': _section_witness_math.sqrt(4 * area / _section_witness_math.pi)}


def _section_witness_boolean(manager: "adsk.fusion.TemporaryBRepManager",
                             bodies: "list[adsk.fusion.BRepBody]",
                             mode: "Literal['material', 'void']",
                             budget: "_SectionWitnessBudget") -> float:
    operation = _section_witness_cast(
        'adsk.fusion.BooleanTypes', adsk.fusion.BooleanTypes.DifferenceBooleanType if mode == 'material'
        else adsk.fusion.BooleanTypes.IntersectionBooleanType)
    # witness - material, or witness intersect material. Both operands already
    # are private temporary copies in one frame. No point classifier is used.
    target, tool = bodies[1], bodies[0]
    if budget.call(manager.booleanOperation, target, tool, operation) is not True:
        raise RuntimeError('Witness Boolean failed')
    # Some SDK empty results invalidate the body. This is deliberately unknown
    # until a native qualified empty-result contract can distinguish it from failure.
    if getattr(target, 'isValid', True) is False:
        raise RuntimeError('Boolean result invalid; empty result is not certified')
    return _section_witness_number(target.volume, 'Residual volume')
