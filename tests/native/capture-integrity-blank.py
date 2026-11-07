"""Pinned real blank-frame negative and camera restoration check."""
import adsk.core
import adsk.fusion
import hashlib
import os

ARGS = {}
DOC_NAME = ''
AUTHORIZATION = 'I authorize native capture-integrity qualification'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def camera_state(app, doc):
    require(app.activeDocument == doc, 'Blank screenshot target is not active')
    camera = app.activeViewport.camera
    state = {'cameraType': int(camera.cameraType),
             'eye': list(camera.eye.asArray()),
             'target': list(camera.target.asArray()),
             'up': list(camera.upVector.asArray()),
             'visualStyle': int(app.activeViewport.visualStyle),
             'componentColors': app.isComponentColorsDisplayed}
    if camera.cameraType == adsk.core.CameraTypes.OrthographicCameraType:
        ok, width, height = camera.getExtents()
        require(ok, 'Blank camera extent readback unavailable')
        state['extents'] = [width, height]
    else:
        state['perspectiveAngle'] = camera.perspectiveAngle
    return state


def equal_vector(left, right):
    return len(left) == len(right) and all(abs(a - b) <= 1e-7 for a, b in zip(left, right))


def main():
    require(ARGS.get('authorization') == AUTHORIZATION and ARGS.get('action') == 'blank',
            'Explicit authorization and action=blank are required')
    require(isinstance(ARGS.get('creationId'), str) and
            FMCAD.doc.creationId == ARGS['creationId'] and FMCAD.doc.name == DOC_NAME,
            'Blank capture is not pinned to its freshly created scratch')
    documents = ARGS.get('documents')
    require(isinstance(documents, list) and len(documents) == 3,
            'Blank capture requires the exact inspected fixture identities')
    rows = [row for row in documents
            if row['role'] == 'BLANK' and row['creationId'] == ARGS['creationId']]
    require(len(rows) == 1 and rows[0]['name'] == DOC_NAME and
            FMCAD.doc.isValid and not FMCAD.doc.isSaved and
            FMCAD.doc.isModified == rows[0]['isModified'],
            'Pinned blank scratch identity changed')
    design = adsk.fusion.Design.cast(FMCAD.doc.products.itemByProductType('DesignProductType'))
    require(design is not None and design.rootComponent.bRepBodies.count == 0 and
            (rows[0].get('geometryReadback') or {}).get('bodyCount') == 0,
            'Pinned blank scratch unexpectedly contains solid geometry')
    output = ARGS.get('outputPath')
    allowed = ARGS.get('allowedRoot')
    require(isinstance(output, str) and os.path.isabs(output) and
            isinstance(allowed, str) and os.path.isabs(allowed),
            'Blank evidence path must be a new absolute file under the owned evidence root')
    try:
        inside = os.path.commonpath([os.path.realpath(allowed),
                                     os.path.realpath(os.path.dirname(output))]) == os.path.realpath(allowed)
    except ValueError:
        inside = False
    require(inside and output != allowed and not os.path.lexists(output),
            'Blank evidence path must be a new file under this run’s evidence directory')
    app = adsk.core.Application.get()
    before = camera_state(app, FMCAD.doc)
    error_message = None
    try:
        FMCAD.call('shot.pack', {'shots': [
            {'path': output, 'width': 640, 'height': 480,
             'camera': {'orientation': 'front', 'fit': True}},
        ]})
    except Exception as error:
        error_message = str(error)
    after = camera_state(app, FMCAD.doc)
    camera_restored = (
        after['cameraType'] == before['cameraType'] and
        equal_vector(after['eye'], before['eye']) and
        equal_vector(after['target'], before['target']) and
        equal_vector(after['up'], before['up']) and
        after['visualStyle'] == before['visualStyle'] and
        after['componentColors'] == before['componentColors'] and
        ('extents' not in before or equal_vector(after['extents'], before['extents'])) and
        ('perspectiveAngle' not in before or
         abs(after['perspectiveAngle'] - before['perspectiveAngle']) <= 1e-7))
    image = None
    if os.path.isfile(output):
        with open(output, 'rb') as stream:
            data = stream.read()
        image = {'name': os.path.basename(output), 'bytes': len(data),
                 'sha256': hashlib.sha256(data).hexdigest(),
                 'pngSignature': data.startswith(b'\x89PNG\r\n\x1a\n')}
    expected_rejection = bool(error_message and
                              'Shot pixel integrity policy failed' in error_message)
    return {
        'status': 'passed' if expected_rejection and camera_restored and image and image['pngSignature'] else
                  'unknown' if not camera_restored else 'failed',
        'documentIdentity': {'name': FMCAD.doc.name,
                             'creationId': FMCAD.doc.creationId,
                             'isSaved': FMCAD.doc.isSaved,
                             'isModified': FMCAD.doc.isModified,
                             'modifiedBefore': rows[0]['isModified']},
        'fusionBuild': app.version,
        'expectedPixelRejection': expected_rejection,
        'error': error_message,
        'cameraRestored': camera_restored,
        'image': image,
        'restoreState': before,
    }


def run(_context):
    result = main()
    FMCAD.emit(result)
    return result
