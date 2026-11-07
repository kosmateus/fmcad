"""Default-atomic modeling-batch command transaction (bundled with core.py).

Reuses CadContext, CAD_HANDLERS and _cad_json from core.py; does not define a
second set of modeling methods. The only public Fusion transaction is a no-input
command whose execute event groups every mutation into one timeline transaction;
setting CommandEventArgs.executeFailed=True requests an abort (never guaranteed
rollback without a post-destroy model measurement).

The holder in sys.modules[module_name] keeps the event handlers and accumulated
state alive across non-persistent execute_python calls. Cleanup (definition delete + handler release) happens
only in atomic_finalize after an observed destroy and an idle command context.
"""

import json as _atomic_json
import math as _atomic_math
import re as _atomic_re
import sys as _atomic_sys
import types as _atomic_types


if _CAD_TYPE_CHECKING:
    from typing import NotRequired as _AtomicNotRequired, SupportsInt as _AtomicSupportsInt

    _AtomicItem = TypeVar('_AtomicItem')

    class _AtomicIdentity(_CadTypedDict):
        name: str
        creationId: str | None
        fileId: str | None

    class _AtomicExpectedIdentity(_CadTypedDict, total=False):
        name: str
        creationId: str | None
        fileId: str | None

    class _AtomicIdentityPin(_CadTypedDict, total=False):
        expected: _AtomicExpectedIdentity
        resolved: _AtomicIdentity

    class _AtomicCounts(_CadTypedDict):
        sketches: int
        bodies: int
        occurrences: int
        userParameters: int

    class _AtomicParameter(_CadTypedDict):
        expression: str
        unit: str

    class _AtomicTimelineEntry(_CadTypedDict):
        name: str
        healthState: int

    class _AtomicBody(_CadTypedDict):
        name: str | None
        volume: float | None
        bounds: list[float] | None
        material: str | None
        appearance: str | None

    class _AtomicSnapshot(_CadTypedDict):
        counts: _AtomicCounts
        parameters: dict[str, _AtomicParameter]
        occurrences: dict[str, list[float]]
        timeline: list[_AtomicTimelineEntry]
        bodies: list[_AtomicBody]

    class _AtomicDimension(_CadTypedDict):
        dimension: str
        matched: bool
        before: JsonValue
        after: JsonValue

    class _AtomicStep(_CadTypedDict):
        operation: str
        id: str
        data: _AtomicNotRequired[JsonValue]
        component: _AtomicNotRequired[JsonValue]
        occurrence: _AtomicNotRequired[JsonValue]
        expectFail: _AtomicNotRequired[bool]

    class _AtomicArgs(_CadTypedDict):
        commandId: JsonValue
        sessionNonce: JsonValue
        operation: _AtomicNotRequired[str]
        documentIdentity: _AtomicNotRequired[JsonValue]
        runId: _AtomicNotRequired[str]
        requestHash: _AtomicNotRequired[str]
        backend: _AtomicNotRequired[str]
        doc: str
        component: _AtomicNotRequired[JsonValue]
        projectId: _AtomicNotRequired[str]
        docId: _AtomicNotRequired[str]
        docFileId: _AtomicNotRequired[str]
        data: _AtomicNotRequired[JsonValue]
        readOnlyOperations: _AtomicNotRequired[JsonValue]
        steps: _AtomicNotRequired[JsonValue]
        testFault: _AtomicNotRequired[JsonValue]

    class _AtomicState(_CadTypedDict):
        status: str
        accepted: bool | None
        completed: bool
        destroyed: bool
        createdCount: int
        executeCount: int
        executeCompleted: bool
        terminationCompleted: bool
        terminationReason: int | None
        results: JsonValue
        created: JsonValue
        error: str | None
        errorStep: str | None
        outcome: str
        rollbackVerified: bool
        identity: _AtomicNotRequired[JsonRecord]
        idle: _AtomicNotRequired[bool]
        cleanupCompleted: _AtomicNotRequired[bool]
        definitionDeleted: _AtomicNotRequired[bool]
        ambiguous: _AtomicNotRequired[bool]
        candidates: _AtomicNotRequired[list[_AtomicIdentity]]
        unavailableEvidence: _AtomicNotRequired[list[str]]
        rollback: _AtomicNotRequired[JsonValue]
        after: _AtomicNotRequired[_AtomicSnapshot]
        nativeReceiptError: _AtomicNotRequired[str]

    class _AtomicObservedState(_CadTypedDict):
        status: str
        accepted: bool | None
        completed: bool
        destroyed: bool
        createdCount: int
        executeCount: int
        executeCompleted: bool
        terminationCompleted: bool
        terminationReason: int | None
        results: JsonValue
        created: JsonValue
        error: str | None
        errorStep: str | None
        outcome: str
        rollbackVerified: bool
        identity: JsonRecord
        idle: bool
        cleanupCompleted: bool
        definitionDeleted: bool

    class _AtomicResolvedDocument(_CadTypedDict):
        status: Literal['resolved']
        document: adsk.core.Document
        resolvedIdentity: _AtomicIdentity
        candidates: list[_AtomicIdentity]
        unavailableEvidence: list[str]

    class _AtomicUnresolvedDocument(_CadTypedDict):
        status: Literal['ambiguous', 'unavailable']
        candidates: list[_AtomicIdentity]
        unavailableEvidence: list[str]

    _AtomicDocumentResolution: TypeAlias = _AtomicResolvedDocument | _AtomicUnresolvedDocument

    _AtomicNativeLifecycle: TypeAlias = dict[str, Callable[..., None]]

    class _AtomicHolder(_Protocol):
        identity: JsonRecord
        ctx: JsonRecord
        before: _AtomicSnapshot
        handlers: list[object]
        state: _AtomicState
        definitionId: str
        native_lifecycle: _AtomicNativeLifecycle | None
        native_registered: bool
        native_returned: bool
        native_published: bool


