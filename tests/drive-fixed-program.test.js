'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const [mode, expectedStatus, expectedDriveCalls, expectedLinks] of [
  ['normal', 'pass', 4, 1],
  ['regular-joint', 'pass', 4, 1],
  ['invalid-motion', 'refused-before-actuation', 0, 0],
  ['invalid-joint', 'refused-before-actuation', 0, 0],
  ['invalid-units', 'refused-before-actuation', 0, 0],
  ['disconnected-restore-unknown', 'unknown', 1, 0],
  ['link-unknown', 'unknown', 1, 1],
  ['linked-restore-unknown', 'unknown', 2, 1],
  ['ratio-restore-unknown', 'unknown', 3, 1],
]) test('FAKE SDK/helpers: fixed drive preserves one fixture and stops mutations after ' + mode, () => {
  const source = path.resolve(__dirname, '../assets/native-qualification/drive-motion.py');
  const program = `
import sys, types, runpy, json, math
source,mode=sys.argv[1:]
core=types.ModuleType('adsk.core'); fusion=types.ModuleType('adsk.fusion'); adsk=types.ModuleType('adsk')
core.Application=types.SimpleNamespace(get=lambda:types.SimpleNamespace(version='fake-build'))
class FakeRevolute:
    rotationValue=0.0
class FakeJoint:
    jointMotion=FakeRevolute()
class FakeAsBuiltJoint:
    jointMotion=FakeRevolute()
fusion.Joint=FakeJoint
fusion.AsBuiltJoint=FakeAsBuiltJoint
fusion.RevoluteJointMotion=FakeRevolute
adsk.core=core; adsk.fusion=fusion
sys.modules.update({'adsk':adsk,'adsk.core':core,'adsk.fusion':fusion})
namespace=runpy.run_path(source)
class FakeFacade:
    def __init__(self):
        self.doc=types.SimpleNamespace(creationId='fake-owned',name='FAKE_SCRATCH')
        self.root=types.SimpleNamespace(bRepBodies=types.SimpleNamespace(count=0),sketches=types.SimpleNamespace(count=0),allOccurrences=types.SimpleNamespace(count=0))
        self.design=types.SimpleNamespace(timeline=types.SimpleNamespace(count=0))
        self.drives=0; self.links=0; self.calls=[]; self.report=None
    def resolve(self,ref,kind=None):
        if kind is not None and ref.get('kind')!=kind:
            raise ValueError('Reference kind conflicts with required kind')
        return FakeJoint() if ref.get('kind')=='Joint' else FakeAsBuiltJoint()
    def emit(self,report):
        assert self.report is None
        self.report=report
    def call(self,operation,data):
        self.calls.append(operation)
        if operation=='document.status': return {'creationId':'fake-owned','saved':False,'modified':False}
        if operation=='component.create': return {'occurrence':{'kind':'occurrence','name':data['name']}}
        if operation=='assembly.ground': return {'grounded':True}
        if operation=='joint.revolute': return {'joint':{'kind':'Joint' if mode=='regular-joint' else 'AsBuiltJoint','name':data['name']}}
        if operation=='joint.inspect': return {'joint':{'kind':'Feature' if mode=='invalid-joint' else data['joint']['kind']},
            'motionType':'RigidJointMotion' if mode=='invalid-motion' else 'RevoluteJointMotion','rotationValue':0.0,
            'units':'mm/deg' if mode=='invalid-units' else 'cm/rad'}
        if operation=='mechanism.motion-link.create':
            self.links+=1
            if mode=='link-unknown': return {'status':'unknown','nativeMotionLink':True,'readback':{'status':'unknown'}}
            return {'status':'pass','nativeMotionLink':True,'readback':{'status':'pass'}}
        assert operation=='mechanism.drive-test',operation
        ratio=data['followers'][0]['ratio']
        step=min(math.pi/180,(math.pi/180)/abs(ratio))
        assert data['waypoints']==[index*step for index in range(5)]
        assert data['driverTolerance']==1e-6 and data['restoreTolerance']==1e-6
        assert data['followers'][0]['tolerance']==1e-5
        self.drives+=1
        status='pass' if self.drives==2 else 'fail'
        restore='unknown' if ((mode=='disconnected-restore-unknown' and self.drives==1) or
            (mode=='linked-restore-unknown' and self.drives==2) or (mode=='ratio-restore-unknown' and self.drives==3)) else 'pass'
        return {'status':status,'actualSolver':{'status':status},'restore':{'status':restore},
            'capture':{'joints':{'driver':{},'follower:0':{}}},'observations':{'joints':{'driver':{},'follower:0':{}}}}
facade=FakeFacade()
namespace['run'].__globals__.update(FMCAD=facade,ARGS={'approved':True,'creationId':'fake-owned','expectedFusionVersion':'fake-build','fixturePrefix':'NQDRIVE01'})
try:
    report=namespace['run']('')
except RuntimeError as error:
    assert mode in ('invalid-motion','invalid-joint','invalid-units') and str(error)=='Native Joint/AsBuiltJoint revolute readback is incomplete'
    print(json.dumps({'status':'refused-before-actuation','drives':facade.drives,'links':facade.links}))
    sys.exit(0)
assert report is facade.report
assert report['expectation']=={'ratio':1.0,'phase':0.0,'source':'integrated-fixture-contract: one-to-one, zero-phase'}
assert not any(name.startswith('document.') and name!='document.status' for name in facade.calls)
print(json.dumps({'status':report['nativeCasesStatus'],'drives':facade.drives,'links':facade.links}))
`;
  const result = spawnSync('python3', ['-B', '-c', program, source, mode], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.deepEqual(JSON.parse(result.stdout.trim()), { status: expectedStatus, drives: expectedDriveCalls, links: expectedLinks });
});
