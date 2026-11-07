"""Read-only Fusion build/document inventory probe; no active-document access."""
import adsk.core
import json

ARGS = {}
DOC_NAME = ''


def run(_context):
    app = adsk.core.Application.get()
    documents = []
    for doc in app.documents:
        row = {
            'name': doc.name,
            'creationId': doc.creationId,
            'isSaved': doc.isSaved,
            'isModified': doc.isModified,
        }
        try:
            file = doc.dataFile
            row['fileId'] = file.id if file else None
            row['version'] = file.versionNumber if file else None
        except Exception as error:
            row['dataFileReadback'] = {'status': 'unavailable',
                                       'type': type(error).__name__}
        documents.append(row)
    result = {
        'fusionBuild': app.version,
        'activeCommand': app.userInterface.activeCommand,
        'documents': documents,
        'documentCount': len(documents),
        'readOnly': True,
        'modelChanged': False,
    }
    print('FMCAD_RESULT ' + json.dumps(result, allow_nan=False))
    return result
