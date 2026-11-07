"""SDK-free definitions validation and numerical data operations."""
import re as _definition_domain_re

def _definition_id(value: object) -> str:
    if not isinstance(value, str) or not _definition_domain_re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise ValueError('Recipe id must contain letters, digits, underscores or hyphens')
    return value


def _definition_regeneration_bindings(record: "JsonObject", changes: object) -> "list[JsonObject]":
    """Select declared bindings in original order, without resolving SDK entities."""
    if not isinstance(changes, dict):
        raise ValueError('parameters must be an object')
    from typing import cast as _definition_cast
    changes_record = _definition_cast("JsonObject", changes)
    bindings = _definition_cast("Sequence[JsonObject]", record['bindings'])
    available: set[str] = {_definition_cast(str, binding['parameter']) for binding in bindings}
    if changes_record.keys() - available:
        raise ValueError('Unbound or structural parameter change; explicit recipe migration required')
    return [binding for binding in bindings if binding['parameter'] in changes_record]
