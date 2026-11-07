"""Leased scratch-only native joint-sampling restore and broad-phase guard."""
import json
import math

DOC_NAME = 'Scratch'
ARGS = {}


def _require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(_context):
    identity = FMCAD.call('document.status', {})
    if identity.get('fileId') != ARGS.get('fileId') or identity.get('projectId') != ARGS.get('projectId') or \
            identity.get('folderId') != ARGS.get('folderId'):
        raise RuntimeError('Clearance scratch identity differs from assigned project/folder/file IDs')

    base = FMCAD.call('component.create', {
        'name': 'IW74_JointBase',
        'placement': {'translation': ['0 mm', '100 mm', '0 mm']},
    })
    mover = FMCAD.call('component.create', {
        'name': 'IW74_JointMover',
        'placement': {'translation': ['40 mm', '100 mm', '0 mm']},
    })
    base_box = FMCAD.call('shape.box', {
        'name': 'IW74_JointBaseBox', 'width': '10 mm', 'depth': '10 mm', 'height': '10 mm'},
        component=base['component'])
    mover_box = FMCAD.call('shape.box', {
        'name': 'IW74_JointMoverBox', 'width': '10 mm', 'depth': '10 mm', 'height': '10 mm'},
        component=mover['component'])
    joint = FMCAD.call('joint.revolute', {
        'name': 'IW74_JointSample', 'occurrenceOne': base['occurrence'],
        'occurrenceTwo': mover['occurrence'], 'point': 'origin', 'axis': 'Z'})['joint']
    base_body = dict(base_box['bodies'][0], occurrence=base['occurrence'])
    mover_body = dict(mover_box['bodies'][0], occurrence=mover['occurrence'])
    joint_before = FMCAD.call('joint.inspect', {'joint': joint})['rotationValue']
    mover_ref = FMCAD.resolve(mover['occurrence'], 'occurrence')
    pose_before = list(mover_ref.transform2.asArray())
    pair = [{'a': base_body, 'b': mover_body}]
    range_spec = [{'joint': joint, 'rotation': {'from': '0 deg', 'to': '30 deg'}}]

    def expect_broad_phase_rejection(data):
        try:
            FMCAD.call('clearance.grid', data)
        except ValueError as error:
            if 'broadPhase' not in str(error):
                raise
            return True
        raise RuntimeError('Unsafe broadPhase input was not rejected before sampling')

    joint_guard = expect_broad_phase_rejection({
        'schemaVersion': 1, 'frame': 'component', 'pairs': pair,
        'joints': range_spec, 'broadPhase': True})
    minimum_guard = expect_broad_phase_rejection({
        'schemaVersion': 1, 'frame': 'component', 'pairs': pair,
        'minimum': '1 mm', 'broadPhase': True})
    joint_after_guards = FMCAD.call('joint.inspect', {'joint': joint})['rotationValue']
    pose_after_guards = list(mover_ref.transform2.asArray())
    _require(joint_after_guards == joint_before and pose_after_guards == pose_before,
             'Broad-phase rejection changed the owned scratch joint pose')

    grid = FMCAD.call('clearance.grid', {
        'schemaVersion': 1, 'frame': 'component', 'pairs': pair, 'minimum': '1 mm',
        'joints': range_spec, 'samples': 3})
    _require(grid.get('poseRestored') is True and not grid.get('restoreErrors'),
             'clearance.grid did not restore/read back the original joint pose: ' + json.dumps(grid))
    _require(grid['coverage']['tested'] == 3 and grid['coverage']['total'] == 3,
             'clearance.grid did not test every requested joint sample')
    joint_after = FMCAD.call('joint.inspect', {'joint': joint})['rotationValue']
    pose_after = list(mover_ref.transform2.asArray())
    _require(math.isclose(joint_after, joint_before, rel_tol=0, abs_tol=1e-9),
             'Joint inspect differs from its pre-grid value')
    _require(all(math.isclose(a, b, rel_tol=0, abs_tol=1e-8)
                 for a, b in zip(pose_after, pose_before)), 'Occurrence pose differs from pre-grid readback')
    return {'jointGuard': joint_guard, 'minimumGuard': minimum_guard,
            'gridStatus': grid['status'], 'gridPoseRestored': grid['poseRestored'],
            'restoreErrors': grid.get('restoreErrors', []), 'jointBefore': joint_before,
            'jointAfter': joint_after, 'poseMaxError': max(abs(a - b) for a, b in zip(pose_after, pose_before)),
            'coverage': grid['coverage']}
