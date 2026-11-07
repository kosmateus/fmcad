"""Create one blank owned integration document; no product document is touched."""
import adsk.core


ARGS = {}
DOC_NAME = ''


def run(_context):
    required={'projectId','folderId','name'}
    if not isinstance(ARGS,dict) or set(ARGS)!=required or not all(
            isinstance(ARGS[key],str) and ARGS[key].strip()==ARGS[key] and ARGS[key]
            for key in required):
        raise ValueError('Create requires exact owned project/folder IDs and a unique fixture name')
    app=adsk.core.Application.get()
    projects=[app.data.dataProjects.item(index) for index in range(app.data.dataProjects.count)
              if app.data.dataProjects.item(index).id==ARGS['projectId']]
    if len(projects)!=1:
        raise ValueError('Owned fixture project ID must resolve exactly once')
    pending=[projects[0].rootFolder];seen=set();matches=[]
    while pending:
        folder=pending.pop()
        if folder.id in seen:continue
        seen.add(folder.id)
        if folder.id==ARGS['folderId']:matches.append(folder)
        pending.extend(folder.dataFolders.item(index) for index in range(folder.dataFolders.count))
    if len(matches)!=1:
        raise ValueError('Owned fixture folder ID must resolve exactly once in its project')
    folder=matches[0]
    if any(folder.dataFiles.item(index).name==ARGS['name'] for index in range(folder.dataFiles.count)):
        raise ValueError('Owned fixture filename already exists; no overwrite or reuse')
    doc=app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
    if doc is None or not doc.isValid or doc.dataFile is not None or doc.isModified:
        raise RuntimeError('Fusion did not create a clean new native design document')
    if not doc.saveAs(ARGS['name'],folder,'Owned fmcad-iw7.9 integration fixture',''):
        raise RuntimeError('Owned fixture saveAs was not accepted; reconcile before retry')
    return {'status':'saveAccepted','name':doc.name,'creationId':doc.creationId,
        'projectId':ARGS['projectId'],'folderId':ARGS['folderId'],'isModified':bool(doc.isModified)}
