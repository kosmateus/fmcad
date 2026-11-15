"""Present facts for a cold normal-currentstore successor; no model writer."""
import json as _nc_json
import adsk.core as _nc_core


def normal_currentstore_facts(creation_id: str, document_name: str) -> dict[str, object]:
    app = _nc_core.Application.get()
    assert app is not None, 'Fusion application unavailable'
    ui = app.userInterface
    assert ui is not None, 'Fusion UI unavailable'
    documents: list[dict[str, str]] = []
    present = False
    for index in range(app.documents.count):
        doc = app.documents.item(index)
        assert doc is not None, 'Document inventory changed'
        documents.append({'creationId': doc.creationId, 'name': doc.name})
        if doc.creationId == creation_id or doc.name == document_name:
            present = True
    return {
        'kind': 'normal-currentstore-current-facts-v1',
        'originalDocumentCreationId': creation_id,
        'originalDocumentName': document_name,
        'originalDocumentPresent': present,
        'activeCommand': ui.activeCommand,
        'documents': documents,
        'historicalOutcome': 'unknown',
        'modelValidation': 'not_performed',
    }
