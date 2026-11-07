"""Pinned native positive case: symmetric front/back pixels are legal similar views."""
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


def run(_context):
    require(ARGS.get('authorization') == AUTHORIZATION and ARGS.get('action') == 'legal-similarity',
            'Explicit authorization and action=legal-similarity are required')
    require(isinstance(ARGS.get('creationId'), str) and
            FMCAD.doc.creationId == ARGS['creationId'] and FMCAD.doc.name == DOC_NAME,
            'Legal-similarity capture is not pinned to its symmetric scratch')
    documents = ARGS.get('documents')
    require(isinstance(documents, list) and len(documents) == 3,
            'Legal-similarity capture requires the exact inspected fixture identities')
    rows = [row for row in documents
            if row['role'] == 'SYMMETRIC' and row['creationId'] == ARGS['creationId']]
    require(len(rows) == 1 and rows[0]['name'] == DOC_NAME and
            FMCAD.doc.isValid and not FMCAD.doc.isSaved,
            'Pinned symmetric scratch identity changed')
    design = adsk.fusion.Design.cast(FMCAD.doc.products.itemByProductType('DesignProductType'))
    bodies = design.rootComponent.bRepBodies
    require(bodies.count == 1 and bodies.item(0).isValid and bodies.item(0).volume > 0,
            'Symmetric fixture must contain one valid solid body')
    bounds = bodies.item(0).boundingBox
    geometry = rows[0].get('geometryReadback') or {}
    require(geometry.get('bodyValid') is True and
            abs(geometry.get('volume', -1) - bodies.item(0).volume) <= 1e-7 and
            len(geometry.get('minimum', [])) == 3 and len(geometry.get('maximum', [])) == 3 and
            all(abs(a - b) <= 1e-7 for a, b in zip(geometry['minimum'], bounds.minPoint.asArray())) and
            all(abs(a - b) <= 1e-7 for a, b in zip(geometry['maximum'], bounds.maxPoint.asArray())),
            'Symmetric fixture geometry differs from its creation readback')
    output_root = ARGS.get('outputRoot')
    allowed_root = ARGS.get('allowedRoot')
    require(all(isinstance(value, str) and os.path.isabs(value)
                for value in (output_root, allowed_root)),
            'Legal-similarity output must be pinned under this run evidence root')
    try:
        inside = os.path.commonpath([os.path.realpath(allowed_root),
                                     os.path.realpath(output_root)]) == os.path.realpath(allowed_root)
    except ValueError:
        inside = False
    require(inside and output_root != allowed_root and not os.path.lexists(output_root),
            'Legal-similarity output is not a fresh owned evidence directory')
    os.mkdir(output_root)
    paths = [os.path.join(output_root, 'front.png'), os.path.join(output_root, 'back.png')]
    app = adsk.core.Application.get()
    modified_before = FMCAD.doc.isModified
    result = FMCAD.call('shot.pack', {'shots': [
        {'path': paths[0], 'width': 640, 'height': 480,
         'camera': {'orientation': 'front', 'fit': True}},
        {'path': paths[1], 'width': 640, 'height': 480,
         'camera': {'orientation': 'back', 'fit': True}},
    ]})
    integrity = result.get('pixelIntegrity', {})
    similar = integrity.get('similarPairs', [])
    legal_pair = any({row.get('left'), row.get('right')} == {'front', 'back'} for row in similar)
    duplicate = any({row.get('left'), row.get('right')} == {'front', 'back'}
                    for row in integrity.get('duplicatePairs', []))
    images = []
    for row in result.get('images', []):
        path = row.get('path')
        if isinstance(path, str) and os.path.isfile(path):
            with open(path, 'rb') as stream:
                data = stream.read()
            images.append({'name': os.path.basename(path), 'bytes': len(data),
                           'sha256': hashlib.sha256(data).hexdigest(),
                           'pngSignature': data.startswith(b'\x89PNG\r\n\x1a\n'),
                           'camera': row.get('camera')})
    identity = {'name': FMCAD.doc.name, 'creationId': FMCAD.doc.creationId,
                'isSaved': FMCAD.doc.isSaved, 'isModified': FMCAD.doc.isModified}
    camera_restored = result.get('cameraRestored') is True
    presentation_restored = result.get('presentationRestoration', {}).get('status') == 'restored'
    status = ('passed' if legal_pair and not duplicate and
              integrity.get('status') == 'review-required' and
              camera_restored and presentation_restored and
              len(images) == 2 and all(row['pngSignature'] for row in images) and
              not identity['isSaved'] and identity['isModified'] == modified_before else
              'failed' if duplicate or integrity.get('status') == 'failed' else 'blocked-unsupported')
    report = {
        'status': status,
        'fusionBuild': app.version,
        'documentIdentity': identity,
        'pixelIntegrity': integrity,
        'cameraRestored': camera_restored,
        'presentationRestoration': result.get('presentationRestoration'),
        'images': images,
        'expectedSimilarPair': legal_pair,
        'sameDirectionDuplicate': duplicate,
    }
    FMCAD.emit(report)
    return report
