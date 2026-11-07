"""Owned .10 fixture: create native Derive drivers and local physical consumers."""
ARGS = []
DOC_NAME = ''


def run(_context):
    import adsk.core

    if not isinstance(ARGS, dict) or set(ARGS) - {'sources', 'linkedBodySource'}:
        raise ValueError('Expected {sources:[...], linkedBodySource?}')
    sources = ARGS.get('sources')
    if not isinstance(sources, list) or not sources:
        raise ValueError('sources must be nonempty')
    app = adsk.core.Application.get()
    design = FMCAD.design
    root = FMCAD.root
    observed = []
    aliases = []
    witnesses = []
    source_docs = {}

    def owned_open_docs(file_id, version):
        matches = []
        for doc in app.documents:
            file = getattr(doc, 'dataFile', None)
            if file is None or file.id != file_id or file.versionNumber != version:
                continue
            try:
                doc.allDocumentReferences.count
            except RuntimeError as error:
                if 'non-top-level document' in str(error):
                    continue
                raise
            matches.append(doc)
        return matches

    for source in sources:
        if not isinstance(source, dict) or set(source) != {'fileId', 'version', 'parameter', 'alias', 'body'}:
            raise ValueError('Each source requires exact fileId, version, parameter, alias and body fields')
        if not isinstance(source['fileId'], str) or not isinstance(source['version'], int):
            raise ValueError('Source file/version identity is invalid')
        matches = owned_open_docs(source['fileId'], source['version'])
        if len(matches) != 1:
            raise ValueError('Expected exactly one already-open owned source at the pinned version')
        source_doc = matches[0]
        source_docs[source['fileId']] = source_doc
        source_design = source_doc.products.itemByProductType('DesignProductType')
        if source_design is None:
            raise ValueError('Pinned source is not a Fusion design')
        collection = root.features.deriveFeatures
        derive_input = collection.createInput(source_design)
        derive_input.isIncludeFavoriteParameters = True
        derive_input.isIncludeComponentParameters = False
        derive_source = derive_input.sourceDesign
        derive_source_doc = derive_source.parentDocument
        if derive_source_doc.dataFile.id != source['fileId'] or derive_source_doc.dataFile.versionNumber != source['version']:
            raise ValueError('Derive input sourceDesign differs from the exact pinned source document')
        derive_input.sourceEntities = [derive_input.sourceDesign.rootComponent]
        feature = collection.add(derive_input)
        if feature is None or bool(feature.isSuppressed):
            raise RuntimeError('Owned Derive feature was not created/healthy')
        native = [parameter for parameter in design.derivedParameters
                  if parameter.deriveFeature == feature and parameter.name]
        names = [str(parameter.name) for parameter in native]
        if source['parameter'] not in [str(parameter.name) for parameter in derive_source.userParameters]:
            raise ValueError('Source parameter name is not present in the pinned source')
        if len(names) != 1:
            raise RuntimeError('Expected exactly one runtime DerivedParameter from this one-favorite-parameter source')
        aliases.append({'name': source['alias'], 'expression': names[0], 'unit': 'mm'})
        if source['body'] is True:
            witnesses.append(source['alias'])
        observed.append({'sourceFileId': source['fileId'], 'featureToken': getattr(feature, 'entityToken', None),
            'healthState': str(getattr(feature, 'healthState', 'unknown')), 'derivedParameters': names,
            'sourceDesignFileId': derive_source_doc.dataFile.id,
            'sourceDesignVersion': int(derive_source_doc.dataFile.versionNumber)})
    extra = FMCAD.call('param.apply', {'parameters': [{'name': 'IW710_ExtraLocal', 'expression': '7 mm', 'unit': 'mm'}]})
    if not isinstance(extra, dict):
        raise RuntimeError('Local extra parameter creation returned no structured result')
    created_aliases = FMCAD.call('param.apply', {'parameters': aliases})
    if not isinstance(created_aliases, dict):
        raise RuntimeError('Explicit derived parameter aliases returned no structured result')
    for alias in witnesses:
        shape = FMCAD.call('shape.box', {'name': 'IW710_' + alias + '_Witness',
            'width': alias, 'depth': '10 mm', 'height': '10 mm'})
        if not isinstance(shape, dict):
            raise RuntimeError('Physical witness operation returned no structured result')
    body_rows = [{'token': getattr(body, 'entityToken', None), 'name': str(body.name),
                  'volumeCm3': float(body.volume), 'isSolid': bool(body.isSolid)}
                 for body in root.bRepBodies]
    if ARGS.get('linkedBodySource') is not None:
        linked_source = ARGS['linkedBodySource']
        if not isinstance(linked_source, dict) or set(linked_source) != {'fileId', 'version'}:
            raise ValueError('linkedBodySource requires exact {fileId,version}')
        matches = owned_open_docs(linked_source['fileId'], linked_source['version'])
        if len(matches) != 1:
            raise ValueError('Expected one separately owned linked source at the pinned version')
        source_doc = matches[0]
        transform = adsk.core.Matrix3D.create()
        occurrence = root.occurrences.addByInsert(source_doc.dataFile, transform, True)
        if occurrence is None or not bool(occurrence.isReferencedComponent):
            raise RuntimeError('Ordinary linked occurrence was not observed after native insert')
        linked = {'sourceFileId': linked_source['fileId'], 'path': occurrence.fullPathName,
                  'isReferencedComponent': bool(occurrence.isReferencedComponent),
                  'isDerived': bool(occurrence.isDerived)}
    else:
        linked = None
    health = FMCAD.call('history.check', {})
    return {'derives': observed, 'aliases': aliases, 'extraLocal': True,
            'linkedOccurrence': linked, 'physicalWitnesses': body_rows, 'health': health}
