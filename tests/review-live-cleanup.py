import adsk.core,adsk.fusion,builtins,json,os
DOC_NAME = ''
def run(context):
    s=builtins._FMCAD_REVIEW_20261017;a=adsk.core.Application.get();assert os.getpid()==13532 and a.userInterface.activeCommand=='SelectCommand';files=[]
    for i,doc in enumerate(s['documents']):
        assert doc.isValid and not doc.isModified and doc.dataFile.versionNumber==2 and doc.dataFile.isComplete
        assert doc.dataFile.parentProject.id==s['testProjectId'];r=adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType')).rootComponent;assert r.attributes.itemByName('FMCAD_REVIEW','owner').value=='primary-R129-transfer-20261011';assert r.bRepBodies.count==1 and abs(r.bRepBodies.item(0).volume*1000-[6000,6803.650459150646][i])<1e-5
        assert doc.dataFile.parentReferences.count==0;files.append(doc.dataFile)
    s['stage']='closing_verified_scratch'
    for doc in reversed(s['documents']):assert doc.close(False)
    s['stage']='deleting_owned_scratch';s['deleted_files']=[]
    for f in files:
        fid=f.id;assert f.deleteMe();s['deleted_files'].append(fid)
    a.isComponentColorsDisplayed=s['originalColors']
    if s['original'].isValid:assert s['original'].activate()
    s['stage']='scratch_cleanup_returned';print(json.dumps({'deleted_files':s['deleted_files'],'editing_handles_closed':all(not d.isValid for d in s['documents']),'active':a.activeDocument.name,'component_colors':a.isComponentColorsDisplayed},indent=2))
