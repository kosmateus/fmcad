"""Document-scoped I/O. Paths are local to the machine running Fusion.

API reference: Autodesk Fusion API Camera/Viewport, SectionAnalyses.createInput,
Canvas.transform (Matrix2D), ImportManager, ExportManager, Materials.addByCopy,
Appearances.addByCopy. No UI text commands, downloads, or implicit document saves.
"""
import os
from pathlib import Path


def _io_path(ctx, data, key='path', output=False, suffixes=None):
    value = data[key]
    if not isinstance(value, str) or not value.strip():
        raise ValueError(key + ' must be a nonempty absolute Fusion-machine path')
    path = Path(value)
    if not path.is_absolute():
        raise ValueError('Use an absolute path on the machine running Fusion; the integrator maps client paths')
    if suffixes and path.suffix.lower() not in suffixes:
        raise ValueError('Expected extension: ' + ', '.join(suffixes))
    if output:
        if not path.parent.is_dir():
            raise ValueError('Output parent directory must already exist on the Fusion machine')
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ValueError('Output must be a regular file, not a directory or symbolic link')
        if path.exists():
            if data.get('overwrite') is not True:
                raise ValueError('Existing output requires overwrite: true and confirm: true')
            ctx.require_confirm(data)
    elif not path.is_file():
        raise ValueError('Input file does not exist on the machine running Fusion: ' + str(path))
    return path


def _io_file(path):
    exists = path.is_file()
    return {'path': str(path), 'exists': exists, 'bytes': path.stat().st_size if exists else None,
            'pathHost': 'machine running Fusion', 'geometryVerified': False}


def _io_viewport(ctx):
    if ctx.app.activeDocument != ctx.doc:
        raise ValueError('View operations require the explicitly scoped document to already be active; activate it first')
    viewport = ctx.app.activeViewport
    if viewport.parentDocument != ctx.doc:
        raise ValueError('Active viewport does not belong to the scoped document')
    return viewport


def _io_identity(ctx):
    return {'creationId': ctx.doc.creationId, 'name': ctx.doc.name,
            'dataFileId': ctx.doc.dataFile.id if ctx.doc.dataFile else None}


def _io_state_doc(ctx, state):
    if state.get('document') != _io_identity(ctx):
        raise ValueError('State belongs to a different document; recapture state for this document')


def _io_visibility(ctx, data, action):
    _cad_fields(data, ('state',) if action == 'restore' else ('refs',),
                ('scope',) if action == 'isolate' else ())
    if action == 'restore':
        _io_state_doc(ctx, data['state'])
        rows = data['state']['items']
        entities = [ctx.resolve(r['ref']) for r in rows]
        values = [r['isLightBulbOn'] for r in rows]
        if any(type(v) is not bool for v in values):
            raise ValueError('Visibility state values must be boolean')
    else:
        if not isinstance(data['refs'], list) or not data['refs']:
            raise ValueError('refs must be a nonempty array')
        selected = [ctx.resolve(r) for r in data['refs']]
        entities = selected
        values = [action == 'show'] * len(entities)
        if action == 'isolate':
            if not isinstance(data.get('scope'), list) or not data['scope']:
                raise ValueError('isolate requires explicit scope refs; use sibling bodies or sibling occurrences')
            entities = [ctx.resolve(r) for r in data['scope']]
            if any(e not in entities for e in selected):
                raise ValueError('Every selected ref must be in isolate scope')
            values = [e in selected for e in entities]
    if any(not hasattr(e, 'isLightBulbOn') for e in entities):
        raise ValueError('Target lacks isLightBulbOn; select bodies, occurrences, sketches, or construction geometry')
    before = {'document': _io_identity(ctx), 'items': [
        {'ref': ctx.ref(e), 'isLightBulbOn': e.isLightBulbOn} for e in entities]}
    for entity, value in zip(entities, values):
        entity.isLightBulbOn = value
    return {'restoreState': before, 'items': [
        {'ref': ctx.ref(e), 'isLightBulbOn': e.isLightBulbOn,
         'isVisible': getattr(e, 'isVisible', None)} for e in entities],
        'limitations': ['Only specified light bulbs change; ancestor and folder visibility can still hide entities.']}


def _io_camera_state(ctx, camera):
    types = adsk.core.CameraTypes
    names = ('OrthographicCameraType', 'PerspectiveCameraType', 'PerspectiveWithOrthoFacesCameraType')
    name = next((n for n in names if getattr(types, n) == camera.cameraType), None)
    if name is None:
        raise ValueError('Unsupported camera type; cannot provide a restorable snapshot')
    state = {'document': _io_identity(ctx), 'eye': _cad_xyz(camera.eye),
             'target': _cad_xyz(camera.target), 'up': _cad_xyz(camera.upVector),
             'cameraType': name, 'units': 'cm'}
    if name == 'OrthographicCameraType':
        if not hasattr(camera, 'getExtents'):
            raise ValueError('Installed API lacks Camera.getExtents; update Fusion to capture restorable orthographic views')
        ok, width, height = camera.getExtents()
        _cad_require_result(ok, 'Read camera extents')
        state['extents'] = [width, height]
    else:
        state['perspectiveAngle'] = camera.perspectiveAngle
    return state


