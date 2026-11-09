"""DTO-only rules extracted from assets/cad/references.py. No SDK or filesystem access."""
_REFERENCES_NATIVE_REPORT_RESERVE_MS = 10000

_REFERENCES_NATIVE_MIN_POLL_MS = 1000

def _references_edge_id(owner_file_id: str, kind: str, source_file_id: str, identity_part: str) -> str:
    import hashlib
    digest = hashlib.sha256((str(owner_file_id) + '\0' + str(kind) + '\0' + str(source_file_id) + '\0' + str(identity_part)).encode('utf-8')).hexdigest()
    return 'edge:' + digest

def _references_public_edges(edges: "Iterable[Mapping[str, object]]") -> "list[dict[str, object]]":
    return [{key: value for key, value in edge.items() if not key.startswith('_')} for edge in edges]

def _references_edge_snapshot_matches(current_edges: "Sequence[Mapping[str, object]]",
                                      plan_edges: "Sequence[Mapping[str, object]]", file_id: str,
                                      effective_targets: "Mapping[str, JsonValue] | None" = None,
                                      prior_edges: "Sequence[Mapping[str, object]] | None" = None) -> "tuple[bool, str | None]":
    effective_targets = effective_targets or {}
    baseline = {_cad_cast(str, edge['edgeId']): edge for edge in (prior_edges if prior_edges is not None else plan_edges)
                if edge.get('ownerFileId') == file_id}
    expected = {_cad_cast(str, edge['edgeId']): edge for edge in plan_edges if edge.get('ownerFileId') == file_id}
    current = {_cad_cast(str, edge['edgeId']): edge for edge in current_edges if edge.get('ownerFileId') == file_id}
    if len(current) != sum(edge.get('ownerFileId') == file_id for edge in current_edges) or set(current) != set(baseline):
        return False, 'forwardEdgeSetDrift'
    for edge_id, row in current.items():
        plan_row = expected.get(edge_id)
        previous_row = baseline[edge_id]
        if plan_row is None or row.get('sourceFileId') != plan_row.get('sourceFileId') or row.get('kind') != plan_row.get('kind'):
            return False, 'forwardEdgeIdentityDrift'
        expected_version = previous_row.get('baselineVersion')
        dependency_receipt_version = effective_targets.get(edge_id)
        if row.get('baselineVersion') != expected_version and row.get('baselineVersion') != dependency_receipt_version:
            return False, 'forwardEdgeVersionDrift'
        expected_latest = effective_targets.get(edge_id, plan_row.get('latestVersion'))
        if expected_latest is not None and row.get('latestVersion') != expected_latest:
            return False, 'unrelatedSourceVersionDrift'
        if row.get('versionSource') == 'unresolved':
            return False, 'referenceVersionUnresolved'
    return True, None


def _references_occurrence_states(metadata: "JsonObject") -> "list[JsonObject] | None":
    rows = _cad_cast("list[JsonObject]", metadata.get('occurrences', []))
    if any(not row.get('token') for row in rows):
        return None
    return sorted([{'token': row['token'], 'nativeToken': row.get('nativeToken'),
                    'transform': row.get('transform'), 'contextKind': row.get('contextKind'),
                    'isDerived': row.get('isDerived'),
                    'isReferencedComponent': row.get('isReferencedComponent')}
                   for row in rows], key=lambda row: _cad_cast(str, row['token']))
