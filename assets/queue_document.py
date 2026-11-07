"""Read-only, document-scoped optimistic concurrency snapshots for the broker.

Component.id/revisionId are documented persistent identity/change markers. Tokens
are not compared as identities. No activation, save, recompute or cloud update.
"""
import hashlib as _qd_hashlib
import json as _qd_json


def _qd_items(collection):
    return [collection.item(i) for i in range(collection.count)]


def _qd_identity(doc):
    data, error = _document_data_file(doc)
    result = {'creationId': doc.creationId, 'name': doc.name,
            'fileId': data.id if data else None,
            'version': data.versionNumber if data else None,
             'isSaved': doc.isSaved, 'isModified': doc.isModified}
    if error:
        result['dataFileError'] = error
    return result


def _qd_design_state(doc, seen):
    identity = _qd_identity(doc)
    key = identity['creationId']
    if key in seen:
        return {'identity': identity, 'alreadyVisited': True}
    if len(seen) >= 256:
        raise RuntimeError('Document dependency snapshot exceeds 256 documents')
    seen.add(key)
    design = doc.products.itemByProductType('DesignProductType')
    if design is None:
        raise RuntimeError('Document is not a supported Design product')
    components, derive_refs = [], []
    for component in _qd_items(design.allComponents):
        bodies = []
        for body in _qd_items(component.bRepBodies):
            box = body.boundingBox
            bodies.append({'name': body.name, 'revisionId': body.revisionId,
                           'boundsCm': [[box.minPoint.x, box.minPoint.y, box.minPoint.z],
                                        [box.maxPoint.x, box.maxPoint.y, box.maxPoint.z]]})
        components.append({'id': component.id, 'name': component.name,
                           'revisionId': component.revisionId,
                           'bodies': bodies, 'sketchCount': component.sketches.count,
                           'featureCount': component.features.count})
        for feature in _qd_items(component.features.deriveFeatures):
            if not feature.isSuppressed:
                derive_refs.append(feature.documentReference)
    parameters = [{'name': p.name, 'expression': p.expression, 'value': p.value, 'unit': p.unit}
                  for p in _qd_items(design.allParameters)]
    references = []
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
        row = {'fileId': source.id, 'version': source.versionNumber}
        referenced = reference.referencedDocument
        if referenced is not None:
            row['state'] = _qd_design_state(referenced, seen)
        references.append(row)
    return {'identity': identity, 'components': sorted(components, key=lambda c: (c['id'], c['name'], c['revisionId'])),
            'parameters': sorted(parameters, key=lambda p: p['name']),
            'references': sorted(references, key=lambda r: (r['fileId'], r['version'])),
            'timeline': {'count': design.timeline.count, 'markerPosition': design.timeline.markerPosition}}


def _qd_capture(app, selector):
    if selector is None:
        return {'status': 'unscoped'}
    if selector.get('metadataOnly'):
        return {'status': 'metadata-only'}
    candidates = []
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
