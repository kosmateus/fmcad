"""Pinned no-model-mutation activation check for a short capture sequence."""
import adsk.core

ARGS = {}
DOC_NAME = ''
AUTHORIZATION = 'I authorize native capture-integrity qualification'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(_context):
    require(ARGS.get('authorization') == AUTHORIZATION and ARGS.get('action') == 'activate',
            'Explicit authorization and action=activate are required')
    require(isinstance(ARGS.get('creationId'), str) and
            FMCAD.doc.name == DOC_NAME and FMCAD.doc.creationId == ARGS['creationId'],
            'Activation helper is not pinned to the expected owned synthetic document')
    app = adsk.core.Application.get()
    require(app.activeDocument == FMCAD.doc,
            'Pinned synthetic document was not activated by the guarded fmcad wrapper')
    result = {'status': 'pinned-active', 'name': FMCAD.doc.name,
              'creationId': FMCAD.doc.creationId, 'saved': FMCAD.doc.isSaved,
              'isModified': FMCAD.doc.isModified}
    FMCAD.emit(result)
    return result
