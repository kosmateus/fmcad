"""GM05 native extension; the existing plane-coordinate calibrator remains the owner."""


def _reference_image(ctx, data):
    if data.get('mode') == 'inspect':
        _cad_fields(data, ('mode', 'ref'))
        canvas = ctx.resolve(data['ref'])
        if _cad_type(canvas) != 'Canvas':
            raise ValueError('ref must be an existing Canvas token')
        return {'schemaVersion': 1, 'status': 'notEvaluated', 'ref': ctx.ref(canvas),
                'transform': list(canvas.transform.asArray()), 'units': 'cm',
                'frame': 'canvas-plane', 'associativity': 'snapshot',
                'metricVerification': False, 'provenance': [],
                'limitations': ['Actual native transform only. Pixel mapping and image identity require operator verification.']}
    _cad_fields(data, ('mode', 'ref', 'segment', 'length', 'anchor', 'source'), ('angle',))
    source = data['source']
    _cad_fields(source, ('path', 'sha256', 'status', 'uncertainty'), ('derivedFrom',))
    if (not isinstance(source['path'], str) or not source['path'].strip() or
            not isinstance(source['sha256'], str) or len(source['sha256']) != 64 or
            any(c not in '0123456789abcdef' for c in source['sha256']) or
            source['status'] not in ('CONFIRMED', 'ESTIMATED', 'OPEN', 'DERIVED') or
            not isinstance(source['uncertainty'], str) or not source['uncertainty'].strip()):
        raise ValueError('Invalid reference source provenance')
    if source['status'] == 'DERIVED' and not source.get('derivedFrom'):
        raise ValueError('DERIVED source requires derivedFrom')
    if source['status'] == 'OPEN':
        return {'schemaVersion': 1, 'status': 'blocked', 'metricVerification': False,
                'provenance': source, 'affected': [], 'reason': 'OPEN dimension source cannot drive native calibration'}
    result = _io_reference_image(ctx, {k: v for k, v in data.items() if k != 'source'})
    result.update(schemaVersion=1, status='notEvaluated', units='cm', frame='canvas-plane',
                  associativity='snapshot', provenance=source,
                  warnings=['Source hash is caller-supplied; no image identity or pixel mapping was verified.'] +
                  (['Source uncertainty remains unresolved metrology.'] if source['status'] != 'CONFIRMED' else []))
    return result
