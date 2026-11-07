"""Owned .10 test fixture: favorite an explicit numeric source driver and optionally consume it in a new body."""
ARGS = []
DOC_NAME = ''


def run(_context):
    if not isinstance(ARGS, dict) or set(ARGS) - {'parameter', 'body'}:
        raise ValueError('Expected {parameter, body?}')
    parameter_name = ARGS.get('parameter')
    if not isinstance(parameter_name, str) or not parameter_name:
        raise ValueError('parameter must be an exact source user parameter name')
    design = FMCAD.design
    parameter = design.userParameters.itemByName(parameter_name)
    if parameter is None:
        raise ValueError('Exact source user parameter was not found')
    parameter.isFavorite = True
    result = {'parameter': parameter.name, 'favorite': bool(parameter.isFavorite),
              'expression': str(parameter.expression), 'unit': str(parameter.unit)}
    if ARGS.get('body') is True:
        shape = FMCAD.call('shape.box', {'name': 'IW710_DriverBody', 'width': parameter_name,
                                         'depth': '10 mm', 'height': '10 mm'})
        if not isinstance(shape, dict):
            raise RuntimeError('Physical source builder returned no structured result')
        result['body'] = shape
    return result