def _io_camera_from_state(ctx, state, validate_only=False):
    _io_state_doc(ctx, state)
    if state.get('units') != 'cm':
        raise ValueError('Camera snapshot units must be cm')
    names = ('OrthographicCameraType', 'PerspectiveCameraType', 'PerspectiveWithOrthoFacesCameraType')
    if state.get('cameraType') not in names:
        raise ValueError('Unsupported snapshot cameraType')
    camera_type = getattr(adsk.core.CameraTypes, state['cameraType'])
    points = []
    for key in ('eye', 'target'):
        xyz = state[key]
        if len(xyz) != 3 or any(type(v) not in (float, int) or not math.isfinite(v) for v in xyz):
            raise ValueError('Snapshot points must contain three finite numbers')
        points.append(adsk.core.Point3D.create(*xyz))
    direction = _cad_direction([b - a for a, b in zip(state['eye'], state['target'])])
    up = _cad_direction(state['up'])
    if abs(sum(a * b for a, b in zip(direction, up))) > 1 - 1e-9:
        raise ValueError('Camera up must not be parallel to sight direction')
    if state['cameraType'] == 'OrthographicCameraType':
        extents = state['extents']
        if len(extents) != 2 or any(type(v) not in (int, float) or not math.isfinite(v) or v <= 0 for v in extents):
            raise ValueError('Camera extents must be two positive finite cm values')
    else:
        angle = state['perspectiveAngle']
        if type(angle) not in (int, float) or not 0 < angle < math.pi:
            raise ValueError('Perspective angle must be between zero and pi radians')
    if validate_only:
        return
    # Validation must not exercise native camera setters.
    camera = _io_viewport(ctx).camera
    camera.isFitView = False
    camera.isSmoothTransition = False
    if camera.cameraType != camera_type:
        camera.cameraType = camera_type
    if state['cameraType'] == 'OrthographicCameraType':
        _cad_require_result(camera.setExtents(*extents), 'Set camera extents')
    elif camera.perspectiveAngle != angle:
        camera.perspectiveAngle = angle
    # Projection/framing setters can adjust the pose. Explicit pose takes precedence.
    camera.target = points[1]
    camera.eye = points[0]
    camera.upVector = adsk.core.Vector3D.create(*up)
    camera.isFitView = False
    camera.isSmoothTransition = False
    return camera


def _io_camera_apply(ctx, state, orientation=None, fit=False):
    viewport = _io_viewport(ctx)
    before = _io_camera_state(ctx, viewport.camera)
    _io_camera_from_state(ctx, state, validate_only=True)

    def apply(snapshot, view=None, fit_view=False):
        current = viewport.camera
        camera_type = getattr(adsk.core.CameraTypes, snapshot['cameraType'])
        projection_changed = current.cameraType != camera_type
        perspective = snapshot['cameraType'] != 'OrthographicCameraType'
        if projection_changed or (perspective and current.perspectiveAngle != snapshot['perspectiveAngle']):
            current.isFitView = False
            current.isSmoothTransition = False
            if projection_changed:
                current.cameraType = camera_type
            if perspective:
                current.perspectiveAngle = snapshot['perspectiveAngle']
            viewport.camera = current
            # Native projection/FOV application can move the eye. Read back the
            # settled lens before applying explicit pose and orthographic extents.
        prepared = _io_camera_from_state(ctx, snapshot)
        if view is not None:
            prepared.viewOrientation = view
        prepared.isFitView = fit_view
        viewport.camera = prepared

    try:
        apply(state, orientation, fit)
    except Exception as error:
        try:
            apply(before)
        except Exception as restore_error:
            raise RuntimeError('Camera apply failed: ' + str(error) +
                               '; camera rollback also failed: ' + str(restore_error)) from error
        raise


def _io_camera(ctx, data, action):
    if action == 'save':
        _cad_fields(data)
        return {'state': _io_camera_state(ctx, _io_viewport(ctx).camera)}
    _cad_fields(data, ('state',) if action == 'restore' else (),
                () if action == 'restore' else ('orientation', 'eye', 'target', 'up', 'projection', 'extents', 'perspectiveAngle', 'fit'))
    viewport = _io_viewport(ctx)
    before = _io_camera_state(ctx, viewport.camera)
    orientation = None
    fit = False
    if action == 'restore':
        state = data['state']
    else:
        state = dict(before)
        if not data:
            raise ValueError('camera.set requires at least one camera setting')
        for key in ('eye', 'target'):
            if key in data:
                state[key] = _cad_xyz(ctx.point(data[key]))
        if 'up' in data:
            state['up'] = data['up']
        if 'projection' in data:
            projections = {'orthographic': 'OrthographicCameraType', 'perspective': 'PerspectiveCameraType'}
            if data['projection'] not in projections:
                raise ValueError('projection must be orthographic or perspective')
            state['cameraType'] = projections[data['projection']]
        if 'extents' in data:
            state['extents'] = [ctx.length(v) for v in data['extents']]
        if state['cameraType'] == 'OrthographicCameraType' and 'extents' not in state:
            raise ValueError('Switching to orthographic requires extents')
        if 'perspectiveAngle' in data:
            state['perspectiveAngle'] = ctx.angle(data['perspectiveAngle'])
        if state['cameraType'] != 'OrthographicCameraType' and 'perspectiveAngle' not in state:
            raise ValueError('Switching to perspective requires perspectiveAngle')
        if state['cameraType'] == 'OrthographicCameraType' and 'perspectiveAngle' in data:
            raise ValueError('perspectiveAngle requires perspective projection')
        if state['cameraType'] != 'OrthographicCameraType' and 'extents' in data:
            raise ValueError('extents requires orthographic projection')
        if 'orientation' in data:
            if any(k in data for k in ('eye', 'up')):
                raise ValueError('orientation cannot be combined with eye or up (a named orientation fixes the direction and up); use target, extents, fit, projection and perspectiveAngle for framing')
            orientations = {'front': 'Front', 'back': 'Back', 'top': 'Top', 'bottom': 'Bottom',
                            'left': 'Left', 'right': 'Right', 'iso-top-left': 'IsoTopLeft',
                            'iso-top-right': 'IsoTopRight', 'iso-bottom-left': 'IsoBottomLeft',
                            'iso-bottom-right': 'IsoBottomRight'}
            if data['orientation'] not in orientations:
                raise ValueError('Unsupported orientation: ' + str(data['orientation']))
            orientation = getattr(adsk.core.ViewOrientations, orientations[data['orientation']] + 'ViewOrientation')
        if type(data.get('fit', False)) is not bool:
            raise ValueError('fit must be boolean')
        fit = data.get('fit', False)
    _io_camera_apply(ctx, state, orientation, fit)
    return {'restoreState': before, 'state': _io_camera_state(ctx, viewport.camera),
            'limitations': ['Restoring to a different viewport aspect ratio can change framing.']}


