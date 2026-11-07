"""Opt-in native readback checks for pre-created unsaved synthetic documents."""
import adsk.core
import adsk.fusion
import hashlib
import json
import math
import os
import tempfile
import uuid


ARGS = {}
DOC_NAME = ''
AUTHORIZATION = 'I authorize native capture-integrity qualification'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def same_vector(left, right, tolerance=1e-7):
    return len(left) == len(right) and all(abs(a - b) <= tolerance for a, b in zip(left, right))


def snapshot(app, doc):
    require(app.activeDocument == doc, 'Cannot snapshot a non-active document viewport')
    camera = app.activeViewport.camera
    state = {
        'cameraType': int(camera.cameraType),
        'eye': list(camera.eye.asArray()),
        'target': list(camera.target.asArray()),
        'up': list(camera.upVector.asArray()),
        'visualStyle': int(app.activeViewport.visualStyle),
        'componentColors': app.isComponentColorsDisplayed,
    }
    if camera.cameraType == adsk.core.CameraTypes.OrthographicCameraType:
        ok, width, height = camera.getExtents()
        require(ok, 'Camera extent readback unavailable')
        state['extents'] = [width, height]
    else:
        state['perspectiveAngle'] = camera.perspectiveAngle
    return state


def restored(app, doc, expected):
    actual = snapshot(app, doc)
    return (actual['cameraType'] == expected['cameraType'] and
            same_vector(actual['eye'], expected['eye']) and
            same_vector(actual['target'], expected['target']) and
            same_vector(actual['up'], expected['up']) and
            actual['visualStyle'] == expected['visualStyle'] and
            actual['componentColors'] == expected['componentColors'] and
            ('extents' not in expected or same_vector(actual['extents'], expected['extents'])) and
            ('perspectiveAngle' not in expected or
             abs(actual['perspectiveAngle'] - expected['perspectiveAngle']) <= 1e-7))


def section_visibility_state(doc, name):
    design = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
    require(design is not None, 'Target lost its Fusion Design product during section readback')
    matches = [section for section in design.analyses.sectionAnalyses if section.name == name]
    require(len(matches) == 1, 'Exact synthetic section is missing or ambiguous')
    return {'section': matches[0].isLightBulbOn,
            'analyses': design.analyses.isLightBulbOn}


def temp_output_root():
    value = ARGS.get('outputRoot')
    if value is None:
        temp = os.path.realpath(tempfile.gettempdir())
        value = os.path.join(temp, 'fmcad-capture-integrity-' + uuid.uuid4().hex)
    require(isinstance(value, str) and os.path.isabs(value),
            'outputRoot must be an absolute Fusion-host temporary path')
    root = os.path.realpath(value)
    allowed = ARGS.get('allowedRoot')
    if allowed is None:
        temp = os.path.realpath(tempfile.gettempdir())
        try:
            inside = os.path.commonpath([temp, root]) == temp
        except ValueError:
            inside = False
        require(inside, 'Native evidence output must be inside the OS temporary directory')
    else:
        require(isinstance(allowed, str) and os.path.isabs(allowed) and
                os.path.basename(os.path.realpath(allowed)).startswith(
                    'fmcad-capture-integrity-native-'),
                'allowedRoot must be this run’s unique native evidence directory')
        try:
            inside = os.path.commonpath([os.path.realpath(allowed), root]) == os.path.realpath(allowed)
        except ValueError:
            inside = False
        require(inside and root != os.path.realpath(allowed),
                'Native evidence output must be a fresh child of this run’s evidence directory')
    require(not os.path.lexists(value), 'Native evidence output path already exists')
    os.mkdir(root)
    return root


