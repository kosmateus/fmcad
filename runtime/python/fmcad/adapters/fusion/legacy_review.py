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
ORIENTATIONS = {
    'front': 'Front', 'back': 'Back', 'left': 'Left', 'right': 'Right',
    'top': 'Top', 'bottom': 'Bottom', 'iso-top-left': 'IsoTopLeft',
    'iso-bottom-right': 'IsoBottomRight', 'iso-top-right': 'IsoTopRight',
    'iso-bottom-left': 'IsoBottomLeft',
}
DEFAULT_RECIPES = [{'name': name, 'kind': 'orientation', 'orientation': name}
                   for name, _ in VIEWS]


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
    actual = camera_state(viewport.camera, core)
    require(capture_restore_status(True, near_state(actual, state)) == 'restored',
            'Camera restoration readback mismatch')


def idle(app):
    require(app.userInterface.activeCommand in ('', 'SelectCommand'), 'Interactive command active; review rejected')


def snapshot(app, core):
    return {'camera': camera_state(app.activeViewport.camera, core),
            'style': app.activeViewport.visualStyle, 'colors': app.isComponentColorsDisplayed}


def _review_recipes(args):
    recipes = args.get('recipes')
    if recipes is None:
        return DEFAULT_RECIPES
    require(isinstance(recipes, list) and 1 <= len(recipes) <= 32,
            'Review recipes must contain from 1 to 32 entries')
    names = set()
    for recipe in recipes:
        require(isinstance(recipe, dict) and
                set(recipe).issubset({'name', 'kind', 'orientation', 'target', 'extents', 'scale',
                                      'sectionName', 'visible'}) and
                all(key in recipe for key in ('name', 'kind', 'orientation')),
                'Invalid review recipe shape')
        name, kind = recipe['name'], recipe['kind']
        require(isinstance(name, str) and len(name) <= 48 and
                name and 'a' <= name[0] <= 'z' and
                all('a' <= ch <= 'z' or '0' <= ch <= '9' or ch == '-' for ch in name) and
                name not in names, 'Review recipe names must be unique safe filenames')
        names.add(name)
        require(recipe['orientation'] in ORIENTATIONS, 'Unsupported review orientation')
        if kind == 'orientation':
            require(set(recipe) == {'name', 'kind', 'orientation'}, 'Invalid orientation recipe')
        elif kind == 'roi':
            require(set(recipe) == {'name', 'kind', 'orientation', 'target', 'extents'} and
                    isinstance(recipe['target'], list) and len(recipe['target']) == 3 and
                    all(type(value) in (int, float) and math.isfinite(value) for value in recipe['target']) and
                    isinstance(recipe['extents'], list) and len(recipe['extents']) == 2 and
                    all(type(value) in (int, float) and math.isfinite(value) and value > 0
                        for value in recipe['extents']), 'Invalid ROI recipe')
        elif kind == 'detail':
            require(set(recipe) == {'name', 'kind', 'orientation', 'target', 'scale'} and
                    isinstance(recipe['target'], list) and len(recipe['target']) == 3 and
                    all(type(value) in (int, float) and math.isfinite(value) for value in recipe['target']) and
                    type(recipe['scale']) in (int, float) and math.isfinite(recipe['scale']) and
                    0.05 <= recipe['scale'] <= 0.75,
                    'Invalid detail recipe')
        elif kind == 'section':
            require(set(recipe) == {'name', 'kind', 'orientation', 'sectionName', 'visible'} and
                    isinstance(recipe['sectionName'], str) and recipe['sectionName'].strip() and
                    type(recipe['visible']) is bool, 'Invalid section recipe')
        else:
            raise RuntimeError('Review recipe kind must be orientation, roi, detail, or section')
    return recipes


def _review_camera(viewport, core, recipe):
    orientation = getattr(core.ViewOrientations,
                          ORIENTATIONS[recipe['orientation']] + 'ViewOrientation')
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
    if recipe['kind'] not in ('roi', 'detail'):
        return actual, None

    fitted = camera_state(actual, core)
    direction = [eye - target for eye, target in zip(fitted['eye'], fitted['target'])]
    length = math.sqrt(sum(value * value for value in direction))
    require(math.isfinite(length) and length > 1e-9, 'Invalid fitted camera direction')
    direction = [value / length for value in direction]
    target = recipe['target']
    distance = math.sqrt(sum((eye - old) ** 2 for eye, old in zip(fitted['eye'], fitted['target'])))
    eye = [point + direction[i] * distance for i, point in enumerate(target)]
    extents = (recipe['extents'] if recipe['kind'] == 'roi' else
               [value * recipe['scale'] for value in fitted['extents']])
    camera = core.Camera.create()
    camera.cameraType = core.CameraTypes.OrthographicCameraType
    require(camera.setExtents(*extents), 'Capture ROI extents rejected')
    camera.target = core.Point3D.create(*target)
    camera.eye = core.Point3D.create(*eye)
    camera.upVector = core.Vector3D.create(*fitted['up'])
    camera.isSmoothTransition = False
    camera.isFitView = False
    viewport.camera = camera
    viewport.refresh()
    actual = viewport.camera
    state = camera_state(actual, core)
    actual_delta = [a - b for a, b in zip(state['eye'], state['target'])]
    actual_length = math.sqrt(sum(value * value for value in actual_delta))
    require(math.isfinite(actual_length) and actual_length > 1e-9,
            'Capture ROI camera direction readback is invalid')
    actual_direction = [value / actual_length for value in actual_delta]
    require(near_state(state, {'target': target, 'extents': list(extents)}) and
            near_state({'direction': actual_direction}, {'direction': direction}),
            'Capture ROI camera readback mismatch')
    framing = {'kind': recipe['kind'], 'target': state['target'], 'extents': state['extents'],
               'direction': actual_direction}
    if recipe['kind'] == 'detail':
        framing.update(fittedExtents=fitted['extents'], scale=recipe['scale'])
    return actual, framing