def _io_cleanup(primary, actions):
    """Attempt each cleanup; retain a pending failure as the aggregate's cause."""
    errors = []
    first_error = None
    for action, cleanup in actions:
        try:
            cleanup()
        except Exception as error:
            if first_error is None:
                first_error = error
            errors.append({'action': action, 'type': type(error).__name__, 'message': str(error)})
    if errors:
        payload = {'primaryError': None if primary is None else {
            'type': type(primary).__name__, 'message': str(primary)}, 'cleanupErrors': errors}
        raise RuntimeError('I/O cleanup failed: ' + json.dumps(payload)) from (
            primary if primary is not None else first_error)


def _io_vis_chain(entity):
    chain = [entity]
    seen = {id(entity)}
    current = entity
    while True:
        parent = getattr(current, 'assemblyContext', None)
        if parent is None or id(parent) in seen:
            break
        chain.append(parent)
        seen.add(id(parent))
        current = parent
    return chain


def _io_capture_bulbs(entities):
    rows = []
    seen = []
    for entity in entities:
        for target in _io_vis_chain(entity):
            if not any(target is other for other in seen):
                seen.append(target)
                rows.append((target, getattr(target, 'isLightBulbOn', None)))
    return rows


def _io_restore_bulbs(rows):
    """Restore captured light-bulb state with the per-entity setter.

    SectionAnalysis.isLightBulbOn does not persist through the public SDK: the
    per-entity setter is a silent no-op and Design.setLightBulbOn does not accept
    SectionAnalysis instances. The restore is therefore best-effort; callers must
    not assert a restored section bulb value after shot.pack.
    """
    errors = []
    for target, value in rows:
        if value is None:
            continue
        try:
            target.isLightBulbOn = value
        except Exception as error:
            errors.append({'action': 'visibility', 'type': type(error).__name__, 'message': str(error)})
    return errors


def _io_section_by_name(ctx, name):
    sections = ctx.design.analyses.sectionAnalyses
    return _cad_unique([s for s in _cad_items(sections) if s.name == name], 'Section name')


def _io_restore_raise(errors, label):
    if errors:
        raise RuntimeError(label + ' failed: ' + json.dumps(errors))


def _io_activate_component(ctx, entity):
    """Activate a component/occurrence through the public SDK.

    Fusion has no ``Component.activate``; the root component is activated via
    ``Design.activateRootComponent`` and a nested component is activated through
    its placed ``Occurrence.activate``. A bare non-root component definition with
    no placed occurrence cannot be activated and is refused honestly.
    """
    if _cad_kind(entity) == 'occurrence':
        return entity.activate()
    if entity == ctx.root:
        return ctx.design.activateRootComponent()
    for occurrence in _cad_items(ctx.root.allOccurrences):
        if getattr(occurrence, 'component', None) is entity:
            return occurrence.activate()
    raise ValueError('activeComponent resolves to a non-root component with no placed occurrence; '
                     'the public SDK cannot activate a bare component definition')


def _io_shot_presentation(ctx, shot, restore_actions, captured):
    if 'visibility' in shot:
        visibility = shot['visibility']
        if not isinstance(visibility, list) or not visibility:
            raise ValueError('visibility must be a nonempty array of {ref, isLightBulbOn}')
        entities, values = [], []
        for row in visibility:
            if not isinstance(row, dict) or set(row) != {'ref', 'isLightBulbOn'} or type(row['isLightBulbOn']) is not bool:
                raise ValueError('visibility rows accept {ref, isLightBulbOn:boolean} only')
            entities.append(ctx.resolve(row['ref']))
            values.append(row['isLightBulbOn'])
        captured['bulbs'] = _io_capture_bulbs(entities)
        for entity, value in zip(entities, values):
            entity.isLightBulbOn = value
        bulbs = captured['bulbs']
        restore_actions.append(('Restore presentation visibility',
                                lambda bulbs=bulbs: _io_restore_raise(_io_restore_bulbs(bulbs), 'Presentation visibility')))
    if 'sections' in shot:
        sections = shot['sections']
        if not isinstance(sections, list) or not sections:
            raise ValueError('sections must be a nonempty array of {name, isLightBulbOn}')
        analyses = ctx.design.analyses
        section_rows = []
        for row in sections:
            if not isinstance(row, dict) or set(row) != {'name', 'isLightBulbOn'} or type(row['isLightBulbOn']) is not bool:
                raise ValueError('sections rows accept {name, isLightBulbOn:boolean} only')
            section_rows.append((_io_section_by_name(ctx, row['name']), row['isLightBulbOn']))
        section_before = [(s, s.isLightBulbOn) for s, _ in section_rows]
        analyses_before = analyses.isLightBulbOn
        captured['sections'] = {'rows': section_before, 'analyses': analyses_before}
        for section, value in section_rows:
            section.isLightBulbOn = value

        def restore_sections(rows=section_before, folder=analyses, folder_bulb=analyses_before):
            errors = _io_restore_bulbs(rows)
            try:
                folder.isLightBulbOn = folder_bulb
            except Exception as error:
                errors.append({'action': 'analyses folder', 'type': type(error).__name__, 'message': str(error)})
            _io_restore_raise(errors, 'Section visibility')

        restore_actions.append(('Restore section visibility', restore_sections))
    if 'activeComponent' in shot:
        previous_active = ctx.design.activeComponent
        captured['activeComponent'] = previous_active
        target = ctx.resolve(shot['activeComponent'])
        if _cad_kind(target) not in ('component', 'occurrence'):
            raise ValueError('activeComponent must resolve to a component or occurrence')
        _cad_require_result(_io_activate_component(ctx, target), 'Activate component')
        restore_actions.append(('Restore active component',
                                lambda previous=previous_active: _cad_require_result(
                                    _io_activate_component(ctx, previous), 'Restore active component')))


