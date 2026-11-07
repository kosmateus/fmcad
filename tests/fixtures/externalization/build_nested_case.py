"""Owned blank fixture: rotated, repeated, coincident local parent with one leaf.

Only builds the pinned fixture; save is a separate authorized action.
"""
ARGS = {}
DOC_NAME = ''
def run(_context):
    import adsk.core
    import math
    doc=FMCAD.doc;d=FMCAD.design;root=FMCAD.root
    assert {'projectId','folderId'}.issubset(ARGS) and not set(ARGS)-{'projectId','folderId','coincidentParents'}
    assert type(ARGS.get('coincidentParents',True)) is bool
    assert doc.dataFile and doc.dataFile.parentProject.id==ARGS['projectId'] and doc.dataFile.parentFolder.id==ARGS['folderId']
    assert not doc.isModified and doc.dataFile.isComplete and not doc.dataFile.isReadOnly
    assert d.timeline.count==0 and root.occurrences.count==0
    parent_pose=adsk.core.Matrix3D.create()
    assert parent_pose.setToRotation(math.pi/2,adsk.core.Vector3D.create(0,0,1),adsk.core.Point3D.create(0,0,0))
    parent_pose.translation=adsk.core.Vector3D.create(3,0,0)
    first=root.occurrences.addNewComponent(parent_pose);first.component.name='Carrier'
    first.attributes.add('FMCAD_NESTED_FIXTURE','site','north')
    local=adsk.core.Matrix3D.create();local.translation=adsk.core.Vector3D.create(1,2,0)
    leaf=first.component.occurrences.addNewComponent(local);leaf.component.name='NestedLeaf'
    leaf.attributes.add('FMCAD_NESTED_FIXTURE','role','leaf')
    leaf.component.attributes.add('FMCAD_NESTED_FIXTURE','definition','leaf')
    body=FMCAD.call('shape.box',{'name':'NestedBody','width':'10 mm','depth':'10 mm','height':'10 mm'},
        component=FMCAD._context.ref(leaf.component))
    leaf.component.bRepBodies.item(0).attributes.add('FMCAD_NESTED_FIXTURE','bodyRole','solid')
    second_pose=parent_pose
    if ARGS.get('coincidentParents',True) is False:
        second_pose=adsk.core.Matrix3D.create()
        assert second_pose.setToRotation(math.pi,adsk.core.Vector3D.create(0,0,1),adsk.core.Point3D.create(0,0,0))
        second_pose.translation=adsk.core.Vector3D.create(8,0,0)
    second=root.occurrences.addExistingComponent(first.component,second_pose)
    second.attributes.add('FMCAD_NESTED_FIXTURE','site','south')
    if d.snapshots.hasPendingSnapshot:assert d.snapshots.add()
    assert d.computeAll()
    leaves=[o for o in root.allOccurrences if o.component==leaf.component]
    assert len(leaves)==2
    for o in leaves:
        t=o.transform2.translation
        expected=(1,1) if ARGS.get('coincidentParents',True) or o.fullPathName.startswith(first.fullPathName+'+') else (7,-2)
        assert abs(t.x-expected[0])<1e-9 and abs(t.y-expected[1])<1e-9 and abs(t.z)<1e-9
    return {'source':{'fileId':doc.dataFile.id,'creationId':doc.creationId,'version':doc.dataFile.versionNumber},
        'leafRefs':[FMCAD._context.ref(o) for o in leaves],'parentRefs':[FMCAD._context.ref(first),FMCAD._context.ref(second)],
        'parentPose':list(parent_pose.asArray()),'leafWorldPoses':[list(o.transform2.asArray()) for o in leaves],
        'inventory':{'bodies':1,'occurrences':0,'history':2},'health':FMCAD.call('history.check',{})}
