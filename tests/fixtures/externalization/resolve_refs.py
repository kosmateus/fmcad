"""Resolve observed native refs without changing the owned source document."""
ARGS = []
DOC_NAME = ''


def run(_context):
    if not isinstance(ARGS, dict) or set(ARGS) != {'refs'} or not isinstance(ARGS['refs'], list):
        raise ValueError('Expected explicit native reference probes')
    rows = []
    for ref in ARGS['refs']:
        try:
            entity = FMCAD.resolve(ref)
            rows.append({'ref': ref, 'resolved': True, 'objectType': str(entity.objectType),
                         'name': str(entity.name),
                         'path': str(entity.fullPathName) if hasattr(entity, 'fullPathName') else None})
        except Exception as error:
            rows.append({'ref': ref, 'resolved': False,
                         'error': type(error).__name__ + ': ' + str(error)})
    return {'document': FMCAD.doc.name, 'results': rows, 'readOnlyObservation': True}
