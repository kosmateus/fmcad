"""Pinned visual evidence capture. identity.py is prepended by review.js.

No geometry operations, document saves, event-pumping or automatic retries.
The terminal report is written only after all independent restoration attempts.
"""
import hashlib
import json
import math
import os
import struct
from datetime import datetime, timezone

ARGS = {}

VIEWS = [('front', 'Front'), ('back', 'Back'), ('left', 'Left'),
         ('right', 'Right'), ('top', 'Top'), ('bottom', 'Bottom'),
         ('iso-top-left', 'IsoTopLeft'), ('iso-bottom-right', 'IsoBottomRight')]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def document_identity(doc):
    file, error = _document_data_file(doc)
    result = {'name': doc.name, 'creationId': doc.creationId,
            'fileId': file.id if file else None,
            'version': file.versionNumber if file else None,
             'isSaved': doc.isSaved, 'isModified': doc.isModified}
    if error:
        result['dataFileError'] = error
    return result


def camera_state(camera, core):
    names = ('OrthographicCameraType', 'PerspectiveCameraType', 'PerspectiveWithOrthoFacesCameraType')
    name = next((name for name in names if getattr(core.CameraTypes, name) == camera.cameraType), None)
    require(name is not None, 'Unsupported camera projection')
    state = {'cameraType': name, 'eye': list(camera.eye.asArray()),
             'target': list(camera.target.asArray()), 'up': list(camera.upVector.asArray())}
    if camera.cameraType == core.CameraTypes.OrthographicCameraType:
        ok, width, height = camera.getExtents()
        require(ok and width > 0 and height > 0, 'Cannot read camera extents')
        state['extents'] = [width, height]
    else:
        state['perspectiveAngle'] = camera.perspectiveAngle
    return state


def near_state(actual, expected):
    for key, value in expected.items():
        other = actual.get(key)
        if isinstance(value, list):
            if not isinstance(other, list) or len(other) != len(value):
                return False
            if not all(math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-8) for a, b in zip(other, value)):
                return False
        elif isinstance(value, str):
            if other != value:
                return False
        elif not isinstance(other, (int, float)) or not math.isclose(other, value, rel_tol=1e-9, abs_tol=1e-8):
            return False
    return True


def restore_camera(viewport, state, core):
    # Settle the projection first; Fusion can adjust eye/extents at conversion.
    lens = viewport.camera
    lens.isFitView = False
    lens.isSmoothTransition = False
    lens.cameraType = getattr(core.CameraTypes, state['cameraType'])
    if 'perspectiveAngle' in state:
        lens.perspectiveAngle = state['perspectiveAngle']
    viewport.camera = lens
    # Fresh explicit camera avoids stale getter pose setters; this is a two-stage
    # projection/pose application, not a retry after failed restoration.
    camera = core.Camera.create()
    camera.cameraType = getattr(core.CameraTypes, state['cameraType'])
    if 'extents' in state:
        require(camera.setExtents(*state['extents']), 'Restore camera extents rejected')
    else:
        camera.perspectiveAngle = state['perspectiveAngle']
    camera.target = core.Point3D.create(*state['target'])
    camera.eye = core.Point3D.create(*state['eye'])
    camera.upVector = core.Vector3D.create(*state['up'])
    camera.isFitView = False
    camera.isSmoothTransition = False
    viewport.camera = camera
    viewport.refresh()
    require(near_state(camera_state(viewport.camera, core), state), 'Camera restoration readback mismatch')


def idle(app):
    require(app.userInterface.activeCommand in ('', 'SelectCommand'), 'Interactive command active; review rejected')


def verify_view_directions(rows):
    def unit(vector):
        length = math.sqrt(sum(x*x for x in vector))
        require(math.isfinite(length) and length > 1e-9, 'Invalid camera direction')
        return [x/length for x in vector]
    def dot(a, b):
        return sum(x*y for x, y in zip(a, b))
    directions = {r['name']: unit([a-b for a, b in zip(r['camera']['eye'], r['camera']['target'])]) for r in rows}
    for a, b in [('front', 'back'), ('left', 'right'), ('top', 'bottom')]:
        require(abs(dot(directions[a], directions[b])+1) < 1e-6, 'Opposed view directions do not match')
    f, r, t = [directions[n] for n in ('front', 'right', 'top')]
    require(max(abs(dot(a, b)) for a, b in [(f, r), (f, t), (r, t)]) < 1e-6, 'Side views are not orthogonal')
    for name, signs in [('iso-top-left', (1, -1, 1)), ('iso-bottom-right', (1, 1, -1))]:
        expected = unit([sum(sign*v[i] for sign, v in zip(signs, (f, r, t))) for i in range(3)])
        require(abs(dot(directions[name], expected)-1) < 1e-6, 'Isometric view direction does not match: ' + name)
    return {'status': 'verified', 'directions': directions,
            'method': 'Opposed orthogonal pairs and ViewCube-relative isometric vectors; enum getter may report arbitrary.'}


