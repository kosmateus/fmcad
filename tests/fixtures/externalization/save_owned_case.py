"""Save one exact owned, modified integration fixture and observe its cloud version."""
import time
import adsk.core


ARGS = {}
DOC_NAME = ''


def run(_context):
    required={'projectId','folderId','fileId','creationId','version'}
    if not isinstance(ARGS,dict) or set(ARGS)!=required or not all(
            isinstance(ARGS[key],str) and ARGS[key] for key in ('projectId','folderId','fileId','creationId')) or \
            type(ARGS['version']) is not int or ARGS['version']<1:
        raise ValueError('Save requires exact owned project/folder/file/creation/version identity')
    doc=FMCAD.doc
    file=doc.dataFile
    if (not file or doc.creationId!=ARGS['creationId'] or file.id!=ARGS['fileId'] or
            file.parentProject.id!=ARGS['projectId'] or file.parentFolder.id!=ARGS['folderId'] or
            int(file.versionNumber)!=ARGS['version'] or file.isComplete is not True or
            file.isReadOnly is not False or doc.isModified is not True):
        raise ValueError('Save target differs from its exact owned dirty fixture baseline')
    baseline=int(file.versionNumber)
    print('FMCAD_PROGRESS '+__import__('json').dumps({'operation':'externalization.fixtureSave',
        'fileId':file.id,'baselineVersion':baseline,'status':'preSubmit'}),flush=True)
    if doc.save('Save owned fmcad-iw7.9 native integration fixture') is not True:
        raise RuntimeError('Owned fixture save was not accepted; inspect before retry')
    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        current=doc.dataFile
        if (current is not None and not doc.isModified and int(current.versionNumber)>baseline and
                current.isComplete is True):break
        adsk.doEvents()
        time.sleep(.25)
    current=doc.dataFile
    if (current is None or current.id!=ARGS['fileId'] or current.parentProject.id!=ARGS['projectId'] or
            current.parentFolder.id!=ARGS['folderId'] or int(current.versionNumber)<=baseline or
            doc.isModified or current.isComplete is not True):
        raise RuntimeError('Owned fixture save is unresolved; inspect identity/version/status before retry')
    return {'status':'complete','name':doc.name,'creationId':doc.creationId,
        'projectId':current.parentProject.id,'folderId':current.parentFolder.id,
        'fileId':current.id,'version':int(current.versionNumber),'isComplete':bool(current.isComplete),
        'isModified':bool(doc.isModified)}
