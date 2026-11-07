"""Read-only Fusion adapter for sketch coordinate and native profile proofs."""
import time as _sketch_geometry_proof_time
from typing import Literal as _sketch_geometry_proof_Literal
from typing import Protocol as _sketch_geometry_proof_Protocol
from typing import TypeAlias as _sketch_geometry_proof_TypeAlias
from typing import cast as _sketch_geometry_proof_cast


class _SketchGeometryProofCenter(_sketch_geometry_proof_Protocol):
    @property
    def center(self) -> "adsk.core.Point3D": ...


class _SketchGeometryProofRadius(_sketch_geometry_proof_Protocol):
    @property
    def radius(self) -> float: ...


class _SketchGeometryProofWorld(_sketch_geometry_proof_Protocol):
    @property
    def worldGeometry(self) -> "adsk.core.Base": ...


class _SketchGeometryProofCurve(_sketch_geometry_proof_Protocol):
    @property
    def geometry(self) -> "adsk.core.Curve3D": ...

    def createForAssemblyContext(self, occurrence: "adsk.fusion.Occurrence") -> "adsk.core.Base": ...


class _SketchGeometryProofEndpoints(_sketch_geometry_proof_Protocol):
    @property
    def startSketchPoint(self) -> "adsk.fusion.SketchPoint": ...

    @property
    def endSketchPoint(self) -> "adsk.fusion.SketchPoint": ...


_SketchGeometryProofEntity: _sketch_geometry_proof_TypeAlias = (
    "adsk.fusion.SketchPoint | adsk.fusion.SketchCurve")


