"""GM29 namespaced entity attributes.

``entity.attribute.set`` and ``entity.attribute.get`` store and read durable
name/value pairs in a caller-declared attribute group (namespace). Values are
strings; the returned resourceIdentity is the actual owning entity reference
(token/kind/name/context), not a guess from a display name. See
docs/APPEARANCES.md.
"""


if _CAD_TYPE_CHECKING:
    class _AttributeCollection(_Protocol):
        def itemByName(self, groupName: str, name: str, /) -> adsk.core.Attribute | None: ...

        def add(self, groupName: str, name: str, value: str, /) -> adsk.core.Attribute: ...

        def itemsByGroup(self, groupName: str, /) -> list[adsk.core.Attribute]: ...


def _attr_entity(ctx: "CadContext", data: "JsonObject") -> "tuple[CadEntity, _AttributeCollection]":
    entity = ctx.resolve(data['ref'])
    if not hasattr(entity, 'attributes'):
        raise ValueError('Target does not expose attributes; select a component, body, face, occurrence, or parameter')
    attributes_value = _cad_cast("object | None", getattr(entity, 'attributes', None))
    if attributes_value is None:
        raise ValueError('Target does not expose attributes; select a component, body, face, occurrence, or parameter')
    return entity, _cad_cast("_AttributeCollection", attributes_value)


def _attr_optional(value: object) -> "adsk.core.Attribute | None":
    return None if value is None else _cad_cast("adsk.core.Attribute", value)


def _attr_check(data: "JsonObject") -> "tuple[str, str]":
    group = data['group']
    name = data['name']
    if not isinstance(group, str) or not group.strip():
        raise ValueError('group (namespace) must be a nonempty string')
    if not isinstance(name, str) or not name.strip():
        raise ValueError('name must be a nonempty string')
    return group, name


def entity_attribute_set(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('ref', 'group', 'name', 'value'), ())
    entity, attributes = _attr_entity(ctx, data)
    group, name = _attr_check(data)
    if not isinstance(data['value'], str):
        raise ValueError('value must be a string')
    value = data['value']
    previous = _attr_optional(attributes.itemByName(group, name))
    previous_value = previous.value if previous is not None else None
    _cad_require_result(attributes.add(group, name, value), 'Store attribute')
    changed = previous_value != value
    result: JsonRecord = {'resourceIdentity': ctx.ref(entity), 'group': group, 'name': name, 'value': value,
              'previousValue': previous_value, 'changed': changed,
              'affected': [{'ref': ctx.ref(entity), 'group': group, 'name': name, 'before': previous_value,
                            'after': value}],
              'associativity': 'durableAttribute',
              'limitations': ['Attributes persist on the user\'s next save; this operation does not save.',
                              'Values are strings limited by the Fusion attribute API; larger payloads must be split.']}
    result.update(schemaVersion=1, operation='entity.attribute.set', status='pass', success=True,
                  documentIdentity={'creationId': getattr(ctx.doc, 'creationId', None), 'name': ctx.doc.name},
                  units={}, frame={'space': 'component', 'component': ctx.ref(ctx.component)},
                  warnings=[], method='Public Fusion Attributes.add/itemByName API (GM29)',
                  provenance={'requirement': 'GM29', 'source': 'docs/APPEARANCES.md'})
    return result


def entity_attribute_get(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('ref', 'group'), ('name',))
    entity, attributes_collection = _attr_entity(ctx, data)
    if not isinstance(data['group'], str) or not data['group'].strip():
        raise ValueError('group (namespace) must be a nonempty string')
    group = data['group']
    if 'name' in data:
        if not isinstance(data['name'], str) or not data['name'].strip():
            raise ValueError('name must be a nonempty string')
        attribute = _attr_optional(attributes_collection.itemByName(group, data['name']))
        attributes = [] if attribute is None else [{'name': attribute.name, 'value': attribute.value}]
    else:
        attributes = [{'name': attribute.name, 'value': attribute.value}
                      for attribute in attributes_collection.itemsByGroup(group)]
    result: JsonRecord = {'resourceIdentity': ctx.ref(entity), 'group': group, 'attributes': attributes,
              'count': len(attributes),
              'limitations': ['Reads the named group only; other namespaces are not enumerated.']}
    result.update(schemaVersion=1, operation='entity.attribute.get', status='pass', success=True,
                  documentIdentity={'creationId': getattr(ctx.doc, 'creationId', None), 'name': ctx.doc.name},
                  units={}, frame={'space': 'component', 'component': ctx.ref(ctx.component)},
                  warnings=[], method='Public Fusion Attributes.itemByName/itemsByGroup API (GM29)',
                  provenance={'requirement': 'GM29', 'source': 'docs/APPEARANCES.md'})
    return result


CAD_HANDLERS.update({'entity.attribute.set': entity_attribute_set, 'entity.attribute.get': entity_attribute_get})
