"""Generic native acceptance recipe for fmcad-iw7.6; owned scratch document only."""

import adsk.core

DOC_NAME = "FMCAD_iw7_6_native_f18c621 v1"

def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def matrix_for(FMCAD, reference):
    path = reference.get('path')
    require(path, 'occurrence result omitted path')
    root = FMCAD.root
    matches = [root.allOccurrences.item(i) for i in range(root.allOccurrences.count)
               if root.allOccurrences.item(i).fullPathName == path]
    require(len(matches) == 1, 'root-context path is not unique: ' + path)
    return list(matches[0].transform2.asArray())


def near_matrix(actual, expected, label):
    require(len(actual) == len(expected) == 16, label + ': invalid matrix size')
    delta = max(abs(a - b) for a, b in zip(actual, expected))
    require(delta < 1e-7, label + ': matrix mismatch, max delta=' + str(delta))


def create(FMCAD, name):
    existing = [FMCAD.design.allComponents.item(i) for i in range(FMCAD.design.allComponents.count)
                if FMCAD.design.allComponents.item(i).name == name]
    if existing:
        require(len(existing) == 1, 'ambiguous scratch component: ' + name)
        component = existing[0]
        roots = [FMCAD.root.occurrences.item(i) for i in range(FMCAD.root.occurrences.count)
                 if FMCAD.root.occurrences.item(i).component == component]
        roots = [o for o in roots if o.fullPathName == name + ':1']
        if roots:
            require(len(roots) == 1, 'ambiguous scratch root occurrence: ' + name)
            occurrence = roots[0]
        else:
            nested = sorted((FMCAD.root.allOccurrences.item(i)
                             for i in range(FMCAD.root.allOccurrences.count)
                             if FMCAD.root.allOccurrences.item(i).component == component),
                            key=lambda item: item.fullPathName)
            require(nested, 'scratch component occurrence unavailable: ' + name)
            occurrence = nested[0]
        return {'component': {'token': component.entityToken, 'kind': 'component', 'name': name},
                'occurrence': {'token': occurrence.entityToken, 'kind': 'occurrence',
                               'name': occurrence.name, 'path': occurrence.fullPathName}}
    return FMCAD.call('component.create', {'name': name})


def component_ref(component):
    return {'token': component.entityToken, 'kind': 'component', 'name': component.name}


def occurrence_ref(occurrence):
    return {'token': occurrence.entityToken, 'kind': 'occurrence', 'name': occurrence.name,
            'path': occurrence.fullPathName}


def existing_nested(FMCAD, component, parent_path):
    return sorted((FMCAD.root.allOccurrences.item(i)
                   for i in range(FMCAD.root.allOccurrences.count)
                   if FMCAD.root.allOccurrences.item(i).component == component and
                   FMCAD.root.allOccurrences.item(i).fullPathName.startswith(parent_path + '+')),
                  key=lambda occurrence: occurrence.fullPathName)


def all_nested_paths(FMCAD, component):
    return sorted(FMCAD.root.allOccurrences.item(i).fullPathName
                  for i in range(FMCAD.root.allOccurrences.count)
                  if FMCAD.root.allOccurrences.item(i).component == component and
                  '+' in FMCAD.root.allOccurrences.item(i).fullPathName)


def transform(FMCAD, occurrence, placement):
    return FMCAD.call('occurrence.transform', {'occurrence': occurrence, 'placement': placement})


def ensure_transform(FMCAD, occurrence, placement, expected):
    current = matrix_for(FMCAD, occurrence)
    if max(abs(a - b) for a, b in zip(current, expected)) < 1e-7:
        return {'verifiedExisting': True, 'matrix': current}
    return transform(FMCAD, occurrence, placement)


def ensure_ungrounded(FMCAD, occurrence):
    native = FMCAD.resolve(occurrence, 'occurrence')
    if native.isGrounded or getattr(native, 'isGroundToParent', False):
        return FMCAD.call('assembly.unground', {'occurrence': occurrence})
    return {'grounded': False, 'verifiedExisting': True}


