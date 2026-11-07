import adsk.core,adsk.fusion,builtins,json,time,os
DOC_NAME = ''
def run(context):
    s=builtins._FMCAD_REVIEW_20261017;a=adsk.core.Application.get();assert os.getpid()==13532;end=time.monotonic()+25
    while time.monotonic()<end:
        adsk.doEvents()
        if all(d.dataFile.versionNumber>=2 and d.dataFile.isComplete for d in s['documents']):break
        time.sleep(.1)
    rows=[]
    for doc in s['documents']:
        assert doc.dataFile.parentProject.id==s['testProjectId'];d=adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'));rows.append({'name':doc.name,'creation':doc.creationId,'file':doc.dataFile.id,'version':doc.dataFile.versionNumber,'complete':doc.dataFile.isComplete,'dirty':doc.isModified,'body_count':d.rootComponent.bRepBodies.count,'volume_mm3':d.rootComponent.bRepBodies.item(0).volume*1000})
    print(json.dumps({'active':a.activeDocument.name,'stage':s['stage'],'documents':rows},indent=2))
