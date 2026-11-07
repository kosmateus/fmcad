"""Read-only diagnostic for duplicate Fusion document wrappers in the owned test project."""
ARGS = []
DOC_NAME = ''


def run(_context):
    import adsk.core

    if not isinstance(ARGS, dict) or not isinstance(ARGS.get('fileIds'), list):
        raise ValueError('Expected exact fileIds list')
    wanted = set(ARGS['fileIds'])
    app = adsk.core.Application.get()
    rows = []
    for doc in app.documents:
        file = getattr(doc, 'dataFile', None)
        if file is None or file.id not in wanted:
            continue
        try:
            references = int(doc.allDocumentReferences.count)
            top_level = True
        except RuntimeError as error:
            references = None
            top_level = 'non-top-level document' not in str(error)
        rows.append({'name': str(doc.name), 'creationId': str(doc.creationId),
                     'fileId': str(file.id), 'version': int(file.versionNumber),
                     'modified': bool(doc.isModified), 'saved': bool(doc.isSaved),
                     'topLevelCheck': top_level, 'documentReferenceCount': references})
    return {'documents': rows}