def _io_shots(ctx, data):
    _cad_fields(data, ('shots',), ('overwrite', 'confirm'))
    if not isinstance(data['shots'], list) or not data['shots']:
        raise ValueError('shots must be a nonempty array')
    viewport = _io_viewport(ctx)
    pending = []
    for shot in data['shots']:
        _cad_fields(shot, ('path',), ('camera', 'width', 'height', 'visibility', 'sections', 'activeComponent'))
        path = _io_path(ctx, dict(data, path=shot['path']), output=True, suffixes=('.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'))
        width, height = shot.get('width', 0), shot.get('height', 0)
        if any(type(v) is not int or not 0 <= v <= 16384 for v in (width, height)):
            raise ValueError('Image width/height must be integers from 0 to 16384')
        pending.append((path, shot, width, height))
    if len({os.path.normcase(str(p.resolve())) for p, _, _, _ in pending}) != len(pending):
        raise ValueError('Shot output paths must be distinct')
    before = _io_camera_state(ctx, viewport.camera)
    images = []
    primary = None
    restore_actions = [('Restore original camera', lambda: _io_camera_apply(ctx, before))]
    captured = {}
    try:
        for path, shot, width, height in pending:
            if 'camera' in shot:
                _io_camera(ctx, shot['camera'], 'set')
            _io_shot_presentation(ctx, shot, restore_actions, captured)
            _cad_require_result(viewport.saveAsImageFile(str(path), width, height), 'Save image ' + str(path))
            row = _io_file(path)
            if not row['exists'] or not row['bytes']:
                raise RuntimeError('Image API reported success but output is missing or empty: ' + str(path))
            row['camera'] = _io_camera_state(ctx, viewport.camera)
            images.append(row)
    except BaseException as error:
        primary = error
        raise
    finally:
        _io_cleanup(primary, restore_actions)
    return {'images': images, 'restoreState': before, 'cameraRestored': True,
            'presentationRestored': True}


def _io_compare(ctx, data):
    _cad_fields(data, ('left', 'right'), ('mode',))
    if data.get('mode', 'pair') != 'pair':
        raise ValueError('Overlay compositing is not provided by the Fusion API; use mode pair and composite returned images externally')
    images = [_io_path(ctx, data, key, suffixes=('.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff')) for key in ('left', 'right')]
    return {'mode': 'pair', 'images': [_io_file(p) for p in images], 'metricVerification': False,
            'limitations': ['Visual pairing only; no registration, pixel overlay, dimensions, or geometric comparison.']}


def _io_section(ctx, data):
    _cad_fields(data, ('mode', 'name'), ('plane', 'offset', 'visible'))
    mode = data['mode']
    if not isinstance(data['name'], str) or not data['name'].strip():
        raise ValueError('name must be nonempty')
    if mode == 'helper':
        _cad_fields(data, ('mode', 'name', 'plane', 'offset'))
        result = ctx.call('datum.plane', {k: data[k] for k in ('name', 'plane', 'offset')})
        return {'representation': 'construction plane helper, NOT a clipping section', 'entity': result}
    if mode not in ('create', 'show', 'hide'):
        raise ValueError('mode must be create (real section), show, hide, or helper (no clipping)')
    if not hasattr(ctx.design, 'analyses') or not hasattr(ctx.design.analyses, 'sectionAnalyses'):
        raise ValueError('Installed API cannot access sections; update Fusion or use Inspect > Section Analysis in the UI')
    analyses = ctx.design.analyses
    sections = analyses.sectionAnalyses
    if mode == 'create':
        _cad_fields(data, ('mode', 'name', 'plane'), ('offset', 'visible'))
        if not hasattr(sections, 'createInput') or not hasattr(sections, 'add'):
            raise ValueError('Installed API cannot create sections; update Fusion or create one via Inspect > Section Analysis, then use show')
        if any(s.name == data['name'] for s in _cad_items(sections)):
            raise ValueError('Section name already exists')
        visible = data.get('visible', True)
        if type(visible) is not bool:
            raise ValueError('visible must be boolean')
        plane = ctx.resolve(data['plane'])
        if _cad_kind(plane) not in ('plane', 'face'):
            raise ValueError('Section plane must be a construction plane or planar face')
        inp = _cad_require_result(sections.createInput(plane, ctx.length(data.get('offset', '0 mm'))), 'Define real section')
        section = _cad_require_result(sections.add(inp), 'Create real section')
        section.name = data['name']
        ctx.created.append(ctx.ref(section))
    else:
        _cad_fields(data, ('mode', 'name'))
        section = _cad_unique([s for s in _cad_items(sections) if s.name == data['name']], 'Section name')
        visible = mode == 'show'
    before = {'section': section.isLightBulbOn, 'analyses': analyses.isLightBulbOn}
    section.isLightBulbOn = visible
    # Do not turn on unrelated analyses by toggling their shared parent folder.
    return {'representation': 'real section analysis', 'ref': ctx.ref(section), 'previousVisibility': before,
            'isVisible': section.isVisible, 'limitations': ['If the Analyses folder is hidden, enable it in the browser to see this section.']}


def _io_reference_image(ctx, data):
    if data.get('mode') == 'inspect' or 'source' in data:
        return _reference_image(ctx, data)
    _cad_fields(data, ('mode',), ('ref', 'segment', 'length', 'anchor', 'angle'))
    if data['mode'] != 'calibrate':
        raise ValueError('Canvas insertion is not exposed by the documented API used here. Insert > Canvas locally, then use mode calibrate with its token')
    _cad_fields(data, ('mode', 'ref', 'segment', 'length', 'anchor'), ('angle',))
    canvas = ctx.resolve(data['ref'])
    if _cad_type(canvas) != 'Canvas':
        raise ValueError('ref must be an existing Canvas token')
    segment = data['segment']
    if not isinstance(segment, list) or len(segment) != 2 or any(not isinstance(p, list) or len(p) != 2 for p in segment):
        raise ValueError('segment must contain two current canvas-plane points, each with two length expressions (not pixels)')
    p, q = [[ctx.length(v) for v in point] for point in segment]
    if not isinstance(data['anchor'], list) or len(data['anchor']) != 2:
        raise ValueError('anchor must contain two canvas-plane length expressions')
    anchor = [ctx.length(v) for v in data['anchor']]
    distance = math.hypot(q[0] - p[0], q[1] - p[1])
    length = ctx.length(data['length'])
    if distance <= 0 or length <= 0:
        raise ValueError('Known and measured segment lengths must be positive')
    angle = ctx.angle(data.get('angle', '0 deg')) - math.atan2(q[1] - p[1], q[0] - p[0])
    a, b = length / distance * math.cos(angle), length / distance * math.sin(angle)
    tx, ty = anchor[0] - a * p[0] + b * p[1], anchor[1] - b * p[0] - a * p[1]
    old = canvas.transform
    # Left-compose the plane-space similarity using cells, avoiding ambiguous transformBy order.
    matrix = adsk.core.Matrix2D.create()
    transform = ((a, -b, tx), (b, a, ty), (0, 0, 1))
    for row in range(3):
        for col in range(3):
            _cad_require_result(matrix.setCell(row, col, sum(transform[row][k] * old.getCell(k, col) for k in range(3))), 'Define calibrated canvas transform')
    previous = list(old.asArray())
    canvas.transform = matrix
    return {'ref': ctx.ref(canvas), 'previousTransform': previous, 'transform': list(canvas.transform.asArray()),
            'calibration': {'lengthCm': length, 'scaleFactor': length / distance, 'anchorCm': anchor},
            'metricVerification': False, 'limitations': ['Uses caller-measured current plane coordinates, not pixels. No image distortion correction or independent measurement verification.']}


