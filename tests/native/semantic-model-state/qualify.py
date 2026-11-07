"""Consent-gated Fusion qualification recipe. NOT run during offline tests.

Run only through a pinned fmcad run turn with cad-v1 helper wiring. A fully
passing run discards its unsaved fixture by closing only its saved, pinned
scratch; it never saves the fixture or restores a previously active document.
"""
import copy
import math

DOC_PREFIX = 'FmcadSemanticStateScratch_'
ARGS = {}


def qualify(facade, args):
    if args.get('confirmNativeQualification') is not True:
        raise RuntimeError('Separate explicit native qualification consent is required')
    run_id = args.get('runId')
    if not isinstance(run_id, str) or not run_id:
        raise RuntimeError('A new immutable qualification runId is required')
    prefix = args.get('fixturePrefix')
    if not isinstance(prefix, str) or not 8 <= len(prefix) <= 20 or not prefix.isalnum() or prefix.upper() != prefix:
        raise RuntimeError('fixturePrefix must be 8-20 uppercase letters/digits')
    status = facade.call('document.status', {})
    expected_document_name = args.get('documentName')
    expected_file_name = args.get('documentFileName')
    if (not isinstance(expected_document_name, str) or
            not expected_document_name.startswith(DOC_PREFIX) or
            status.get('name') != expected_document_name):
        raise RuntimeError('Dedicated scratch document required')
    for key in ('projectId', 'folderId', 'fileId', 'creationId', 'version'):
        if args.get(key) is None or status.get(key) != args[key]:
            raise RuntimeError('Pinned scratch identity mismatch: ' + key)
    if status.get('saved') is not True or status.get('isReadOnly') is not False:
        raise RuntimeError('Saved writable scratch required')
    if (not isinstance(expected_file_name, str) or not expected_file_name.startswith(DOC_PREFIX) or
            status.get('fileName') != expected_file_name):
        raise RuntimeError('Saved scratch file name differs from the exact run document')
    if status.get('isComplete') is not True or status.get('projectId') != args['projectId']:
        raise RuntimeError('Owned scratch is not cloud-complete in the pinned project')
    root = facade.root
    empty_scratch = facade.call('document.clear', {
        'fileId': status['fileId'], 'confirm': True, 'dryRun': True})
    if (empty_scratch.get('status') != 'inspected' or empty_scratch.get('dryRun') is not True or
            any(empty_scratch.get('before', {}).values())):
        raise RuntimeError('Pinned saved scratch is not empty; refusing native fixture creation')
    if root.occurrences.count or root.bRepBodies.count or root.sketches.count:
        raise RuntimeError('Scratch must be empty before qualification; never replay a partial run')
    import adsk.fusion
    import adsk.core

    fusion_build = str(adsk.core.Application.get().version)
    if args.get('expectedFusionBuild') != fusion_build:
        raise RuntimeError('Fusion build differs from the fresh pinned broker probe')
    if (not isinstance(args.get('runId'), str) or not args['runId'] or
            not isinstance(args.get('capabilityProbeRequestId'), str) or
            not isinstance(args.get('capabilityProbeJobId'), str)):
        raise RuntimeError('Run id and fresh broker probe receipts are required')
    if (args.get('capabilityProbeBuild') != fusion_build or
            args.get('capabilityProbeStatus') != 'partial' or
            args.get('capabilityProbeIdentity') != 'verified'):
        raise RuntimeError('Fresh broker probe did not confirm this build and pinned document')

    def matrix(x=0, y=0, z=0, rotate_z=False):
        m = adsk.core.Matrix3D.create()
        if rotate_z:
            if m.setToRotation(math.pi / 2, adsk.core.Vector3D.create(0, 0, 1),
                               adsk.core.Point3D.create(0, 0, 0)) is not True:
                raise RuntimeError('Could not create analytic rotated fixture placement')
        m.translation = adsk.core.Vector3D.create(x, y, z)
        return m

    def box(component):
        sketch = component.sketches.add(component.xYConstructionPlane)
        sketch.sketchCurves.sketchLines.addTwoPointRectangle(
            adsk.core.Point3D.create(0, 0, 0), adsk.core.Point3D.create(1, 2, 0))
        extrusion = component.features.extrudeFeatures.addSimple(
            sketch.profiles.item(0), adsk.core.ValueInput.createByReal(3),
            adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
        return extrusion.bodies.item(0)

    report = {'nativeModelQualification': 'incomplete', 'fusionBuild': fusion_build,
              'qualificationRunId': run_id, 'fixturePrefix': prefix,
              'capabilityProbe': {'requestId': args.get('capabilityProbeRequestId'),
                                  'jobId': args.get('capabilityProbeJobId'),
                                  'capabilityId': 'frame.context_audit',
                                  'status': args.get('capabilityProbeStatus'),
                                  'identity': args.get('capabilityProbeIdentity'),
                                  'build': args.get('capabilityProbeBuild')},
              'documentIdentity': {key: status.get(key) for key in
                                   ('name', 'projectId', 'folderId', 'fileId', 'creationId', 'version')},
              'checks': [], 'restored': False, 'restoration': {'pose': 'not-attempted',
              'visibility': 'not-attempted', 'scratchContents': 'not-attempted'},
              'ownedRootOccurrences': [], 'ownedRootBody': None,
              'limitations': ['Sampled BRep witnesses and semantic summaries, not exact BRep equivalence.']}

    def check(name, condition):
        report['checks'].append({'name': name, 'passed': bool(condition)})
        if not condition:
            raise RuntimeError('Native qualification failed: ' + name)

    def path(occurrence):
        return occurrence.fullPathName.split('+')

    def binding(body, instance, role):
        return {'role': role, 'sourceId': role, 'ref': {'token': body.entityToken}, 'instance': instance}

    def capture(bindings):
        return facade.call('snapshot.capture_v2', {'scope': {'kind': 'explicit-bindings',
            'document': {k: status[k] for k in ('creationId', 'fileId', 'version')}}, 'bindings': bindings})

    def diff(a, b, allowed=None):
        return facade.call('snapshot.diff_v2', {'before': a, 'after': b,
                                             'allowedMovedSubtrees': allowed or []})

    moved, saved = None, None
    visibility_restore_state, visibility_restore_attempted = None, False
    pose_restore_attempted = False
    baseline = None
    try:
        a = root.occurrences.addNewComponent(matrix(10, rotate_z=True))
        a.component.name = 'SEM_A'
        report['ownedRootOccurrences'].append({'name': a.name, 'token': a.entityToken, 'path': path(a)})
        b = a.component.occurrences.addNewComponent(matrix(0, 20))
        b.component.name = 'SEM_B'
        report['ownedRootOccurrences'].append({'name': b.name, 'token': b.entityToken, 'path': path(b)})
        c = b.component.occurrences.addNewComponent(matrix(0, 0, 30))
        c.component.name = 'SEM_C'
        report['ownedRootOccurrences'].append({'name': c.name, 'token': c.entityToken, 'path': path(c)})
        body = box(c.component)
        repeated = root.occurrences.addExistingComponent(c.component, matrix(-10))
        report['ownedRootOccurrences'].append({'name': repeated.name, 'token': repeated.entityToken,
                                               'path': path(repeated)})
        root_body = box(root)
        report['ownedRootBody'] = root_body.entityToken
        qualified = [root.allOccurrences.item(i) for i in range(root.allOccurrences.count)
                     if root.allOccurrences.item(i).component == c.component and
                     len(path(root.allOccurrences.item(i))) == 3]
        check('three-level occurrence resolves uniquely', len(qualified) == 1)
        nested = qualified[0]
        bindings = [binding(body, path(nested), 'shared-body'),
                    binding(body, path(repeated), 'shared-body'), binding(root_body, [], 'root-body')]
        baseline = capture(bindings)
        check('capture is explicitly partial and pinned to actual source version',
              baseline['status'] == 'partial' and baseline['coverage'] == 'partial' and
              baseline['scope']['document']['creationId'] == status['creationId'] and
              baseline['scope']['document']['fileId'] == status['fileId'] and
              baseline['scope']['document']['version'] == status['version'] and
              all(row['source']['document']['version'] == status['version'] for row in baseline['entities']))
        check('reorder stable', diff(baseline, capture(list(reversed(bindings))))['status'] == 'pass')
        # An A-local +20 cm Y translation under a +90 degree A rotation moves
        # to root -20 cm X; add A's +10 cm X and C's +30 cm Z. This expectation
        # is derived from fixture inputs, never from a proxy roundtrip.
        expected_nested = [0, -1, 0, 10 - 20, 1, 0, 0, 0, 0, 0, 1, 30, 0, 0, 0, 1]
        expected_repeated = [1, 0, 0, -10, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        expected_root = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        check('fixture parent rotation is applied analytically',
              expected_nested[3] == -10 and expected_nested[7] == 0 and expected_nested[11] == 30)
        for item, expected in [(bindings[0], expected_nested), (bindings[1], expected_repeated),
                               (bindings[2], expected_root)]:
            audit_input = {key: item[key] for key in ('ref', 'sourceId', 'instance')}
            audit_input.update(datumToRoot=list(expected),
                               datumSource={'kind': 'fixture-analytic-rz90-parent-chain', 'version': 1})
            audit = facade.call('frame.context_audit', audit_input)
            report.setdefault('frameAudits', []).append({'instance': item['instance'],
                                                          'status': audit['status'],
                                                          'nativeToRoot': audit['nativeToRoot'],
                                                          'proxyToRoot': audit['observation']['proxyToRoot'],
                                                          'witnessCount': audit['witnessCount'],
                                                          'visibility': audit['observation']['visibility']})
            check('independent native/proxy/BRep ' + str(item['instance']), audit['status'] == 'pass')

        # A real capture carries the actual DataFile version. Exercise the
        # semantic source-version fence with a deliberately changed saved-source
        # observation, without saving or editing another document/version.
        version_changed = copy.deepcopy(baseline)
        version_changed['entities'][0]['source']['document']['version'] += 1
        version_diff = diff(baseline, version_changed)
        report['sourceVersionCheck'] = {
            'capturedFileId': baseline['scope']['document']['fileId'],
            'capturedVersion': baseline['scope']['document']['version'],
            'comparisonVersion': version_changed['entities'][0]['source']['document']['version'],
            'comparisonInput': 'synthetically advanced source-document version on a real native capture',
        }
        check('source version drift rejected', version_diff['status'] == 'fail' and
              any(change.get('channel') == 'source' for change in version_diff['changes']))

        # Visibility changes are measured on one exact repeated root occurrence;
        # restore the helper's opaque before-state and verify the same capture.
        visibility = facade.call('visibility.hide', {'refs': [
            {'token': repeated.entityToken, 'kind': 'occurrence',
             'path': repeated.fullPathName}]})
        visibility_restore_state = visibility['restoreState']
        hidden = capture(bindings)
        visibility_diff = diff(baseline, hidden)
        changed_visibility = [change for change in visibility_diff['changes']
                             if change['channel'] == 'visibility']
        check('repeated-instance visibility change detected', visibility_diff['status'] == 'fail' and
              any(change['instance'] == path(repeated) and not change['allowed']
                  for change in changed_visibility))
        visibility_restore_attempted = True
        restored_visibility = facade.call('visibility.restore', {'state': visibility_restore_state})
        visibility_restore_state = None
        visible_again = capture(bindings)
        check('visibility independently restored', restored_visibility['items'][0]['isLightBulbOn'] is True and
              diff(baseline, visible_again)['status'] == 'pass')
        report['restoration']['visibility'] = 'verified-by-readback'

        moved, saved = repeated, repeated.transform2.copy()
        repeated.transform2 = matrix(-12)
        changed = capture(bindings)
        check('repeated instance move detected', diff(baseline, changed)['status'] == 'fail')
        check('unauthorized subtree rejected', diff(baseline, changed, [path(nested)])['status'] == 'fail')
        check('allowed subtree accepted', diff(baseline, changed, [path(repeated)])['status'] == 'pass')
        pose_restore_attempted = True
        repeated.transform2 = saved
        moved = None
        check('native pose restored', diff(baseline, capture(bindings))['status'] == 'pass')
        report['restoration']['pose'] = 'verified-by-independent-capture'
        missing = copy.deepcopy(baseline)
        missing['entities'].pop(0)
        check('missing role rejected', diff(baseline, missing)['status'] == 'fail')
        duplicated = copy.deepcopy(baseline)
        duplicated['entities'].append(copy.deepcopy(duplicated['entities'][0]))
        check('duplicate rejected', diff(baseline, duplicated)['status'] == 'fail')
        # Corrupt observation, not a claim that Fusion accepts a scaled placement.
        for factor in (-1, 2):
            invalid = list(expected_nested)
            for index in (0, 4, 8):
                invalid[index] *= factor
            audit_input = {key: bindings[0][key] for key in ('ref', 'sourceId', 'instance')}
            audit_input.update(datumToRoot=invalid,
                               datumSource={'kind': 'deliberately-corrupt-fixture-observation', 'version': 1})
            audit = facade.call('frame.context_audit', audit_input)
            check('reflection/scale observation rejected ' + str(factor), audit['status'] == 'fail')
        report.update(nativeModelQualification='pass', restored=True)
    except BaseException as error:
        report['error'] = str(error)
        report['nativeModelQualification'] = 'fail-or-unknown'
        raise
    finally:
        # Visibility cleanup is conditional on reading the live value first;
        # never replay an opaque setter after an uncertain result.
        if visibility_restore_state is not None and not visibility_restore_attempted:
            try:
                ref = visibility_restore_state['items'][0]['ref']
                entity = facade.resolve(ref)
                if entity.isLightBulbOn != visibility_restore_state['items'][0]['isLightBulbOn']:
                    visibility_restore_attempted = True
                    facade.call('visibility.restore', {'state': visibility_restore_state})
                visibility_restore_state = None
                report['restoration']['visibility'] = 'readback-confirmed'
            except BaseException as error:
                report['restoration']['visibility'] = 'unknown-or-failed: ' + str(error)
        if moved is not None:
            try:
                current = list(moved.transform2.asArray())
                if any(abs(a-b) > 1e-9 for a, b in zip(current, saved.asArray())):
                    if pose_restore_attempted:
                        raise RuntimeError('Pose restore was already attempted; refusing setter replay')
                    pose_restore_attempted = True
                    moved.transform2 = saved
                report['restoration']['pose'] = (
                    'verified-by-independent-capture'
                    if baseline is not None and diff(baseline, capture(bindings))['status'] == 'pass'
                    else 'unknown-or-failed')
            except BaseException as error:
                report['restoration']['pose'] = 'unknown-or-failed: ' + str(error)
        if visibility_restore_state is not None:
            report['restoration']['visibility'] = 'unknown-or-failed: visibility restore was not verified'
        # Failed or incompletely restored fixtures remain open for inspection.
        # Only a complete native PASS can discard its unsaved fixture into the
        # pinned, saved, empty baseline. Never close a foreign/previous document.
        if not _native_pass_is_discardable(report):
            if report.get('nativeModelQualification') == 'pass':
                report['nativeModelQualification'] = 'fail-or-unknown'
            report['restoration']['scratchContents'] = {
                'status': 'left-open-for-inspection; native qualification or restore incomplete',
                'creationId': status['creationId'], 'fileId': status['fileId'],
                'savedVersion': status['version'],
            }
            report['restored'] = False
        else:
            try:
                current = facade.call('document.status', {})
                exact_target = (current.get('creationId') == status['creationId'] and
                                current.get('fileId') == status['fileId'] and
                                current.get('projectId') == status['projectId'] and
                                current.get('version') == status['version'] and
                                current.get('saved') is True)
                if not exact_target:
                    raise RuntimeError('Own scratch identity/version changed before discard-close')
                target_document = facade.doc
                close_result = target_document.close(False)
                closed = close_result is True and getattr(target_document, 'isValid', True) is False
                report['restoration']['scratchContents'] = {
                    'status': 'closed-without-save; external document-list confirmation pending'
                    if closed else 'unknown-or-failed',
                    'savedFileId': current['fileId'], 'savedVersion': current['version'],
                    'creationId': current['creationId'], 'closeAccepted': close_result,
                    'documentInvalidAfterClose': getattr(target_document, 'isValid', None) is False,
                }
                report['restored'] = closed
                if not closed:
                    report['nativeModelQualification'] = 'fail-or-unknown'
            except BaseException as error:
                report['restoration']['scratchContents'] = {'status': 'unknown-or-failed',
                                                           'error': str(error)}
                report['restored'] = False
                report['nativeModelQualification'] = 'fail-or-unknown'
        facade.emit(report)
    return report


def _native_pass_is_discardable(report):
    checks = report.get('checks', [])
    restoration = report.get('restoration', {})
    return (report.get('nativeModelQualification') == 'pass' and bool(checks) and
            all(check.get('passed') is True for check in checks) and
            restoration.get('pose') == 'verified-by-independent-capture' and
            restoration.get('visibility') == 'verified-by-readback')


def run(_context):
    return qualify(FMCAD, ARGS)
