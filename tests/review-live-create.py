import adsk.core,adsk.fusion,builtins,json,os,time
DOC_NAME = ''
def run(context):
    a=adsk.core.Application.get();assert os.getpid()==13532 and a.version=='2705.1.25' and a.userInterface.activeCommand=='SelectCommand';assert not hasattr(builtins,'_FMCAD_REVIEW_20261017')
    pid='a.YnVzaW5lc3M6Z21haWwzODI5NTUjMjAyNjA5MTExMTM4Njk0MTA2';projects=[p for p in a.data.dataProjects if p.id==pid];assert len(projects)==1;project=projects[0];assert project.name=='fmcad — Generic Methods Tests'
    s={'testProjectId':pid,'documents':[],'original':a.activeDocument,'originalColors':a.isComponentColorsDisplayed,'stage':'creating'};builtins._FMCAD_REVIEW_20261017=s
    def wait(doc):
        end=time.monotonic()+30
        while time.monotonic()<end:
            adsk.doEvents()
            if doc.dataFile.isComplete and not doc.isModified:return
            time.sleep(.1)
        raise RuntimeError('Scratch cloud completion not observed')
    tm=adsk.fusion.TemporaryBRepManager.get();P=adsk.core.Point3D.create;V=adsk.core.Vector3D.create
    def box(c,d):return tm.createBox(adsk.core.OrientedBoundingBox3D.create(P(*c),V(1,0,0),V(0,1,0),*d))
    for role in ('ORIGINAL','TARGET'):
        doc=a.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType);s['documents'].append(doc);assert doc.saveAs('FMCAD_REVIEW_20261017_'+role,project.rootFolder,'Owned review-command fixture; no product content','');wait(doc);assert doc.dataFile.parentProject.id==pid
        d=adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'));r=d.rootComponent;b=box((1.5,1,.5),(3,2,1))
        if role=='TARGET':
            assert tm.booleanOperation(b,box((.5,.5,1.5),(1,1,1)),adsk.fusion.BooleanTypes.UnionBooleanType);assert tm.booleanOperation(b,tm.createCylinderOrCone(P(2.2,1.3,-.1),.25,P(2.2,1.3,1.1),.25),adsk.fusion.BooleanTypes.DifferenceBooleanType)
        bf=r.features.baseFeatures.add();assert bf.startEdit();r.bRepBodies.add(b,bf);assert bf.finishEdit();r.attributes.add('FMCAD_REVIEW','owner','primary-R129-transfer-20261011');assert doc.save('Owned asymmetrical review fixture');wait(doc)
    original=s['documents'][0];assert original.activate();a.isComponentColorsDisplayed=True;vp=a.activeViewport;c=vp.camera;c.cameraType=adsk.core.CameraTypes.PerspectiveCameraType;c.isSmoothTransition=False;c.isFitView=False;c.eye=P(7,-6,5);c.target=P(1.5,1,.5);c.upVector=V(0,0,1);c.perspectiveAngle=.7;vp.camera=c;vp.visualStyle=adsk.core.VisualStyles.ShadedVisualStyle;s['stage']='ready'
    print(json.dumps({'pid':os.getpid(),'build':a.version,'testProjectId':pid,'documents':[{'name':doc.name,'creation':doc.creationId,'file':doc.dataFile.id,'version':doc.dataFile.versionNumber,'complete':doc.dataFile.isComplete,'dirty':doc.isModified} for doc in s['documents']]},indent=2))