def _io_style_value(value):
    return {'id': value.id, 'name': value.name} if value is not None else None


def _io_style_state(ctx, entity):
    kind = _cad_kind(entity)
    owner = _cad_owner(entity)
    appearance = getattr(entity, 'appearance', None)
    source = getattr(entity, 'appearanceSourceType', None)
    names = ('MaterialAppearanceSource', 'BodyAppearanceSource', 'OccurrenceAppearanceSource',
             'FaceAppearanceSource', 'OverrideAppearanceSource')
    enum_type = getattr(adsk.core, 'AppearanceSourceTypes', None)
    source_name = next((n for n in names if enum_type is not None and
                        source == getattr(enum_type, n)), None) if source is not None else None
    proxy = (getattr(entity, 'assemblyContext', None) is not None or
             getattr(entity, 'nativeObject', None) is not None)
    # Typed sources identify the override's owner, not just the inspected entity.
    own_source = {'body': 'BodyAppearanceSource', 'face': 'FaceAppearanceSource'}.get(kind)
    override = (source_name == 'OverrideAppearanceSource' or source_name == own_source) if source_name else None
    override_scope = ('native-definition' if proxy else 'definition') if override else None
    if proxy and source_name == 'OverrideAppearanceSource':
        override_scope = 'proxy-context-unspecified'
    if kind == 'occurrence':
        override = appearance is not None
        source_name = 'OccurrenceOverride' if override else 'Contents (no occurrence override)'
        override_scope = 'instance' if override else None
    material_entity = entity.body if kind == 'face' else entity.component if kind == 'occurrence' else entity
    return {'ref': ctx.ref(entity), 'scope': 'instance' if kind == 'occurrence' else
            'proxy-read-only' if proxy else 'definition',
            'definition': ctx.ref(owner) if owner is not None else None,
            'appearance': _io_style_value(appearance), 'appearanceSource': source_name,
            'appearanceOverride': override, 'appearanceOverrideScope': override_scope,
            'material': _io_style_value(getattr(material_entity, 'material', None)),
            'materialReadFrom': ctx.ref(material_entity),
            'materialSource': 'BRepBody.material' if _cad_kind(material_entity) == 'body' else 'Component.material',
            'materialInheritance': 'Not exposed by this API; equal IDs do not establish inheritance'}


