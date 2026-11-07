"""Restore one exact owned driver-probe source after a known no-update consumer outcome."""
import time
import adsk.core
import adsk.fusion


ARGS = {}
DOC_NAME = ''


def run(_context):
    required = {'projectId', 'folderId', 'fileId', 'creationId', 'version'}
    if not isinstance(ARGS, dict) or set(ARGS) != required:
        raise ValueError('Restore requires the exact owned project/folder/file/creation/version pin')

    app = adsk.core.Application.get()
    doc = FMCAD.doc
    file = doc.dataFile
    if (not file or doc.creationId != ARGS['creationId'] or file.id != ARGS['fileId'] or
            file.parentProject.id != ARGS['projectId'] or file.parentFolder.id != ARGS['folderId'] or
            int(file.versionNumber) != ARGS['version'] or file.isComplete is not True or
            file.isReadOnly is not False or doc.isModified is not False):
        raise ValueError('Restore source differs from its exact clean saved pin')

    design = FMCAD.design
    root = FMCAD.root
    parameter = design.userParameters.itemByName('IW79_Driver')
    bodies = [root.bRepBodies.item(i) for i in range(root.bRepBodies.count)]
    if (parameter is None or parameter.expression != '15 mm' or len(bodies) != 1 or
            abs(float(parameter.value) - 1.5) > 1e-9 or abs(float(bodies[0].volume) - 1.5) > 1e-9):
        raise ValueError('Restore precondition failed: expected the published 15 mm test state')

    baseline_version = int(file.versionNumber)
    parameter.expression = '10 mm'
    if not design.computeAll():
        raise RuntimeError('Driver restore recompute failed; inspect before any further mutation')
    health = FMCAD.call('history.check', {})
    if health.get('status') != 'pass' or health.get('healthy') is not True:
        raise RuntimeError('Driver restore produced unhealthy history; inspect before save')
    if abs(float(parameter.value) - 1.0) > 1e-9 or abs(float(bodies[0].volume) - 1.0) > 1e-9:
        raise RuntimeError('Driver restore readback failed before save')

    print('FMCAD_PROGRESS ' + __import__('json').dumps({'operation': 'driverProbe.restore',
        'sourceFileId': file.id, 'baselineVersion': baseline_version, 'status': 'restoredLocally'}), flush=True)
    if not doc.save('IW79 driver probe nominal restore; original refresh plan was blocked before update'):
        raise RuntimeError('Driver restore save was not accepted; inspect before retry')

    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        current_file = doc.dataFile
        if current_file is not None:
            current_file.refresh(None)
        file = doc.dataFile
        if (file is not None and not doc.isModified and int(file.versionNumber) > baseline_version and
                file.isComplete is True):
            break
        adsk.doEvents()
        time.sleep(0.25)
    if doc.isModified or int(file.versionNumber) <= baseline_version or file.isComplete is not True:
        raise RuntimeError('Driver restore publication outcome is unresolved; inspect current document and cloud version')

    restored = {'projectId': file.parentProject.id, 'folderId': file.parentFolder.id,
        'fileId': file.id, 'version': int(file.versionNumber), 'creationId': doc.creationId}
    if not doc.close(False):
        raise RuntimeError('Could not close the owned clean source for cold restore verification')
    reopened = app.documents.open(file, True)
    if (not reopened or not reopened.isValid or reopened.isModified or not reopened.dataFile or
            reopened.dataFile.id != restored['fileId'] or
            reopened.dataFile.parentProject.id != restored['projectId'] or
            reopened.dataFile.parentFolder.id != restored['folderId'] or
            int(reopened.dataFile.versionNumber) != restored['version'] or
            reopened.dataFile.isComplete is not True or reopened.dataFile.isReadOnly is not False):
        raise RuntimeError('Cold restore identity/status verification failed; inspect before any further action')

    cold_design = adsk.fusion.Design.cast(reopened.products.itemByProductType('DesignProductType'))
    cold_parameter = cold_design.userParameters.itemByName('IW79_Driver')
    cold_bodies = [cold_design.rootComponent.bRepBodies.item(i)
                   for i in range(cold_design.rootComponent.bRepBodies.count)]
    unhealthy = [feature.name for component in cold_design.allComponents
                 for feature in component.features
                 if not feature.isSuppressed and int(feature.healthState) != 0]
    if (cold_parameter is None or cold_parameter.expression != '10 mm' or len(cold_bodies) != 1 or
            abs(float(cold_parameter.value) - 1.0) > 1e-9 or
            abs(float(cold_bodies[0].volume) - 1.0) > 1e-9 or unhealthy):
        raise RuntimeError('Cold restore value, geometry, or history verification failed')

    return {'status': 'pass', 'restore': restored, 'expression': cold_parameter.expression,
        'internalValueCm': float(cold_parameter.value), 'bodyVolumeCm3': float(cold_bodies[0].volume),
        'healthy': True, 'consumerRefresh': 'not performed by this source-only restore helper'}
