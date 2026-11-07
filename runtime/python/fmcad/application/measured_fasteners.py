"""Orchestrate measured fastener checks through explicit adapter ports."""
from typing import Literal as _MFAppLiteral, Protocol as _MFAppProtocol, TYPE_CHECKING as _MFAppTypeChecking, cast as _MFAppCast


if _MFAppTypeChecking:
    class _MFApplicationPorts(_MFAppProtocol):
        def measure_native(self, request: "JsonObject") -> "JsonObject": ...

        def declared_fastener(self, operation: _MFAppLiteral['fastener.stack', 'fastener.check'],
                              data: "JsonObject") -> "JsonObject": ...

        def tool_access(self, request: "JsonValue") -> "JsonObject": ...


def measured_fasteners_check(data: "JsonValue", ports: "_MFApplicationPorts") -> "JsonObject":
    if not isinstance(data, dict):
        raise ValueError('fastener.measured-check data must be an object')
    allowed = {'schemaVersion', 'mode', 'native', 'declaredEvidence', 'toolAccess'}
    unexpected = set(data) - allowed
    if unexpected:
        raise ValueError('Unexpected fastener.measured-check fields: ' + ', '.join(sorted(unexpected)))
    if type(data.get('schemaVersion')) is not int or data.get('schemaVersion') != 1 or data.get('mode') != 'native':
        raise ValueError('fastener.measured-check requires schemaVersion:1 and mode:native')
    native_value = data.get('native')
    if not isinstance(native_value, dict):
        raise ValueError('native must contain versioned native measurement references')

    native = native_value
    measured = _measured_fasteners_evaluate(ports.measure_native(native))
    declared: "JsonObject" = {'status': 'notProvided'}
    if 'declaredEvidence' in data:
        request = data['declaredEvidence']
        if not isinstance(request, dict):
            raise ValueError('declaredEvidence must be the unchanged legacy fastener.stack/check request')
        operation = request.get('operation')
        if operation not in ('fastener.stack', 'fastener.check'):
            raise ValueError('declaredEvidence.operation must be fastener.stack or fastener.check')
        legacy_data = {key: value for key, value in request.items() if key != 'operation'}
        result = ports.declared_fastener(operation, legacy_data)
        declared = {'status': 'reported', 'operation': operation, 'sourceVersion': 1,
                    'frame': result.get('frame'), 'units': result.get('units'), 'result': result}

    tool: "JsonObject" = {'status': 'notEvaluated'}
    checks = list(_MFAppCast("list[JsonObject]", measured.get('checks', [])))
    status = _MFAppCast('str', measured.get('status', 'unknown'))
    if 'toolAccess' in data:
        tool_result = ports.tool_access(data['toolAccess'])
        sdk_result = tool_result.get('result')
        if not isinstance(sdk_result, dict):
            tool = dict(tool_result)
            tool['status'] = 'unknown'
            tool.setdefault('coverage', 'tool-access adapter returned no result')
            checks.append({'check': 'tool-access', 'status': 'unknown', 'message': tool['coverage']})
        elif sdk_result.get('reachable') is False:
            tool = dict(tool_result, status='fail')
            checks.append({'check': 'tool-access', 'status': 'fail', 'result': sdk_result})
            status = 'fail'
        elif sdk_result.get('reachable') is True and tool_result.get('complete', True):
            tool = dict(tool_result, status='pass')
            checks.append({'check': 'tool-access', 'status': 'pass', 'result': sdk_result})
        else:
            tool = dict(tool_result, status='unknown')
            checks.append({'check': 'tool-access', 'status': 'unknown', 'result': sdk_result,
                           'message': 'Tool access or obstacle coverage is incomplete.'})
            if status != 'fail':
                status = 'unknown'

    return {'schemaVersion': 1, 'operation': 'fastener.measured-check', 'mode': 'native',
            'status': status, 'success': status == 'pass',
            'frame': measured.get('frame'), 'units': {'length': 'mm', 'angle': 'rad'},
            'nativeMeasurements': measured, 'declaredEvidence': declared,
            'toolAccess': tool, 'checks': checks,
             'limitations': list(_MFAppCast('list[str]', measured.get('limitations', []))) +
                           ['declaredEvidence preserves the legacy local-frame calculation and is never substituted for native measurements.']}
