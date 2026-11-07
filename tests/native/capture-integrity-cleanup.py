"""Close only exact unsaved documents created by capture-integrity-qualification."""
import adsk.core
import builtins
import json

ARGS = {}
DOC_NAME = ''
AUTHORIZATION = 'I authorize native capture-integrity qualification'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def same_vector(left, right, tolerance=1e-7):
    return (isinstance(left, list) and isinstance(right, list) and
            len(left) == len(right) and
            all(abs(a - b) <= tolerance for a, b in zip(left, right)))


def verify_geometry(doc, expected):
    design = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
    require(design is not None, 'Owned scratch is no longer a Fusion Design')
    bodies = design.rootComponent.bRepBodies
    actual = {'bodyCount': bodies.count}
    if expected['role'] in ('ASYMMETRIC', 'SYMMETRIC'):
        require(bodies.count == 1, 'Owned synthetic solid body count changed')
        body = bodies.item(0)
        require(body.isValid and body.volume > 0, 'Owned synthetic body is invalid or empty')
        bounds = body.boundingBox
        actual.update({'bodyValid': body.isValid, 'volume': body.volume,
                       'minimum': list(bounds.minPoint.asArray()),
                       'maximum': list(bounds.maxPoint.asArray())})
        prior = expected.get('geometryReadback') or {}
        require(prior.get('bodyValid') is True and
                abs(prior.get('volume', -1) - actual['volume']) <= 1e-7 and
                same_vector(prior.get('minimum'), actual['minimum']) and
                same_vector(prior.get('maximum'), actual['maximum']),
                'Owned synthetic body geometry changed; refusing cleanup')
    else:
        require(bodies.count == 0, 'Owned blank scratch gained solid bodies')
        require((expected.get('geometryReadback') or {}).get('bodyCount') == 0,
                'Blank fixture report does not prove an empty body set')


def run(_context):
    require(ARGS.get('authorization') == AUTHORIZATION and ARGS.get('action') == 'cleanup',
            'Explicit user authorization and action=cleanup are required')
    rows = ARGS.get('documents')
    token = ARGS.get('token')
    require(isinstance(token, str) and len(token) == 12 and
            isinstance(rows, list) and len(rows) == 3 and
            {row.get('role') for row in rows} == {'BLANK', 'ASYMMETRIC', 'SYMMETRIC'},
            'Cleanup requires the exact three recorded fresh fixture identities')
    require(isinstance(ARGS.get('creationId'), str) and
            FMCAD.doc.name == DOC_NAME and FMCAD.doc.creationId == ARGS['creationId'] and
            any(row['role'] == 'ASYMMETRIC' and row['creationId'] == ARGS['creationId'] and
                row['name'] == DOC_NAME for row in rows),
            'Cleanup must be pinned to this run’s owned asymmetric scratch')
    state = getattr(builtins, '_FMCAD_CAPTURE_INTEGRITY', None)
    if state is not None:
        require(isinstance(state, dict) and state.get('stage') == 'ready' and
                state.get('token') == token,
                'In-memory fixture token/stage differs from the pinned cleanup report')
        for row in rows:
            require(any(candidate.get('creationId') == row['creationId'] and
                        candidate.get('name') == row['name'] and
                        candidate.get('role') == row['role'] for candidate in state['documents']),
                    'Pinned cleanup report differs from in-memory fixture ownership')
    app = adsk.core.Application.get()
    owned = []
    require(len({row.get('creationId') for row in rows}) == 3 and
            len({row.get('name') for row in rows}) == 3,
            'Fixture cleanup identities/names must be unique')
    for row in rows:
        require(isinstance(row.get('creationId'), str) and isinstance(row.get('name'), str) and
                row['name'].startswith('FMCAD_CAPTURE_' + token + '_'),
                'Cleanup report contains an identity outside this unique capture token')
        matches = [candidate for candidate in app.documents
                   if candidate.creationId == row['creationId']]
        require(len(matches) == 1, 'Exact owned scratch is missing or duplicated; refusing cleanup')
        doc = matches[0]
        require(doc.isValid and doc.name == row['name'] and not doc.isSaved and
                doc.isModified == row['isModified'],
                'Owned scratch identity/saved/modified state changed; refusing cleanup')
        verify_geometry(doc, row)
        owned.append((row, doc))
    closed = []
    for row, doc in reversed(owned):
        if doc.isValid:
            require(doc.close(False), 'Could not close owned synthetic document ' + row['name'])
            require(not any(candidate.creationId == row['creationId'] for candidate in app.documents),
                    'Closed synthetic document identity remains open')
            closed.append({'name': row['name'], 'creationId': row['creationId']})
    if state is not None:
        del builtins._FMCAD_CAPTURE_INTEGRITY
    print('FMCAD_RESULT ' + json.dumps({'status': 'cleaned', 'closed': closed,
                                       'activeDocumentNotForced': True}))