def _io_style(ctx, data, kind, action):
    prop = 'appearances' if kind == 'appearance' else 'materials'
    if action == 'list':
        _cad_fields(data, (), ('library', 'search'))
    elif action == 'assign':
        _cad_fields(data, ('refs', 'id'), ('library', 'includeChildren') if kind == 'appearance' else ('library',))
    else:
        _cad_fields(data, ('refs',), ('includeChildren',) if kind == 'appearance' else ())
    source = ctx.design
    if 'library' in data:
        if not isinstance(data['library'], str) or not data['library']:
            raise ValueError('library must be an exact loaded library ID')
        source = _cad_unique([lib for lib in _cad_items(ctx.app.materialLibraries)
                              if lib.id == data['library']], 'Loaded library ID')
    collection = getattr(source, prop)
    if action == 'list':
        search = data.get('search', '')
        if not isinstance(search, str):
            raise ValueError('search must be a name substring string')
        return {'kind': kind, 'items': [_io_style_value(item) for item in _cad_items(collection)
                                      if search.casefold() in item.name.casefold()],
                'library': data.get('library'), 'libraries': [
                    {'id': lib.id, 'name': lib.name} for lib in _cad_items(ctx.app.materialLibraries)],
                'affected': [], 'count': 0}
    if not isinstance(data['refs'], list) or not data['refs']:
        raise ValueError('refs must be a nonempty array')
    children = data.get('includeChildren', False)
    if type(children) is not bool:
        raise ValueError('includeChildren must be boolean')
    selected = [ctx.resolve(ref) for ref in data['refs']]
    if 'includeChildren' in data and not any(_cad_kind(e) == 'component' for e in selected):
        raise ValueError('includeChildren applies only to component definition selections')
    entities, mappings = [], []
    for selected_entity in selected:
        if not getattr(selected_entity, 'isValid', True):
            raise ValueError('Style targets must be valid persistent entities')
        targets = [selected_entity]
        if kind == 'appearance' and _cad_kind(selected_entity) == 'component':
            components = [selected_entity]
            if children:
                for component in components:
                    for occurrence in _cad_items(component.occurrences):
                        if occurrence.component not in components:
                            components.append(occurrence.component)
            targets = [body for component in components for body in _cad_items(component.bRepBodies)]
        for entity in targets:
            entity_kind = _cad_kind(entity)
            allowed = ('component', 'body') if kind == 'material' and action == 'assign' else ('component', 'body', 'face', 'occurrence')
            if entity_kind not in allowed:
                raise ValueError('Physical material requires native Component or BRepBody; for a face use appearance.assign'
                                 if kind == 'material' else 'Appearance requires Component, BRepBody, BRepFace, or Occurrence')
            body = entity.body if entity_kind == 'face' else entity
            if getattr(body, 'isTransient', False) or not getattr(entity, 'isValid', True):
                raise ValueError('Style targets must be valid persistent entities')
            native = getattr(entity, 'nativeObject', None)
            if action != 'inspect' and (getattr(entity, 'assemblyContext', None) is not None or
                                        (native is not None and native != entity)):
                raise ValueError('Proxy mutation is unsupported; select the native definition, or a native occurrence for an instance appearance')
            if action != 'inspect' and not hasattr(entity, kind):
                raise ValueError('Installed API lacks writable ' + kind + ' for selected target')
            if entity not in entities:
                entities.append(entity)
        mappings.append({'selected': ctx.ref(selected_entity), 'scope': 'component-body-cascade' if
                         kind == 'appearance' and _cad_kind(selected_entity) == 'component' else
                         'instance' if _cad_kind(selected_entity) == 'occurrence' else 'definition',
                         'targets': [ctx.ref(e) for e in targets], 'count': len(targets)})
    item = None
    resolution = None
    if action == 'assign':
        if not isinstance(data['id'], str) or not data['id']:
            raise ValueError('id must be an exact ID from ' + kind + '.list')
        item, resolution = _cad_style_resolve(
            [v for v in _cad_items(collection) if v.id == data['id']], kind + ' ID',
            getattr(ctx.design, prop), data['id'])
        if source != ctx.design:
            local = getattr(ctx.design, prop)
            if any(v.id == item.id or v.name == item.name for v in _cad_items(local)):
                raise ValueError('Design-local ID/name collision: no equivalence assumed. Use ' + kind +
                                 '.list and explicitly select the local id without library; nothing was copied or assigned')
    # Capture actual getters, including unchanged overrides that can mask definition edits.
    observed = list(entities)
    definitions = []
    for entity in entities:
        owner = _cad_owner(entity)
        if _cad_kind(entity) != 'occurrence' and owner is not None and owner not in definitions:
            definitions.append(owner)
        if _cad_kind(entity) == 'component':
            for body in _cad_items(entity.bRepBodies):
                if body not in observed:
                    observed.append(body)
    for entity in list(observed):
        if _cad_kind(entity) == 'body' and hasattr(entity, 'faces'):
            for face in _cad_items(entity.faces):
                if face not in observed:
                    observed.append(face)
    for occurrence in _cad_items(ctx.root.allOccurrences):
        if occurrence.component in definitions and occurrence not in observed:
            observed.append(occurrence)
    before = [_io_style_state(ctx, e) for e in observed]
    result = {'kind': kind, 'action': action, 'count': len(entities), 'mapping': mappings,
              'affectedDefinitions': [ctx.ref(e) for e in definitions],
              'affectedDefinitionCount': len(definitions), 'includeChildren': children,
              'atomic': False, 'limitations': [
                  'Appearance is visual only: no physical material or coating thickness is assigned.' if kind == 'appearance' else
                  'Physical material can affect inherited appearance; existing visual overrides are retained.',
                  'Definition changes are shared by all occurrences. Existing face and occurrence overrides are not cleared unless explicitly selected.',
                  'Component appearance expands to current direct BRepBodies, not a component appearance property or future bodies.',
                  'Material getters do not expose inheritance provenance. Use a separate measure command for mass; no physical validation is performed.',
                  'Prevalidation is not a transaction; runtime failures may leave copied styles or earlier assignments. No automatic rollback.']}
    previous = [{'ref': b['ref'], 'id': (b[kind] or {}).get('id')} for b in before[:len(entities)]]
    if action == 'assign':
        result['requested'] = {'id': data['id'], 'library': data.get('library')}
        result['copiedStyle'] = None
        result['resolution'] = resolution
        if resolution['ambiguous']:
            result['warnings'] = [
                '%s ID %r is not unique; deterministically resolved to %r (precedence %s) among %d candidates'
                % (kind, data['id'], resolution['selected']['name'], resolution['precedence'],
                   len(resolution['candidates']))]
    try:
        if action == 'assign' and source != ctx.design and entities:
            item = _cad_require_result(local.addByCopy(item, item.name), 'Copy ' + kind)
            result['copiedStyle'] = _io_style_value(item)
        if action != 'inspect':
            for entity in entities:
                setattr(entity, kind, item)
    except Exception as error:
        result['error'] = str(error)
        result['affected'] = [{'ref': ctx.ref(e), 'before': b, 'after': _io_style_state(ctx, e)}
                              for e, b in zip(observed, before)]
        raise RuntimeError('Style operation failed without rollback: ' + json.dumps(result)) from error
    result['affected'] = [{'ref': ctx.ref(e), 'before': b, 'after': _io_style_state(ctx, e)}
                          for e, b in zip(observed, before)]
    result['items'] = [row['after'] for row in result['affected']]
    if action == 'assign':
        result.update(id=item.id, assigned=[ctx.ref(e) for e in entities], previous=previous)
    return result


_IO_IMPORTS = {'.step': 'createSTEPImportOptions', '.stp': 'createSTEPImportOptions',
               '.f3d': 'createFusionArchiveImportOptions', '.iges': 'createIGESImportOptions',
               '.igs': 'createIGESImportOptions', '.sat': 'createSATImportOptions', '.smt': 'createSMTImportOptions'}


def _io_import_options(ctx, path):
    method = _IO_IMPORTS.get(path.suffix.lower())
    if method is None:
        raise ValueError('Supported local imports: STEP, F3D, IGES, SAT, SMT. F3Z needs explicit cloud upload; mesh imports do not reconstruct parametric history')
    manager = ctx.app.importManager
    if not hasattr(manager, method):
        raise ValueError('Installed Fusion lacks ' + method + '; update Fusion or import using the UI')
    return _cad_require_result(getattr(manager, method)(str(path)), 'Create import options')


