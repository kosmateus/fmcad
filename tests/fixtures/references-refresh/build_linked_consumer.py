"""Owned .10 fixture: add one pinned ordinary linked component, not a Derive."""
ARGS = []
DOC_NAME = ''


def run(_context):
    import adsk.core

    if not isinstance(ARGS, dict) or set(ARGS) != {'projectId', 'sourceFileId', 'sourceVersion'}:
        raise ValueError('Expected exact projectId, sourceFileId and sourceVersion')
    app = adsk.core.Application.get()
    matches = []
    for doc in app.documents:
        file = getattr(doc, 'dataFile', None)
        if file is None or file.parentProject.id != ARGS['projectId'] or \
                file.id != ARGS['sourceFileId'] or file.versionNumber != ARGS['sourceVersion']:
            continue
        try:
            doc.allDocumentReferences.count
        except RuntimeError as error:
            if 'non-top-level document' in str(error):
                continue
            raise
        matches.append(doc)
    if len(matches) != 1:
        raise ValueError('Expected exactly one open source document at the pinned version')
    source = matches[0]
    if source.isModified or source.dataFile.isComplete is not True or source.dataFile.isReadOnly is not False:
        raise ValueError('Pinned ordinary source must be saved, complete and writable')
    occurrence = FMCAD.root.occurrences.addByInsert(source.dataFile, adsk.core.Matrix3D.create(), True)
    if occurrence is None or occurrence.isReferencedComponent is not True or occurrence.isDerived is not False:
        raise RuntimeError('Native linked occurrence did not match the ordinary-reference fixture')
    extra = FMCAD.call('param.apply', {'parameters': [{'name': 'IW710_LinkConsumerExtra',
        'expression': '7 mm', 'unit': 'mm'}]})
    return {'sourceFileId': source.dataFile.id, 'sourceVersion': int(source.dataFile.versionNumber),
            'linkedPath': str(occurrence.fullPathName), 'isReferencedComponent': True,
            'isDerived': False, 'extraLocalCreated': isinstance(extra, dict),
            'history': FMCAD.call('history.check', {})}