def settle(FMCAD):
    snapshots = FMCAD.design.snapshots
    if snapshots.hasPendingSnapshot:
        require(snapshots.add() is not None, 'could not capture pending scratch positions')
    require(not snapshots.hasPendingSnapshot, 'scratch positions remain pending')


def run(context):
    # The caller pins a fresh saved test document in this task's dedicated folder.
    require(FMCAD.doc is not None and FMCAD.design is not None, 'owned scratch design unavailable')
    results = {}
    parent = create(FMCAD, 'IW76_Parent')
    source = create(FMCAD, 'IW76_Source')
    parent_ref, source_ref = parent['occurrence'], source['occurrence']
    ensure_ungrounded(FMCAD, parent_ref)
    ensure_transform(FMCAD, parent_ref, {'translation': ['10 mm', '20 mm', '0 mm'],
        'axis': [0, 0, 1], 'angle': '90 deg'},
        [0, -1, 0, 1, 1, 0, 0, 2, 0, 0, 1, 0, 0, 0, 0, 1])
    ensure_transform(FMCAD, source_ref, {'translation': ['30 mm', '40 mm', '0 mm'],
        'axis': [0, 0, 1], 'angle': '30 deg'},
        [0.8660254037844387, -0.5, 0, 3, 0.5, 0.8660254037844387, 0, 4,
         0, 0, 1, 0, 0, 0, 0, 1])

    legacy_source = create(FMCAD, 'IW76_LegacyRoot')
    legacy_component = FMCAD.resolve(legacy_source['component'], 'component')
    legacy_roots = [FMCAD.root.occurrences.item(i) for i in range(FMCAD.root.occurrences.count)
                    if FMCAD.root.occurrences.item(i).component == legacy_component]
    if len(legacy_roots) > 1:
        linked = {'copyMode': 'linked', 'affectedPaths': [o.fullPathName for o in legacy_roots]}
    else:
        linked = FMCAD.call('occurrence.add', {'component': legacy_source['component'], 'copyMode': 'linked',
                                               'destination': 'root'})
    require(linked['copyMode'] == 'linked' and linked['affectedPaths'], 'linked root add failed')
    results['legacyRootLinkedAdd'] = linked
    settle(FMCAD)

    source_component = FMCAD.resolve(source['component'], 'component')
    current_nested = existing_nested(FMCAD, source_component, parent_ref['path'])
    if current_nested:
        linked_nested = {'occurrence': occurrence_ref(current_nested[0]),
                         'component': component_ref(source_component), 'copyMode': 'linked',
                         'affectedPaths': sorted(o.fullPathName for o in
                             [FMCAD.root.allOccurrences.item(i) for i in range(FMCAD.root.allOccurrences.count)]
                             if o.component == source_component)}
    else:
        linked_nested = FMCAD.call('occurrence.add', {'component': source['component'], 'copyMode': 'linked',
                                                      'destination': parent_ref,
                                                      'sharedParentPolicy': 'allInstances'})
    require(linked_nested['component'] == source['component'], 'linked nested add changed definition')
    require(linked_nested['affectedPaths'], 'linked nested add omitted affected paths')
    require(len(linked_nested['affectedPaths']) >= 2,
            'linked add did not report every repeated-parent path')
    results['linkedNested'] = linked_nested
    settle(FMCAD)

    proxy_source = create(FMCAD, 'IW76_ProxyReturn')
    proxy_component = FMCAD.resolve(proxy_source['component'], 'component')
    proxy_existing = existing_nested(FMCAD, proxy_component, parent_ref['path'])
    if proxy_existing:
        proxy_nested = {'occurrence': occurrence_ref(proxy_existing[0]), 'component': component_ref(proxy_component),
                        'copyMode': 'linked', 'affectedPaths': all_nested_paths(FMCAD, proxy_component)}
    else:
        proxy_nested = FMCAD.call('occurrence.add', {'component': proxy_source['component'], 'copyMode': 'linked',
            'destination': parent_ref, 'sharedParentPolicy': 'allInstances'})
    require(proxy_nested['occurrence']['path'].startswith(parent_ref['path'] + '+'),
            'nested add did not return a root-context path reference')
    require(len(proxy_nested['affectedPaths']) >= 2,
            'nested add omitted repeated-parent paths')
    require(FMCAD.resolve(proxy_nested['occurrence'], 'occurrence') is not None,
            'nested add result reference cannot be resolved')
    results['explicitRootContextProxy'] = proxy_nested
    settle(FMCAD)

    copies = [FMCAD.design.allComponents.item(i) for i in range(FMCAD.design.allComponents.count)
              if FMCAD.design.allComponents.item(i).name.startswith('IW76_Source (')]
    if copies:
        copy_component = copies[0]
        copied_paths = existing_nested(FMCAD, copy_component, parent_ref['path'])
        require(copied_paths, 'existing independent definition has no nested instance')
        independent = {'occurrence': occurrence_ref(copied_paths[0]), 'component': component_ref(copy_component),
                       'copyMode': 'independent', 'affectedPaths': all_nested_paths(FMCAD, copy_component)}
    else:
        independent = FMCAD.call('occurrence.duplicate', {'occurrence': source_ref, 'copyMode': 'independent',
                                                           'destination': parent_ref,
                                                           'sharedParentPolicy': 'allInstances'})
    require(independent['copyMode'] == 'independent', 'independent duplicate mode changed')
    require(independent['component'] != source['component'], 'independent copy reused source definition')
    require(len(independent['affectedPaths']) >= 2,
            'independent nested copy did not report every repeated-parent path')
    near_matrix(matrix_for(FMCAD, independent['occurrence']), matrix_for(FMCAD, source_ref),
                'nested duplicate without placement must preserve source world pose')
    results['independentWorldPoseDuplicate'] = independent
    settle(FMCAD)

    parent_space_source = create(FMCAD, 'IW76_ParentSpace')
    parent_space_component = FMCAD.resolve(parent_space_source['component'], 'component')
    parent_space_existing = existing_nested(FMCAD, parent_space_component, parent_ref['path'])
    if parent_space_existing:
        parent_space = {'occurrence': occurrence_ref(parent_space_existing[0]),
                        'component': component_ref(parent_space_component), 'copyMode': 'linked',
                        'affectedPaths': all_nested_paths(FMCAD, parent_space_component)}
    else:
        parent_space = FMCAD.call('occurrence.add', {'component': parent_space_source['component'],
            'copyMode': 'linked', 'destination': parent_ref, 'placementSpace': 'parent',
            'sharedParentPolicy': 'allInstances',
            'placement': {'translation': ['1 cm', '0 cm', '0 cm']}})
    expected_parent = [0, -1, 0, 1, 1, 0, 0, 3, 0, 0, 1, 0, 0, 0, 0, 1]
    actual_parent = matrix_for(FMCAD, parent_space['occurrence'])
    near_matrix(actual_parent, expected_parent, 'parent-local rotated placement')
    require(abs(actual_parent[3] - 1) < 1e-7 and abs(actual_parent[7] - 3) < 1e-7,
            'parent-local placement did not compose with rotated parent')
    results['placementSpaceParent'] = parent_space
    settle(FMCAD)

    root_space_source = create(FMCAD, 'IW76_RootSpace')
    root_space_component = FMCAD.resolve(root_space_source['component'], 'component')
    root_space_existing = existing_nested(FMCAD, root_space_component, parent_ref['path'])
    if root_space_existing:
        root_space = {'occurrence': occurrence_ref(root_space_existing[0]), 'component': component_ref(root_space_component),
                      'copyMode': 'linked', 'affectedPaths': all_nested_paths(FMCAD, root_space_component)}
    else:
        root_space = FMCAD.call('occurrence.add', {'component': root_space_source['component'],
            'copyMode': 'linked', 'destination': parent_ref, 'placementSpace': 'root',
            'sharedParentPolicy': 'allInstances',
            'placement': {'translation': ['5 cm', '0 cm', '0 cm']}})
    actual_root = matrix_for(FMCAD, root_space['occurrence'])
    near_matrix(actual_root, [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                'root-frame placement')
    results['placementSpaceRoot'] = root_space
    settle(FMCAD)

    # Explicit root-context ref succeeds; an ambiguous short name is rejected
    # by resolver preflight without replay or a second attempted mutation.
    nested_path_ref = linked_nested['occurrence']
    nested_proxy = FMCAD.resolve(nested_path_ref, 'occurrence')
    require(nested_proxy is not None, 'explicit root-context occurrence proxy did not resolve')
    source_proxies = [FMCAD.root.allOccurrences.item(i)
                      for i in range(FMCAD.root.allOccurrences.count)
                      if FMCAD.root.allOccurrences.item(i).component == source_component and
                      '+' in FMCAD.root.allOccurrences.item(i).fullPathName]
    ambiguous_names = [name for name in set(item.name for item in source_proxies)
                       if sum(item.name == name for item in source_proxies) > 1]
    require(ambiguous_names, 'scratch does not contain a repeated ambiguous native nested name')
    try:
        FMCAD.call('component.reparent', {'occurrence': sorted(ambiguous_names)[0],
            'target': parent_ref, 'confirm': True})
    except (ValueError, TypeError) as error:
        results['ambiguousNativeRejected'] = str(error)
    else:
        raise RuntimeError('ambiguous native short occurrence name was accepted')

    # A source definition containing the target is a cycle and must fail before add.
    try:
        FMCAD.call('occurrence.add', {'component': parent['component'], 'copyMode': 'linked',
                                      'destination': nested_path_ref})
    except (ValueError, TypeError) as error:
        results['cycleRejected'] = str(error)
    else:
        raise RuntimeError('cyclic nested add was accepted')

    # Reparent a unique root occurrence; capture/read back its root-space matrix.
    target = create(FMCAD, 'IW76_Target')
    moving = create(FMCAD, 'IW76_Moving')
    ensure_ungrounded(FMCAD, moving['occurrence'])
    expected_moving = [0.9563047559630354, -0.29237170472273677, 0, 7,
                       0.29237170472273677, 0.9563047559630354, 0, 1.1,
                       0, 0, 1, 0, 0, 0, 0, 1]
    ensure_transform(FMCAD, moving['occurrence'], {'translation': ['70 mm', '11 mm', '0 mm'],
        'axis': [0, 0, 1], 'angle': '17 deg'}, expected_moving)
    target_existing = existing_nested(FMCAD, FMCAD.resolve(moving['component'], 'component'),
                                      target['occurrence']['path'])
    if target_existing:
        moved = {'occurrence': occurrence_ref(target_existing[0]), 'worldPosePreserved': True,
                 'affectedPaths': sorted(o.fullPathName for o in target_existing)}
        near_matrix(matrix_for(FMCAD, moved['occurrence']), expected_moving,
                    'resumed reparent world pose')
    else:
        before = matrix_for(FMCAD, moving['occurrence'])
        moved = FMCAD.call('component.reparent', {'occurrence': moving['occurrence'],
            'target': target['occurrence'], 'confirm': True})
        after = matrix_for(FMCAD, moved['occurrence'])
        near_matrix(after, before, 'component.reparent world pose')
    require(moved['worldPosePreserved'] is True and moved['affectedPaths'],
            'reparent omitted pose/path evidence')
    results['reparentWorldPose'] = moved

    # A repeated destination must reject without explicit policy, then enumerate
    # every affected predicted path with allInstances explicitly authorized.
    target_component = FMCAD.resolve(target['component'], 'component')
    target_roots = [FMCAD.root.occurrences.item(i) for i in range(FMCAD.root.occurrences.count)
                    if FMCAD.root.occurrences.item(i).component == target_component]
    if len(target_roots) > 1:
        repeated_target = {'copyMode': 'linked', 'affectedPaths': [o.fullPathName for o in target_roots]}
    else:
        repeated_target = FMCAD.call('occurrence.add', {'component': target['component'],
            'copyMode': 'linked', 'destination': 'root'})
        settle(FMCAD)
    try:
        FMCAD.call('component.reparent', {'occurrence': moving['occurrence'],
            'target': target['occurrence'], 'confirm': True})
    except (ValueError, TypeError) as error:
        results['repeatedTargetRejectedWithoutPolicy'] = str(error)
    else:
        raise RuntimeError('reparent to repeated target omitted allInstances guard')
    repeated_move_source = create(FMCAD, 'IW76_RepeatedMove')
    ensure_ungrounded(FMCAD, repeated_move_source['occurrence'])
    repeated_move_component = FMCAD.resolve(repeated_move_source['component'], 'component')
    target_paths = [FMCAD.root.allOccurrences.item(i).fullPathName
                    for i in range(FMCAD.root.allOccurrences.count)
                    if FMCAD.root.allOccurrences.item(i).component == target_component]
    existing_repeated_move = sorted((FMCAD.root.allOccurrences.item(i)
        for i in range(FMCAD.root.allOccurrences.count)
        if FMCAD.root.allOccurrences.item(i).component == repeated_move_component and
        any(FMCAD.root.allOccurrences.item(i).fullPathName.startswith(path + '+') for path in target_paths)),
        key=lambda item: item.fullPathName)
    if existing_repeated_move:
        repeated_move = {'occurrence': occurrence_ref(existing_repeated_move[0]), 'worldPosePreserved': True,
                         'affectedPaths': sorted(o.fullPathName for o in existing_repeated_move)}
    else:
        repeated_move = FMCAD.call('component.reparent', {'occurrence': repeated_move_source['occurrence'],
            'target': target['occurrence'], 'confirm': True, 'sharedParentPolicy': 'allInstances'})
        settle(FMCAD)
    require(len(repeated_move['affectedPaths']) >= 2, 'allInstances did not report all target paths')
    results['reparentAllInstances'] = repeated_move
    results['repeatedTargetAdded'] = repeated_target

    # Reparenting a nested occurrence whose definition also occurs at root is
    # unsupported; the explicit proxy lets this guard be exercised unambiguously.
    repeated_source = create(FMCAD, 'IW76_RepeatedSource')
    repeated_source_component = FMCAD.resolve(repeated_source['component'], 'component')
    prior_nested_source = existing_nested(FMCAD, repeated_source_component, parent_ref['path'])
    if prior_nested_source:
        nested_source = {'occurrence': occurrence_ref(prior_nested_source[0]),
                         'component': component_ref(repeated_source_component), 'copyMode': 'linked',
                         'affectedPaths': [o.fullPathName for o in prior_nested_source]}
    else:
        nested_source = FMCAD.call('occurrence.add', {'component': repeated_source['component'],
            'copyMode': 'linked', 'destination': parent_ref, 'sharedParentPolicy': 'allInstances'})
        settle(FMCAD)
    try:
        FMCAD.call('component.reparent', {'occurrence': nested_source['occurrence'],
            'target': target['occurrence'], 'confirm': True})
    except (ValueError, TypeError) as error:
        results['repeatedNestedSourceRejected'] = str(error)
    else:
        raise RuntimeError('nested repeated-source reparent was accepted')

    results['scratchOnly'] = True
    return {'scratchOnly': True, 'status': 'all assertions passed',
            'document': {'name': FMCAD.doc.name, 'creationId': FMCAD.doc.creationId,
                         'fileId': getattr(FMCAD.doc.dataFile, 'id', None)},
            'legacyRootPaths': linked['affectedPaths'],
            'linkedNestedPaths': linked_nested['affectedPaths'],
            'nestedIndependentWorldPosePreserved': True,
            'placementSpaceParentReadback': matrix_for(FMCAD, parent_space['occurrence'])[3:8:4],
            'placementSpaceRootReadback': matrix_for(FMCAD, root_space['occurrence'])[3:8:4],
            'explicitRootProxyPath': proxy_nested['occurrence']['path'],
            'ambiguousNativeRejected': bool(results.get('ambiguousNativeRejected')),
            'cycleRejected': bool(results.get('cycleRejected')),
            'reparentWorldPosePreserved': moved['worldPosePreserved'],
            'reparentPaths': moved['affectedPaths'],
            'repeatedTargetRejectedWithoutPolicy': bool(results.get('repeatedTargetRejectedWithoutPolicy')),
            'allInstancesReparentPaths': repeated_move['affectedPaths'],
            'repeatedNestedSourceRejected': bool(results.get('repeatedNestedSourceRejected'))}
