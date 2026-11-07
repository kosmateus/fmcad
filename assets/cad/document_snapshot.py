"""Bounded document metadata shared by full and lightweight status bundles."""


def _document_snapshot(doc):
    saved = doc.isSaved
    file, error = _document_data_file(doc) if saved else (None, None)
    folder = file.parentFolder if file else None
    project = folder.parentProject if folder else None
    result = {'name': doc.name, 'creationId': doc.creationId,
            'saved': saved, 'modified': doc.isModified,
            'fileId': file.id if file else None,
            'fileName': file.name if file else None,
            'version': getattr(file, 'versionNumber', None),
            'versionId': getattr(file, 'versionId', None),
            'isComplete': getattr(file, 'isComplete', None),
            'isReadOnly': getattr(file, 'isReadOnly', None),
            'folderId': folder.id if folder else None,
             'projectId': project.id if project else None}
    if error:
        result['dataFileError'] = error
    return result
