"""Add one exact pinned link to an already saved owned externalization case."""
ARGS = []
DOC_NAME = ''


def run(_context):
    if not isinstance(ARGS, dict) or set(ARGS) != {'projectId','folderId','fileId','version','role'}:
        raise ValueError('Expected exact projectId/folderId/fileId/version and caller role')
    if not all(isinstance(ARGS[key], str) and ARGS[key] for key in ('projectId','folderId','fileId','role')) or \
            type(ARGS['version']) is not int or ARGS['version'] < 1:
        raise ValueError('External link fixture needs exact project/file/version identity')
    doc = FMCAD.doc
    if doc.dataFile is None or doc.dataFile.parentProject.id != ARGS['projectId'] or \
            doc.dataFile.parentFolder.id != ARGS['folderId'] or \
            doc.isModified or doc.dataFile.isComplete is not True or doc.dataFile.isReadOnly is not False:
        raise ValueError('Destination must be the exact saved, complete, clean and writable owned case')
    result = FMCAD.call('occurrence.insert_external', {
        'source': {'dataFileId': ARGS['fileId'], 'version': ARGS['version']},
        'confirm': True})
    occurrences = result.get('occurrences')
    if result.get('status') != 'complete' or not isinstance(occurrences, list) or not occurrences:
        raise RuntimeError('Shipped occurrence.insert_external did not return a complete linked insertion')
    for ref in occurrences:
        occurrence = FMCAD.resolve(ref, 'occurrence')
        if occurrence.isReferencedComponent is not True or occurrence.isDerived is not False:
            raise RuntimeError('Inserted fixture is not an ordinary linked occurrence')
        current=occurrence.attributes.itemByName('FMCAD_EXTERNALIZATION_FIXTURE','role')
        if current is None:occurrence.attributes.add('FMCAD_EXTERNALIZATION_FIXTURE','role',ARGS['role'])
        elif current.value!=ARGS['role']:raise ValueError('Existing caller role differs; no retry or overwrite')
        native=getattr(occurrence,'nativeObject',None) or occurrence
        current=native.attributes.itemByName('FMCAD_EXTERNALIZATION_FIXTURE','native_role')
        if current is None:native.attributes.add('FMCAD_EXTERNALIZATION_FIXTURE','native_role',ARGS['role'])
        elif current.value!=ARGS['role']:raise ValueError('Existing native caller role differs; no retry or overwrite')
    return {'sourceFileId': ARGS['fileId'], 'sourceVersion': ARGS['version'],
            'projectId': doc.dataFile.parentProject.id,'folderId':doc.dataFile.parentFolder.id,
            'occurrences': [{'ref': ref, 'path': path,
                'isReferencedComponent': True, 'isDerived': False}
                for ref, path in zip(occurrences, result['paths'])],
            'worldPoses': result['worldPoses'], 'sourceLifecycleEffects': result.get('lifecycleEffects',[])}
