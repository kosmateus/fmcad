import adsk.core,builtins,json,os
DOC_NAME = ''
def run(context):
    s=builtins._FMCAD_REVIEW_20261017;a=adsk.core.Application.get();assert os.getpid()==13532 and s['stage']=='scratch_cleanup_returned';p=next(p for p in a.data.dataProjects if p.id==s['testProjectId']);present=[f.id for f in p.rootFolder.dataFiles if f.id in s['deleted_files']];assert not present
    s['stage']='scratch_cleanup_verified';print(json.dumps({'scratch_files_absent_from_test_project':True,'editing_handles_closed':all(not d.isValid for d in s['documents']),'active':a.activeDocument.name,'command':a.userInterface.activeCommand,'pending':False}))
