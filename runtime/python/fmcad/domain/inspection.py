"""Bounded readonly composition. No SDK imports or execution ownership."""
import itertools as _inspection_itertools
import json as _inspection_json
from collections.abc import Mapping as _InspectionMapping
from collections.abc import Sequence as _InspectionSequence
from typing import TYPE_CHECKING as _INSPECTION_TYPE_CHECKING
from typing import cast as _inspection_cast

if _INSPECTION_TYPE_CHECKING:
    from typing import Callable as _InspectionCallable
    from typing import NotRequired as _InspectionNotRequired
    from typing import TypedDict as _InspectionTypedDict

    class _InspectionRead(_InspectionTypedDict):
        id: str
        operation: str
        data: JsonObject
        fields: _InspectionNotRequired[list[str]]

    class _InspectionPlan(_InspectionTypedDict):
        reads: list[_InspectionRead]
        inventory: list[str]
        maxItems: int
        maxDepth: int
        maxStringBytes: int
        maxBytes: int


def inspection_pack(
    plan: "_InspectionPlan",
    dispatch: "_InspectionCallable[[str, JsonObject], JsonValue]",
    serialize: "_InspectionCallable[[object], JsonValue]",
) -> "JsonObject":
    """Compose one catalog inventory and one context; limits bound output, not SDK work."""
    items: list[JsonValue] = []
    supported = set(plan['inventory'])
    partial = False
    remaining_nodes = [plan['maxBytes'] // 4]
    remaining_bytes = [plan['maxBytes']]

    def charge(value: "JsonValue", reasons: set[str]) -> "tuple[bool, JsonValue]":
        cost = len(_inspection_json.dumps(value, ensure_ascii=True, allow_nan=False).encode('utf-8'))
        remaining_bytes[0] -= cost
        if remaining_bytes[0] < 0:
            reasons.add('maxBytes')
            return False, None
        return True, value

    def project(value: "JsonValue", depth: int, reasons: set[str]) -> "JsonValue":
        remaining_nodes[0] -= 1
        if remaining_nodes[0] < 0 or remaining_bytes[0] < 4:
            reasons.add('maxBytes')
            return None
        if depth > plan['maxDepth']:
            reasons.add('maxDepth')
            return None
        if isinstance(value, _InspectionMapping):
            entries = _inspection_cast("_InspectionMapping[object, object]", value)
            pairs = list(_inspection_itertools.islice(entries.items(), plan['maxItems']))
            if len(value) > len(pairs):
                reasons.add('maxItems')
            remaining_bytes[0] -= 2
            object_result: "JsonObject" = {}
            for key, untyped_item in pairs:
                if not isinstance(key, str):
                    raise TypeError('Inspection DTO keys must be strings')
                if len(key.encode('utf-8')) > plan['maxStringBytes']:
                    reasons.add('maxStringBytes')
                    continue
                accepted, _ = charge(key, reasons)
                if not accepted or remaining_bytes[0] < 8:
                    reasons.add('maxBytes')
                    break
                remaining_bytes[0] -= 2
                object_result[key] = project(_inspection_cast("JsonValue", untyped_item), depth + 1, reasons)
            return object_result
        if isinstance(value, _InspectionSequence) and not isinstance(value, str):
            if len(value) > plan['maxItems']:
                reasons.add('maxItems')
            remaining_bytes[0] -= 2
            sequence_result: "list[JsonValue]" = []
            for item in _inspection_itertools.islice(value, plan['maxItems']):
                if remaining_bytes[0] < 8:
                    reasons.add('maxBytes')
                    break
                remaining_bytes[0] -= 1
                sequence_result.append(project(item, depth + 1, reasons))
            return sequence_result
        if isinstance(value, str):
            encoded = value.encode('utf-8')
            if len(encoded) > plan['maxStringBytes']:
                reasons.add('maxStringBytes')
                value = encoded[:plan['maxStringBytes']].decode('utf-8', errors='ignore')
        accepted, serialized = charge(serialize(value), reasons)
        return serialized if accepted else None

    def encoded_size(value: "JsonValue") -> int:
        return len(_inspection_json.dumps(value, ensure_ascii=True, allow_nan=False).encode('utf-8'))

    for read in plan['reads']:
        row: "JsonObject" = {'id': read['id'], 'operation': read['operation']}
        if read['operation'] not in supported:
            row.update(status='unsupported', reasons=['notInspectionSafe'])
        else:
            try:
                value = dispatch(read['operation'], read['data'])
                reasons: set[str] = set()
                if isinstance(value, dict) and (value.get('success') is False or value.get('passed') is False or
                        value.get('sampledPassed') is False or value.get('checkOutcome') == 'fail' or
                        value.get('status') in ('fail', 'failed', 'error', 'skipped', 'notEvaluated', 'blocked', 'unknown', 'missing', 'stale', 'partial', 'unsupported')):
                    reasons.add('nonPassingRead')
                if 'fields' in read:
                    fields = read['fields']
                    if not isinstance(value, dict):
                        reasons.add('projectionRequiresObject')
                        value = None
                    else:
                        if any(key not in value for key in fields):
                            reasons.add('missingFields')
                        value = {key: value[key] for key in fields if key in value}
                row.update(status='pass', result=project(value, 0, reasons))
                if reasons:
                    row.update(status='partial', reasons=sorted(reasons))
            except Exception as error:
                row.update(status='error', error=str(error)[:256])
        # Reserve all remaining status rows plus envelope overhead. Large results
        # are omitted explicitly, never silently serialized beyond the budget.
        if encoded_size(items + [row]) + 512 + 256 * (len(plan['reads']) - len(items) - 1) > plan['maxBytes']:
            row = {'id': read['id'], 'operation': read['operation'], 'status': 'partial', 'reasons': ['maxBytes']}
        partial = partial or row['status'] != 'pass'
        items.append(row)
    result: "JsonObject" = {'status': 'partial' if partial else 'pass', 'items': items,
                          'readOnly': True, 'modelValidation': 'not-performed'}
    # Tiny budgets may not fit even status metadata. Return bounded summary,
    # explicitly reporting how many individual rows could not be included.
    omitted = 0
    while encoded_size(result) > plan['maxBytes']:
        items.pop()
        omitted += 1
        result.update(status='partial', omittedReads=omitted, reason='maxBytes')
    return result
