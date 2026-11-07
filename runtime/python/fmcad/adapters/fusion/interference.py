"""GM19: clearance/interference grid audits and motion envelopes.

`clearance.grid` extends the single-pair `assembly.interference`/`assembly.clearance`
primitives (reused by dispatch) to instance/pair sets with include/exclude, expected
contacts that carry a cause and an allowed range, optional broad-phase pruning,
optional Cartesian joint ranges (PAN x TILT is a product, not a synchronous diagonal
track) and an explicit sample x pair budget. `motion.envelope` computes sampled,
conservative-bounded and (only with an explicit coverage proof) certified swept
envelopes for translation and rotation ranges.

Reuses `assembly.clearance`, `measure.distance`, `measure.bounds` and `joint.drive`
by dispatch; the pair/sample math here is self-contained. Dense sampled grids and
sums of sampled bodies never prove continuous no-collision: `continuousVerified` is
only true for a certified path with coverage proof.
"""
def _interference_contract(ctx: "CadContext", operation: str, result: "JsonObject", status: str = 'pass',
                           read_only: bool = True, **extra: "JsonValue") -> "JsonObject":
    identity: JsonValue = None
    if hasattr(ctx, 'doc') and getattr(ctx.doc, 'name', None) is not None:
        identity = {'creationId': _cad_cast("JsonValue", getattr(ctx.doc, 'creationId', None)),
                    'name': ctx.doc.name}
    component: JsonValue = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = ctx.ref(ctx.component)
        except Exception:
            component = None
    out: JsonObject = dict(schemaVersion=1, operation=operation, status=status, success=status == 'pass',
               documentIdentity=identity,
               units={'length': 'cm', 'volume': 'cm^3', 'angle': 'rad'},
               frame={'space': 'component', 'component': component},
               associativity='snapshot',
               method='GM19 interference/clearance grid and motion envelope audit',
               provenance={'requirement': 'GM19', 'source': 'docs/INTERFERENCE.md'})
    out['warnings'] = list(_cad_cast("Iterable[JsonValue]", result.pop('warnings', []))) + list(
        _cad_cast("Iterable[JsonValue]", extra.pop('warnings', [])))
    out['limitations'] = (
        ['Unsigned distance is not penetration depth; a failed Boolean is not an empty intersection.',
         'Dense sampled grids do not prove continuous no-collision; continuousVerified requires a coverage proof.',
         'Expected contacts must declare a cause and allowed range; they are never deleted wholesale.'] +
        list(_cad_cast("Iterable[JsonValue]", result.pop('limitations', []))) +
        list(_cad_cast("Iterable[JsonValue]", extra.pop('limitations', []))))
    out['affected'] = list(_cad_cast("Iterable[JsonValue]", result.pop('affected', []))) + list(
        _cad_cast("Iterable[JsonValue]", extra.pop('affected', [])))
    out.update(extra)
    out.update(result)
    return out


