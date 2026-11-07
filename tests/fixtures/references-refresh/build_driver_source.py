"""Build one owned .10 source with a favorite driver and optional physical body."""
ARGS = []
DOC_NAME = ''


def run(_context):
    if not isinstance(ARGS, dict) or set(ARGS) != {'parameter', 'expression', 'body'}:
        raise ValueError('Expected exact parameter, expression and body inputs')
    if not isinstance(ARGS['parameter'], str) or not ARGS['parameter'] or \
            not isinstance(ARGS['expression'], str) or type(ARGS['body']) is not bool:
        raise ValueError('Invalid driver source inputs')
    result = FMCAD.call('param.apply', {'parameters': [{'name': ARGS['parameter'],
        'expression': ARGS['expression'], 'unit': 'mm'}]})
    if not isinstance(result, dict):
        raise RuntimeError('Driver parameter creation returned no structured result')
    parameter = FMCAD.design.userParameters.itemByName(ARGS['parameter'])
    if parameter is None:
        raise RuntimeError('Exact driver parameter was not created')
    parameter.isFavorite = True
    body = None
    if ARGS['body']:
        body = FMCAD.call('shape.box', {'name': 'IW710_Final_DriverBody',
            'width': ARGS['parameter'], 'depth': '10 mm', 'height': '10 mm'})
        if not isinstance(body, dict):
            raise RuntimeError('Driver body creation returned no structured result')
    return {'parameter': parameter.name, 'favorite': bool(parameter.isFavorite),
            'expression': str(parameter.expression), 'unit': str(parameter.unit), 'body': body}
