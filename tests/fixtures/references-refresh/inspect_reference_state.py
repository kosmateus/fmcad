"""Read-only native inspection of owned .10 Derive/source/consumer state after a refresh."""
ARGS = []
DOC_NAME = ''


def _read(obj, name):
    try:
        return getattr(obj, name)
    except Exception as error:
        return {'getterError': type(error).__name__ + ': ' + str(error)}


def _parameter(parameter, units_manager):
    name = str(_read(parameter, 'name'))
    expression = str(_read(parameter, 'expression'))
    unit = str(_read(parameter, 'unit'))
    value = _read(parameter, 'value')
    favorite = _read(parameter, 'isFavorite')
    if isinstance(value, dict):
        return {'name': name, 'expression': expression, 'unit': unit,
                'internalValue': value, 'favorite': favorite}
    internal_unit = 'cm' if unit in ('mm', 'cm', 'm', 'in', 'ft') else \
        'rad' if unit in ('deg', 'rad') else unit or '1'
    try:
        display_value = float(value) if unit in ('', '1', internal_unit) else \
            float(units_manager.convert(float(value), internal_unit, unit))
    except Exception as error:
        display_value = {'getterError': type(error).__name__ + ': ' + str(error)}
    return {'name': name, 'expression': expression, 'unit': unit,
            'internalValue': float(value), 'internalUnit': internal_unit,
            'displayValue': display_value, 'displayUnit': unit or '1', 'favorite': favorite}


def run(_context):
    import adsk.core

    if not isinstance(ARGS, dict) or set(ARGS) - {'aliases'}:
        raise ValueError('Expected optional aliases list')
    app = adsk.core.Application.get()
    design = FMCAD.design
    root = FMCAD.root
    derives = []
    source_ids = set()
    for component in [root]:
        for feature in component.features.deriveFeatures:
            reference = feature.documentReference
            data_file = reference.dataFile
            source_ids.add(data_file.id)
            source_design = feature.sourceDesign
            parent_document = source_design.parentDocument
            parent_file = getattr(parent_document, 'dataFile', None)
            source_parameters = [_parameter(parameter, source_design.unitsManager)
                                 for parameter in source_design.userParameters]
            derived_parameters = [_parameter(parameter, design.unitsManager)
                for parameter in design.derivedParameters if parameter.deriveFeature == feature]
            try:
                reference_version = int(reference.version)
                reference_error = None
            except Exception as error:
                reference_version = None
                reference_error = type(error).__name__ + ': ' + str(error)
            derives.append({'featureName': str(feature.name), 'featureToken': str(feature.entityToken),
                'suppressed': bool(feature.isSuppressed), 'healthState': str(feature.healthState),
                'documentReference': {'fileId': data_file.id, 'version': int(data_file.versionNumber),
                    'latestVersion': int(data_file.latestVersionNumber), 'isComplete': bool(data_file.isComplete),
                    'isReadOnly': bool(data_file.isReadOnly), 'getterVersion': reference_version,
                    'getterError': reference_error},
                'sourceDesign': {'parentCreationId': str(parent_document.creationId) if parent_document else None,
                    'parentName': str(parent_document.name) if parent_document else None,
                    'fileId': getattr(parent_file, 'id', None),
                    'version': int(parent_file.versionNumber) if parent_file else None,
                    'latestVersion': int(parent_file.latestVersionNumber) if parent_file else None,
                    'isComplete': bool(parent_file.isComplete) if parent_file else None,
                    'userParameters': source_parameters},
                'derivedParameters': derived_parameters,
                'includeFavoriteParameters': _read(feature, 'isIncludeFavoriteParameters'),
                'includeComponentParameters': _read(feature, 'isIncludeComponentParameters')})
    loaded = []
    for doc in app.documents:
        file = getattr(doc, 'dataFile', None)
        if file is None or file.id not in source_ids:
            continue
        try:
            int(doc.allDocumentReferences.count)
            top_level = True
        except RuntimeError as error:
            top_level = 'non-top-level document' not in str(error)
        loaded.append({'fileId': file.id, 'name': str(doc.name), 'creationId': str(doc.creationId),
            'version': int(file.versionNumber), 'modified': bool(doc.isModified), 'saved': bool(doc.isSaved),
            'isComplete': bool(file.isComplete), 'isReadOnly': bool(file.isReadOnly), 'topLevel': top_level})
    aliases = []
    for name in ARGS.get('aliases', []):
        parameter = design.userParameters.itemByName(name)
        aliases.append(_parameter(parameter, design.unitsManager) if parameter else {'name': name, 'status': 'missing'})
    bodies = [{'token': getattr(body, 'entityToken', None), 'volumeInternalCm3': float(body.volume),
               'boundsInternalCm': [[float(body.boundingBox.minPoint.x), float(body.boundingBox.minPoint.y), float(body.boundingBox.minPoint.z)],
                                    [float(body.boundingBox.maxPoint.x), float(body.boundingBox.maxPoint.y), float(body.boundingBox.maxPoint.z)]]}
              for body in root.bRepBodies]
    occurrence_bodies = [{'path': str(occurrence.fullPathName), 'isDerived': bool(occurrence.isDerived),
        'isReferencedComponent': bool(occurrence.isReferencedComponent),
        'bodies': [{'token': getattr(body, 'entityToken', None), 'volumeInternalCm3': float(body.volume),
                    'isSolid': bool(body.isSolid)} for body in occurrence.component.bRepBodies]}
        for occurrence in root.allOccurrences]
    return {'consumer': {'name': str(FMCAD.doc.name), 'creationId': str(FMCAD.doc.creationId),
                'fileId': FMCAD.doc.dataFile.id, 'version': int(FMCAD.doc.dataFile.versionNumber),
                'latestVersion': int(FMCAD.doc.dataFile.latestVersionNumber),
                'isComplete': bool(FMCAD.doc.dataFile.isComplete), 'isReadOnly': bool(FMCAD.doc.dataFile.isReadOnly),
                'modified': bool(FMCAD.doc.isModified), 'saved': bool(FMCAD.doc.isSaved)},
            'derives': derives, 'loadedSourceDocuments': loaded, 'aliases': aliases,
            'localBodies': bodies, 'occurrenceBodies': occurrence_bodies,
            'timeline': {'marker': int(design.timeline.markerPosition),
                'count': int(design.timeline.count)}}
