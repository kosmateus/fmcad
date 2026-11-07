"""Leased .4 scratch qualification for hidden B-Rep, CSG and recursive history."""
import json

import adsk.core
import adsk.fusion

DOC_NAME = 'Scratch'
ARGS = {}


def _require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(_context):
    identity = FMCAD.call('document.status', {})
    if identity.get('fileId') != ARGS.get('fileId') or identity.get('projectId') != ARGS.get('projectId') or \
            identity.get('folderId') != ARGS.get('folderId'):
        raise RuntimeError('Geometry/history scratch identity differs from assigned project/folder/file IDs')

    design = FMCAD.design
    bodies = FMCAD.call('entity.list', {'kind': 'body', 'component': 'root'})['entities']
    if len(bodies) not in (1, 2):
        raise RuntimeError('Expected the owned seed body and optional prior comparison body, found %d' % len(bodies))
    source = bodies[0]
    body = FMCAD.resolve(source, 'body')
    if not hasattr(body, 'isLightBulbOn'):
        raise RuntimeError('Native body visibility control is unavailable on this Fusion build')
    prior_visibility = body.isLightBulbOn
    try:
        body.isLightBulbOn = False
        snapshot = FMCAD.call('snapshot', {})
        inventoried = [row['ref'] for component in snapshot['components'] for row in component['bodies']]
        if not any(ref.get('token') == source.get('token') for ref in inventoried):
            raise RuntimeError('Hidden physical B-Rep body was omitted from measure.snapshot inventory')
    finally:
        body.isLightBulbOn = prior_visibility
        if body.isLightBulbOn != prior_visibility:
            raise RuntimeError('Scratch body visibility failed to restore')

    equal_volume = (bodies[1] if len(bodies) == 2 else FMCAD.call('shape.box', {
        'name': 'IW74_EqualVolumeDifferentShape',
        'width': '20 mm', 'depth': '5 mm', 'height': '10 mm'})['bodies'][0])
    frame = {'space': 'assembly', 'component': {'kind': 'component', 'name': 'root'}}
    comparison = FMCAD.compare_bodies(source, equal_volume, frame,
                                      '0.1 mm^3', '0.01 mm', '0.01 deg')
    _require(not comparison['volumeEqual'], 'Equal-volume unequal-shape bodies must fail bidirectional CSG')
    _require(comparison['aMinusB']['value'] > 0 and comparison['bMinusA']['value'] > 0,
             'Both directional CSG residuals must be nonzero for this pair')
    _require(comparison['poseEqual'], 'Bodies in the same root frame should retain identity pose')

    timeline = design.timeline
    group_items = [timeline.item(i) for i in range(timeline.count)
                   if getattr(timeline.item(i), 'isGroup', False)]
    if group_items:
        if len(group_items) != 1:
            raise RuntimeError('Found an unexpected pre-existing timeline group in owned scratch')
        group = group_items[0]
    else:
        if timeline.count < 2:
            raise RuntimeError('Expected at least two owned timeline features for group-walker qualification')
        group = timeline.timelineGroups.add(0, timeline.count - 1)
        if group is None:
            raise RuntimeError('Fusion did not create the owned timeline group')
    group_indexes = [i for i in range(timeline.count)
                     if getattr(timeline.item(i), 'isGroup', False) and timeline.item(i).name == group.name]
    if len(group_indexes) != 1:
        raise RuntimeError('Could not uniquely resolve the newly created scratch TimelineGroup')
    group_path = str(group_indexes[0])
    recursive = FMCAD.call('history.check', {'scope': {'group': group_path}, 'recursive': True})
    if recursive.get('status') != 'pass' or not recursive.get('healthy'):
        raise RuntimeError('Recursive native group health check did not pass: ' + json.dumps(recursive))
    non_recursive = FMCAD.call('history.check', {'scope': {'group': group_path}, 'recursive': False})
    child_rows = [row for row in recursive['timeline'] if not row.get('isGroup')]
    duplicate_rows = [row for row in child_rows if row.get('duplicate') is True]
    if len(child_rows) != group.count or recursive['coverage']['visitedLeaves'] + len(duplicate_rows) != group.count:
        raise RuntimeError('Recursive history inventory omitted group leaves')
    if group.count and (non_recursive.get('status') != 'unknown' or non_recursive.get('healthy')):
        raise RuntimeError('Non-recursive group inventory must remain unknown while children are unvisited')

    return {'hiddenBodyIncluded': True, 'bodyCount': len(inventoried),
            'equalVolumeUnequalShape': comparison, 'groupPath': group_path,
            'recursiveHistory': recursive, 'nonRecursiveHistory': non_recursive}
