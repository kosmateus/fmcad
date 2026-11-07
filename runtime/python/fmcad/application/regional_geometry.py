"""Finite Boolean orchestration over a single injected geometry/comparator port.

Port values are opaque in-memory temporaries, never JSON handles or stored state.
The port must copy BOTH Boolean arguments and distinguish empty from invalid.
"""
import time as _regional_time
from typing import TYPE_CHECKING as _REGIONAL_APP_TYPE_CHECKING
from typing import Callable as _RegionalCallable, ParamSpec as _RegionalParamSpec
from typing import Protocol as _RegionalProtocol, TypeVar as _RegionalTypeVar
from typing import cast as _regional_app_cast


_RegionalTurnArgs = _RegionalParamSpec('_RegionalTurnArgs')
_RegionalTurnResult = _RegionalTypeVar('_RegionalTurnResult')


if _REGIONAL_APP_TYPE_CHECKING:
    class _RegionalGeometryPort(_RegionalProtocol):
        def identity(self) -> "JsonRecord": ...

        def read(self, ref: "JsonValue", frame: "JsonValue") -> object: ...

        def boolean(self, left: "object | None", right: "object | None",
                    operation: str) -> "object | None": ...

        def describe(self, body: "object | None") -> "JsonRecord": ...

        def compare(self, before: object, after: object,
                    frame: "JsonValue") -> "JsonRecord": ...

        def verify(self) -> None: ...

        def provenance(self) -> "list[JsonRecord]": ...

    class _RegionalReasonedError(_RegionalProtocol):
        reason: str


def regional_geometry_compare(
        data: "JsonObject", port: "_RegionalGeometryPort",
        operation: str = 'geometry.compare-region',
        clock: "_RegionalCallable[[], float]" = _regional_time.monotonic) -> "JsonRecord":
    masks = regional_geometry_request(data, operation)
    result = regional_geometry_contract(operation, data['frame'])
    started = clock()
    budget = _regional_app_cast('int', data.get('operationBudget', 256))
    time_limit = _regional_app_cast('int', data.get('timeBudgetMs', 10000))
    used: int = 0

    def turn(function: "_RegionalCallable[_RegionalTurnArgs, _RegionalTurnResult]",
             *args: "_RegionalTurnArgs.args",
             **kwargs: "_RegionalTurnArgs.kwargs") -> "_RegionalTurnResult":
        nonlocal used
        if used >= budget or (clock() - started) * 1000 >= time_limit:
            raise RegionalGeometryUnavailable('budget-exhausted', 'Regional geometry budget exhausted')
        used += 1
        value = function(*args, **kwargs)
        if (clock() - started) * 1000 >= time_limit:
            raise RegionalGeometryUnavailable('budget-exhausted', 'Regional geometry call exceeded time budget')
        return value

    def union(refs: "list[JsonValue]") -> "object | None":
        body: object | None = None
        for ref in refs:
            operand = turn(port.read, ref, data['frame'])
            body = operand if body is None else turn(port.boolean, body, operand, 'union')
        return body

    def mask(spec: "dict[str, list[JsonValue]]") -> "object | None":
        included = union(spec['include'])
        excluded = union(spec['exclude'])
        return turn(port.boolean, included, excluded, 'difference')

    def describe(body: "object | None") -> "JsonRecord":
        description = turn(port.describe, body)
        volume = regional_geometry_nonnegative(description['volume'])
        if type(description.get('empty')) is not bool or description['empty'] != (volume == 0):
            raise RegionalGeometryUnavailable('invalid-measurement', 'Inconsistent empty finite-solid evidence')
        return description

    try:
        result['documentIdentity'] = turn(port.identity)
        before = turn(port.read, data['before'], data['frame'])
        after = turn(port.read, data['after'], data['frame'])
        # Preserve the existing comparator through the adapter port; never a
        # second equality solver. Strict regional decisions use the actual sets.
        comparison = turn(port.compare, before, after, data['frame'])
        allowed = mask(masks['allowed'])
        protected = mask(masks['protected'])
        delta: dict[str, dict[str, JsonRecord]] = {}
        for name, left, right in (('removed', before, after), ('added', after, before)):
            body = turn(port.boolean, left, right, 'difference')
            inside = turn(port.boolean, body, allowed, 'intersection')
            outside = turn(port.boolean, body, allowed, 'difference')
            intrusion = turn(port.boolean, body, protected, 'intersection')
            delta[name] = {
                'total': describe(body), 'insideAllowed': describe(inside),
                'outsideAllowed': describe(outside), 'insideProtected': describe(intrusion)}
            # Fail closed on inconsistent kernel results, never cancel added
            # against removed volume or infer finite coverage from points/rays.
            total = _regional_app_cast('float', delta[name]['total']['volume'])
            partition = (_regional_app_cast('float', delta[name]['insideAllowed']['volume']) +
                         _regional_app_cast('float', delta[name]['outsideAllowed']['volume']))
            if abs(total - partition) > max(1e-10, total * 1e-8):
                raise RegionalGeometryUnavailable('inconsistent-kernel', 'Regional partition does not conserve volume')
        turn(port.verify)
        controls = {
            'outsideAllowedUnchanged': all(
                _regional_app_cast('bool', delta[k]['outsideAllowed']['empty']) for k in delta),
            'protectedUnchanged': all(
                _regional_app_cast('bool', delta[k]['insideProtected']['empty']) for k in delta)}
        passed = all(controls.values())
        result.update(status='pass' if passed else 'fail', passed=passed, success=passed,
                      precision='pass', coverage='pass', delta=delta, controls=controls,
                      comparison=comparison, provenance=port.provenance())
    except Exception as exc:
        # Runtime/input incompleteness must not leak any partial exact-pass flag.
        reason = (_regional_app_cast('_RegionalReasonedError', exc).reason
                  if hasattr(exc, 'reason') else 'kernel-or-input-failure')
        result.update(status='unknown', passed=None, success=False, precision='unknown', coverage='unknown',
                      reason=reason, message=str(exc))
    result['budget'] = {'operationsUsed': used, 'operationLimit': budget,
                        'timeLimitMs': time_limit,
                        'elapsedMs': max(0, (clock() - started) * 1000)}
    return result


if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'regional-geometry'
regional_geometry_register(CAD_HANDLERS)
_FMCAD_REGIONAL_GEOMETRY_LOADED = True