def snapshot(app, core):
    return {'camera': camera_state(app.activeViewport.camera, core),
            'style': app.activeViewport.visualStyle, 'colors': app.isComponentColorsDisplayed}


def capture_review(app, core, fusion, args):
    report = {'schemaVersion': 1, 'operation': 'review', 'requestId': args['requestId'],
              'success': False, 'status': 'failed', 'requiresVisualReview': True,
              'startedAt': datetime.now(timezone.utc).isoformat(), 'fusionBuild': None,
              'documentIdentity': None, 'views': [], 'errors': [],
              'restoration': {'status': 'not-needed', 'steps': []}}
    original = target = None
    original_state = target_state = None
    touched = False
    stage = 'preflight'
    out = args['fusionOut']

    def error(where, exc):
        report['errors'].append({'stage': where, 'type': type(exc).__name__, 'message': str(exc)})

    def restore_step(name, action):
        try:
            action()
            report['restoration']['steps'].append({'name': name, 'status': 'restored'})
        except Exception as exc:
            error('restore.' + name, exc)
            report['restoration']['steps'].append({'name': name, 'status': 'failed'})

    def restore_view(doc, state, name):
        def camera():
            require(app.activeDocument == doc, 'Wrong active document during camera restore')
            restore_camera(app.activeViewport, state['camera'], core)

        def style():
            require(app.activeDocument == doc, 'Wrong active document during style restore')
            app.activeViewport.visualStyle = state['style']
            require(app.activeViewport.visualStyle == state['style'], 'Visual style restoration mismatch')

        def colors():
            require(app.activeDocument == doc, 'Wrong active document during component-color restore')
            app.isComponentColorsDisplayed = state['colors']
            require(app.isComponentColorsDisplayed == state['colors'], 'Component-color restoration mismatch')

        restore_step(name + '.camera', camera)
        restore_step(name + '.style', style)
        restore_step(name + '.colors', colors)

    try:
        require(args.get('docId') or args.get('docFileId'), 'A pinned document identity is required')
        for key in ('width', 'height'):
            require(type(args[key]) is int and 32 <= args[key] <= 4096, 'Invalid image ' + key)
        require(args['width'] * args['height'] <= 16000000, 'Image exceeds 16 megapixels')
        idle(app)
        report['fusionBuild'] = app.version
        original = app.activeDocument
        require(original is not None, 'No active document to restore')
        target = _document_target(app, args['doc'])
        _document_assert_identity(target, args.get('docId'), args.get('docFileId'))
        require(fusion.Design.cast(target.products.itemByProductType('DesignProductType')) is not None,
                'Target is not a Fusion Design')
        report['documentIdentity'] = document_identity(target)
        report['originalDocumentIdentity'] = document_identity(original)
        # This token proves the backend sees the exclusively claimed local directory.
        with open(os.path.join(out, 'request.json'), encoding='utf-8') as stream:
            require(json.load(stream) == args, 'Mapped output request mismatch')
        require(set(os.listdir(out)) == {'request.json'}, 'Output directory is not fresh')
        original_state = snapshot(app, core)
        report['originalState'] = original_state
        touched = True  # Activation may partially succeed before raising.
        _document_activate_target(app, target, args.get('docId'), args.get('docFileId'))
        target_state = snapshot(app, core)
        report['targetState'] = target_state
        idle(app)
        viewport = app.activeViewport
        viewport.visualStyle = core.VisualStyles.ShadedWithVisibleEdgesOnlyVisualStyle
        app.isComponentColorsDisplayed = False
        staging = os.path.join(out, '_capture')
        os.mkdir(staging)
        for name, enum_name in VIEWS:
            stage = 'capture.' + name
            idle(app)
            require(app.activeDocument == target, 'Active document changed during capture')
            _document_assert_identity(target, args.get('docId'), args.get('docFileId'))
            require(document_identity(target) == report['documentIdentity'], 'Document state changed during review')
            require(viewport.visualStyle == core.VisualStyles.ShadedWithVisibleEdgesOnlyVisualStyle and
                    app.isComponentColorsDisplayed is False, 'Capture display settings mismatch')
            orientation = getattr(core.ViewOrientations, enum_name + 'ViewOrientation')
            lens = viewport.camera
            lens.cameraType = core.CameraTypes.OrthographicCameraType
            lens.isSmoothTransition = False
            lens.isFitView = False
            viewport.camera = lens
            camera = core.Camera.create()
            camera.cameraType = core.CameraTypes.OrthographicCameraType
            camera.viewOrientation = orientation
            camera.isSmoothTransition = False
            camera.isFitView = True
            viewport.camera = camera
            viewport.refresh()
            actual = viewport.camera
            require(actual.cameraType == core.CameraTypes.OrthographicCameraType,
                    'Capture projection readback mismatch')
            row = {'name': name, 'file': name + '.png', 'status': 'attempted',
                   'camera': camera_state(actual, core), 'width': args['width'], 'height': args['height'],
                   'visualStyle': 'shaded-with-visible-edges', 'componentColors': False,
                   'requestedOrientation': enum_name, 'orientationReadback': int(actual.viewOrientation)}
            report['views'].append(row)
            temporary = os.path.join(staging, row['file'])
            require(not os.path.lexists(temporary), 'Capture staging path already exists')
            require(viewport.saveAsImageFile(temporary, args['width'], args['height']), 'Image capture returned false')
            with open(temporary, 'rb') as stream:
                data = stream.read()
            require(len(data) >= 24 and data[:8] == b'\x89PNG\r\n\x1a\n' and data[12:16] == b'IHDR' and
                    struct.unpack('>II', data[16:24]) == (args['width'], args['height']), 'Invalid PNG header/dimensions')
            # SDK only writes in our staging directory; final publication is exclusive.
            with open(os.path.join(out, row['file']), 'xb') as stream:
                stream.write(data)
            row.update(status='captured', sizeBytes=len(data), sha256=hashlib.sha256(data).hexdigest())
            os.unlink(temporary)
        os.rmdir(staging)
        stage = 'verifyOrientations'
        report['orientationVerification'] = verify_view_directions(report['views'])
    except Exception as exc:
        error(stage, exc)
    finally:
        if touched:
            if target_state is not None:
                restore_view(target, target_state, 'target')

            def activate_original():
                if app.activeDocument != original:
                    require(original.activate(), 'Original document activation failed')
                require(app.activeDocument == original, 'Original active document not restored')

            restore_step('activeDocument', activate_original)
            # Always restore original state: activation itself may change framing.
            if original_state is not None and (original != target or target_state is None):
                restore_view(original, original_state, 'original')
            report['restoration']['status'] = ('restored' if all(
                step['status'] == 'restored' for step in report['restoration']['steps']) else 'failed')
        if target is not None and report['documentIdentity'] is not None:
            try:
                report['documentAfter'] = document_identity(target)
                require(report['documentAfter'] == report['documentIdentity'], 'Document saved/dirty/identity state changed')
            except Exception as exc:
                error('documentAfter', exc)
    report['success'] = (not report['errors'] and len(report['views']) == len(VIEWS) and
                         all(row['status'] == 'captured' for row in report['views']) and
                         report['restoration']['status'] == 'restored')
    report['status'] = 'captured' if report['success'] else 'failed'
    report['finishedAt'] = datetime.now(timezone.utc).isoformat()
    return report


def run(_context):
    import adsk.core
    import adsk.fusion
    report = capture_review(adsk.core.Application.get(), adsk.core, adsk.fusion, ARGS)
    # If persistence fails the caller must report unknown; never print a successful
    # terminal record that cannot be read back from the mapped local directory.
    with open(os.path.join(ARGS['fusionOut'], 'backend-report.json'), 'x', encoding='utf-8') as stream:
        json.dump(report, stream, indent=2)
    print('FMCAD_RESULT ' + json.dumps(report))