def image_artifacts(root):
    result = []
    for directory, _, filenames in os.walk(root):
        for filename in sorted(filenames):
            if not filename.lower().endswith('.png'):
                continue
            path = os.path.join(directory, filename)
            with open(path, 'rb') as stream:
                data = stream.read()
            result.append({'path': path, 'name': os.path.relpath(path, root),
                           'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    return result


def pixel_integrity_from_error(message):
    marker = 'Shot pixel integrity policy failed: '
    if not isinstance(message, str) or marker not in message:
        return None
    try:
        return json.loads(message.split(marker, 1)[1])
    except Exception:
        return None


def verify_fixture_geometry(doc, expected):
    design = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
    require(design is not None, 'Pinned asymmetric scratch is no longer a Fusion Design')
    bodies = design.rootComponent.bRepBodies
    require(bodies.count == 1, 'Pinned asymmetric scratch must contain exactly one solid body')
    body = bodies.item(0)
    require(body.isValid and body.volume > 0, 'Pinned asymmetric solid is invalid or empty')
    bounds = body.boundingBox
    geometry = expected.get('geometryReadback') or {}
    require(geometry.get('bodyValid') is True and
            abs(geometry.get('volume', -1) - body.volume) <= 1e-7 and
            same_vector(geometry.get('minimum', []), bounds.minPoint.asArray()) and
            same_vector(geometry.get('maximum', []), bounds.maxPoint.asArray()),
            'Pinned asymmetric geometry differs from the fixture creation readback')


def run(_context):
    require(ARGS.get('authorization') == AUTHORIZATION and ARGS.get('action') == 'capture',
            'Explicit user authorization and action=capture are required')
    documents = ARGS.get('documents')
    require(isinstance(documents, list) and len(documents) == 3 and
            {row.get('role') for row in documents} == {'BLANK', 'ASYMMETRIC', 'SYMMETRIC'},
            'Capture requires the exact three inspected synthetic document pins')
    app = adsk.core.Application.get()
    matches = [row for row in documents
               if row['role'] == 'ASYMMETRIC' and row['name'] == DOC_NAME]
    require(len(matches) == 1 and matches[0]['creationId'] == FMCAD.doc.creationId and
            not FMCAD.doc.isSaved and FMCAD.doc.isModified == matches[0]['isModified'],
            'Pinned document is not the owned unsaved asymmetric synthetic design')
    target = FMCAD.doc
    target_modified_before = target.isModified
    require(not target.isSaved and target_modified_before == matches[0]['isModified'],
            'Synthetic target identity or pre-capture dirty state changed')
    verify_fixture_geometry(target, matches[0])
    root = temp_output_root()
    report = {
        'status': 'failed',
        'fusionBuild': app.version,
        'target': {'name': target.name, 'creationId': target.creationId},
        'outputRoot': root,
        'saved': False,
        'cases': [],
    }

    section_name = ARGS.get('sectionName')
    section_before = None
    if section_name:
        try:
            section_before = section_visibility_state(target, section_name)
        except Exception as error:
            section_name = None
            report['sectionSetupError'] = type(error).__name__ + ': ' + str(error)

    target_before = snapshot(app, target)
    custom_dir = os.path.join(root, 'custom')
    os.mkdir(custom_dir)
    custom_shots = [
            {'path': os.path.join(custom_dir, 'roi.png'), 'width': 640, 'height': 480,
             'camera': {'orientation': 'front', 'target': ['15 mm', '10 mm', '5 mm'],
                        'extents': ['40 mm', '30 mm'], 'fit': False}},
            {'path': os.path.join(custom_dir, 'detail.png'), 'width': 640, 'height': 480,
             'camera': {'orientation': 'front', 'target': ['15 mm', '10 mm', '5 mm'],
                        'extents': ['8 mm', '6 mm'], 'fit': False}},
    ]
    if section_name:
        custom_shots.append({'path': os.path.join(custom_dir, 'section.png'), 'width': 640, 'height': 480,
             'camera': {'orientation': 'left', 'fit': True},
             'sections': [{'name': section_name, 'isLightBulbOn': True}]})
    try:
        custom = FMCAD.call('shot.pack', {'shots': custom_shots})
    except Exception as error:
        camera_restored = restored(app, target, target_before)
        presentation_status = 'unsupported'
        presentation_after = None
        if section_before is not None:
            try:
                presentation_after = section_visibility_state(target, section_name)
                presentation_status = 'restored' if presentation_after == section_before else 'failed'
            except Exception:
                presentation_status = 'unknown'
        target_clean = (not target.isSaved and target.isModified == target_modified_before)
        report['cases'].append({
            'name': 'roi-detail-section-readback',
            'status': 'failed' if camera_restored and target_clean and
                      presentation_status in ('restored', 'unsupported') else 'unknown',
            'error': str(error),
            'cameraRestored': camera_restored,
            'sectionRestoration': presentation_status,
            'sectionStateBefore': section_before,
            'sectionStateAfter': presentation_after,
            'targetClean': target_clean,
        })
        report['targetReadbackRestored'] = camera_restored and presentation_status in (
            'restored', 'unsupported')
        report['targetUnsavedAndClean'] = target_clean
        report['imageArtifacts'] = image_artifacts(root)
        report['status'] = 'failed' if camera_restored and target_clean and \
            presentation_status in ('restored', 'unsupported') else 'unknown'
        FMCAD.emit(report)
        return report
    images = custom.get('images', [])
    camera_restored = custom.get('cameraRestored') is True and restored(app, target, target_before)
    presentation_restore = custom.get('presentationRestoration', {}).get('status')
    if not camera_restored or presentation_restore in ('failed', 'unknown', 'unsupported'):
        report['cases'].append({
            'name': 'roi-detail-section-readback',
            'status': 'blocked-restore',
            'cameraRestored': camera_restored,
            'presentationRestoration': presentation_restore,
            'result': custom,
        })
        report['imageArtifacts'] = image_artifacts(root)
        report['status'] = 'unknown'
        FMCAD.emit(report)
        return report
    section_capture = ('unsupported' if not section_name else
                       custom.get('presentationCapture', {}).get('status'))
    section_restore = ('unsupported' if not section_name else
                       custom.get('presentationRestoration', {}).get('status'))
    state_unknown = (not section_name or
                     section_capture in ('unsupported', 'unknown') or
                     section_restore in ('unsupported', 'unknown'))
    custom_verified = (
        custom.get('cameraRestored') is True and
        custom.get('pixelIntegrity', {}).get('status') in ('verified', 'review-required') and
        len(images) == len(custom_shots) and
        same_vector(images[0].get('camera', {}).get('extents', []), [4, 3]) and
        same_vector(images[1].get('camera', {}).get('extents', []), [0.8, 0.6]) and
        custom.get('status') != 'failed' and
        camera_restored)
    section_restored = (not state_unknown and
                        section_capture == 'restored' and section_restore == 'restored')
    section_honestly_unsupported = (
        not section_name or
        (state_unknown and
        custom.get('status') in ('unknown', None) and
        custom.get('presentationRestored') in (True, None)))
    custom_status = (
        'passed' if custom_verified and section_restored else
        'blocked-unsupported' if custom_verified and section_honestly_unsupported else
        'failed')
    report['cases'].append({
        'name': 'roi-detail-section-readback',
        'status': custom_status,
        'sectionCapture': section_capture,
        'sectionRestoration': section_restore,
        'result': custom,
    })

    duplicate_dir = os.path.join(root, 'duplicate')
    os.mkdir(duplicate_dir)
    try:
        FMCAD.call('shot.pack', {'shots': [
            {'path': os.path.join(duplicate_dir, 'front-a.png'), 'width': 640, 'height': 480,
             'camera': {'orientation': 'front', 'fit': True}},
            {'path': os.path.join(duplicate_dir, 'front-b.png'), 'width': 640, 'height': 480,
             'camera': {'orientation': 'front', 'fit': True}},
        ]})
        duplicate_case = {'name': 'same-direction-duplicate', 'status': 'failed',
                          'cameraRestored': restored(app, target, target_before),
                          'message': 'Duplicate frame was not rejected'}
    except Exception as error:
        duplicate_camera_restored = restored(app, target, target_before)
        duplicate_pixels = pixel_integrity_from_error(str(error))
        duplicate_case = {
            'name': 'same-direction-duplicate',
            'status': ('passed' if duplicate_pixels and duplicate_pixels.get('status') == 'failed' and
                       duplicate_pixels.get('duplicatePairs') and duplicate_camera_restored else 'failed'),
            'message': str(error),
            'pixelIntegrity': duplicate_pixels,
            'cameraRestored': duplicate_camera_restored,
        }
    report['cases'].append(duplicate_case)
    if duplicate_case['cameraRestored'] is False:
        report['imageArtifacts'] = image_artifacts(root)
        report['status'] = 'unknown'
        FMCAD.emit(report)
        return report

    partial_dir = os.path.join(root, 'partial')
    os.mkdir(partial_dir)
    first_partial = os.path.join(partial_dir, 'front.png')
    second_partial = os.path.join(partial_dir, 'invalid-framing.png')
    partial_error = None
    try:
        FMCAD.call('shot.pack', {'shots': [
            {'path': first_partial, 'width': 640, 'height': 480,
             'camera': {'orientation': 'front', 'fit': True}},
            {'path': second_partial, 'width': 640, 'height': 480,
             'camera': {'orientation': 'front', 'target': ['15 mm', '10 mm', '5 mm'],
                        'extents': ['not-a-length', '30 mm'], 'fit': False}},
        ]})
    except Exception as error:
        partial_error = str(error)
    partial_camera_restored = restored(app, target, target_before)
    partial_rows = image_artifacts(partial_dir)
    partial_first_exists = os.path.isfile(first_partial) and os.path.getsize(first_partial) > 0
    partial_second_absent = not os.path.lexists(second_partial)
    partial_case = {
        'name': 'partial-files-after-later-shot-failure',
        'status': ('passed' if partial_error and partial_first_exists and
                   partial_second_absent and partial_camera_restored else
                   'unknown' if not partial_camera_restored else 'failed'),
        'error': partial_error,
        'firstImageRetained': partial_first_exists,
        'failedImageAbsent': partial_second_absent,
        'cameraRestored': partial_camera_restored,
        'imageArtifacts': partial_rows,
    }
    report['cases'].append(partial_case)
    if not partial_camera_restored:
        report['imageArtifacts'] = image_artifacts(root)
        report['status'] = 'unknown'
        FMCAD.emit(report)
        return report

    report['targetReadbackRestored'] = restored(app, target, target_before)
    report['targetUnsavedAndClean'] = (not target.isSaved and
                                       target.isModified == target_modified_before)
    rows = report['cases']
    if all(row['status'] == 'passed' for row in rows):
        report['status'] = ('passed' if report['targetReadbackRestored'] and
                            report['targetUnsavedAndClean'] else 'failed')
    elif any(row['status'] == 'failed' for row in rows):
        report['status'] = 'failed'
    else:
        report['status'] = 'blocked-unsupported'
    report['imageArtifacts'] = image_artifacts(root)
    FMCAD.emit(report)
    return report
