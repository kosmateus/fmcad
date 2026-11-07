"""Order declared rigid parts; no SDK entities, dispatch or second workflow engine."""
from collections import deque
from collections.abc import Iterable as _sequence_Iterable
from typing import NotRequired as _sequence_NotRequired
from typing import TypedDict as _sequence_TypedDict
from typing import cast as _sequence_application_cast


class _SequenceMedia(_sequence_TypedDict):
    name: "JsonValue"
    connects: list["JsonValue"] | tuple["JsonValue", ...]
    rigid: _sequence_NotRequired["JsonValue"]


def _sequence_plan(data: "JsonObject") -> "JsonObject":
    parts = data['parts']
    if not isinstance(parts, list) or not parts or any(not isinstance(p, str) for p in parts):
        raise ValueError('parts must be a nonempty array of names')
    parts = _sequence_application_cast(list[str], parts)
    if len(set(parts)) != len(parts):
        raise ValueError('part names must be unique')

    dependencies = data.get('dependencies', [])
    if not isinstance(dependencies, list):
        raise ValueError('dependencies must be an array of [prerequisite, dependent] pairs')
    dependencies = _sequence_application_cast(list[object], dependencies)
    edges: list[tuple[str, str]] = []
    for dep in dependencies:
        if not isinstance(dep, (list, tuple)):
            raise ValueError('dependencies must be [prerequisite, dependent] pairs')
        pair = _sequence_application_cast(list[object] | tuple[object, ...], dep)
        if len(pair) != 2:
            raise ValueError('dependencies must be [prerequisite, dependent] pairs')
        a, b = pair[0], pair[1]
        if a not in parts or b not in parts:
            raise ValueError('dependency references an unknown part: %s -> %s' % (a, b))
        edges.append((_sequence_application_cast(str, a), _sequence_application_cast(str, b)))

    media = data.get('disconnectedMedia', [])
    if not isinstance(media, list):
        raise ValueError('disconnectedMedia must be an array')
    media = _sequence_application_cast(list[object], media)
    media_names: set[object] = set()
    media_items: list[_SequenceMedia] = []
    for m in media:
        if not isinstance(m, dict) or 'name' not in m or 'connects' not in m:
            raise ValueError('disconnectedMedia entries require name and connects')
        media_object = _sequence_application_cast('JsonObject', m)
        if media_object['name'] in media_names:
            raise ValueError('duplicate media name: ' + _sequence_application_cast(str, media_object['name']))
        media_names.add(media_object['name'])
        connects = media_object['connects']
        if not isinstance(connects, (list, tuple)) or len(connects) != 2 or any(c not in parts for c in connects):
            raise ValueError('media connects must reference two known parts')
        media_items.append(_sequence_application_cast(_SequenceMedia, media_object))

    service = data.get('serviceStates', [])
    if not isinstance(service, list):
        raise ValueError('serviceStates must be an array')
    service = _sequence_application_cast(list[object], service)
    service_by_part: dict[str, list["JsonValue"]] = {}
    for service_item in service:
        if not isinstance(service_item, dict) or 'part' not in service_item or 'requires' not in service_item:
            raise ValueError('serviceStates entries require part and requires')
        service_object = _sequence_application_cast('JsonObject', service_item)
        part = _sequence_application_cast(str, service_object['part'])
        if part not in parts:
            raise ValueError('serviceStates references unknown part: ' + part)
        if part in service_by_part:
            raise ValueError('duplicate serviceStates for part: ' + part)
        requires = service_object['requires']
        if not isinstance(requires, list) or not requires:
            raise ValueError('serviceStates requires must be a nonempty array')
        service_by_part[part] = requires

    phases = data.get('phases', [])
    if not isinstance(phases, list):
        raise ValueError('phases must be an array')
    phases = _sequence_application_cast(list[object], phases)
    phase_assign: dict[str, "JsonValue"] = {}
    for phase in phases:
        if not isinstance(phase, dict) or 'name' not in phase or 'parts' not in phase:
            raise ValueError('phases entries require name and parts')
        phase_object = _sequence_application_cast('JsonObject', phase)
        phase_parts = _sequence_application_cast(_sequence_Iterable["JsonValue"], phase_object['parts'])
        for p in phase_parts:
            if p not in parts:
                raise ValueError('phase references unknown part: ' + _sequence_application_cast(str, p))
            part = _sequence_application_cast(str, p)
            if part in phase_assign:
                raise ValueError('part assigned to more than one phase: ' + part)
            phase_assign[part] = phase_object['name']

    adj: dict[str, list[str]] = {p: [] for p in parts}
    indeg = {p: 0 for p in parts}
    for a, b in edges:
        adj[a].append(b)
        indeg[b] += 1
    queue = deque([p for p in parts if indeg[p] == 0])
    order: list[str] = []
    while queue:
        p = queue.popleft()
        order.append(p)
        for nxt in adj[p]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                queue.append(nxt)
    cycles = sorted(p for p in parts if indeg[p] > 0)
    ok = not cycles
    blockers = {p: [a for a, b in edges if b == p] for p in parts}
    disassembly = list(reversed(order)) if ok else list(order)
    removed = data.get('removedParts', [])
    if not isinstance(removed, list) or any(p not in parts for p in removed):
        raise ValueError('removedParts must reference known parts')
    removed = _sequence_application_cast(list[str], removed)
    removals: list["JsonObject"] = []
    for p in removed:
        disconnections = [m['name'] for m in media_items if p in m['connects']]
        row: "JsonObject" = {'part': p,
                              'removeBlockers': [b for a, b in edges if a == p],
                              'disconnections': disconnections,
                              'servicePrerequisites': service_by_part.get(p, [])}
        removals.append(row)
    removals.sort(key=lambda r: disassembly.index(_sequence_application_cast(str, r['part']))
                  if _sequence_application_cast(str, r['part']) in disassembly else 0)
    return {
        'order': order, 'disassemblyOrder': disassembly, 'blockers': blockers,
        'removals': removals, 'cycles': cycles, 'mediaRigidized': False,
        'mediaDisconnections': [{'name': m['name'], 'connects': list(m['connects']),
                                 'rigid': bool(m.get('rigid', False))} for m in media_items],
        'phaseAssignments': phase_assign, 'unphased': [p for p in parts if p not in phase_assign]}
