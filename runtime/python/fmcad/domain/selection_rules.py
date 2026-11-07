"""JSON-only validation and manifest projection for persistent selection rules."""
from typing import TYPE_CHECKING as _SELECTION_TYPE_CHECKING
from typing import TypedDict as _SelectionTypedDict, cast as _selection_rule_cast


if _SELECTION_TYPE_CHECKING:
    class _SelectionCardinality(_SelectionTypedDict):
        min: int | float | None
        max: int | float | None

    class _SelectionDefinition(_SelectionTypedDict):
        ruleId: str
        query: "JsonObject"
        exclude: list["JsonObject"]
        expectedCardinality: _SelectionCardinality

    class _SelectionStoredRule(_SelectionTypedDict):
        id: str
        version: int
        query: "JsonObject"
        exclude: list["JsonObject"]

    class _SelectionReferenceRow(_SelectionTypedDict):
        reference: "JsonObject"

    class _SelectionLastResolution(_SelectionTypedDict):
        sourceVersion: int
        count: int
        selectedReferences: list[_SelectionReferenceRow]

    class _SelectionRuleManifest(_SelectionTypedDict):
        schemaVersion: int
        revision: int
        rule: _SelectionStoredRule
        owner: "JsonObject"
        source: "JsonObject"
        instanceScope: "JsonObject"
        lastResolution: _SelectionLastResolution
        provenance: "JsonObject"

_SELECTION_RULE_QUERY_FIELDS = (
    'schemaVersion', 'kind', 'component', 'occurrence', 'scope', 'instances',
    'frame', 'filters', 'expect', 'groupBy',
)


def _selection_rule_fields(value: "JsonValue", required: "tuple[str, ...]" = (),
                           optional: "tuple[str, ...]" = ()) -> "JsonObject":
    if not isinstance(value, dict):
        raise ValueError('Selection rule value must be an object')
    record = value
    missing = [key for key in required if key not in record]
    unknown = [key for key in record if key not in required and key not in optional]
    if missing or unknown:
        raise ValueError('Invalid selection rule fields; missing=%s unknown=%s' % (missing, unknown))
    return record


def _selection_rule_id(value: "JsonValue") -> str:
    if (not isinstance(value, str) or not value or len(value) > 128
            or value != value.strip() or any(ord(char) < 32 for char in value)):
        raise ValueError('ruleId must be nonempty printable text of at most 128 characters')
    return value


def _selection_rule_cardinality(value: "JsonValue") -> "_SelectionCardinality":
    def count(item: "JsonValue") -> int:
        if type(item) is not int or item < 0:
            raise ValueError('expected cardinality requires nonnegative integer counts')
        return item

    if type(value) is int:
        exact = count(value)
        return _selection_rule_cast('_SelectionCardinality', {'min': exact, 'max': exact})
    if not isinstance(value, dict) or not value or any(key not in ('min', 'max') for key in value):
        raise ValueError('expected cardinality must be a count or a nonempty min/max object')
    low = count(value['min']) if 'min' in value else None
    high = count(value['max']) if 'max' in value else None
    if low is not None and high is not None and low > high:
        raise ValueError('expected cardinality min exceeds max')
    return _selection_rule_cast('_SelectionCardinality', {'min': low, 'max': high})


def _selection_rule_definition(data: "JsonValue") -> "_SelectionDefinition":
    data = _selection_rule_fields(data, ('ruleId', 'query'), ('schemaVersion', 'exclude'))
    if data.get('schemaVersion', 1) != 1 or type(data.get('schemaVersion', 1)) is not int:
        raise ValueError('schemaVersion must be 1')
    query_value = data['query']
    if not isinstance(query_value, dict):
        raise ValueError('query must be an object')
    query = query_value
    unknown = [key for key in query if key not in _SELECTION_RULE_QUERY_FIELDS]
    if unknown:
        raise ValueError('Unknown selection query fields: ' + ', '.join(unknown))
    if 'kind' not in query or 'expect' not in query:
        raise ValueError('query requires kind and explicit expected cardinality')
    if query.get('schemaVersion', 1) != 1 or type(query.get('schemaVersion', 1)) is not int:
        raise ValueError('query schemaVersion must be 1')
    if 'unique' in query:
        raise ValueError('Selection rules use explicit expected cardinality, not unique')
    if 'instances' in query and type(query['instances']) is not bool:
        raise ValueError('query instances must be boolean')
    scope = query.get('scope')
    has_instance_scope = (
        any(key in query and query[key] is not None for key in ('component', 'occurrence'))
        or query.get('instances') is True
        or (isinstance(scope, dict) and any(
            key in scope and scope[key] is not None
            for key in ('component', 'occurrence', 'body', 'feature')
        ))
    )
    if not has_instance_scope:
        raise ValueError('query requires an explicit component, occurrence, body, feature, or instances:true scope')
    expected = _selection_rule_cardinality(query['expect'])
    normalized_query: "JsonObject" = dict(query)
    normalized_query['schemaVersion'] = 1
    expected_object: "JsonObject" = {}
    minimum = expected['min']
    maximum = expected['max']
    if minimum is not None:
        expected_object['min'] = minimum
    if maximum is not None:
        expected_object['max'] = maximum
    normalized_query['expect'] = expected_object
    exclusions = data.get('exclude', [])
    if not isinstance(exclusions, list) or len(exclusions) > 64:
        raise ValueError('exclude must be an array of at most 64 filter objects')
    normalized_exclusions: list[JsonObject] = []
    for filters in exclusions:
        if not isinstance(filters, dict):
            raise ValueError('Each exclusion must be a filter object')
        normalized_exclusions.append(filters)
    return _selection_rule_cast('_SelectionDefinition', {
        'ruleId': _selection_rule_id(data['ruleId']),
        'query': normalized_query,
        'exclude': [dict(filters) for filters in normalized_exclusions],
        'expectedCardinality': expected,
    })