def _review_section(design, recipe):
    if not hasattr(design, 'analyses') or not hasattr(design.analyses, 'sectionAnalyses'):
        return {'status': 'unsupported', 'name': recipe['sectionName']}, \
            lambda: {'status': 'unsupported'}
    analyses = design.analyses
    sections = analyses.sectionAnalyses
    rows = [sections.item(index) for index in range(sections.count)]
    matches = [section for section in rows if section.name == recipe['sectionName']]
    if len(matches) != 1:
        return {'status': 'failed', 'name': recipe['sectionName']}, \
            lambda: {'status': 'failed'}
    section = matches[0]
    try:
        section_supported = hasattr(section, 'isLightBulbOn')
        folder_supported = hasattr(analyses, 'isLightBulbOn')
        section_before = getattr(section, 'isLightBulbOn', None)
        folder_before = getattr(analyses, 'isLightBulbOn', None)
    except Exception:
        return {'status': 'unknown', 'name': recipe['sectionName']}, \
            lambda: {'status': 'unknown'}
    if not section_supported or not folder_supported or section_before is None or folder_before is None:
        return {'status': 'unsupported', 'name': recipe['sectionName']}, \
            lambda: {'status': 'unsupported'}

    def readback():
        try:
            section_actual = section.isLightBulbOn
            folder_actual = analyses.isLightBulbOn
        except Exception:
            return {'status': 'unknown'}
        statuses = [
            capture_apply_status(recipe['visible'], section_actual),
            capture_apply_status(True, folder_actual),
        ]
        return {'status': capture_aggregate_status([{'status': value} for value in statuses]),
                'sectionVisible': section_actual, 'analysesVisible': folder_actual}

    def restore():
        try:
            section.isLightBulbOn = section_before
            analyses.isLightBulbOn = folder_before
            section_actual = section.isLightBulbOn
            folder_actual = analyses.isLightBulbOn
        except Exception:
            return {'status': 'unknown'}
        rows = [
            {'status': capture_restore_status(section_before, section_actual)},
            {'status': capture_restore_status(folder_before, folder_actual)},
        ]
        return {'status': capture_aggregate_status(rows), 'sectionVisible': section_actual,
                'analysesVisible': folder_actual}

    try:
        analyses.isLightBulbOn = True
        section.isLightBulbOn = recipe['visible']
    except Exception:
        return {'status': 'failed', 'name': recipe['sectionName']}, restore
    applied = readback()
    readback = {'status': 'verified' if applied['status'] == 'restored' else applied['status'],
                'name': recipe['sectionName'], 'requestedVisible': recipe['visible'],
                'actualVisible': applied.get('sectionVisible'),
                'analysesVisible': applied.get('analysesVisible')}

    return readback, restore