def _io_import(ctx, data):
    _cad_fields(data, ('path', 'mode'))
    if data['mode'] not in ('new', 'component'):
        raise ValueError('mode must be new or component')
    path = _io_path(ctx, data)
    options = _io_import_options(ctx, path)
    if data['mode'] == 'new':
        doc = _cad_require_result(ctx.app.importManager.importToNewDocument(options), 'Import to new document')
        return {'document': {'name': doc.name, 'creationId': doc.creationId}, 'sourceDocument': _io_identity(ctx),
                'newUnsavedDocument': True, 'pathHost': 'machine running Fusion', 'historyReconstructed': False}
    if ctx.occurrence is not None:
        raise ValueError('Component import requires a native component context, not an occurrence')
    results = _cad_require_result(ctx.app.importManager.importToTarget2(options, ctx.component), 'Import to component')
    refs = [ctx.ref(e) for e in _cad_items(results)]
    ctx.created.extend(refs)
    return {'created': refs, 'document': _io_identity(ctx), 'historyReconstructed': False,
            'limitations': ['Neutral formats bring geometry, not original feature history; F3D retains only history present in the archive.']}


def _io_export_plan(ctx, data, kind):
    _cad_fields(data, ('path',), ('ref', 'overwrite', 'confirm', 'units') +
                (('surfaceDeviation',) if kind == 'mesh' else ()))
    suffixes = {'native': ('.f3d',), 'step': ('.step', '.stp'), 'mesh': ('.stl', '.3mf')}
    if kind == 'native' and Path(data['path']).suffix.lower() == '.f3z':
        raise ValueError('F3Z packaging is not exposed by ExportManager; use Fusion UI export for externally referenced assemblies')
    path = _io_path(ctx, data, output=True, suffixes=suffixes[kind])
    geometry = ctx.resolve(data['ref']) if 'ref' in data else ctx.component
    allowed = ('component',) if kind in ('native', 'step') else ('component', 'body', 'occurrence')
    if _cad_kind(geometry) not in allowed:
        raise ValueError(kind + ' export requires ' + ', '.join(allowed))
    if kind != 'mesh' and 'units' in data:
        raise ValueError('units input is supported for STL only')
    if kind == 'native':
        if not hasattr(ctx.doc, 'allDocumentReferences') or any(
                not hasattr(o, 'isReferencedComponent') for o in _cad_items(ctx.root.allOccurrences)):
            raise ValueError('Installed API cannot certify external-reference status; update Fusion or use UI F3Z export')
        if ctx.doc.allDocumentReferences.count or any(o.isReferencedComponent for o in _cad_items(ctx.root.allOccurrences)):
            raise ValueError('Design has external references and cannot be certified self-contained as F3D. Use UI F3Z export; references will not be broken automatically')
        if geometry != ctx.root:
            raise ValueError('Native archive export requires root component to preserve the whole design history; use ref root')
    surface_deviation = None
    if kind == 'mesh':
        units = {'mm': 'MillimeterDistanceUnits', 'cm': 'CentimeterDistanceUnits', 'in': 'InchDistanceUnits'}
        if path.suffix.lower() == '.3mf':
            if 'units' in data or 'surfaceDeviation' in data:
                raise ValueError('3MF does not support units or surfaceDeviation overrides; omit both')
        else:
            if data.get('units') not in units:
                raise ValueError('STL requires explicit units: mm, cm, or in; STL itself does not encode units')
            if 'surfaceDeviation' in data:
                surface_deviation = ctx.length(data['surfaceDeviation'])
                if surface_deviation <= 0:
                    raise ValueError('surfaceDeviation must be a positive length expression')
    manager = ctx.design.exportManager
    if kind == 'native':
        options = manager.createFusionArchiveExportOptions(str(path), geometry)
    elif kind == 'step':
        options = manager.createSTEPExportOptions(str(path), geometry)
    else:
        method = 'createSTLExportOptions' if path.suffix.lower() == '.stl' else 'createC3MFExportOptions'
        if not hasattr(manager, method):
            raise ValueError('Installed Fusion lacks ' + method + '; update Fusion or export STL')
        options = _cad_require_result(getattr(manager, method)(geometry, str(path)), 'Create mesh export options')
        options.sendToPrintUtility = False
        options.isOneFilePerBody = False
        if path.suffix.lower() == '.stl':
            if not hasattr(options, 'unitType'):
                raise ValueError('Installed API lacks STL unitType; update Fusion to export with explicit units')
            options.unitType = getattr(adsk.fusion.DistanceUnits, units[data['units']])
            if surface_deviation is not None:
                # SDK setter takes cm and automatically selects MeshRefinementCustom.
                options.surfaceDeviation = surface_deviation
    return path, _cad_require_result(options, 'Create export options')


def _io_export_execute(ctx, path, options):
    _cad_require_result(ctx.design.exportManager.execute(options), 'Export ' + str(path))
    result = _io_file(path)
    if not result['exists'] or not result['bytes']:
        raise RuntimeError('Export reported success but file is missing or empty: ' + str(path))
    return result


def _io_export(ctx, data, kind):
    path, options = _io_export_plan(ctx, data, kind)
    result = _io_export_execute(ctx, path, options)
    if 'surfaceDeviation' in data:
        result['tessellation'] = {'surfaceDeviation': data['surfaceDeviation'],
                                  'surfaceDeviationCm': options.surfaceDeviation,
                                  'meshRefinement': options.meshRefinement}
    return result


def _io_parts(ctx, data):
    _cad_fields(data, ('parts',), ('overwrite', 'confirm'))
    if not isinstance(data['parts'], list) or not data['parts']:
        raise ValueError('parts must be a nonempty array with explicit ref, format, and path per part')
    plans = []
    for part in data['parts']:
        _cad_fields(part, ('ref', 'format', 'path'), ('units',))
        if part['format'] not in ('step', 'mesh'):
            raise ValueError('Part format must be step or mesh')
        spec = {k: v for k, v in part.items() if k != 'format'}
        spec.update({k: data[k] for k in ('overwrite', 'confirm') if k in data})
        plans.append(_io_export_plan(ctx, spec, part['format']))
    if len({os.path.normcase(str(p.resolve())) for p, _ in plans}) != len(plans):
        raise ValueError('Part output paths must be distinct')
    return {'files': [_io_export_execute(ctx, *plan) for plan in plans], 'atomic': False,
            'limitations': ['STEP parts use component-local coordinates; mesh occurrence exports use their assembly context.']}