class SketchGeometryProofFusion:
    def __init__(self, ctx: "CadContext") -> None:
        self.ctx = ctx

    def _xyz(self, point: "adsk.core.Point3D") -> list[float]:
        return [point.x, point.y, point.z]

    def _point(self, value: "JsonValue") -> "adsk.core.Point3D":
        if not isinstance(value, list):
            raise ValueError('Expected three unit-bearing length expressions')
        coordinates = value
        if len(coordinates) != 3:
            raise ValueError('Expected three unit-bearing length expressions')
        if any(not isinstance(coordinate, str) or not coordinate.strip() for coordinate in coordinates):
            raise ValueError('Coordinate values must be nonempty length expressions')
        return self.ctx.point(_sketch_geometry_proof_cast(list[str], coordinates))

    def _length(self, value: "JsonValue", name: str, positive: bool = True) -> float:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(name + ' must be a length expression')
        return proof_number(self.ctx.length(value), name, positive)

    def _area(self, value: "JsonValue", name: str) -> float:
        return proof_number(value, name, True)

    def _target(self, data: "JsonObject") -> "adsk.fusion.Sketch":
        if type(data.get('schemaVersion')) is not int or data.get('schemaVersion') != 1:
            raise ValueError('Sketch proof requires schemaVersion 1')
        self.ctx.assert_identity()
        return _sketch_target(self.ctx, data['sketch'])

    def _result(self, sketch: "adsk.fusion.Sketch", operation: str,
                geometry_status: str, **extra: "JsonValue") -> "JsonObject":
        health_state = int(_sketch_geometry_proof_cast('int', sketch.healthState))
        health = 'pass' if health_state == adsk.fusion.FeatureHealthStates.HealthyFeatureHealthState else 'fail'
        sampled = extra.get('sampled')
        sampled_requested = not (
            isinstance(sampled, dict) and sampled.get('status') == 'notRequested')
        status = proof_status([health, geometry_status])
        result: JsonObject = {
            'schemaVersion': 1,
            'operation': operation,
            'status': status,
            'success': status == 'pass',
            'evidenceStatus': 'partial' if status == 'pass' and sampled_requested else status,
            'precision': 'sampled' if sampled_requested else 'analytic',
            'healthStatus': health,
            'geometryStatus': geometry_status,
            'documentIdentity': _sketch_identity(self.ctx),
            'sketch': self.ctx.ref(sketch),
            'units': {'length': 'cm', 'area': 'cm^2', 'angle': 'rad'},
            'frame': {
                'space': 'sketch',
                'model': 'native component',
                'world': 'root component via explicit occurrence or root-native sketch',
            },
            'associativity': 'snapshot',
            'affected': [],
            'warnings': [],
            'method': 'Read-only Fusion sketch, profile and evaluator APIs',
            'limitations': [
                'Offline doubles do not qualify native geometry.',
                'Containment, gaps, branches and duplicate strokes are sampled, not a continuous analytic certificate.',
                'No solve, recompute, repair, mutation or implicit profile selection is performed.',
            ],
        }
        result.update(extra)
        return result

    def _expectations(self, values: "JsonValue", brep: bool = False) -> list["JsonObject"]:
        if not isinstance(values, list) or not values or len(values) > 256:
            raise ValueError('expectations must contain 1..256 items')
        result: list[JsonObject] = []
        for value in values:
            proof_fields(value, ('entity',),
                         ('frame', 'point', 'center', 'start', 'end', 'radius', 'diameter'))
            if not isinstance(value, dict):
                raise ValueError('Each expectation must be an object')
            expectation = value
            default_frame = 'model' if brep else 'sketch'
            frame_value = expectation.get('frame', default_frame)
            if not isinstance(frame_value, str):
                raise ValueError('Expectation frame must be text')
            frame = frame_value
            allowed_frames = ('model',) if brep else ('sketch', 'model', 'world')
            if frame not in allowed_frames:
                raise ValueError('Invalid expectation frame')
            normalized: JsonObject = {'entity': expectation['entity'], 'frame': frame}
            for key in ('point', 'center', 'start', 'end'):
                if key in expectation:
                    normalized[key] = self._xyz(self._point(expectation[key]))
            for key in ('radius', 'diameter'):
                if key in expectation:
                    normalized[key] = self._length(expectation[key], key)
            if len(normalized) == 2:
                raise ValueError('An expectation requires a point, center, endpoint or dimension')
            result.append(normalized)
        return result

    def _point_property(self, geometry: object, key: str) -> "adsk.core.Point3D | None":
        if key == 'point':
            return geometry if isinstance(geometry, adsk.core.Point3D) else None
        if key == 'center':
            if not hasattr(geometry, 'center'):
                return None
            return _sketch_geometry_proof_cast('_SketchGeometryProofCenter', geometry).center
        return None

    def _curve_endpoint(self, entity: _SketchGeometryProofEntity,
                        key: _sketch_geometry_proof_Literal['start', 'end']) -> "adsk.fusion.SketchPoint | None":
        if not hasattr(entity, 'startSketchPoint') or not hasattr(entity, 'endSketchPoint'):
            return None
        endpoints = _sketch_geometry_proof_cast('_SketchGeometryProofEndpoints', entity)
        return endpoints.startSketchPoint if key == 'start' else endpoints.endSketchPoint

    def _world_geometry(self, entity: _SketchGeometryProofEntity,
                        occurrence: "adsk.fusion.Occurrence | None") -> "adsk.core.Base | None":
        proxy: adsk.core.Base = entity
        if occurrence is not None:
            if isinstance(entity, adsk.fusion.SketchPoint):
                proxy = entity.createForAssemblyContext(occurrence)
            elif hasattr(entity, 'createForAssemblyContext'):
                proxy = _sketch_geometry_proof_cast('_SketchGeometryProofCurve', entity).createForAssemblyContext(occurrence)
            else:
                return None
        if not hasattr(proxy, 'worldGeometry'):
            return None
        return _sketch_geometry_proof_cast('_SketchGeometryProofWorld', proxy).worldGeometry

    def _curve_geometry(self, entity: "adsk.fusion.SketchCurve") -> "adsk.core.Curve3D":
        if not hasattr(entity, 'geometry'):
            raise ValueError('Sketch curve geometry is unavailable')
        return _sketch_geometry_proof_cast('_SketchGeometryProofCurve', entity).geometry

    def _root_point(self, model_point: "adsk.core.Point3D",
                    occurrence: "adsk.fusion.Occurrence | None") -> "adsk.core.Point3D":
        point = _cad_require_result(model_point.copy(), 'Point3D.copy')
        if occurrence is not None and not point.transformBy(occurrence.transform2):
            raise ValueError('Occurrence world transform failed')
        return point

    def _coordinate_entity(self, sketch: "adsk.fusion.Sketch", expected: "JsonObject",
                           occurrence: "adsk.fusion.Occurrence | None",
                           tolerance: float) -> "JsonObject":
        entity_value = expected['entity']
        entity = self.ctx.resolve(entity_value)
        if isinstance(entity, adsk.fusion.SketchPoint):
            sketch_entity: _SketchGeometryProofEntity = entity
        elif isinstance(entity, adsk.fusion.SketchCurve):
            sketch_entity = entity
        else:
            raise ValueError('Coordinate expectation must select a sketch point or curve')
        if sketch_entity.parentSketch != sketch:
            raise ValueError('Coordinate expectation entity belongs to a different sketch')
        frame_value = expected['frame']
        if not isinstance(frame_value, str):
            raise ValueError('Expectation frame must be text')
        frame = frame_value
        world_geometry = self._world_geometry(sketch_entity, occurrence)
        checks: list[JsonObject] = []
        coordinates: JsonObject = {}
        for key in ('point', 'center', 'start', 'end', 'radius', 'diameter'):
            if key not in expected:
                continue
            wanted = expected[key]
            if key in ('radius', 'diameter'):
                geometry = (sketch_entity.geometry if isinstance(sketch_entity, adsk.fusion.SketchPoint)
                            else self._curve_geometry(sketch_entity))
                radius = self._radius(geometry)
                world_radius = self._radius(world_geometry) if world_geometry is not None else None
                multiplier = 2.0 if key == 'diameter' else 1.0
                actual = radius * multiplier if radius is not None else None
                native_world = world_radius * multiplier if world_radius is not None else None
                checks.append(proof_compare(key, actual, wanted, tolerance))
                checks.append(proof_compare('worldGeometry.' + key, native_world, wanted, tolerance))
                continue
            if key == 'start' or key == 'end':
                endpoint = self._curve_endpoint(sketch_entity, key)
                native_point = endpoint.geometry if endpoint is not None else None
                native_world_point = endpoint.worldGeometry if endpoint is not None else None
            else:
                geometry = (sketch_entity.geometry if isinstance(sketch_entity, adsk.fusion.SketchPoint)
                            else self._curve_geometry(sketch_entity))
                native_point = self._point_property(geometry, key)
                native_world_point = (self._point_property(world_geometry, key)
                                      if world_geometry is not None else None)
            if native_point is None:
                checks.append(proof_compare(key, None, wanted, tolerance))
                checks.append(proof_compare(key + '.worldGeometry', None, None, tolerance))
                continue
            model_point = sketch.sketchToModelSpace(native_point)
            roundtrip = sketch.modelToSketchSpace(model_point)
            world_point = self._root_point(model_point, occurrence)
            native_world = self._xyz(native_world_point) if native_world_point is not None else None
            frames: JsonObject = {
                'sketch': self._xyz(native_point),
                'model': self._xyz(model_point),
                'world': self._xyz(world_point),
                'nativeWorldGeometry': native_world,
                'roundtrip': self._xyz(roundtrip),
            }
            coordinates[key] = frames
            checks.extend([
                proof_compare(key, frames[frame], wanted, tolerance),
                proof_compare(key + '.roundtrip', frames['roundtrip'], frames['sketch'], tolerance),
                proof_compare(key + '.worldGeometry', native_world, frames['world'], tolerance),
            ])
        return {'entity': entity_value, 'frame': frame, 'coordinates': coordinates,
                'status': proof_status(str(check['status']) for check in checks), 'checks': checks}

    def _radius(self, geometry: object) -> float | None:
        if not hasattr(geometry, 'radius'):
            return None
        return _sketch_geometry_proof_cast('_SketchGeometryProofRadius', geometry).radius

    def _brep_body(self, entity: "adsk.core.Base") -> "adsk.fusion.BRepBody | None":
        if isinstance(entity, adsk.fusion.BRepEdge):
            return entity.body
        if isinstance(entity, adsk.fusion.BRepFace):
            return entity.body
        if isinstance(entity, adsk.fusion.BRepVertex):
            return entity.body
        return None

    def _brep_geometry(self, entity: "adsk.core.Base") -> "adsk.core.Base | None":
        if isinstance(entity, adsk.fusion.BRepEdge):
            return entity.geometry
        if isinstance(entity, adsk.fusion.BRepFace):
            return entity.geometry
        if isinstance(entity, adsk.fusion.BRepVertex):
            return entity.geometry
        return None

    def _brep_point(self, entity: "adsk.core.Base", key: str) -> "adsk.core.Point3D | None":
        if key == 'point' and isinstance(entity, adsk.fusion.BRepVertex):
            return entity.geometry
        if key == 'center':
            geometry = self._brep_geometry(entity)
            return self._point_property(geometry, 'center') if geometry is not None else None
        if key in ('start', 'end') and isinstance(entity, adsk.fusion.BRepEdge):
            vertex = entity.startVertex if key == 'start' else entity.endVertex
            return vertex.geometry
        return None

    def _feature_brep(self, spec: "JsonValue", tolerance: float) -> "JsonObject":
        proof_fields(spec, ('feature', 'expectations'))
        if not isinstance(spec, dict):
            raise ValueError('featureBRep must be an object')
        data = spec
        expected_values = data['expectations']
        expectations = self._expectations(expected_values, brep=True)
        feature = self.ctx.resolve(data['feature'], 'feature')
        if getattr(feature, 'assemblyContext', None) is not None:
            raise ValueError('Feature BRep proof requires native component/model coordinates')
        bodies = _cad_items(feature.bodies)
        results: list[JsonObject] = []
        for expected in expectations:
            entity_ref = expected['entity']
            entity = self.ctx.resolve(entity_ref)
            body = self._brep_body(entity)
            belongs = (body is not None and body in bodies and body.parentComponent == self.ctx.component)
            checks: list[JsonObject] = [
                {'check': 'featureOwnsBRep', 'status': 'pass' if belongs else 'fail',
                 'method': 'nativeTopology'}
            ]
            for key in ('point', 'center', 'start', 'end', 'radius', 'diameter'):
                if key not in expected:
                    continue
                wanted = expected[key]
                if key in ('radius', 'diameter'):
                    geometry = self._brep_geometry(entity)
                    radius = self._radius(geometry) if geometry is not None else None
                    multiplier = 2.0 if key == 'diameter' else 1.0
                    actual = radius * multiplier if radius is not None else None
                else:
                    point = self._brep_point(entity, key)
                    actual = self._xyz(point) if point is not None else None
                checks.append(proof_compare(key, actual, wanted, tolerance))
            results.append({'entity': entity_ref, 'checks': checks,
                            'status': proof_status(str(check['status']) for check in checks)})
        return {'status': proof_status(str(result['status']) for result in results),
                'feature': data['feature'], 'frame': 'model', 'entities': results,
                'method': 'Explicit feature body membership and native component BRep readback'}

    def coordinate_check(self, data: "JsonObject") -> "JsonObject":
        proof_fields(data, ('schemaVersion', 'sketch', 'expectations'),
                     ('tolerance', 'occurrence', 'featureBRep'))
        sketch = self._target(data)
        tolerance = self._length(data.get('tolerance', '0.001 mm'), 'tolerance')
        expectations = self._expectations(data['expectations'])
        occurrence: adsk.fusion.Occurrence | None = None
        if 'occurrence' in data:
            occurrence = self.ctx.resolve(data['occurrence'], 'occurrence')
            if occurrence.component != sketch.parentComponent:
                raise ValueError('Occurrence must instance the sketch component')
        elif sketch.parentComponent != self.ctx.root:
            raise ValueError('A non-root native sketch requires an explicit occurrence for world proof')
        entities = [self._coordinate_entity(sketch, expected, occurrence, tolerance)
                    for expected in expectations]
        feature_value = data.get('featureBRep')
        feature = self._feature_brep(feature_value, tolerance) if feature_value is not None else None
        geometry_status = proof_status(
            [str(entity['status']) for entity in entities] +
            ([str(feature['status'])] if feature is not None else []))
        return self._result(sketch, 'sketch.coordinate-check', geometry_status,
                            analytic={'status': geometry_status, 'entities': entities,
                                      'featureBRep': feature},
                            sampled={'status': 'notRequested'}, tolerance=tolerance)

    def _limits(self, data: "JsonObject") -> tuple[float, int, float]:
        tolerance = self._length(data.get('tolerance', '0.001 mm'), 'tolerance')
        maximum, budget = data.get('maxSamples', 2000), data.get('budgetMs', 10000)
        if (type(maximum) is not int or not 2 <= maximum <= 10000 or
                type(budget) is not int or not 1 <= budget <= 120000):
            raise ValueError('Invalid sketch proof work budget')
        return tolerance, maximum, _sketch_geometry_proof_time.monotonic() + budget / 1000

    def _sample(self, entities: list["adsk.core.Base"], limits: tuple[float, int, float],
                consumed: list[int]) -> "JsonObject":
        tolerance, maximum, deadline = limits
        if _sketch_geometry_proof_time.monotonic() > deadline:
            raise ValueError('Sketch proof budget exceeded')
        evidence = _curve_evidence(self.ctx, entities, tolerance, maximum-consumed[0], deadline)
        consumed[0] += int(_sketch_geometry_proof_cast(int, evidence['strokeCount']))
        return evidence

    def _profile(self, profile: "adsk.fusion.Profile", index: int,
                 limits: tuple[float, int, float], consumed: list[int]) -> "JsonObject":
        result: JsonObject = {
            'index': index, 'area': None, 'centroid': None, 'outerLoops': None,
            'innerLoops': None, 'topologyStatus': 'unknown', 'integralStatus': 'unknown',
            'sampledTopologyStatus': 'unknown', 'boundaries': [], 'loops': [],
        }
        try:
            accuracy = _sketch_geometry_proof_cast(
                'adsk.fusion.CalculationAccuracy',
                adsk.fusion.CalculationAccuracy.HighCalculationAccuracy,
            )
            properties = profile.areaProperties(accuracy)
            area = proof_number(properties.area, 'native area')
            result['area'] = area
            result['centroid'] = self._xyz(properties.centroid)
            result['integralStatus'] = 'pass' if area > 0 else 'fail'
            native_loops = _cad_items(profile.profileLoops)
            if not native_loops:
                return result
            outer_count = 0
            boundaries: list[JsonValue] = []
            loop_results: list[JsonObject] = []
            for loop_index, loop in enumerate(native_loops):
                outer_count += int(loop.isOuter)
                profile_curves = _cad_items(loop.profileCurves)
                if not profile_curves:
                    return result
                curve_entities = _sketch_geometry_proof_cast(list[adsk.core.Base], profile_curves)
                evidence = self._sample(curve_entities, limits, consumed)
                topology = proof_topology(evidence, limits[0])
                boundaries.append(evidence['polylines'])
                loop_result: JsonObject = {'isOuter': loop.isOuter}
                loop_result.update(topology)
                loop_result['index'] = loop_index
                loop_results.append(loop_result)
            result['outerLoops'] = outer_count
            result['innerLoops'] = len(native_loops) - outer_count
            result['topologyStatus'] = 'pass' if outer_count == 1 else 'fail'
            result['sampledTopologyStatus'] = proof_status(str(loop['status']) for loop in loop_results)
            result['boundaries'] = boundaries
            result['loops'] = _sketch_geometry_proof_cast(list[JsonValue], loop_results)
        except (AttributeError, RuntimeError):
            return result
        return result

    def profile_query(self, data: "JsonObject") -> "JsonObject":
        proof_fields(data, ('schemaVersion', 'sketch'),
                     ('query', 'expected', 'tolerance', 'areaTolerance', 'maxSamples', 'budgetMs'))
        sketch = self._target(data)
        limits = self._limits(data)
        area_tolerance = self._area(data.get('areaTolerance', 0.000001), 'areaTolerance')
        query_value = data.get('query', {})
        proof_fields(query_value, (), ('index', 'area', 'centroid', 'contains', 'outerLoops', 'innerLoops'))
        if not isinstance(query_value, dict):
            raise ValueError('query must be an object')
        query = query_value
        normalized_query: JsonObject = {}
        for key, value in query.items():
            if key == 'index' or key in ('outerLoops', 'innerLoops'):
                normalized_query[key] = proof_count(value, key)
            elif key == 'area':
                normalized_query[key] = self._area(value, 'area')
            elif key == 'centroid' or key == 'contains':
                normalized_query[key] = self._xyz(self._point(value))
        expected_value = data.get('expected', {})
        proof_fields(expected_value, (), ('profiles', 'loops', 'outerLoops', 'innerLoops'))
        if not isinstance(expected_value, dict):
            raise ValueError('expected must be an object')
        expected_counts: JsonObject = {}
        for key, value in expected_value.items():
            expected_counts[key] = proof_count(value, key)
        consumed = [0]
        sketch_curves = [curve for curve in _cad_items(sketch.sketchCurves) if not curve.isConstruction]
        if len(sketch_curves) > 256:
            raise ValueError('Sketch proof supports at most 256 curves')
        sampled: JsonObject
        if sketch_curves:
            curve_entities = _sketch_geometry_proof_cast(list[adsk.core.Base], sketch_curves)
            sampled = proof_topology(self._sample(curve_entities, limits, consumed), limits[0])
        else:
            sampled = {'status': 'unknown', 'method': 'sampled', 'loops': [],
                       'reason': 'missingSketchCurves'}
        native_profiles = _cad_items(sketch.profiles)
        if len(native_profiles) > 256:
            raise ValueError('Sketch proof supports at most 256 profiles')
        profiles = [self._profile(profile, index, limits, consumed)
                    for index, profile in enumerate(native_profiles)]
        selection = proof_select(profiles, normalized_query, limits[0], area_tolerance)
        complete = all(profile['outerLoops'] is not None and profile['innerLoops'] is not None
                       for profile in profiles)
        total_loops = (sum(proof_count(profile['outerLoops'], 'outerLoops') +
                            proof_count(profile['innerLoops'], 'innerLoops') for profile in profiles)
                       if complete else None)
        total_outer = sum(proof_count(profile['outerLoops'], 'outerLoops') for profile in profiles) if complete else None
        total_inner = sum(proof_count(profile['innerLoops'], 'innerLoops') for profile in profiles) if complete else None
        counts: JsonObject = {
            'profiles': len(profiles), 'loops': total_loops,
            'outerLoops': total_outer, 'innerLoops': total_inner,
        }
        expected_checks: list[JsonObject] = []
        for key, expected_count in expected_counts.items():
            actual_count = counts[key]
            expected_checks.append(proof_compare(key, actual_count, expected_count, 0.0, 'nativeTopology'))
        analytic_status = proof_status(
            [str(profile['topologyStatus']) for profile in profiles] +
            [str(profile['integralStatus']) for profile in profiles] +
            [str(check['status']) for check in expected_checks])
        sampled_status = proof_status(
            [str(sampled['status'])] +
            [str(profile['sampledTopologyStatus']) for profile in profiles])
        sampled['status'] = sampled_status
        geometry_status = proof_status([str(selection['status']), analytic_status, sampled_status])
        selected = selection['selectedIndex'] if geometry_status == 'pass' else None
        profile_ref: JsonValue = None
        if selected is not None:
            profile_ref = {'kind': 'profile', 'sketch': data['sketch'], 'index': selected}
        return self._result(sketch, 'sketch.profile-query', geometry_status,
                            profile=profile_ref, selection=selection, profiles=profiles,
                            counts=counts,
                            analytic={'status': analytic_status, 'expectedChecks': expected_checks,
                                      'method': 'High-accuracy native area/centroid and native profile-loop enumeration'},
                            sampled=sampled, strokeCount=consumed[0],
                            strokeTolerance=limits[0], areaTolerance=area_tolerance)
