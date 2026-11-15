"""Present facts for a cold normal-currentstore successor; no model writer."""
import json as _nc_json
import adsk.core as _nc_core
from typing import cast as _nc_cast


def normal_currentstore_facts(creation_id: str, document_name: str,
                             allow_new_unsaved_default: bool = False) -> dict[str, object]:
    app = _nc_core.Application.get()
    assert app is not None, 'Fusion application unavailable'
    ui = app.userInterface
    assert ui is not None, 'Fusion UI unavailable'
    documents: list[dict[str, object]] = []
    seen: set[str] = set()
    present = False
    for index in range(app.documents.count):
        doc = app.documents.item(index)
        assert doc is not None, 'Document inventory changed'
        assert doc.creationId and doc.creationId not in seen, 'Distinct document creation identities required'
        seen.add(doc.creationId)
        # The SDK stub declares DataFile, but an unsaved document returns None.
        data_file = _nc_cast('_nc_core.DataFile | None', doc.dataFile)
        file_id = data_file.id if data_file is not None else None
        documents.append({'creationId': doc.creationId, 'name': doc.name,
                          'fileId': file_id, 'isSaved': doc.isSaved, 'isModified': doc.isModified})
        # Only an explicitly authorized, clean unnamed default in a proven new
        # process may share a display name. Named/saved/file identities retain
        # the conservative name guard, and an exact creation always matches.
        distinct_default = (allow_new_unsaved_default is True
                            and document_name in ('Bez nazwy', 'Untitled')
                            and doc.creationId != creation_id
                            and doc.isSaved is False and doc.isModified is False and data_file is None)
        if doc.creationId == creation_id or (doc.name == document_name and not distinct_default):
            present = True
    return {
        'kind': 'normal-currentstore-current-facts-v1',
        'originalDocumentCreationId': creation_id,
        'originalDocumentName': document_name,
        'originalDocumentPresent': present,
        'identityPolicy': ('new-unsaved-default-v1' if allow_new_unsaved_default is True
                           else 'creation-or-name-v1'),
        'activeCommand': ui.activeCommand,
        'documents': documents,
        'historicalOutcome': 'unknown',
        'modelValidation': 'not_performed',
    }
