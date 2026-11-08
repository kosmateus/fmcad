"""DTO-only rules extracted from assets/cad/externalization.py. No SDK or filesystem access."""
import hashlib as _external_hashlib
import json as _external_json
from typing import (
    NotRequired as _ExternalNotRequired,
    Protocol as _ExternalProtocol,
    Required as _ExternalRequired,
    TypedDict as _ExternalTypedDict,
)


if TYPE_CHECKING:
    class _ExternalDestination(_ExternalTypedDict):
        projectId: str
        folderId: str
        fileName: _ExternalNotRequired[str]
        name: _ExternalNotRequired[str]

    class _ExternalPin(_ExternalTypedDict):
        fileId: str
        projectId: str
        version: int
        creationId: _ExternalNotRequired[str]
        context: _ExternalNotRequired[str]

    class _ExternalCopyIntent(_ExternalTypedDict):
        destination: _ExternalDestination
        description: str
        operationId: str
        itemId: str
        purpose: str
        source: _ExternalPin
        nonce: str
        finalDescription: str
        component: JsonValue

    class _ExternalCopyEvent(_ExternalTypedDict, total=False):
        projectId: _ExternalRequired[str]
        folderId: _ExternalRequired[str]
        description: _ExternalRequired[str]
        fileId: _ExternalRequired[str]
        version: _ExternalRequired[int]
        event: _ExternalRequired[str]
        name: str
        isComplete: bool
        status: _ExternalRequired[JsonObject]
        statusReadContext: str
        statusReadError: str
        statusReadErrorAt: str

    _ExternalValue = TypeVar('_ExternalValue')

    class _ExternalAttributed(_ExternalProtocol):
        @property
        def attributes(self) -> "adsk.core.Attributes": ...

_EXTERNAL_PROBE_RESTORE_RESERVE_MS = 60000


def _external_require(value: "_ExternalValue", message: str) -> "_ExternalValue":
    if not value:
        raise ValueError(message)
    return value


