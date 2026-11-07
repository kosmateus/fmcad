"""Append to the normal CAD bundle; single-operator native acceptance only.

The operator selects a disposable, empty parametric document via _FMCAD_REQUEST.
Creates owned GM06 fixtures, leaves evidence in the document, never saves/deletes.
An assertion stops the run. Inspect partial geometry before another attempt.
"""


def run(_context: str):
    request = _FMCAD_REQUEST
    ctx = CadContext(request['doc'], request.get('component'), request.get('projectId'), request.get('docId'), request.get('docFileId'))
    ctx.assert_identity()
    ctx.activate_target()
    prefix = 'GM06_' + str(int(time.time()))
    evidence = []

    def check(label, passed, actual):
        record = {'requirement': 'GM06', 'case': label, 'status': 'pass' if passed else 'fail', 'actual': actual}
        evidence.append(record)
        print('GM06_EVIDENCE ' + json.dumps(record))
        assert passed, label

    def call(operation, data):
        result = ctx.call(operation, data)
        if isinstance(result, dict) and result.get('status') in ('fail', 'blocked'):
            check(operation, False, result)
        return result

    def oval(name, plane, position=False):
        data = {'name': name, 'plane': plane, 'inferencePolicy': 'explicit', 'geometry': [
            {'type': 'ellipse', 'name': 'oval', 'center': ['-10 mm', '0 mm', '0 mm'], 'majorRadius': '20 mm', 'minorRadius': '10 mm', 'angle': '30 deg'},
            {'type': 'line', 'name': 'axis', 'start': ['0 mm', '0 mm', '0 mm'], 'end': ['10 mm', '0 mm', '0 mm'], 'construction': True, 'fixed': True}],
            'dimensions': [{'type': 'majorRadius', 'entities': ['oval'], 'expression': '20 mm'},
                {'type': 'minorRadius', 'entities': ['oval'], 'expression': '10 mm'},
                {'type': 'angle', 'entities': ['axis', 'oval.majorAxis'], 'expression': '30 deg', 'text': ['25 mm', '8 mm', '0 mm']}]}
        if position:
            data['positions'] = [{'name': name + '_center', 'point': 'oval.center', 'coordinates': [prefix + '_x', '0 mm', '0 mm']}]
        return call('sketch.build', data)

    call('param.apply', {'parameters': [{'name': prefix + '_x', 'expression': '-10 mm', 'unit': 'mm'}]})
    bottom = oval(prefix + '_bottom', 'XY', True)
    plane = call('datum.plane', {'name': prefix + '_top_plane', 'plane': 'XY', 'offset': '30 mm'})
    top = oval(prefix + '_top', plane)
    loft = call('model.loft', {'name': prefix + '_loft', 'profiles': [bottom['profiles'][0], top['profiles'][0]]})
    check('ellipse-to-loft', bool(loft.get('feature')), loft)
    sketch = ctx.resolve(bottom['sketch'], 'sketch')
    ellipse = ctx.resolve(bottom['refs']['oval'])
    dims = { _cad_type(d): ctx.ref(d) for d in _cad_items(sketch.sketchDimensions) }
    call('sketch.edit', {'sketch': bottom['sketch'], 'dimensions': [
        {'dimension': dims['SketchEllipseMajorRadiusDimension'], 'expression': '25 mm'},
        {'dimension': dims['SketchEllipseMinorRadiusDimension'], 'expression': '12 mm'}]})
    check('both ellipse radii', abs(ellipse.majorAxisRadius-2.5) < 1e-7 and abs(ellipse.minorAxisRadius-1.2) < 1e-7,
        {'majorRadiusCm': ellipse.majorAxisRadius, 'minorRadiusCm': ellipse.minorAxisRadius})
    for x in ('0 mm', '10 mm', '-10 mm'):
        call('param.apply', {'parameters': [{'name': prefix + '_x', 'expression': x, 'unit': 'mm'}], 'overwrite': True})
        call('history.recompute', {})
        check('signed center ' + x, abs(ellipse.centerSketchPoint.geometry.x-ctx.length(x)) < 1e-7,
            {'pointCm': _cad_xyz(ellipse.centerSketchPoint.geometry)})
    check('loft health after regeneration', int(ctx.resolve(loft['feature']).healthState) == 0, ctx.describe(ctx.resolve(loft['feature'])))

    for support in ('XZ', 'YZ'):
        built = call('sketch.build', {'name': prefix + '_' + support, 'plane': support, 'geometry': [
            {'type': 'ellipse', 'name': 'oval', 'center': ['-10 mm', '0 mm', '0 mm'],
             'majorAxisPoint': ['10 mm', '0 mm', '0 mm'], 'minorAxisPoint': ['-10 mm', '10 mm', '0 mm']}]})
        local = ctx.resolve(built['sketch'], 'sketch')
        curve = ctx.resolve(built['refs']['oval'])
        call('sketch.transform', {'sketch': built['sketch'], 'entities': [built['refs']['oval']], 'frame': 'sketch',
            'rotate': {'angle': '90 deg'}, 'translate': ['0 mm', '10 mm', '0 mm']})
        p = curve.centerSketchPoint.geometry
        major = curve.majorAxis
        major_dir_y = major.y / major.length if major.length else 0.0
        check(support + ' rotation and translation', math.hypot(p.x, p.y) < 1e-7 and abs(abs(major_dir_y) - 1) < 1e-7,
            {'localCenterCm': _cad_xyz(p), 'worldCenterCm': _cad_xyz(local.sketchToModelSpace(p)),
             'majorAxisLenCm': major.length, 'majorAxisDir': _cad_xyz(major),
             'worldLocalXAxis': _cad_xyz(local.sketchToModelSpace(adsk.core.Point3D.create(1, 0, 0))),
             'worldLocalYAxis': _cad_xyz(local.sketchToModelSpace(adsk.core.Point3D.create(0, 1, 0)))})
        call('sketch.edit', {'sketch': built['sketch'], 'movePoints': [{'point': {'entity': built['refs']['oval'], 'point': 'center'}, 'to': ['-5 mm', '0 mm', '0 mm']}]})
        call('sketch.edit', {'sketch': built['sketch'], 'entities': [built['refs']['oval']], 'fixed': True})
        count = local.geometricConstraints.count
        refused = ctx.call('sketch.edit', {'sketch': built['sketch'], 'movePoints': [{'point': {'entity': built['refs']['oval'], 'point': 'center'}, 'to': ['0 mm', '0 mm', '0 mm']}]})
        check(support + ' constrained point refusal', refused['status'] in ('blocked', 'fail') and local.geometricConstraints.count == count, refused)

    automatic = call('sketch.build', {'name': prefix + '_plan', 'geometry': [
        {'type': 'circle', 'name': 'circle', 'center': ['-30 mm', '0 mm', '0 mm'], 'radius': '5 mm'},
        {'type': 'rectangle', 'name': 'box', 'start': ['10 mm', '0 mm', '0 mm'], 'end': ['30 mm', '10 mm', '0 mm']}]})
    target = ctx.resolve(automatic['sketch'], 'sketch')
    before = _sketch_state(ctx, target)
    planned = call('sketch.dimension-plan', {'sketch': automatic['sketch']})
    check('plan mutation separation', before == _sketch_state(ctx, target), {'proposalCount': len(planned['plan']['proposals'])})
    check('circle and rectangle recognition', len(planned['plan']['proposals']) == 3, planned)
    call('sketch.dimension-apply', {'sketch': automatic['sketch'], 'plan': planned['plan'], 'accept': [p['id'] for p in planned['plan']['proposals']]})
    again = call('sketch.dimension-plan', {'sketch': automatic['sketch']})
    check('repeat plan has no duplicate dimensions', not again['plan']['proposals'], again)
    print('GM06_NATIVE_RESULT ' + json.dumps({'status': 'pass', 'documentIdentity': _sketch_identity(ctx), 'prefix': prefix, 'evidence': evidence}))