def _io_verify(ctx, data):
    _cad_fields(data, ('path',), ('reimport', 'ref', 'volumeTolerance', 'lengthTolerance'))
    if type(data.get('reimport', False)) is not bool:
        raise ValueError('reimport must be boolean')
    # Missing files are reported, not confused with a failed geometric comparison.
    value = data['path']
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ValueError('path must be absolute on the machine running Fusion')
    path = Path(value)
    result = _io_file(path)
    if not data.get('reimport', False):
        if any(k in data for k in ('ref', 'volumeTolerance', 'lengthTolerance')):
            raise ValueError('Comparison inputs require reimport: true')
        return result
    if not result['exists'] or not result['bytes']:
        raise ValueError('Cannot reimport a missing or empty file')
    if 'volumeTolerance' in data:
        raise ValueError('Volume comparison is not implemented; omit volumeTolerance and use bounding-box comparison')
    source = ctx.resolve(data['ref'], 'component') if 'ref' in data else ctx.component
    tolerance = ctx.length(data.get('lengthTolerance', '0.01 mm'))
    if tolerance < 0:
        raise ValueError('lengthTolerance must be nonnegative')
    options = _io_import_options(ctx, path)
    source_box = _cad_brep_bounds(source)
    source_values = source_box['min'] + source_box['max']
    active_before = ctx.app.activeDocument
    imported = None
    primary = None
    try:
        imported = _cad_require_result(ctx.app.importManager.importToNewDocument(options), 'Verification reimport')
        design = adsk.fusion.Design.cast(imported.products.itemByProductType('DesignProductType'))
        if design is None:
            raise ValueError('Reimport did not produce a Design product')
        box = _cad_brep_bounds(design.rootComponent)
        values = box['min'] + box['max']
        deltas = [abs(a - b) for a, b in zip(source_values, values)]
        result['comparison'] = {'method': 'axis-aligned bounding box only', 'units': 'cm',
                                'source': source_values, 'reimport': values, 'absoluteDeltas': deltas,
                                'tolerance': tolerance, 'withinTolerance': max(deltas) <= tolerance}
        result['reimported'] = True
        result['limitations'] = ['Bounding-box agreement is not shape, topology, volume, mass, or feature-history equivalence.',
                                'Uses B-Rep body preciseBoundingBox unions in component-local frames; includes hidden bodies, excludes graphics and construction geometry.']
    except BaseException as error:
        primary = error
        raise
    finally:
        actions = []
        if imported is not None:
            actions.append(('Close verification-owned temporary document', lambda: _cad_require_result(
                imported.close(False), 'Close verification-owned temporary document')))
        if active_before is not None:
            actions.append(('Restore previously active document', lambda: _cad_require_result(
                active_before.activate(), 'Restore previously active document')))
        _io_cleanup(primary, actions)
    return result


def _io_checkpoint(ctx, data, action):
    if action == 'create':
        _cad_fields(data, ('path',), ('overwrite', 'confirm'))
        result = _io_export(ctx, dict(data, ref='root'), 'native')
        return dict(result, checkpointType='local self-contained F3D snapshot', document=_io_identity(ctx),
                    userDocumentSaved=False)
    if action == 'list':
        _cad_fields(data, ('directory',))
        path = Path(data['directory'])
        if not path.is_absolute() or not path.is_dir():
            raise ValueError('directory must exist on the Fusion machine and be absolute')
        return {'checkpoints': [_io_file(p) for p in sorted(path.iterdir()) if p.is_file() and p.suffix.lower() == '.f3d'],
                'limitations': ['Lists local F3D candidates, not authenticated provenance or cloud versions.']}
    _cad_fields(data, ('path',))
    path = _io_path(ctx, data, suffixes=('.f3d',))
    if action == 'inspect':
        return dict(_io_file(path), modifiedUnix=path.stat().st_mtime,
                    limitations=['File metadata only; archive contents and geometry are not inspected.'])
    # Always import as a separate unsaved document; never replace, save, or close ctx.doc.
    return _io_import(ctx, {'path': str(path), 'mode': 'new'})


CAD_HANDLERS.update({
    'visibility.show': lambda c, d: _io_visibility(c, d, 'show'),
    'visibility.hide': lambda c, d: _io_visibility(c, d, 'hide'),
    'visibility.restore': lambda c, d: _io_visibility(c, d, 'restore'),
    'visibility.isolate': lambda c, d: _io_visibility(c, d, 'isolate'),
    'camera.save': lambda c, d: _io_camera(c, d, 'save'),
    'camera.restore': lambda c, d: _io_camera(c, d, 'restore'),
    'camera.set': lambda c, d: _io_camera(c, d, 'set'),
    'shot.pack': _io_shots, 'view.compare': _io_compare, 'section.view': _io_section,
    'reference.image': _io_reference_image,
    'appearance.list': lambda c, d: _io_style(c, d, 'appearance', 'list'),
    'appearance.assign': lambda c, d: _io_style(c, d, 'appearance', 'assign'),
    'appearance.inspect': lambda c, d: _io_style(c, d, 'appearance', 'inspect'),
    'appearance.clear': lambda c, d: _io_style(c, d, 'appearance', 'clear'),
    'material.list': lambda c, d: _io_style(c, d, 'material', 'list'),
    'material.assign': lambda c, d: _io_style(c, d, 'material', 'assign'),
    'material.inspect': lambda c, d: _io_style(c, d, 'material', 'inspect'),
    'import.file': _io_import,
    'checkpoint.create': lambda c, d: _io_checkpoint(c, d, 'create'),
    'checkpoint.list': lambda c, d: _io_checkpoint(c, d, 'list'),
    'checkpoint.inspect': lambda c, d: _io_checkpoint(c, d, 'inspect'),
    'checkpoint.open': lambda c, d: _io_checkpoint(c, d, 'open'),
    'export.native': lambda c, d: _io_export(c, d, 'native'),
    'export.step': lambda c, d: _io_export(c, d, 'step'),
    'export.mesh': lambda c, d: _io_export(c, d, 'mesh'),
    'export.parts': _io_parts, 'export.verify': _io_verify,
})
