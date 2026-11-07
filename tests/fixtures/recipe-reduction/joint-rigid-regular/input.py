ARGS = {'prefix': 'caller-prefix', 'parameterDelta': '2 mm'}
DOC_NAME = 'scratch'

def run(_context):
    import adsk.fusion

    FMCAD.call('param.apply', {'parameters': [
        {'name': ARGS['prefix'] + 'One', 'expression': '20 mm', 'unit': 'mm'},
        {'name': ARGS['prefix'] + 'Two', 'expression': '20 mm', 'unit': 'mm'}]})

    def make_pair(suffix, one_expression, two_expression):
        base = FMCAD.call('component.create', {'name': ARGS['prefix'] + suffix + 'One'})
        moving = FMCAD.call('component.create', {'name': ARGS['prefix'] + suffix + 'Two'})
        one_component, one_occurrence = base['component'], base['occurrence']
        two_component, two_occurrence = moving['component'], moving['occurrence']
        for occurrence in (one_occurrence, two_occurrence):
            native = FMCAD.resolve(occurrence, 'occurrence')
            if getattr(native, 'isGrounded', False) or getattr(native, 'isGroundToParent', False):
                FMCAD.call('assembly.unground', {'occurrence': occurrence})

        def origin(component, tag, x_expression):
            prefix = ARGS['prefix'] + suffix + tag
            p0 = FMCAD.call('datum.point', {'name': prefix + 'Origin',
                'point': [x_expression, '0 mm', '0 mm']}, component=component)
            px = FMCAD.call('datum.point', {'name': prefix + 'XAxisEnd',
                'point': ['(' + x_expression + ') + 1 mm', '0 mm', '0 mm']}, component=component)
            pz = FMCAD.call('datum.point', {'name': prefix + 'ZAxisEnd',
                'point': [x_expression, '0 mm', '1 mm']}, component=component)
            x_axis = FMCAD.call('datum.axis', {'name': prefix + 'XAxis', 'mode': 'twoPoints',
                'point1': p0, 'point2': px}, component=component)
            z_axis = FMCAD.call('datum.axis', {'name': prefix + 'ZAxis', 'mode': 'twoPoints',
                'point1': p0, 'point2': pz}, component=component)
            return {'point': p0, 'xAxis': x_axis, 'zAxis': z_axis}

        return one_occurrence, two_occurrence, one_component, two_component, \
               origin(one_component, 'A', one_expression), origin(two_component, 'B', two_expression)

    def prebuild_origin(component_ref, origin_data):
        component = FMCAD.resolve(component_ref, 'component')
        point = FMCAD.resolve(origin_data['point'], 'point')
        x_axis = FMCAD.resolve(origin_data['xAxis'], 'axis')
        z_axis = FMCAD.resolve(origin_data['zAxis'], 'axis')
        geometry = adsk.fusion.JointGeometry.createByPoint(point)
        origin_input = component.jointOrigins.createInput(geometry)
        origin_input.xAxisEntity = x_axis
        origin_input.zAxisEntity = z_axis
        origin = component.jointOrigins.add(origin_input)
        return {'token': origin.entityToken, 'kind': 'JointOrigin'}

    variants = (
        ('UpdateAnchor', '0 deg', '0 mm', False, 'moveSecond'),
        ('Preserve', '0 deg', '0 mm', False, 'preserve'),
        ('JointOriginRef', '0 deg', '0 mm', False, 'preserve'),
        ('OffsetFlip', '30 deg', '2 mm', True, 'moveSecond'),
        ('OffsetPlain', '-15 deg', '-1 mm', False, 'moveSecond'),
    )
    results = []
    first_pair = None
    for index, (suffix, angle, offset, flipped, pose_policy) in enumerate(variants):
        one, two, component_one, component_two, origin_one, origin_two = make_pair(
            suffix,
            ARGS['prefix'] + 'One' if index == 0 else '0 mm',
            ARGS['prefix'] + 'Two' if index == 0 else '0 mm')
        if index == 0:
            first_pair = one, two
            grounded = FMCAD.call('assembly.ground', {'occurrence': two})
            if grounded.get('grounded') is not True:
                raise RuntimeError('grounding precondition fixture did not ground occurrenceTwo')
            try:
                FMCAD.call('joint.rigid', {'name': ARGS['prefix'] + 'GroundedReject', 'mode': 'regular',
                    'occurrenceOne': one, 'occurrenceTwo': two, 'originOne': origin_one, 'originTwo': origin_two,
                    'confirm': True, 'posePolicy': 'preserve', 'linearTolerance': '0.01 mm',
                    'angularTolerance': '0.01 deg', 'groundingPolicy': 'reject'})
            except (RuntimeError, ValueError) as exc:
                if 'rejects grounded' not in str(exc):
                    raise
            else:
                raise RuntimeError('regular joint did not reject a grounded input')
            native = FMCAD.resolve(two, 'occurrence')
            if not (getattr(native, 'isGrounded', False) or getattr(native, 'isGroundToParent', False)):
                raise RuntimeError('regular joint silently ungrounded the rejected input')
            FMCAD.call('assembly.unground', {'occurrence': two})
        if suffix == 'JointOriginRef':
            origin_one = {'ref': prebuild_origin(component_one, origin_one)}
            origin_two = {'ref': prebuild_origin(component_two, origin_two)}
        joint_data = {'name': ARGS['prefix'] + 'Joint' + suffix, 'mode': 'regular',
            'occurrenceOne': one, 'occurrenceTwo': two, 'originOne': origin_one, 'originTwo': origin_two,
            'confirm': True, 'posePolicy': pose_policy, 'angle': angle, 'offset': offset,
            'isFlipped': flipped, 'linearTolerance': '0.01 mm', 'angularTolerance': '0.01 deg',
            'groundingPolicy': 'reject'}
        if index == 0:
            for invalid, phrase in ((dict(joint_data, originOne=origin_two), 'matching input component'),
                                    (dict(joint_data, occurrenceTwo=one), 'distinct occurrences')):
                try:
                    FMCAD.call('joint.rigid', invalid)
                except (ValueError, RuntimeError) as exc:
                    if phrase not in str(exc):
                        raise
                else:
                    raise RuntimeError('regular joint accepted invalid source scope/occurrences')
        result = FMCAD.call('joint.rigid', joint_data)
        if result.get('asBuilt') is not False or result.get('mode') != 'regular':
            raise RuntimeError('regular rigid joint result was not reported as a native Joint')
        if index == 0:
            try:
                FMCAD.call('joint.rigid', joint_data)
            except (ValueError, RuntimeError) as exc:
                if 'name already exists' not in str(exc):
                    raise
            else:
                raise RuntimeError('regular joint accepted a duplicate joint name')
        results.append(result)

    occurrences = FMCAD.root.allOccurrences
    before = {occurrences.item(index).fullPathName: list(occurrences.item(index).transform2.asArray())
              for index in range(occurrences.count)}
    FMCAD.call('param.apply', {'parameters': [{'name': ARGS['prefix'] + 'Two',
        'expression': '20 mm + ' + ARGS['parameterDelta'], 'unit': 'mm'}], 'overwrite': True})
    FMCAD.call('history.recompute', {})
    updated = {occurrences.item(index).fullPathName: list(occurrences.item(index).transform2.asArray())
               for index in range(occurrences.count)}
    first_path, second_path = first_pair
    first_path, second_path = FMCAD.resolve(first_path, 'occurrence').fullPathName, \
                              FMCAD.resolve(second_path, 'occurrence').fullPathName
    if any(abs(a - b) > 1e-6 for a, b in zip(before[first_path], updated[first_path])):
        raise RuntimeError('source parameter update moved the protected first subtree')
    if not any(abs(a - b) > 1e-6 for a, b in zip(before[second_path], updated[second_path])):
        raise RuntimeError('source parameter update did not regenerate the dependent joint pose')

    FMCAD.call('param.apply', {'parameters': [{'name': ARGS['prefix'] + 'Two',
        'expression': '20 mm', 'unit': 'mm'}], 'overwrite': True})
    FMCAD.call('history.recompute', {})
    restored = {occurrences.item(index).fullPathName: list(occurrences.item(index).transform2.asArray())
                for index in range(occurrences.count)}
    if any(abs(a - b) > 1e-6 for a, b in zip(before[first_path], restored[first_path])) or \
            any(abs(a - b) > 1e-6 for a, b in zip(before[second_path], restored[second_path])):
        raise RuntimeError('restoring source parameter did not restore the mate subtree poses')
    FMCAD.emit({'variants': len(results), 'parameterUpdateRestored': True, 'joints': [r['joint'] for r in results]})
