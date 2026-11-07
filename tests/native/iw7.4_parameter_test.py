"""Leased scratch-only acceptance fixture for parameter.test v2 and local restore.

Run only against this worker's dedicated scratch Design using `fmcad run` with
`--helpers cad-v1` and exact document identity pins. This file does not save,
publish, or close the document.
"""

DOC_NAME = 'Scratch'
ARGS = {}


def run(_context):
    identity = FMCAD.call('document.status', {})
    if identity.get('fileId') != ARGS.get('fileId') or identity.get('projectId') != ARGS.get('projectId') or \
            identity.get('folderId') != ARGS.get('folderId'):
        raise RuntimeError('Parameter-test scratch identity differs from the assigned project/folder/file IDs')
    parameter = 'IW74_Width'
    FMCAD.call('param.apply', {'parameters': [
        {'name': parameter, 'expression': '10 mm', 'unit': 'mm'}]})
    box = FMCAD.call('shape.box', {
        'name': 'IW74_ParameterTestBox', 'width': parameter,
        'depth': '20 mm', 'height': '5 mm'})
    body = box['bodies'][0]
    measured = FMCAD.call('measure.volume', {'ref': body, 'units': 'mm3'})
    frame = measured['context']
    baseline = FMCAD.temporary_body(body, frame)
    expected_volume = {'width-20': 2000.0, 'width-30': 3000.0}
    spec = {
        'confirm': True,
        'timeBudgetMs': 120000,
        'cases': [
            {'id': 'width-20', 'assign': [{'parameter': parameter, 'expression': '20 mm'}],
             'checks': [{'measurement': {'operation': 'measure.volume',
                                          'data': {'ref': body, 'units': 'mm3'}},
                         'expected': '2000 mm^3', 'tolerance': '1 mm^3'}]},
            {'id': 'width-30', 'assign': [{'parameter': parameter, 'expression': '30 mm'}],
             'checks': [{'measurement': {'operation': 'measure.volume',
                                          'data': {'ref': body, 'units': 'mm3'}},
                         'expected': '3000 mm^3', 'tolerance': '1 mm^3'}]},
        ],
    }

    def check_case(_spec, case):
        actual = FMCAD.call('measure.volume', {'ref': body, 'units': 'mm3'})
        return {'passed': abs(actual['value'] - expected_volume[case['id']]) <= 1.0,
                'actual': actual, 'expected': expected_volume[case['id']]}

    def check_restored(_spec, _restored):
        comparison = FMCAD.compare_bodies(baseline, body, frame,
                                          '1 mm^3', '0.01 mm', '0.01 deg')
        return {'passed': comparison['equal'], 'comparison': comparison}

    result = FMCAD.parameter_test(spec, check_case, check_restored)
    FMCAD.require_pass(result)
    return result