def _external_digest(value: "JsonValue") -> str:
    return _external_hashlib.sha256(_external_json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _external_event_matches(intent: "_ExternalCopyIntent", event: "_ExternalCopyEvent") -> bool:
    destination=intent['destination']
    return (event.get('projectId')==destination['projectId'] and event.get('folderId')==destination['folderId'] and
            event.get('description')==intent['description'])


def _external_next_saved_name(name: str, version: int) -> str:
    import re
    match=re.fullmatch(r'(.+) v(\d+)',str(name))
    if match is None or int(match.group(2))!=int(version):
        raise ValueError('Saved consumer name/version suffix is not qualified for request-bound UI')
    return match.group(1)+' v'+str(int(version)+1)


# Pure requests and plan checks: no document open/save, SDK calls or mutations.
from typing import cast as _external_cast


def _external_probe_refresh_bindings(derived_bindings: "list[JsonObject]",current_edges: "list[_ExternalReferenceEdge]") -> "list[JsonObject]":
    result: list[JsonObject]=[]
    drivers=_external_cast('list[_ExternalBoundDriver]',derived_bindings)
    edges=_external_cast('list[_ExternalDriverBindingEdge]',current_edges)
    for driver in drivers:
        matches: list[_ExternalDriverBindingEdge]=[]
        for current_edge in edges:
            if current_edge.get('kind')!='derive' or current_edge.get('sourceFileId')!=driver['sourceFileId'] or \
                    current_edge.get('edgeIdentityUnique') is not True:
                continue
            owner_file_id=driver.get('ownerFileId')
            if owner_file_id and current_edge.get('ownerFileId')!=owner_file_id:continue
            sources:set[str]={row['name'] for row in current_edge.get('sourceParameters',[])}
            derived:set[str]={row['name'] for row in current_edge.get('derivedParameters',[])}
            if driver['sourceParameter'] in sources and driver['nativeDerivedParameter'] in derived:
                matches.append(current_edge)
        _external_require(len(matches)==1,
                          'Saved consumer graph must uniquely identify each declared driver binding edge')
        edge=matches[0]
        result.append({'edgeId':edge['edgeId'],'sourceFileId':edge['sourceFileId'],
            'sourceParameter':driver['sourceParameter'],
            'nativeDerivedParameter':driver['nativeDerivedParameter'],
            'consumerAlias':driver['consumerAlias']})
    return result



def _external_probe_refresh_bindings_payload(bindings: "list[JsonObject]") -> "list[JsonObject]":
    return [{name:row[name] for name in
        ('edgeId','sourceParameter','nativeDerivedParameter','consumerAlias')}
        for row in bindings]



def _external_probe_refresh_plan_request(data: "_ExternalStepData",probe: "_ExternalProbeWithRefresh",state: "_ExternalProbeState",key: "str") -> "JsonObject":
    target_value=state.get('targetPin')
    _external_require(target_value is not None,'Driver refresh requires the exact saved consumer baseline pin')
    target=_external_cast('_ExternalPin',target_value)
    source=state['source']
    published=state.get('publishedVersion')
    _external_require(all(target.get(name) for name in ('projectId','fileId')) and
                      type(target.get('version')) is int and target['version']>0,
                      'Driver refresh requires the exact saved consumer baseline pin')
    _external_require(source.get('fileId') and type(published) is int and published>0 and
                      source.get('version')==published,
                      'Driver refresh requires the exact settled producer publication receipt')
    suffix='restore' if state.get('restoring') else 'driver'
    return {'schemaVersion':1,'phase':'plan',
        'root':{name:target[name] for name in ('projectId','fileId','version')},
        'policy':'latest','lifecycle':'openOwned','durability':'cold',
        'reportPath':probe['refresh']['reportPath'],
        'nativeFallback':probe['refresh'].get('nativeFallback','never'),
        'parameterBindings':_external_probe_refresh_bindings_payload(state.get('refreshBindings',[])),
        'requestId':data['operationId']+'_'+key+'_'+suffix+'_plan'}



def _external_probe_validate_refresh_plan(state: "_ExternalProbeState",plan: "JsonObject") -> "None":
    bindings=_external_cast('list[_ExternalBoundDriver]',state.get('refreshBindings',[]))
    edges=_external_cast('list[_ExternalRefreshPlanEdge]',plan.get('edges',[]))
    baseline_edges=state.get('baselineEdges',[])
    expected:set[str]={row['edgeId'] for row in bindings
              if row.get('sourceFileId')==state['source']['fileId']}
    actual:set[str]={edge['edgeId'] for edge in edges
            if edge.get('kind')=='derive' and edge.get('sourceFileId')==state['source']['fileId']}
    _external_require(bool(expected) and actual==expected,
                      'Consumer plan omitted or changed the declared published driver binding edge')
    for edge in edges:
        if edge['sourceFileId']==state['source']['fileId']:
            _external_require(edge['targetVersion']==state['publishedVersion'],
                              'Consumer plan did not pin this exact producer publication')
        else:
            baseline=next((e for e in baseline_edges if e['edgeId']==edge['edgeId']),None)
            if baseline is None:
                _external_require(False,'Unrelated dependency drift during driver publication')
            else:
                expected_version=state.get('appliedVersions',{}).get(
                    edge['sourceFileId'],baseline['baselineVersion'])
                _external_require(expected_version==edge['targetVersion'],
                                  'Unrelated dependency drift during driver publication')



def _external_probe_refresh_apply_request(data: "_ExternalStepData",probe: "_ExternalProbeWithRefresh",state: "_ExternalProbeState",key: "str",plan: "JsonObject") -> "JsonObject":
    planned_value=state.get('refreshRequest')
    if planned_value is None:raise ValueError('Missing planned immutable consumer refresh request')
    planned=_external_cast('_ExternalProbeRefreshPlanRequest',planned_value)
    target_value=state.get('targetPin')
    if target_value is None:raise ValueError('Missing exact consumer pin for refresh apply')
    target=target_value
    _external_require(plan and plan.get('planId') and plan.get('invocationStatus')=='complete',
                      'Missing successful immutable consumer refresh plan')
    _external_require(plan.get('root')==planned.get('root') and planned.get('root')==
                      {name:target.get(name) for name in ('projectId','fileId','version')},
                      'Consumer refresh plan differs from the exact saved consumer baseline')
    suffix='restore' if state.get('restoring') else 'driver'
    request: JsonObject={'schemaVersion':1,'phase':'apply','confirm':True,
        'root':dict(planned['root']),'reportPath':planned['reportPath'],
        'planId':plan['planId'],'requestId':data['operationId']+'_'+key+'_'+suffix+'_apply',
        'policy':planned['policy'],'lifecycle':planned['lifecycle'],
        'durability':planned['durability'],'nativeFallback':planned['nativeFallback'],
        'parameterBindings':list(planned['parameterBindings'])}
    lease_key='restoreUiLeases' if state.get('restoring') else 'driverUiLeases'
    if probe['refresh'].get(lease_key):
        refresh_with_leases=_external_cast('_ExternalProbeRefreshValidation',probe['refresh'])
        leases=(refresh_with_leases['restoreUiLeases'] if lease_key=='restoreUiLeases'
                else refresh_with_leases['driverUiLeases'])
        request['uiLeases']=_external_cast('JsonValue',leases)
    return request