def _selection_rules_validate_manifest(value: "JsonValue") -> "_SelectionRuleManifest":
    value = _selection_rule_fields(value, (
        'schemaVersion', 'revision', 'rule', 'owner', 'source', 'instanceScope',
        'lastResolution', 'provenance',
    ))
    if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1:
        raise ValueError('Unsupported selection rule manifest version')
    if type(value['revision']) is not int or value['revision'] < 1:
        raise ValueError('Selection rule revision must be a positive integer')
    rule = _selection_rule_fields(value['rule'], ('id', 'version', 'query', 'exclude'))
    if type(rule['version']) is not int or rule['version'] != 1:
        raise ValueError('Unsupported selection rule version')
    definition = _selection_rule_definition({
        'ruleId': rule['id'], 'query': rule['query'],
        'exclude': rule['exclude'],
    })
    owner = _selection_rule_fields(value['owner'], ('projectId', 'documentFileId', 'documentCreationId'))
    for key in ('projectId', 'documentFileId'):
        if not isinstance(owner[key], str) or not owner[key]:
            raise ValueError('Selection rule owner %s must be nonempty text' % key)
    if owner['documentCreationId'] is not None and not isinstance(owner['documentCreationId'], str):
        raise ValueError('Selection rule documentCreationId must be text or null')
    source = _selection_rule_fields(value['source'], ('documentName', 'version'))
    if not isinstance(source['documentName'], str) or not source['documentName']:
        raise ValueError('Selection rule source documentName must be nonempty text')
    if type(source['version']) is not int or source['version'] < 0:
        raise ValueError('Selection rule source version must be a nonnegative integer')
    instance_scope_value = value['instanceScope']
    if not isinstance(instance_scope_value, dict):
        raise ValueError('Selection rule instanceScope must be an object')
    instance_scope = instance_scope_value
    if instance_scope != _selection_rule_in_scope(definition['query']):
        raise ValueError('Selection rule instance scope disagrees with its query')
    last_resolution = _selection_rule_fields(value['lastResolution'], ('sourceVersion', 'count', 'selectedReferences'))
    if last_resolution['sourceVersion'] != source['version']:
        raise ValueError('Selection rule resolution provenance version disagrees with its source')
    if type(last_resolution['count']) is not int or last_resolution['count'] < 0:
        raise ValueError('Selection rule lastResolution count must be nonnegative')
    references_value = last_resolution['selectedReferences']
    if not isinstance(references_value, list) or len(references_value) != last_resolution['count']:
        raise ValueError('Selection rule selectedReferences must match the recorded count')
    references = references_value
    normalized_references: list[_SelectionReferenceRow] = []
    for item in references:
        reference_record = _selection_rule_fields(item, ('reference',))
        if not isinstance(reference_record['reference'], dict):
            raise ValueError('Selection rule reference provenance must be an object')
        normalized_references.append(_selection_rule_cast('_SelectionReferenceRow', reference_record))
    provenance = _selection_rule_fields(value['provenance'], (
        'definedBy', 'resolver', 'projectId', 'documentFileId',
        'documentCreationId', 'sourceVersion',
    ), ('lastResolvedBy', 'lastResolvedVersion'))
    if (provenance['definedBy'] != 'selection.rule.define'
            or provenance['resolver'] != 'entity._entity_query'
            or provenance['projectId'] != owner['projectId']
            or provenance['documentFileId'] != owner['documentFileId']
            or provenance['documentCreationId'] != owner['documentCreationId']
            or provenance['sourceVersion'] != source['version']):
        raise ValueError('Selection rule provenance disagrees with its owner or source')
    if ('lastResolvedBy' in provenance and provenance['lastResolvedBy'] not in
            ('selection.rule.resolve', 'selection.rule.check')):
        raise ValueError('Selection rule lastResolvedBy is unsupported')
    if ('lastResolvedVersion' in provenance
            and provenance['lastResolvedVersion'] != source['version']):
        raise ValueError('Selection rule lastResolvedVersion disagrees with its source')
    return _selection_rule_cast('_SelectionRuleManifest', {
        'schemaVersion': 1,
        'revision': value['revision'],
        'rule': {
            'id': definition['ruleId'], 'version': rule['version'],
            'query': definition['query'], 'exclude': definition['exclude'],
        },
        'owner': dict(owner),
        'source': dict(source),
        'instanceScope': dict(instance_scope),
        'lastResolution': {
            'sourceVersion': last_resolution['sourceVersion'],
            'count': last_resolution['count'],
            'selectedReferences': [dict(item) for item in normalized_references],
        },
        'provenance': dict(provenance),
    })


def _selection_rule_in_scope(query: "JsonObject") -> "JsonObject":
    return {key: query[key] for key in ('component', 'occurrence', 'scope', 'instances') if key in query}


def _selection_rule_cardinality_passed(count: int, expected: "_SelectionCardinality") -> bool:
    return ((expected['min'] is None or count >= expected['min'])
            and (expected['max'] is None or count <= expected['max']))