def _atomic_reference_parts(reference: str) -> list[str]:
    parts = reference.split('.')
    if len(parts) < 2 or any(
            not _atomic_re.fullmatch(r'[A-Za-z0-9_-]+', part) or part in ('__proto__', 'prototype', 'constructor')
            for part in parts):
        raise ValueError('Invalid reference: ' + reference)
    return parts


def _atomic_resolve(value: "JsonValue", results: "JsonObject") -> "JsonValue":
    """Resolve sole-key {'$ref': 'stepId.result.field'} markers against accumulated results."""
    if isinstance(value, dict) and len(value) == 1 and '$ref' in value:
        reference = value['$ref']
        if not isinstance(reference, str) or not reference:
            raise ValueError('$ref must be the sole key with a nonempty string value')
        current: JsonValue = results
        for part in _atomic_reference_parts(reference):
            if isinstance(current, list):
                if not _atomic_re.fullmatch(r'(0|[1-9][0-9]*)', part):
                    raise ValueError('Invalid array index in reference: ' + reference)
                index = int(part)
                if index >= len(current):
                    raise ValueError('Array index out of range in reference: ' + reference)
                current = _cad_cast("list[JsonValue]", current)[index]
            elif isinstance(current, dict) and part in current:
                current = current[part]
            else:
                raise ValueError('Unresolved reference: ' + reference)
        return _cad_cast("JsonValue", _atomic_json.loads(_atomic_json.dumps(current)))
    if isinstance(value, list):
        return [_atomic_resolve(item, results) for item in value]
    if isinstance(value, dict):
        return {key: _atomic_resolve(item, results) for key, item in value.items()}
    return value


def _atomic_result_failed(result: "JsonValue") -> bool:
    """Mirror the JS/buildCadScript success predicate so an explicit unsuccessful
    handler result aborts the transaction just like a raised exception."""
    if not isinstance(result, dict):
        return False
    result_record = result
    if result_record.get('success') is False:
        return True
    if result_record.get('status') in ('unknown', 'missing', 'stale'):
        return True
    if result_record.get('passed') is False:
        return True
    if result_record.get('restored') is False and result_record.get('leftRequestedState') is not True and result_record.get('status') != 'pass':
        return True
    if result_record.get('sampledPassed') is False:
        return True
    if result_record.get('checkOutcome') == 'fail':
        return True
    return result_record.get('status') in ('fail', 'failed', 'blocked')


# Numeric tolerances for the post-destroy rollback measurement (§7): lengths cm,
# volumes cm^3, and unitless transform rotation entries are compared with
# explicit, measurement-appropriate tolerances, never by token/counter identity.
_ATOMIC_LENGTH_TOL = 1e-6
_ATOMIC_VOLUME_TOL = 1e-9
_ATOMIC_TRANSFORM_TOL = 1e-9
_TRANSLATION_INDEXES = (3, 7, 11)


def _atomic_items(collection: "_CadItemCollection[_AtomicItem] | list[_AtomicItem] | tuple[_AtomicItem, ...]") -> "list[_AtomicItem]":
    """Mirror core._cad_items without a cross-module dependency on the bundle."""
    if isinstance(collection, (list, tuple)):
        return list(collection)
    return [collection.item(i) for i in range(collection.count)]