def _grid_pairs(ctx: "CadContext", data: "JsonObject") -> "list[JsonObject]":
    """Return an ordered list of {id, a, b} from explicit pairs or instance expansion."""
    pairs: list[JsonObject] = []
    if 'pairs' in data:
        if not isinstance(data['pairs'], list) or not data['pairs']:
            raise ValueError('pairs must be a nonempty array of {a,b}')
        for i, pair in enumerate(data['pairs']):
            if not isinstance(pair, dict) or set(pair) - {'a', 'b'} or 'a' not in pair or 'b' not in pair:
                raise ValueError('pairs entries require a and b')
            if _ref_key(pair['a']) == _ref_key(pair['b']):
                raise ValueError('pairs require distinct instances')
            pairs.append({'id': _pair_id(pair['a'], pair['b']), 'a': pair['a'], 'b': pair['b']})
    elif 'instances' in data:
        instances = data['instances']
        if not isinstance(instances, list) or len(instances) < 2:
            raise ValueError('instances must be an array of at least two refs')
        if len(set(_cad_cast(str, _ref_key(r)) for r in instances)) != len(instances):
            raise ValueError('instances must be distinct')
        for i in range(len(instances)):
            for j in range(i + 1, len(instances)):
                pairs.append({'id': _pair_id(instances[i], instances[j]),
                              'a': instances[i], 'b': instances[j]})
    else:
        raise ValueError('clearance.grid requires pairs or instances')
    include = data.get('include')
    exclude = data.get('exclude')
    if include is not None:
        if not isinstance(include, list):
            raise ValueError('include must be an array of pair ids')
        allowed = {_pair_id(p['a'], p['b'])
                   if isinstance(p, dict) else str(p) for p in include}
        pairs = [p for p in pairs if _cad_cast(str, p['id']) in allowed]
    if exclude is not None:
        if not isinstance(exclude, list):
            raise ValueError('exclude must be an array of pair ids')
        blocked = {_pair_id(p['a'], p['b'])
                   if isinstance(p, dict) else str(p) for p in exclude}
        pairs = [p for p in pairs if _cad_cast(str, p['id']) not in blocked]
    if not pairs:
        raise ValueError('No pairs remain after include/exclude filtering')
    return pairs


def _grid_expected(data: "JsonObject") -> "list[JsonObject]":
    expected = data.get('expectedContacts', [])
    if not isinstance(expected, list):
        raise ValueError('expectedContacts must be an array')
    parsed: list[JsonObject] = []
    for contact in expected:
        if not isinstance(contact, dict) or 'a' not in contact or 'b' not in contact or 'cause' not in contact:
            raise ValueError('expectedContacts entries require a, b and a cause')
        clearance = contact.get('clearance')
        if not isinstance(clearance, dict) or set(clearance) - {'min', 'max'} or 'min' not in clearance or 'max' not in clearance:
            raise ValueError('expectedContacts require a clearance {min,max} range')
        parsed.append({'id': _pair_id(contact['a'], contact['b']), 'cause': contact['cause'],
                       'min': clearance['min'], 'max': clearance['max']})
    return parsed


def _grid_cartesian(ctx: "CadContext", joints: "JsonValue", samples: "JsonValue") -> "tuple[list[JsonObject], list[list[tuple[JsonObject, float]]]]":
    """Expand Cartesian joint ranges into a product of configs (not a diagonal track)."""
    if not isinstance(joints, list) or not joints:
        raise ValueError('joints must be a nonempty array')
    if type(samples) is not int or not 2 <= samples <= 10000:
        raise ValueError('samples must be an integer in 2..10000')
    axes: list[JsonObject] = []
    joint_keys: set[str] = set()
    for track in joints:
        if not isinstance(track, dict) or 'joint' not in track:
            raise ValueError('joints entries require a joint ref')
        joint_key = _cad_cast(str, _ref_key(track['joint']))
        if joint_key in joint_keys:
            raise ValueError('joints must contain one range per distinct joint ref')
        joint_keys.add(joint_key)
        dof = None
        for key in ('rotation', 'slide'):
            if key in track:
                dof = key
                break
        if dof is None or not isinstance(track[dof], dict) or set(_cad_cast("JsonObject", track[dof])) - {'from', 'to'} or \
                'from' not in _cad_cast("JsonObject", track[dof]) or 'to' not in _cad_cast("JsonObject", track[dof]):
            raise ValueError('joints entries require rotation or slide {from,to}')
        start = ctx.angle(_cad_cast("JsonObject", track[dof])['from']) if dof == 'rotation' else ctx.length(_cad_cast("JsonObject", track[dof])['from'])
        end = ctx.angle(_cad_cast("JsonObject", track[dof])['to']) if dof == 'rotation' else ctx.length(_cad_cast("JsonObject", track[dof])['to'])
        values = [start if i == 0 else end if i == samples - 1 else start * (1 - i / (samples - 1)) + end * (i / (samples - 1)) for i in range(samples)]
        axes.append({'joint': track['joint'], 'dof': dof, 'values': values, 'unit': 'rad' if dof == 'rotation' else 'cm'})
    configs: list[list[tuple[JsonObject, float]]] = [[]]
    for axis in axes:
        configs = [config + [(axis, _cad_cast(float, value))] for config in configs
                   for value in _cad_cast("list[JsonValue]", axis['values'])]
    return axes, configs


