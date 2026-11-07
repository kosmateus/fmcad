"""Section-series and finite witness use cases for the canonical CAD bundle."""
from typing import Callable as _SectionWitnessAppCallable, cast as _section_app_cast


def _measure_section_series(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('body', 'frame', 'origin', 'normal', 'stations'), ('limits',))
    budget = _SectionWitnessBudget(data)
    stations = data['stations']
    if not isinstance(stations, list) or not 1 <= len(stations) <= budget.limits['stations']:
        raise ValueError('stations must be nonempty and within the station limit')
    offsets: list[float] = [ctx.length(value) for value in stations]
    for offset in offsets:
        _section_witness_number(offset, 'Station offset')
    origin = ctx.point(data['origin'])
    normal = _cad_direction(data['normal'])
    frame, bodies = _section_witness_operands(ctx, [data['body']], data['frame'], budget)
    manager = adsk.fusion.TemporaryBRepManager.get()
    result = _section_witness_base('measure.section-series', frame)
    station_results: list[JsonRecord] = []
    coverage_detail: JsonRecord = {'kind': 'discrete stations only', 'continuous': False,
                                   'requested': len(offsets), 'complete': 0}
    result.update(origin=_cad_xyz(origin), normal=normal, stations=station_results,
                  coverage='partial',
                  coverageDetail=coverage_detail)
    for index, offset in enumerate(offsets):
        point_value = adsk.core.Point3D.create(*[value + offset * direction
                                                 for value, direction in zip(_cad_xyz(origin), normal)])
        if point_value is None:
            raise RuntimeError('Section station point construction failed')
        point = point_value
        plane = adsk.core.Plane.create(point, adsk.core.Vector3D.create(*normal))
        try:
            row = _section_witness_station(manager, bodies[0], plane, budget)
            coverage_detail['complete'] = _section_cast('int', coverage_detail['complete']) + 1
        except Exception as error:
            row = {'status': 'unknown', 'reason': str(error), 'loops': None, 'area': None}
        station_results.append(dict(row, index=index, offset=offset))
        budget.finish(result)
    complete = coverage_detail['complete'] == len(offsets)
    result['status'] = 'complete' if complete else 'unknown'
    result['coverage'] = 'partial' if complete else 'unknown'
    return budget.finish(result)


def _measure_witness_check(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('body', 'witness', 'frame', 'expect', 'volumeTolerance'), ('limits',))
    if data['expect'] not in ('material', 'void'):
        raise ValueError('expect must be material or void')
    if not isinstance(data['volumeTolerance'], str) or not data['volumeTolerance'].strip():
        raise ValueError('volumeTolerance must be an explicit volume expression')
    expression = _section_app_cast(
        "_SectionWitnessAppCallable[[object, str | None], tuple[str, float]]",
        getattr(ctx, '_expression'))
    tolerance = _section_witness_number(
        expression(data['volumeTolerance'], 'cm^3')[1], 'Volume tolerance')
    if tolerance < 0:
        raise ValueError('Volume tolerance must be nonnegative')
    budget = _SectionWitnessBudget(data)
    # Frame/solid validation errors are request errors, not evidence of failure.
    frame, bodies = _section_witness_operands(ctx, [data['body'], data['witness']], data['frame'], budget)
    volume = _section_witness_number(bodies[1].volume, 'Witness volume')
    if volume <= 0:
        raise ValueError('Witness must have positive finite volume')
    result = _section_witness_base('measure.witness-check', frame)
    result.update(expect=data['expect'], coverage='unknown',
                  coverageDetail={'kind': 'finite solid Boolean', 'sampled': False},
                  witnessVolume=volume, volumeTolerance=tolerance, residualVolume=None)
    _section_cast('list[str]', result['limitations']).append(
        'Volume proof only, within explicit tolerance; not boundary/contact clearance or a manufacturability proof.')
    try:
        residual = _section_witness_boolean(adsk.fusion.TemporaryBRepManager.get(), bodies, data['expect'], budget)
        result.update(status=_section_witness_verdict(residual, tolerance), coverage='pass', residualVolume=residual)
    except Exception as error:
        result.update(status='unknown', reason=str(error))
    status = _section_cast('str', result['status'])
    result['passed'] = (True if status == 'pass' else False if status == 'fail' else None)
    return budget.finish(result)