def _atomic_snapshot(ctx: "CadContext") -> "_AtomicSnapshot":
    """Bounded, deterministic model baseline for rollback verification (§7).

    Captures more than the four legacy counters: user-parameter expressions,
    per-occurrence transforms, timeline feature health, and per-body volume,
    bounding box, name, material and appearance. No full-model dump; only the
    bounded dimensions §7 requires for baseline→final comparison.
    """
    parameters: dict[str, _AtomicParameter] = {}
    for parameter in _atomic_items(ctx.design.userParameters):
        parameters[parameter.name] = {'expression': parameter.expression, 'unit': parameter.unit}
    occurrences: dict[str, list[float]] = {}
    for occurrence in _atomic_items(ctx.root.allOccurrences):
        occurrences[occurrence.fullPathName] = list(occurrence.transform2.asArray())
    timeline: list[_AtomicTimelineEntry] = []
    timeline_object = _cad_cast("adsk.fusion.Timeline | None", getattr(ctx.design, 'timeline', None))
    if timeline_object is not None:
        for item in _atomic_items(timeline_object):
            timeline.append({'name': item.name,
                             'healthState': int(_cad_cast("int", item.healthState))})
    bodies: list[_AtomicBody] = []
    for body in _atomic_items(ctx.root.bRepBodies):
        volume = _cad_cast("float | None", getattr(body, 'volume', None))
        box = _cad_cast("adsk.core.BoundingBox3D | None", getattr(body, 'boundingBox', None))
        bounds = None
        if box is not None:
            bounds = [float(box.minPoint.x), float(box.minPoint.y), float(box.minPoint.z),
                      float(box.maxPoint.x), float(box.maxPoint.y), float(box.maxPoint.z)]
        bodies.append({
            'name': _cad_cast("str | None", getattr(body, 'name', None)),
            'volume': float(volume) if volume is not None else None,
            'bounds': bounds,
            'material': _cad_cast("str | None", getattr(getattr(body, 'material', None), 'name', None)),
            'appearance': _cad_cast("str | None", getattr(getattr(body, 'appearance', None), 'name', None)),
        })
    bodies.sort(key=lambda row: (row['name'] is None, row['name'] or ''))
    return {
        'counts': {'sketches': ctx.root.sketches.count, 'bodies': ctx.root.bRepBodies.count,
                   'occurrences': ctx.root.allOccurrences.count,
                   'userParameters': ctx.design.userParameters.count},
        'parameters': parameters,
        'occurrences': occurrences,
        'timeline': timeline,
        'bodies': bodies,
    }


def _atomic_numbers_close(before: "int | float | None", after: "int | float | None",
                          tolerance: float) -> bool:
    if before is None or after is None:
        return before is after
    return _atomic_math.isclose(before, after, rel_tol=1e-9, abs_tol=tolerance)


def _atomic_compare(before: "_AtomicSnapshot", after: "_AtomicSnapshot") -> "tuple[bool, list[_AtomicDimension]]":
    """Compare two `_atomic_snapshot` baselines with numeric tolerance.

    Returns (verified, dimensions); dimensions is the list of measured dimensions
    with matched/mismatched evidence, and verified is True only when every
    dimension matches.
    """
    dimensions: list[_AtomicDimension] = []

    def record(dimension: str, matched: bool, before_value: "JsonValue" = None,
               after_value: "JsonValue" = None) -> bool:
        dimensions.append({'dimension': dimension, 'matched': bool(matched),
                           'before': before_value, 'after': after_value})
        return bool(matched)

    verified = True
    for key in ('sketches', 'bodies', 'occurrences', 'userParameters'):
        verified &= record('counts.' + key, before['counts'][key] == after['counts'][key],
                           before['counts'][key], after['counts'][key])
    verified &= record('parameters', before['parameters'] == after['parameters'],
                       _cad_cast("JsonValue", before['parameters']),
                       _cad_cast("JsonValue", after['parameters']))
    before_occurrences = sorted(before['occurrences'])
    after_occurrences = sorted(after['occurrences'])
    if before_occurrences != after_occurrences:
        verified = False
        record('occurrences', False, before_occurrences, after_occurrences)
    else:
        occurrence_matched = True
        for path in before['occurrences']:
            wanted = before['occurrences'][path]
            actual = after['occurrences'][path]
            for index in range(16):
                tolerance = _ATOMIC_LENGTH_TOL if index in _TRANSLATION_INDEXES else _ATOMIC_TRANSFORM_TOL
                if not _atomic_numbers_close(wanted[index], actual[index], tolerance):
                    occurrence_matched = False
                    record('occurrence.%s[%d]' % (path, index), False, wanted[index], actual[index])
        verified &= record('occurrences', occurrence_matched, before_occurrences, after_occurrences)
    verified &= record('timeline', before['timeline'] == after['timeline'],
                       _cad_cast("JsonValue", before['timeline']),
                       _cad_cast("JsonValue", after['timeline']))
    if len(before['bodies']) != len(after['bodies']):
        verified = False
        record('bodies.count', False, len(before['bodies']), len(after['bodies']))
    else:
        for wanted, actual in zip(before['bodies'], after['bodies']):
            for key in ('name', 'material', 'appearance'):
                verified &= record('body.' + key, wanted[key] == actual[key], wanted[key], actual[key])
            verified &= record('body.volume',
                               _atomic_numbers_close(wanted['volume'], actual['volume'], _ATOMIC_VOLUME_TOL),
                               wanted['volume'], actual['volume'])
            bounds_matched = (wanted['bounds'] is None and actual['bounds'] is None) or (
                wanted['bounds'] is not None and actual['bounds'] is not None and
                all(_atomic_numbers_close(x, y, _ATOMIC_LENGTH_TOL)
                    for x, y in zip(wanted['bounds'], actual['bounds'])))
            verified &= record('body.bounds', bounds_matched, wanted['bounds'], actual['bounds'])
    return bool(verified), dimensions


