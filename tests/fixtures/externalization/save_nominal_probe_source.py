"""Publish and cold-verify an already-restored nominal driver source."""
import time
import adsk.core
import adsk.fusion


ARGS = {}
DOC_NAME = ''


def run(_context):
    required={'projectId','folderId','fileId','creationId','version'}
    if not isinstance(ARGS,dict) or set(ARGS)!=required:
        raise ValueError('Nominal save requires an exact owned project/folder/file/creation/version pin')
    app=adsk.core.Application.get()
    doc=FMCAD.doc
    file=doc.dataFile
    if (not file or doc.creationId!=ARGS['creationId'] or file.id!=ARGS['fileId'] or
            file.parentProject.id!=ARGS['projectId'] or file.parentFolder.id!=ARGS['folderId'] or
            int(file.versionNumber)!=ARGS['version'] or file.isComplete is not True or
            file.isReadOnly is not False):
        raise ValueError('Nominal save document differs from its exact owned pin')
    design=FMCAD.design
    parameter=design.userParameters.itemByName('IW79_Driver')
    bodies=[design.rootComponent.bRepBodies.item(i) for i in range(design.rootComponent.bRepBodies.count)]
    if (parameter is None or parameter.expression!='10 mm' or abs(float(parameter.value)-1.0)>1e-9 or
            len(bodies)!=1 or abs(float(bodies[0].volume)-1.0)>1e-9):
        raise ValueError('Nominal save precondition failed; expected 10 mm and 1.0 cm3')
    health=FMCAD.call('history.check',{})
    if health.get('status')!='pass' or health.get('healthy') is not True:
        raise ValueError('Nominal save precondition has unhealthy feature history')

    baseline=int(file.versionNumber)
    if doc.isModified:
        print('FMCAD_PROGRESS '+__import__('json').dumps({'operation':'driverProbe.nominalSave',
            'fileId':file.id,'baselineVersion':baseline,'status':'preSubmit'}),flush=True)
        if doc.save('IW79 driver nominal checkpoint after known local perturb/restore; consumer refresh not applied') is not True:
            raise RuntimeError('Nominal save was not accepted; inspect before retry')

    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        current=doc.dataFile
        if (current is not None and not doc.isModified and int(current.versionNumber)>baseline and
                current.isComplete is True):break
        adsk.doEvents()
        time.sleep(.25)
    current=doc.dataFile
    if current is None or doc.isModified or current.isComplete is not True:
        raise RuntimeError('Nominal source save outcome unresolved; inspect exact current identity/version')
    final={'projectId':current.parentProject.id,'folderId':current.parentFolder.id,
        'fileId':current.id,'version':int(current.versionNumber),'creationId':doc.creationId}
    if not doc.close(False):
        raise RuntimeError('Could not close the owned clean nominal source before cold readback')
    reopened=app.documents.open(current,True)
    if (not reopened or not reopened.isValid or reopened.isModified or not reopened.dataFile or
            reopened.dataFile.id!=final['fileId'] or int(reopened.dataFile.versionNumber)!=final['version'] or
            reopened.dataFile.isComplete is not True or reopened.dataFile.isReadOnly is not False):
        raise RuntimeError('Cold nominal source identity/status verification failed')
    cold_design=adsk.fusion.Design.cast(reopened.products.itemByProductType('DesignProductType'))
    cold_parameter=cold_design.userParameters.itemByName('IW79_Driver')
    cold_bodies=[cold_design.rootComponent.bRepBodies.item(i) for i in range(cold_design.rootComponent.bRepBodies.count)]
    unhealthy=[feature.name for component in cold_design.allComponents for feature in component.features
        if not feature.isSuppressed and int(feature.healthState)!=0]
    if (cold_parameter is None or cold_parameter.expression!='10 mm' or
            abs(float(cold_parameter.value)-1.0)>1e-9 or len(cold_bodies)!=1 or
            abs(float(cold_bodies[0].volume)-1.0)>1e-9 or unhealthy):
        raise RuntimeError('Cold nominal source value, body or health verification failed')
    final.update({'expression':cold_parameter.expression,'internalValueCm':float(cold_parameter.value),
        'bodyVolumeCm3':float(cold_bodies[0].volume),'healthy':True,'consumerRefresh':'not performed'})
    return {'status':'pass','source':final}
