"""Read-only, document-scoped optimistic concurrency snapshots for the broker.

Component.id/revisionId are documented persistent identity/change markers. Tokens
are not compared as identities. No activation, save, recompute or cloud update.
"""
import hashlib as _qd_hashlib
import json as _qd_json
from typing import TYPE_CHECKING as _qd_TYPE_CHECKING, Protocol as _qd_Protocol, TypeVar as _qd_TypeVar, cast as _qd_cast
if _qd_TYPE_CHECKING:
    import adsk.core as _qd_core
    import adsk.fusion as _qd_fusion

_qd_T = _qd_TypeVar('_qd_T', covariant=True)
class _qd_Collection(_qd_Protocol[_qd_T]):
    @property
    def count(self) -> int: ...
    def item(self, index: int) -> _qd_T: ...


def _qd_items(collection: _qd_Collection[_qd_T]) -> list[_qd_T]:
    return [collection.item(i) for i in range(collection.count)]


def _qd_identity(doc: '_qd_core.Document') -> dict[str, object]:
    data, error = _document_data_file(doc)
    result: dict[str, object] = {'creationId': doc.creationId, 'name': doc.name,
            'fileId': data.id if data else None,
            'version': data.versionNumber if data else None,
             'isSaved': doc.isSaved, 'isModified': doc.isModified}
    if error:
        result['dataFileError'] = error
    return result


def _qd_design_state(doc: '_qd_core.Document', seen: set[str]) -> dict[str, object]:
    identity = _qd_identity(doc)
    key = doc.creationId
    if key in seen:
        return {'identity': identity, 'alreadyVisited': True}
    if len(seen) >= 256:
        raise RuntimeError('Document dependency snapshot exceeds 256 documents')
    seen.add(key)
    # Native lookups can be absent; the upstream annotations omit that branch.
    product = _qd_cast('_qd_core.Product | None', doc.products.itemByProductType('DesignProductType'))
    if product is None:
        raise RuntimeError('Document is not a supported Design product')
    # The SDK lookup is explicitly discriminated by DesignProductType. This is
    # the same product used before typing; do not activate or replace it.
    design = _qd_cast('_qd_fusion.Design', product)
    components: list[tuple[str, str, str, dict[str, object]]] = []
    derive_refs: list['_qd_core.DocumentReference'] = []
    for component in _qd_items(design.allComponents):
        bodies: list[dict[str, object]] = []
        for body in _qd_items(component.bRepBodies):
            box = body.boundingBox
            bodies.append({'name': body.name, 'revisionId': body.revisionId,
                           'boundsCm': [[box.minPoint.x, box.minPoint.y, box.minPoint.z],
                                        [box.maxPoint.x, box.maxPoint.y, box.maxPoint.z]]})
        row: dict[str, object] = {'id': component.id, 'name': component.name,
                           'revisionId': component.revisionId,
                           'bodies': bodies, 'sketchCount': component.sketches.count,
                           'featureCount': component.features.count}
        components.append((component.id, component.name, component.revisionId, row))
        for feature in _qd_items(component.features.deriveFeatures):
            if not feature.isSuppressed:
                derive_refs.append(feature.documentReference)
    parameters: list[dict[str, object]] = [{'name': p.name, 'expression': p.expression, 'value': p.value, 'unit': p.unit}
                  for p in sorted(_qd_items(design.allParameters), key=lambda p: p.name)]
    references: list[tuple[str, int, dict[str, object]]] = []
    # allDocumentReferences includes nested ordinary references. Derive features
    # are added explicitly because some SDK builds omit parameter-only Derives.
    try:
        document_refs = _qd_items(doc.allDocumentReferences)
    except RuntimeError as error:
        if 'non-top-level document' not in str(error):
            raise
        document_refs = _qd_items(doc.documentReferences)
    for reference in document_refs + derive_refs:
        source = reference.dataFile
        reference_row: dict[str, object] = {'fileId': source.id, 'version': source.versionNumber}
        referenced = _qd_cast('_qd_core.Document | None', reference.referencedDocument)
        if referenced is not None:
            reference_row['state'] = _qd_design_state(referenced, seen)
        references.append((source.id, source.versionNumber, reference_row))
    return {'identity': identity, 'components': [c[3] for c in sorted(components, key=lambda c: c[:3])],
            'parameters': parameters,
            'references': [r[2] for r in sorted(references, key=lambda r: (r[0], r[1]))],
            'timeline': {'count': design.timeline.count, 'markerPosition': design.timeline.markerPosition}}


def _qd_capture(app: '_qd_core.Application', selector: dict[str, object] | None) -> dict[str, object]:
    if selector is None:
        return {'status': 'unscoped'}
    if selector.get('metadataOnly'):
        return {'status': 'metadata-only'}
    candidates: list['_qd_core.Document'] = []
    try:
        for doc in _qd_items(app.documents):
            if selector.get('creationId') and doc.creationId != selector['creationId']:
                continue
            if selector.get('name') and doc.name != selector['name']:
                continue
            if selector.get('fileId'):
                file, error = _document_data_file(doc)
                if error:
                    # Cannot establish a file-only selector's uniqueness by
                    # pretending this unreadable document is another lineage.
                    raise RuntimeError('Cannot verify document fileId; pin its creationId/name: ' + error['message'])
                if file is None or file.id != selector['fileId']:
                    continue
            candidates.append(doc)
        if len(candidates) != 1:
            return {'status': 'target-unavailable', 'matches': len(candidates), 'selector': selector}
        state = _qd_design_state(candidates[0], set())
        canonical = _qd_json.dumps(state, sort_keys=True, separators=(',', ':'), allow_nan=False)
        return {'status': 'complete', 'fingerprint': _qd_hashlib.sha256(canonical.encode('utf-8')).hexdigest(),
                'state': state}
    except Exception as error:
        return {'status': 'unavailable', 'selector': selector,
                'error': {'type': type(error).__name__, 'message': str(error)}}
