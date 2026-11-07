"""Cold-readback an exact owned, already-restored driver-probe source version."""
import adsk.core
import adsk.fusion


ARGS = {}
DOC_NAME = ''


def run(_context):
    required = {'projectId', 'folderId', 'fileId', 'creationId', 'version'}
    if not isinstance(ARGS, dict) or set(ARGS) != required:
        raise ValueError('Cold verification requires an exact owned project/folder/file/creation/version pin')
    app = adsk.core.Application.get()
    doc = FMCAD.doc
    file = doc.dataFile
    if (not file or doc.creationId != ARGS['creationId'] or file.id != ARGS['fileId'] or
            file.parentProject.id != ARGS['projectId'] or file.parentFolder.id != ARGS['folderId'] or
            int(file.versionNumber) != ARGS['version'] or file.isComplete is not True or
            file.isReadOnly is not False or doc.isModified is not False):
        raise ValueError('Cold verification source differs from its exact clean saved pin')
    exact = file
    if int(exact.versionNumber) != ARGS['version'] or exact.isComplete is not True or exact.isReadOnly is not False:
        raise ValueError('Exact restored cloud version is incomplete or read-only')
    if not doc.close(False):
        raise RuntimeError('Could not close the owned clean source for cold verification')
    reopened = app.documents.open(exact, True)
    if (not reopened or not reopened.isValid or reopened.isModified or not reopened.dataFile or
            reopened.dataFile.id != ARGS['fileId'] or
            reopened.dataFile.parentProject.id != ARGS['projectId'] or
            reopened.dataFile.parentFolder.id != ARGS['folderId'] or
            int(reopened.dataFile.versionNumber) != ARGS['version'] or
            reopened.dataFile.isComplete is not True or reopened.dataFile.isReadOnly is not False):
        raise RuntimeError('Cold reopened source identity/status differs from the exact restored pin')
    design = adsk.fusion.Design.cast(reopened.products.itemByProductType('DesignProductType'))
    parameter = design.userParameters.itemByName('IW79_Driver')
    bodies = [design.rootComponent.bRepBodies.item(i) for i in range(design.rootComponent.bRepBodies.count)]
    unhealthy = [feature.name for component in design.allComponents for feature in component.features
                 if not feature.isSuppressed and int(feature.healthState) != 0]
    if (parameter is None or parameter.expression != '10 mm' or len(bodies) != 1 or
            abs(float(parameter.value) - 1.0) > 1e-9 or abs(float(bodies[0].volume) - 1.0) > 1e-9 or unhealthy):
        raise RuntimeError('Cold restored parameter, geometry, or feature health readback failed')
    return {'status': 'pass', 'identity': {'projectId': reopened.dataFile.parentProject.id,
        'folderId': reopened.dataFile.parentFolder.id, 'fileId': reopened.dataFile.id,
        'version': int(reopened.dataFile.versionNumber), 'creationId': reopened.creationId,
        'isComplete': bool(reopened.dataFile.isComplete), 'isModified': bool(reopened.isModified)},
        'expression': parameter.expression, 'internalValueCm': float(parameter.value),
        'bodyVolumeCm3': float(bodies[0].volume), 'unhealthyFeatures': unhealthy}