def capture_review(app, core, fusion, args):
    report = {'schemaVersion': 1, 'operation': 'review', 'requestId': args['requestId'],
              'success': False, 'status': 'failed', 'requiresVisualReview': True,
              'startedAt': datetime.now(timezone.utc).isoformat(), 'fusionBuild': None,
              'documentIdentity': None, 'views': [], 'captureRecipes': [], 'errors': [],
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
            result = action()
            status = result.get('status', 'restored') if isinstance(result, dict) else 'restored'
            step = {'name': name, 'status': status}
            if isinstance(result, dict):
                step['readback'] = result
            report['restoration']['steps'].append(step)
            if status != 'restored':
                error('restore.' + name, RuntimeError('Restoration readback status: ' + status))
            return status
        except Exception as exc:
            error('restore.' + name, exc)
            report['restoration']['steps'].append({'name': name, 'status': 'failed'})
            return 'failed'

    def restore_view(doc, state, name):
        def camera():
            require(app.activeDocument == doc, 'Wrong active document during camera restore')
            restore_camera(app.activeViewport, state['camera'], core)

        def style():
            require(app.activeDocument == doc, 'Wrong active document during style restore')
            app.activeViewport.visualStyle = state['style']
            require(capture_restore_status(state['style'], app.activeViewport.visualStyle) == 'restored',
                    'Visual style restoration mismatch')

        def colors():
            require(app.activeDocument == doc, 'Wrong active document during component-color restore')
            app.isComponentColorsDisplayed = state['colors']
            require(capture_restore_status(state['colors'], app.isComponentColorsDisplayed) == 'restored',
                    'Component-color restoration mismatch')

        restore_step(name + '.camera', camera)
        restore_step(name + '.style', style)
        restore_step(name + '.colors', colors)

    try:
        require(args.get('docId') or args.get('docFileId'), 'A pinned document identity is required')
        for key in ('width', 'height'):
            require(type(args[key]) is int and 32 <= args[key] <= 4096, 'Invalid image ' + key)
        require(args['width'] * args['height'] <= 16000000, 'Image exceeds 16 megapixels')
        recipes = _review_recipes(args)
        report['captureRecipes'] = recipes
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
        for recipe in recipes:
            name = recipe['name']
            stage = 'capture.' + name
            section_restore = None
            row = {'name': name, 'file': name + '.png', 'status': 'attempted',
                   'recipeKind': recipe['kind'], 'width': args['width'], 'height': args['height'],
                   'visualStyle': 'shaded-with-visible-edges', 'componentColors': False,
                   'requestedOrientation': recipe['orientation']}
            try:
                idle(app)
                require(app.activeDocument == target, 'Active document changed during capture')
                _document_assert_identity(target, args.get('docId'), args.get('docFileId'))
                require(document_identity(target) == report['documentIdentity'],
                        'Document state changed during review')
                require(viewport.visualStyle == core.VisualStyles.ShadedWithVisibleEdgesOnlyVisualStyle and
                        app.isComponentColorsDisplayed is False, 'Capture display settings mismatch')
                report['views'].append(row)
                if recipe['kind'] == 'section':
                    row['sectionReadback'], section_restore = _review_section(
                        fusion.Design.cast(target.products.itemByProductType('DesignProductType')), recipe)
                    require(row['sectionReadback']['status'] == 'verified',
                            'Section recipe readback is ' + row['sectionReadback']['status'])
                actual, framing = _review_camera(viewport, core, recipe)
                require(actual.cameraType == core.CameraTypes.OrthographicCameraType,
                        'Capture projection readback mismatch')
                row['camera'] = camera_state(actual, core)
                row['orientationReadback'] = int(actual.viewOrientation)
                if framing is not None:
                    row['framingReadback'] = framing
                temporary = os.path.join(staging, row['file'])
                require(not os.path.lexists(temporary), 'Capture staging path already exists')
                require(viewport.saveAsImageFile(temporary, args['width'], args['height']),
                        'Image capture returned false')
                with open(temporary, 'rb') as stream:
                    data = stream.read()
                require(len(data) >= 24 and data[:8] == b'\x89PNG\r\n\x1a\n' and
                        data[12:16] == b'IHDR' and
                        struct.unpack('>II', data[16:24]) == (args['width'], args['height']),
                        'Invalid PNG header/dimensions')
                with open(os.path.join(out, row['file']), 'xb') as stream:
                    stream.write(data)
                row.update(status='captured', sizeBytes=len(data), sha256=hashlib.sha256(data).hexdigest())
                os.unlink(temporary)
            finally:
                if section_restore is not None:
                    restore_step(name + '.section', section_restore)
        os.rmdir(staging)
        stage = 'verifyOrientations'
        report['orientationVerification'] = (
            verify_view_directions(report['views']) if recipes == DEFAULT_RECIPES else
            read_view_directions(report['views']))
        def pixel_frames():
            for row in report['views']:
                with open(os.path.join(out, row['file']), 'rb') as stream:
                    image = stream.read()
                camera = row['camera']
                yield {'name': row['name'], 'bytes': image, 'width': args['width'],
                       'height': args['height'],
                       'direction': [a - b for a, b in zip(camera['eye'], camera['target'])]}
        report['pixelIntegrity'] = analyze_capture_pixels(pixel_frames())
        require(report['pixelIntegrity']['status'] != 'failed',
                'Capture pixel integrity policy failed')
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
            report['restoration']['status'] = capture_aggregate_status(report['restoration']['steps'])
        if target is not None and report['documentIdentity'] is not None:
            try:
                report['documentAfter'] = document_identity(target)
                require(report['documentAfter'] == report['documentIdentity'], 'Document saved/dirty/identity state changed')
            except Exception as exc:
                error('documentAfter', exc)
    report['success'] = (not report['errors'] and len(report['views']) == len(report['captureRecipes']) and
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
