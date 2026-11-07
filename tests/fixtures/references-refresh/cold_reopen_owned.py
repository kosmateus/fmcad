"""Cold-reopen one exact clean owned consumer and verify its declared references."""
import adsk.core
import adsk.fusion

ARGS = {}
DOC_NAME = ''


def run(_context):
    required = {'projectId', 'folderId', 'fileId', 'creationId', 'version',
                'parameters', 'derivedParameters', 'bodyVolumesCm3', 'references'}
    if not isinstance(ARGS, dict) or set(ARGS) != required:
        raise ValueError('Cold readback requires exact pin and explicit physical/reference expectations')
    app = adsk.core.Application.get()
    doc = FMCAD.doc
    file = doc.dataFile
    if (file is None or doc.creationId != ARGS['creationId'] or file.id != ARGS['fileId'] or
            file.parentProject.id != ARGS['projectId'] or file.parentFolder.id != ARGS['folderId'] or
            int(file.versionNumber) != ARGS['version'] or file.isComplete is not True or
            file.isReadOnly is not False or doc.isModified or not doc.isSaved):
        raise ValueError('Cold readback target differs from the exact clean saved owned pin')
    if not doc.close(False):
        raise RuntimeError('Could not close the exact owned clean consumer for cold verification')
    if any(candidate.creationId == ARGS['creationId'] for candidate in app.documents):
        raise RuntimeError('Owned consumer editor remains open; do not open another buffer')
    reopened = app.documents.open(file, True)
    if (not reopened or not reopened.isValid or reopened.isModified or not reopened.isSaved or
            reopened.creationId != ARGS['creationId'] or reopened.dataFile is None or
            reopened.dataFile.id != ARGS['fileId'] or reopened.dataFile.parentProject.id != ARGS['projectId'] or
            reopened.dataFile.parentFolder.id != ARGS['folderId'] or
            int(reopened.dataFile.versionNumber) != ARGS['version'] or
            reopened.dataFile.isComplete is not True or reopened.dataFile.isReadOnly is not False):
        raise RuntimeError('Cold consumer identity/status differs from the exact saved pin')
    design = adsk.fusion.Design.cast(reopened.products.itemByProductType('DesignProductType'))
    root = design.rootComponent
    observed_parameters = []
    for row in ARGS['parameters']:
        parameter = design.userParameters.itemByName(row['name'])
        if parameter is None or parameter.expression != row['expression'] or \
                abs(float(parameter.value) - float(row['valueCm'])) > 1e-9:
            raise RuntimeError('Cold user-parameter expression/value mismatch: ' + row['name'])
        observed_parameters.append({'name': parameter.name, 'expression': parameter.expression,
            'valueCm': float(parameter.value), 'unit': parameter.unit})
    observed_derived = []
    for row in ARGS['derivedParameters']:
        matches = [parameter for parameter in design.derivedParameters if parameter.name == row['name']]
        parameter = matches[0] if len(matches) == 1 else None
        if parameter is None or parameter.expression != row['expression'] or \
                abs(float(parameter.value) - float(row['valueCm'])) > 1e-9:
            raise RuntimeError('Cold DerivedParameter expression/value mismatch: ' + row['name'])
        observed_derived.append({'name': parameter.name, 'expression': parameter.expression,
            'valueCm': float(parameter.value), 'unit': parameter.unit})
    body_volumes = [float(root.bRepBodies.item(index).volume) for index in range(root.bRepBodies.count)]
    if len(body_volumes) != len(ARGS['bodyVolumesCm3']) or any(
            abs(actual - float(expected)) > 1e-9 for actual, expected in zip(body_volumes, ARGS['bodyVolumesCm3'])):
        raise RuntimeError('Cold physical witness body inventory/volume mismatch')
    occurrences = []
    for expected in ARGS['references']:
        matches = [occurrence for occurrence in root.allOccurrences if occurrence.isReferencedComponent and
                   occurrence.documentReference.dataFile.id == expected['fileId']]
        if len(matches) != 1 or int(matches[0].documentReference.version) != expected['version'] or \
                matches[0].isDerived is not False:
            raise RuntimeError('Cold ordinary-reference identity/version mismatch: ' + expected['fileId'])
        occurrences.append({'fileId': expected['fileId'], 'version': int(matches[0].documentReference.version),
            'path': str(matches[0].fullPathName), 'isReferencedComponent': True, 'isDerived': False,
            'worldPose': list(matches[0].transform2.asArray())})
    unhealthy = [feature.name for component in design.allComponents for feature in component.features
                 if not feature.isSuppressed and int(feature.healthState) != 0]
    if unhealthy or int(design.timeline.markerPosition) != int(design.timeline.count):
        raise RuntimeError('Cold history health or end-marker verification failed')
    return {'status': 'pass', 'identity': {'projectId': reopened.dataFile.parentProject.id,
        'folderId': reopened.dataFile.parentFolder.id, 'fileId': reopened.dataFile.id,
        'version': int(reopened.dataFile.versionNumber), 'creationId': reopened.creationId,
        'isComplete': bool(reopened.dataFile.isComplete), 'isModified': bool(reopened.isModified)},
        'parameters': observed_parameters, 'derivedParameters': observed_derived,
        'rootBodyVolumesCm3': body_volumes, 'references': occurrences,
        'unhealthyFeatures': unhealthy, 'timeline': {'marker': int(design.timeline.markerPosition),
            'count': int(design.timeline.count)}}