def _atomic_fresh_context(app: "adsk.core.Application", doc: "adsk.core.Document",
                          args: "_AtomicArgs") -> "CadContext":
    """Bind a newly enumerated open document without name lookup or activation."""
    import adsk.fusion
    if getattr(doc, 'isValid', True) is False:
        raise ValueError('Resolved atomic document handle is no longer valid')
    ctx = CadContext.__new__(CadContext)
    ctx.app, ctx.doc = app, doc
    ctx.doc_id, ctx.doc_file_id = args.get('docId'), args.get('docFileId')
    ctx.assert_identity()
    design = _atomic_design(doc.products.itemByProductType('DesignProductType'))
    if design is None:
        raise ValueError('Resolved document no longer has a Fusion Design product')
    ctx.design = design
    ctx.root = ctx.design.rootComponent
    ctx.component, ctx.occurrence = ctx.root, None
    ctx.created = []
    setattr(ctx, '_profile_selections', [])
    component_ref = args.get('component')
    if component_ref is not None:
        entity = ctx.resolve(component_ref)
        if _cad_kind(entity) == 'occurrence':
            occurrence = _cad_cast("adsk.fusion.Occurrence", entity)
            ctx.occurrence, ctx.component = occurrence, occurrence.component
        elif _cad_kind(entity) == 'component':
            ctx.component = _cad_cast("adsk.fusion.Component", entity)
        else:
            raise ValueError('component_ref must resolve to a component or occurrence')
    return ctx


def _atomic_design(product: "adsk.core.Base") -> "adsk.fusion.Design | None":
    caster = _cad_cast("Callable[[adsk.core.Base], adsk.fusion.Design | None]",
                       getattr(adsk.fusion.Design, 'cast'))
    return caster(product)


def _atomic_termination_int(value: object) -> int:
    return int(_cad_cast("_AtomicSupportsInt", value))


def _atomic_command_definition(app: "adsk.core.Application", command_id: str) -> "adsk.core.CommandDefinition | None":
    lookup = _cad_cast("Callable[[str], object]",
                       getattr(app.userInterface.commandDefinitions, 'itemById'))
    value = lookup(command_id)
    return None if value is None else _cad_cast("adsk.core.CommandDefinition", value)


def _atomic_add_definition(app: "adsk.core.Application", command_id: str) -> "adsk.core.CommandDefinition | None":
    create = _cad_cast("Callable[[str, str, str], object]",
                        getattr(app.userInterface.commandDefinitions, 'addButtonDefinition'))
    value = create(command_id, 'fmcad atomic batch', 'Execute one atomic modeling batch')
    return None if value is None else _cad_cast("adsk.core.CommandDefinition", value)


