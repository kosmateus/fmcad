import adsk.core,adsk.fusion,builtins,json,os
DOC_NAME = ''
def run(context):
    s=builtins._FMCAD_REVIEW_20261017;a=adsk.core.Application.get();assert os.getpid()==13532;doc=s['documents'][1];assert doc.dataFile.parentProject.id==s['testProjectId'];original=a.activeDocument;ns={};exec(open(r'\\wsl.localhost\Ubuntu\home\kamil\.config\opencode\plugins\fmcad\assets\review.py',encoding='utf-8').read(),ns);original_state=ns['snapshot'](a,adsk.core);assert doc.activate();vp=a.activeViewport;target_state=ns['snapshot'](a,adsk.core);rows=[]
    try:
        for mode in ('getter','fresh'):
            for name in ('Front','Back','IsoTopLeft'):
                c=vp.camera if mode=='getter' else adsk.core.Camera.create();c.cameraType=adsk.core.CameraTypes.OrthographicCameraType;c.viewOrientation=getattr(adsk.core.ViewOrientations,name+'ViewOrientation');c.isFitView=True;c.isSmoothTransition=False;vp.camera=c;vp.refresh();actual=vp.camera;rows.append({'mode':mode,'requested':name,'requested_enum':getattr(adsk.core.ViewOrientations,name+'ViewOrientation'),'actual_enum':actual.viewOrientation,'camera':ns['camera_state'](actual,adsk.core)})
    finally:
        ns['restore_camera'](vp,target_state['camera'],adsk.core);assert original.activate();ns['restore_camera'](a.activeViewport,original_state['camera'],adsk.core)
    print(json.dumps(rows,indent=2))