def clearance_grid(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _interference_version(data)
    _model_fields(data, ('schemaVersion', 'frame'),
                  ('pairs', 'instances', 'include', 'exclude', 'expectedContacts', 'joints',
                   'samples', 'minimum', 'volumeTolerance', 'budget', 'broadPhase', 'tolerance'))
    pairs = _grid_pairs(ctx, data)
    expected = _grid_expected(data)
    expected_by_id = {_cad_cast(str, e['id']): e for e in expected}
    minimum = data.get('minimum', '0 mm')
    volume_tolerance = data.get('volumeTolerance', '0 mm^3')
    budget = data.get('budget', {})
    if not isinstance(budget, dict):
        raise ValueError('budget must be an object')
    max_checks = budget.get('maxChecks')
    if max_checks is not None and (type(max_checks) is not int or max_checks < 1):
        raise ValueError('budget.maxChecks must be a positive integer')
    broad_phase = data.get('broadPhase', False)
    if type(broad_phase) is not bool:
        raise ValueError('broadPhase must be boolean')
    minimum_cm = ctx.length(minimum)
    if minimum_cm < 0:
        raise ValueError('minimum must be nonnegative')
    if broad_phase and ('joints' in data or minimum_cm > 0):
        raise ValueError('broadPhase is unsupported with joint sampling or a positive minimum until safe pruning is established')
    pruned = 0
    if broad_phase and 'instances' in data:
        bounds: dict[str, JsonObject | None] = {}
        for instance in _cad_cast("list[JsonValue]", data['instances']):
            try:
                bounds[_cad_cast(str, _ref_key(instance))] = _cad_cast("JsonObject", ctx.call('measure.bounds', {'ref': instance}))
            except Exception:
                bounds[_cad_cast(str, _ref_key(instance))] = None
        kept: list[JsonObject] = []
        for pair in pairs:
            ba = bounds.get(_cad_cast(str, _ref_key(pair['a'])))
            bb = bounds.get(_cad_cast(str, _ref_key(pair['b'])))
            if ba and bb and not _aabb_overlap(ba, bb, 0.0):
                pruned += 1
            else:
                kept.append(pair)
        pairs = kept
    axes, configs = _grid_cartesian(ctx, data['joints'], data.get('samples', 5)) if 'joints' in data else (None, [None])
    total_checks = len(pairs) * len(configs)
    plan = {'pairCount': len(pairs), 'configCount': len(configs), 'totalChecks': total_checks,
            'broadPhasePruned': pruned, 'budget': {'maxChecks': max_checks},
            'withinBudget': max_checks is None or total_checks <= max_checks}
    if max_checks is not None and total_checks > max_checks:
        return _interference_contract(ctx, 'clearance.grid',
                                      {'plan': plan, 'results': [], 'minimumConfig': None, 'worstCaseGap': None,
                                       'coverage': {'tested': 0, 'skipped': 0, 'failed': 0, 'unknown': len(pairs) * len(configs),
                                                    'total': total_checks, 'continuousVerified': False},
                                       'poseRestored': True, 'skippedReason': 'budget exceeded'},
                                       status='unknown', read_only=False,
                                      limitations=['Sample x pair explosion exceeded budget.maxChecks; no pairs were tested.'])
    results: list[JsonObject] = []
    original: dict[str, JsonObject] | None = None
    if axes is not None:
        original = {}
        for axis in axes:
            inspected = ctx.call('joint.inspect', {'joint': axis['joint']})
            inspected = _cad_cast("JsonObject", inspected)
            value = inspected.get('rotationValue' if axis['dof'] == 'rotation' else 'slideValue')
            original[_cad_cast(str, _ref_key(axis['joint']))] = {'joint': axis['joint'], 'value': value,
                                                'unit': axis['unit'], 'dof': axis['dof']}
    restore_errors: list[JsonObject] = []
    try:
        for config_index, config in enumerate(configs):
            if config is not None:
                for axis, value in config:
                    ctx.call('joint.drive', {'joint': axis['joint'],
                                             _cad_cast(str, axis['dof']): format(value, '.17g') + ' ' + _cad_cast(str, axis['unit'])})
            for pair in pairs:
                pair_result: JsonObject = {'id': pair['id'], 'a': pair['a'], 'b': pair['b'],
                          'configIndex': config_index if config is not None else None}
                try:
                    measured = _grid_measure(ctx, pair, minimum, volume_tolerance)
                    pair_result.update(measured)
                    contact = expected_by_id.get(_cad_cast(str, pair['id']))
                    if contact:
                        pair_result['expected'] = True
                        pair_result['cause'] = contact['cause']
                        pair_result['status'] = 'tested'
                        pair_result['passed'] = _grid_expected_pass(ctx, pair_result, contact)
                    else:
                        pair_result['expected'] = False
                        pair_result['status'] = 'failed' if not pair_result['clearancePassed'] else 'tested'
                        pair_result['passed'] = pair_result['clearancePassed']
                except Exception as exc:
                    pair_result['status'] = 'unknown'
                    pair_result['passed'] = False
                    pair_result['error'] = type(exc).__name__ + ': ' + str(exc)
                results.append(pair_result)
    finally:
        if axes is not None and original:
            for state in original.values():
                joint = state['joint']
                if state['value'] is None:
                    restore_errors.append({'joint': joint, 'stage': 'baseline', 'error': 'original joint value unavailable'})
                    continue
                try:
                    ctx.call('joint.drive', {'joint': joint,
                                             _cad_cast(str, state['dof']): format(float(_cad_cast(float, state['value'])), '.17g') + ' ' + _cad_cast(str, state['unit'])})
                except Exception as exc:
                    restore_errors.append({'joint': joint, 'stage': 'setter',
                                           'error': type(exc).__name__ + ': ' + str(exc)})
                try:
                    inspected = _cad_cast("JsonObject", ctx.call('joint.inspect', {'joint': joint}))
                    actual = inspected.get('rotationValue' if state['dof'] == 'rotation' else 'slideValue')
                    tolerance = 1e-9
                    if actual is None or not math.isclose(float(_cad_cast(float, actual)),
                                                          float(_cad_cast(float, state['value'])),
                                                          rel_tol=0, abs_tol=tolerance):
                        restore_errors.append({'joint': joint, 'stage': 'readback', 'expected': state['value'],
                                               'actual': actual, 'tolerance': tolerance, 'units': state['unit']})
                except Exception as exc:
                    restore_errors.append({'joint': joint, 'stage': 'readback',
                                           'error': type(exc).__name__ + ': ' + str(exc)})
    pose_restored = not restore_errors
    tested = [r for r in results if r['status'] == 'tested']
    skipped = [r for r in results if r['status'] == 'skipped']
    failed = [r for r in results if r['status'] == 'failed']
    unknown = [r for r in results if r['status'] == 'unknown']
    gaps = [_grid_length_cm(r.get('distance')) for r in tested if r.get('distance') is not None and not r.get('expected', False)]
    gaps = [g for g in gaps if g is not None]
    minimum_config = min(tested, key=lambda r: _grid_length_cm(r.get('distance')) or math.inf) if tested else None
    worst_case_gap = min(gaps) if gaps else None
    coverage = {'tested': len(tested), 'skipped': len(skipped), 'failed': len(failed), 'unknown': len(unknown),
                'total': len(results), 'continuousVerified': False}
    status = 'fail' if failed or not pose_restored else ('unknown' if unknown else 'pass')
    result: JsonObject = {'plan': plan, 'results': results, 'minimumConfig': minimum_config,
              'worstCaseGap': {'value': worst_case_gap, 'units': 'cm'} if worst_case_gap is not None else None,
              'coverage': coverage, 'poseRestored': pose_restored, 'restoreErrors': restore_errors,
              'continuousVerified': False}
    if not pose_restored:
        result['warnings'] = ['Real pose was not fully restored after sampling; inspect the document before continuing.']
    return _interference_contract(ctx, 'clearance.grid', result, status=status, read_only=False,
                                  limitations=['Coverage is sampled; continuous no-collision is not certified by a dense grid.'])


def _grid_measure(ctx: "CadContext", pair: "JsonObject", minimum: "JsonValue", volume_tolerance: "JsonValue") -> "JsonObject":
    clear = _cad_cast("JsonObject", ctx.call('assembly.clearance', {'a': pair['a'], 'b': pair['b'],
                                                                 'minimum': minimum, 'volumeTolerance': volume_tolerance}))
    witness = None
    if not clear.get('interferes'):
        try:
            distance = _cad_cast("JsonObject", ctx.call('measure.distance', {'a': pair['a'], 'b': pair['b'], 'mode': 'minimum'}))
            witness = distance.get('points')
        except Exception:
            witness = None
    return {'interferes': clear.get('interferes'),
            'overlapVolume': clear.get('overlapVolume'),
            'distance': clear.get('distance'),
            'clearancePassed': clear.get('clearancePassed'),
            'witnessPoints': witness}


# assembly.clearance reports distance in its own units (mm from the live kernel;
# cm from the offline mock). ctx.length always returns cm, so normalize any
# reported length to cm before comparing against an expected-contact range.


def _grid_length_cm(measurement: "JsonValue") -> "float | None":
    if not isinstance(measurement, dict) or measurement.get('value') is None:
        return None
    factor = _LENGTH_TO_CM.get(_cad_cast(str, measurement.get('units')))
    if factor is None:
        return None
    return float(_cad_cast(float, measurement['value'])) * factor


def _grid_expected_pass(ctx: "CadContext", result: "JsonObject", contact: "JsonObject") -> bool:
    distance = _grid_length_cm(result.get('distance'))
    if distance is None:
        return False
    low = ctx.length(contact['min'])
    high = ctx.length(contact['max'])
    if low > high:
        raise ValueError('expected contact clearance min exceeds max')
    return low <= distance <= high


def motion_envelope(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _interference_version(data)
    _model_fields(data, ('schemaVersion', 'frame', 'motion'),
                  ('moving', 'bounds', 'samples', 'representation', 'certifiedPath'))
    representation = _cad_cast(str, data.get('representation', 'sampled'))
    if representation not in ('sampled', 'conservative', 'certified'):
        raise ValueError('representation must be sampled, conservative or certified')
    bounds = _envelope_bounds(ctx, data)
    motion = data['motion']
    if not isinstance(motion, dict) or 'type' not in motion:
        raise ValueError('motion requires a type')
    result: JsonObject = {'representation': representation,
              'continuousVerified': False,
              'envelopes': {}}
    if motion['type'] == 'translation':
        result.update(_envelope_translation(ctx, data, motion, bounds, representation))
    elif motion['type'] == 'rotation':
        result.update(_envelope_rotation(ctx, data, motion, bounds, representation))
    else:
        raise ValueError('motion.type must be translation or rotation')
    if representation == 'certified':
        certified = data.get('certifiedPath')
        if not isinstance(certified, list) or not certified:
            result['certified'] = False
            result['warnings'] = ['certified representation requires an explicit certifiedPath coverage proof; dense samples are not a proof.']
            result['continuousVerified'] = False
        else:
            result['certified'] = True
            result['certifiedPath'] = certified
            result['continuousVerified'] = True
    status = 'pass' if result.get('continuousVerified') or representation != 'certified' else 'unknown'
    return _interference_contract(ctx, 'motion.envelope', result, status=status, read_only=True,
                                  limitations=['Sampled and conservative envelopes bound the swept AABB, not a collision certificate.',
                                               'Continuous no-collision requires the certified path coverage proof.'])


CAD_HANDLERS.update({'clearance.grid': clearance_grid, 'motion.envelope': motion_envelope})


def _envelope_bounds(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    if 'bounds' in data:
        bounds = data['bounds']
        if not isinstance(bounds, dict) or 'min' not in bounds or 'max' not in bounds:
            raise ValueError('bounds requires {min:[x,y,z], max:[x,y,z]}')
        low = [ctx.length(str(v) + ' cm') if isinstance(v, (int, float)) else ctx.length(v)
               for v in _cad_cast("list[JsonValue]", bounds['min'])]
        high = [ctx.length(str(v) + ' cm') if isinstance(v, (int, float)) else ctx.length(v)
                for v in _cad_cast("list[JsonValue]", bounds['max'])]
        if any(h < l for l, h in zip(low, high)):
            raise ValueError('bounds min must be <= max')
        return {'min': low, 'max': high}
    if 'moving' not in data:
        raise ValueError('motion.envelope requires moving ref or explicit bounds')
    measured = _cad_cast("JsonObject", ctx.call('measure.bounds', {'ref': data['moving']}))
    units = _cad_cast(str, measured.get('units', 'mm'))
    scale = {'mm': 0.1, 'cm': 1.0, 'm': 100.0, 'in': 2.54}.get(units)
    if scale is None:
        raise ValueError('measure.bounds returned unsupported units')
    return {'min': [v * scale for v in _cad_cast("list[float]", measured['min'])],
            'max': [v * scale for v in _cad_cast("list[float]", measured['max'])]}


def _envelope_direction(value: "JsonValue") -> "list[float]":
    if value is None:
        return [1.0, 0.0, 0.0]
    return _cad_direction(value)


def _envelope_translation(ctx: "CadContext", data: "JsonObject", motion: "JsonObject",
                          bounds: "JsonObject", representation: str) -> "JsonObject":
    direction = _envelope_direction(motion.get('axis'))
    start = ctx.length(motion.get('from', '0 mm'))
    end = ctx.length(motion.get('to', '0 mm'))
    delta = [direction[i] * (end - start) for i in range(3)]
    samples = data.get('samples', 16)
    if type(samples) is not int or not 2 <= samples <= 100000:
        raise ValueError('samples must be an integer in 2..100000')
    result: JsonObject = {}
    sampled_bounds: list[JsonObject] = []
    for i in range(samples):
        t = start if i == 0 else end if i == samples - 1 else start * (1 - i / (samples - 1)) + end * (i / (samples - 1))
        translated: JsonObject = _cad_cast("JsonObject", {
            'min': [_cad_cast("list[float]", bounds['min'])[k] + direction[k] * t for k in range(3)],
            'max': [_cad_cast("list[float]", bounds['max'])[k] + direction[k] * t for k in range(3)]})
        sampled_bounds.append(translated)
    result['sampledEnvelope'] = _aabb_union(sampled_bounds)
    result['sampleCount'] = samples
    conservative = {'min': [min(_cad_cast("list[float]", bounds['min'])[k],
                                _cad_cast("list[float]", bounds['min'])[k] + delta[k]) for k in range(3)],
                    'max': [max(_cad_cast("list[float]", bounds['max'])[k],
                                _cad_cast("list[float]", bounds['max'])[k] + delta[k]) for k in range(3)]}
    result['conservativeEnvelope'] = conservative
    result['errorBound'] = {'value': 0.0, 'units': 'cm',
                            'note': 'straight-translation AABB is the exact sweep of the AABB; it still over-approximates the swept body'}
    result['direction'] = direction
    result['range'] = {'from': {'value': start, 'units': 'cm'}, 'to': {'value': end, 'units': 'cm'}}
    return result


def _envelope_rotation(ctx: "CadContext", data: "JsonObject", motion: "JsonObject",
                       bounds: "JsonObject", representation: str) -> "JsonObject":
    axis = _envelope_direction(motion['axis'])
    start = ctx.angle(motion.get('from', '0 deg'))
    end = ctx.angle(motion.get('to', '360 deg'))
    samples = data.get('samples', 16)
    if type(samples) is not int or not 2 <= samples <= 100000:
        raise ValueError('samples must be an integer in 2..100000')
    corners = [[_cad_cast("list[float]", bounds['min'])[0], _cad_cast("list[float]", bounds['min'])[1], _cad_cast("list[float]", bounds['min'])[2]],
               [_cad_cast("list[float]", bounds['min'])[0], _cad_cast("list[float]", bounds['min'])[1], _cad_cast("list[float]", bounds['max'])[2]],
               [_cad_cast("list[float]", bounds['min'])[0], _cad_cast("list[float]", bounds['max'])[1], _cad_cast("list[float]", bounds['min'])[2]],
               [_cad_cast("list[float]", bounds['min'])[0], _cad_cast("list[float]", bounds['max'])[1], _cad_cast("list[float]", bounds['max'])[2]],
               [_cad_cast("list[float]", bounds['max'])[0], _cad_cast("list[float]", bounds['min'])[1], _cad_cast("list[float]", bounds['min'])[2]],
               [_cad_cast("list[float]", bounds['max'])[0], _cad_cast("list[float]", bounds['min'])[1], _cad_cast("list[float]", bounds['max'])[2]],
               [_cad_cast("list[float]", bounds['max'])[0], _cad_cast("list[float]", bounds['max'])[1], _cad_cast("list[float]", bounds['min'])[2]],
               [_cad_cast("list[float]", bounds['max'])[0], _cad_cast("list[float]", bounds['max'])[1], _cad_cast("list[float]", bounds['max'])[2]]]
    sampled: list[JsonObject] = []
    for i in range(samples):
        angle = start if i == 0 else end if i == samples - 1 else start * (1 - i / (samples - 1)) + end * (i / (samples - 1))
        rotated = [_envelope_rotate_point(c, axis, angle) for c in corners]
        sampled.append(_cad_cast("JsonObject", {'min': [min(r[k] for r in rotated) for k in range(3)],
                                                   'max': [max(r[k] for r in rotated) for k in range(3)]}))
    center = [(_cad_cast("list[float]", bounds['min'])[k] + _cad_cast("list[float]", bounds['max'])[k]) / 2.0 for k in range(3)]
    radius = math.hypot(*(_cad_cast("list[float]", bounds['max'])[k] - center[k] for k in range(3)))
    # Conservative: the body is contained in a sphere of `radius` about its center;
    # rotating sweeps that sphere into a torus about the axis. Bound the torus by
    # its AABB (center path radius + sphere radius), which over-approximates the body.
    center_projected = [center[k] - axis[k] * sum(center[m] * axis[m] for m in range(3)) for k in range(3)]
    center_radius = math.hypot(*center_projected)
    axial = sum(center[m] * axis[m] for m in range(3))
    planar_extent = center_radius + radius
    conservative = {'min': [-planar_extent, -planar_extent, axial - radius],
                    'max': [planar_extent, planar_extent, axial + radius]}
    result: JsonObject = {'sampledEnvelope': _aabb_union(sampled), 'sampleCount': samples,
              'conservativeEnvelope': conservative,
              'errorBound': {'value': radius, 'units': 'cm',
                             'note': 'bounding-sphere torus over-approximation of the rotated body'},
              'axis': axis,
              'range': {'from': {'value': start, 'units': 'rad'}, 'to': {'value': end, 'units': 'rad'}}}
    return result