def _atomic_transaction(app: "adsk.core.Application", args: "_AtomicArgs") -> "JsonRecord":
    import adsk.core
    import adsk.fusion
    command_id = _cad_cast(str, args.get('commandId'))
    session_nonce = args.get('sessionNonce')
    if not _atomic_re.fullmatch(r'fmcad_atomic_[0-9a-f]{32}', command_id):
        raise ValueError('Atomic batch requires a pinned command identity')
    if not isinstance(session_nonce, str) or not _atomic_re.fullmatch(r'[0-9a-f]{32}', session_nonce):
        raise ValueError('Atomic batch requires a pinned session nonce')
    operation = args.get('operation')
    module_name = '_fmcad_' + command_id
    holder_value = _atomic_sys.modules.get(module_name)
    holder: _AtomicHolder | None = (
        None if holder_value is None else _cad_cast("_AtomicHolder", holder_value))

    def documents() -> list[adsk.core.Document]:
        collection = app.documents
        if isinstance(collection, (list, tuple)):
            return list(_cad_cast("Sequence[adsk.core.Document]", collection))
        return _atomic_items(collection)

    def identity(doc: "adsk.core.Document") -> "_AtomicIdentity":
        if getattr(doc, 'isValid', True) is False:
            raise ValueError('Open document handle is no longer valid')
        data_file = doc.dataFile
        return {'name': doc.name,
                'creationId': doc.creationId,
                'fileId': data_file.id if data_file else None}

    def resolve_expected() -> "_AtomicDocumentResolution":
        expected = _cad_cast("_AtomicIdentityPin", args.get('documentIdentity') or {})
        wanted = expected.get('expected', {})
        all_documents = documents()
        getter_failures: list[str] = []
        rows: list[tuple[adsk.core.Document, _AtomicIdentity]] = []
        for doc in all_documents:
            try:
                rows.append((doc, identity(doc)))
            except Exception as error:
                getter_failures.append(type(error).__name__)
        if wanted.get('fileId') is not None:
            same_file = [(doc, actual) for doc, actual in rows if actual.get('fileId') == wanted.get('fileId')]
            if len(same_file) > 1:
                return {'status': 'ambiguous', 'candidates': [row[1] for row in same_file],
                        'unavailableEvidence': ['unique open buffer for pinned fileId'] + getter_failures}
        if getter_failures:
            return {'status': 'unavailable', 'candidates': [row[1] for row in rows],
                    'unavailableEvidence': ['document identity getter failed'] + getter_failures}
        candidates: list[tuple[adsk.core.Document, _AtomicIdentity]] = []
        for doc, actual in rows:
            if actual['name'] != wanted.get('name'):
                continue
            expected_creation_id = wanted.get('creationId')
            if expected_creation_id is not None and actual['creationId'] != expected_creation_id:
                continue
            expected_file_id = wanted.get('fileId')
            if expected_file_id is not None and actual['fileId'] != expected_file_id:
                continue
            candidates.append((doc, actual))
        if len(candidates) != 1:
            return {'status': 'ambiguous' if len(candidates) > 1 else 'unavailable',
                    'candidates': [row[1] for row in candidates],
                    'unavailableEvidence': ['unique open document identity'] + getter_failures}
        doc, actual = candidates[0]
        return {'status': 'resolved', 'document': doc, 'resolvedIdentity': actual,
                'candidates': [actual], 'unavailableEvidence': []}

    if operation == 'atomic_resolve':
        resolved = resolve_expected()
        return _cad_cast("JsonRecord", {key: value for key, value in resolved.items() if key != 'document'})

    if operation != 'atomic_start':
        if holder is None:
            return {'status': 'unavailable', 'accepted': None, 'completed': False,
                    'destroyed': False, 'cleanupCompleted': False, 'definitionDeleted': False,
                    'outcome': 'unknown', 'error': 'Live atomic batch state lost; inspect model, never replay'}
        expected_identity: JsonRecord = {'commandId': command_id, 'runId': args.get('runId'),
            'requestHash': args.get('requestHash'), 'backend': args.get('backend'),
            'sessionNonce': session_nonce,
            'documentIdentity': args.get('documentIdentity')}
        if any(holder.identity.get(key) != value for key, value in expected_identity.items()):
            return {'status': 'identity_mismatch', 'accepted': None, 'completed': False,
                    'destroyed': False, 'cleanupCompleted': False, 'definitionDeleted': False,
                    'outcome': 'unknown', 'error': 'Atomic holder identity mismatch; no cleanup performed'}
        resolved = resolve_expected()
        if resolved['status'] != 'resolved' or resolved['resolvedIdentity'] != holder.identity.get('resolvedIdentity'):
            status = resolved['status'] if resolved['status'] != 'resolved' else 'identity_mismatch'
            return _cad_cast("JsonRecord", dict(holder.state, status=status, ambiguous=status == 'ambiguous',
                        candidates=resolved['candidates'], unavailableEvidence=resolved['unavailableEvidence'],
                        identity=holder.identity, cleanupCompleted=False, definitionDeleted=False))
        state = _cad_cast("_AtomicObservedState", dict(holder.state, identity=holder.identity,
                     idle=app.userInterface.activeCommand in ('', 'SelectCommand'),
                     cleanupCompleted=holder.state.get('cleanupCompleted', False),
                     definitionDeleted=holder.state.get('definitionDeleted', False)))
        if operation == 'atomic_status':
            if not state['cleanupCompleted']:
                live_definition = _atomic_command_definition(app, command_id)
                if live_definition is None or getattr(live_definition, 'isValid', True) is False or \
                        live_definition.isNative or live_definition.id != holder.definitionId:
                    return _cad_cast("JsonRecord", dict(state, status='unavailable', outcome='unknown',
                                unavailableEvidence=['owned native command lifetime']))
            return _cad_cast("JsonRecord", state)
        if operation == 'atomic_observe':
            if state['cleanupCompleted']:
                return _cad_cast("JsonRecord", dict(state, status='unavailable', outcome='unknown',
                            unavailableEvidence=['native command observation lifetime ended']))
            requests = args.get('data')
            allowed = set(_cad_cast("Iterable[str]", args.get('readOnlyOperations') or []))
            if not isinstance(requests, list) or len(requests) > 100:
                raise ValueError('Atomic observe requires at most 100 operations')
            for request in requests:
                if not isinstance(request, dict) or request.get('operation') not in allowed or not isinstance(request.get('data'), dict):
                    raise ValueError('Atomic observe operation is not in the read-only whitelist')
            # Resolve a fresh live document reference; never reuse holder.ctx SDK objects.
            ctx = _atomic_fresh_context(app, resolved['document'], args)
            if identity(ctx.doc) != holder.identity['resolvedIdentity']:
                return _cad_cast("JsonRecord", dict(state, status='identity_mismatch', outcome='unknown'))
            results: list[JsonValue] = []
            for request in requests:
                request_record = _cad_cast("JsonObject", request)
                request_operation = _cad_cast(str, request_record.get('operation'))
                request_data = _cad_cast("JsonObject", request_record.get('data'))
                handler = CAD_HANDLERS.get(request_operation)
                if handler is None:
                    raise ValueError('Atomic observe handler is unavailable: ' + request_operation)
                results.append(_cad_json(ctx.call(request_operation, request_data)))
            return _cad_cast("JsonRecord", dict(state, status='observed', results=results))
        if holder.state.get('cleanupCompleted') is True:
            return _cad_cast("JsonRecord", dict(holder.state, identity=holder.identity,
                        idle=app.userInterface.activeCommand in ('', 'SelectCommand')))
        # atomic_finalize: require observed destroy before any cleanup or readback.
        if not state.get('destroyed'):
            return _cad_cast("JsonRecord", dict(state, completed=False, outcome='unknown'))
        if app.userInterface.activeCommand not in ('', 'SelectCommand'):
            # Destroy was already observed and the outcome determined; keep the
            # reliable commit/abort result and defer only cleanup + rollback
            # measurement until the command context is idle again. Never relabel
            # an observed termination as unknown here.
            return _cad_cast("JsonRecord", dict(state, status='cleanup_pending', completed=state.get('completed'),
                        outcome=state.get('outcome') or 'unknown'))
        # Resolve a fresh current document and complete the native measurement
        # before cleanup; never use the holder's saved SDK document reference.
        ctx = _atomic_fresh_context(app, resolved['document'], args)
        if identity(ctx.doc) != holder.identity['resolvedIdentity']:
            return _cad_cast("JsonRecord", dict(state, status='identity_mismatch', outcome='unknown', cleanupCompleted=False))
        after = _atomic_snapshot(ctx)
        rollback_verified = False
        rollback: JsonRecord = {'measured': False, 'matched': None, 'dimensions': []}
        if state.get('outcome') == 'aborted':
            rollback_verified, dimensions = _atomic_compare(holder.before, after)
            rollback = {'measured': True, 'matched': rollback_verified,
                        'dimensions': _cad_cast("JsonValue", dimensions)}
        definition = _atomic_command_definition(app, command_id)
        if definition is None or getattr(definition, 'isValid', True) is False or \
                definition.isNative or definition.id != holder.definitionId:
            raise ValueError('Owned atomic command definition changed')
        if not definition.deleteMe() or _atomic_command_definition(app, command_id) is not None:
            raise RuntimeError('Atomic command definition cleanup not confirmed')
        holder.handlers.clear()
        holder.state.update(definitionDeleted=True, cleanupCompleted=True,
                            rollbackVerified=rollback_verified, rollback=rollback, after=after)
        return _cad_cast("JsonRecord", dict(holder.state, identity=holder.identity,
                    idle=app.userInterface.activeCommand in ('', 'SelectCommand')))

    # atomic_start
    if app.userInterface.activeCommand not in ('', 'SelectCommand'):
        raise ValueError('Atomic batch start requires an idle non-command host context; nested Command execution is unsupported')
    if holder is not None or _atomic_command_definition(app, command_id) is not None:
        raise ValueError('Atomic batch was already submitted; inspect existing state, never replay')
    steps_value = args.get('steps')
    if not isinstance(steps_value, list) or not steps_value:
        raise ValueError('Atomic batch requires a nonempty step list')
    fault_steps: list[JsonObject] = []
    for step_value in steps_value:
        if isinstance(step_value, dict) and step_value.get('operation') == '__test.fault':
            fault_steps.append(step_value)
    if (args.get('testFault') is True) != (len(fault_steps) == 1) or any(
            step.get('id') != '__test_fault' for step in fault_steps):
        raise ValueError('Atomic test fault request and synthetic step do not match')
    steps = _cad_cast("list[_AtomicStep]", steps_value)
    ctx = CadContext(args['doc'], args.get('component'), args.get('projectId'),
                     args.get('docId'), args.get('docFileId'))
    resolved = resolve_expected()
    identity_pin = _cad_cast("_AtomicIdentityPin", args.get('documentIdentity') or {})
    if resolved['status'] != 'resolved' or resolved['resolvedIdentity'] != identity_pin.get('resolved') or \
            identity(ctx.doc) != resolved['resolvedIdentity']:
        raise ValueError('Atomic start resolved document identity changed; no command submitted')
    if app.activeDocument != ctx.doc:
        raise ValueError('Atomic batch requires the pinned document to be active')
    ctx.activate_target()
    ctx.assert_identity()
    before = _atomic_snapshot(ctx)
    module_holder = _atomic_types.ModuleType(module_name)
    holder = _cad_cast("_AtomicHolder", module_holder)
    holder.identity = {'commandId': command_id, 'runId': args.get('runId'), 'sessionNonce': session_nonce,
                      'requestHash': args.get('requestHash'), 'backend': args.get('backend'),
                       'documentIdentity': args.get('documentIdentity'),
                       'resolvedIdentity': _cad_cast("JsonValue", resolved['resolvedIdentity'])}
    holder.ctx = {'doc': args['doc'], 'component': args.get('component'), 'projectId': args.get('projectId'),
                  'docId': args.get('docId'), 'docFileId': args.get('docFileId')}
    holder.before = before
    holder.handlers = []
    holder.state = {'status': 'submitted', 'accepted': None, 'completed': False, 'destroyed': False,
                    'createdCount': 0, 'executeCount': 0, 'executeCompleted': False,
                    'terminationCompleted': False, 'terminationReason': None,
                    'results': None, 'created': None, 'error': None, 'errorStep': None,
                    'outcome': 'unknown', 'rollbackVerified': False}
    lifecycle = globals().get('__fmcad_native_lifecycle__')
    lifecycle_mapping = _cad_cast("dict[str, Callable[..., None]]", lifecycle)
    holder.native_lifecycle = lifecycle_mapping if isinstance(lifecycle, dict) and all(
        callable(lifecycle_mapping.get(k)) for k in ('start', 'complete')) else None
    holder.native_registered = holder.native_returned = holder.native_published = False

    def publish_native_end():
        state = holder.state
        rejected = state['accepted'] is False and state['createdCount'] == 0 and state['executeCount'] == 0
        if (not holder.native_lifecycle or not holder.native_registered or not holder.native_returned
                or holder.native_published or not (state['destroyed'] or rejected)):
            return
        try:
            holder.native_lifecycle['complete']('atomic-batch', holder.identity, state)
            holder.native_published = True
            holder.native_lifecycle = None
        except Exception as error:
            state['nativeReceiptError'] = type(error).__name__ + ': ' + str(error)
    _atomic_sys.modules[module_name] = module_holder  # Handlers must survive non-persistent script calls.

    class Execute(adsk.core.CommandEventHandler):
        def notify(self, eventArgs: "adsk.core.CommandEventArgs") -> None:
            state = holder.state
            state['executeCount'] += 1
            state['status'] = 'executing'
            try:
                if state['executeCount'] != 1 or state['error']:
                    raise RuntimeError('Repeated or failed atomic command execution refused')
                results: JsonRecord = {}
                for step in steps:
                    state['errorStep'] = step.get('id')
                    data = _atomic_resolve(step.get('data', {}), results)
                    scope: JsonObject = {}
                    if step.get('component') is not None:
                        scope['component'] = _atomic_resolve(step.get('component'), results)
                    if step.get('occurrence') is not None:
                        scope['occurrence'] = _atomic_resolve(step.get('occurrence'), results)
                    old_component, old_occurrence = ctx.component, ctx.occurrence
                    created_before = len(ctx.created)
                    try:
                        if scope:
                            ctx.component, ctx.occurrence = _cad_cast(
                                "Callable[[JsonObject], tuple[adsk.fusion.Component, adsk.fusion.Occurrence | None]]",
                                getattr(ctx, '_scope'))(scope)
                            handler = CAD_HANDLERS.get(step['operation'])
                            if getattr(handler, '_cad_native_only', False) and ctx.occurrence is not None:
                                raise ValueError(step['operation'] + ' creates native component geometry; per-step occurrence override is unsupported')
                        if step['operation'] == '__test.fault':
                            if args.get('testFault') is not True or step.get('id') != '__test_fault':
                                raise ValueError('Atomic test fault step is not authorized by the internal test gate')
                            raw = _atomic_test_fault(ctx, _cad_cast("JsonObject", data))
                        else:
                            raw = ctx.call(step['operation'], data)
                    finally:
                        ctx.component, ctx.occurrence = old_component, old_occurrence
                    result = _cad_json(raw)
                    raw_record = raw if isinstance(raw, dict) else {}
                    if _atomic_result_failed(raw) and not (
                            step.get('expectFail') is True and raw_record.get('status') == 'fail' and
                            raw_record.get('restored') is not False and raw_record.get('rollbackVerified') is not False):
                        raise RuntimeError('Step %s returned an unsuccessful result: %s'
                                           % (step['id'], _atomic_json.dumps(result)))
                    results[step['id']] = {'success': True, 'operation': step['operation'],
                                           'document': ctx.doc.name, 'result': result,
                                           'created': _cad_json(ctx.created[created_before:])}
                state.update(results=results, created=_cad_json(ctx.created),
                             errorStep=None, executeCompleted=True, status='executed')
            except Exception as error:
                error_message = type(error).__name__ + ': ' + str(error)
                state.update(error=error_message, status='failed')
                eventArgs.executeFailedMessage = error_message
                eventArgs.executeFailed = True  # Request abort; never assume rollback without measurement.

    class Destroy(adsk.core.CommandEventHandler):
        def notify(self, eventArgs: "adsk.core.CommandEventArgs") -> None:
            state = holder.state
            good = eventArgs.terminationReason == _cad_cast(
                "adsk.core.CommandTerminationReason", adsk.core.CommandTerminationReason.CompletedTerminationReason)
            complete = good and state['executeCompleted'] and not state['error']
            # On an error-driven abort the kernel may still report CompletedTerminationReason;
            # surface the effective AbortedTerminationReason so the report's terminationReason
            # matches the aborted outcome (§5). The outcome derivation above is unchanged.
            termination_reason = _atomic_termination_int(
                adsk.core.CommandTerminationReason.AbortedTerminationReason) if state['error'] \
                else _atomic_termination_int(eventArgs.terminationReason)
            state.update(destroyed=True, terminationReason=termination_reason,
                         terminationCompleted=good, completed=bool(complete),
                         status='completed' if complete else 'terminated',
                          outcome='committed' if complete else 'aborted')
            publish_native_end()

    class Created(adsk.core.CommandCreatedEventHandler):
        def notify(self, eventArgs: "adsk.core.CommandCreatedEventArgs") -> None:
            try:
                state = holder.state
                state['createdCount'] += 1
                if state['createdCount'] != 1:
                    raise RuntimeError('Repeated CommandCreated event refused')
                execute_handler, destroy_handler = Execute(), Destroy()
                holder.handlers.extend([execute_handler, destroy_handler])
                if not eventArgs.command.destroy.add(destroy_handler) or not eventArgs.command.execute.add(execute_handler):
                    raise RuntimeError('Atomic command event attachment failed')
                eventArgs.command.isRepeatable = False
                eventArgs.command.isExecutedWhenPreEmpted = False
                eventArgs.command.isAutoExecute = True
                if eventArgs.command.commandInputs.count:
                    raise RuntimeError('Atomic command must not have inputs')
                state['status'] = 'created'
            except Exception as error:
                holder.state.update(error=type(error).__name__ + ': ' + str(error), status='failed')

    try:
        definition = _atomic_add_definition(app, command_id)
        if definition is None:
            raise RuntimeError('Atomic command definition creation failed')
        holder.definitionId = command_id
        created_handler = Created()
        holder.handlers.append(created_handler)
        if not definition.commandCreated.add(created_handler):
            raise RuntimeError('Atomic CommandCreated attachment failed')
        if holder.native_lifecycle:
            holder.native_lifecycle['start']('atomic-batch', holder.identity)
            holder.native_registered = True
        holder.state['accepted'] = bool(definition.execute())
        if not holder.state['accepted']:
            holder.state.update(completed=False, outcome='unknown', error='Native launch was not accepted; late execution refused')
    except Exception as error:
        holder.state.update(error=type(error).__name__ + ': ' + str(error), status='unknown',
                            completed=False, outcome='unknown')
        raise
    finally:
        holder.native_returned = True
        publish_native_end()
    return _cad_cast("JsonRecord", dict(holder.state, identity=holder.identity))


def _atomic_test_fault(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    """Test-only deterministic fault injection for the guarded atomic test path.

    This helper is dispatched privately by the atomic command only when its
    internally injected testFault flag and synthetic step agree. It is never
    registered in CAD_HANDLERS, so normal handler dispatch cannot reach it.

    Supported phases (data['phase']):
      - after_mutation:    raise after prior real steps mutated the model, so the
                           whole transaction is aborted and every prior mutation
                           is reverted (scenario: error after mutation).
      - before_ref_publish: create a real object via the shared handlers, then
                           raise before its reference is published to the step
                           results, so the abort leaves no orphan (partial handler).
      - final_validation:  return an explicit unsuccessful result that the shared
                           result-failure predicate treats as a failed required
                           check, aborting the whole batch.
    """
    phase = data.get('phase')
    if phase == 'after_mutation':
        raise RuntimeError('test fault: after-mutation abort')
    if phase == 'before_ref_publish':
        ctx.call('component.create', {'name': data.get('name', '__test_orphan')})
        raise RuntimeError('test fault: before-ref-publish abort (no orphan)')
    if phase == 'final_validation':
        return {'status': 'fail', 'message': 'test fault: final validation rejected the result'}
    raise ValueError('unknown test fault phase: %r' % (phase,))


def execute(args: "JsonObject") -> "JsonRecord":
    import adsk.core
    app = adsk.core.Application.get()
    return _atomic_transaction(app, _cad_cast("_AtomicArgs", args))
