// Exclusive, opt-in scratch-only native diagnostic and production regression.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createBackend } = require('./helpers/live-broker');
const { executeCad } = require('../src/cad');
const reportPath = path.join(__dirname, 'live-joint-limits-probe.json');
const report = { runs: fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath)).runs : [] };
const run = { mode: process.argv.includes('--verify') ? 'verify' : 'diagnose', requests: [], cases: [] };
const name = 'FMCAD_LIMITS_' + randomUUID().replaceAll('-', '_');
const { fixture } = require('./helpers/live-broker');
fixture(name);
const py = v => `json.loads(${JSON.stringify(JSON.stringify(v))})`;
const persist = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
let baseline, identity, uncertain = false;
const client = createBackend({ backend: 'addin', url: 'http://127.0.0.1:8765/mcp', headers: {},
  timeoutMs: 60000, transport: 'windows-curl', curlPath: '/mnt/c/Windows/System32/curl.exe', protocolVersion: '2025-06-18' }, { command: true });
const helpers = `import adsk.core, adsk.fusion, json, math
app = adsk.core.Application.get()
def environment():
    return dict(documents=sorted([dict(creationId=d.creationId, name=d.name, saved=d.isSaved, modified=d.isModified) for d in app.documents if _fmcad_live_visible(d)], key=lambda d:d['creationId']), active=app.activeDocument.creationId if app.activeDocument else None, workspace=app.userInterface.activeWorkspace.id)
VALUES = ('minimumValue', 'maximumValue', 'restValue')
FLAGS = ('isMinimumValueEnabled', 'isMaximumValueEnabled', 'isRestValueEnabled')
def read_limits(m):
    return {a:{p:getattr(getattr(m,a+'Limits'),p) for p in VALUES+FLAGS} for a in ('rotation','slide') if hasattr(m,a+'Limits')}
def state(d):
    r = d.rootComponent
    return dict(joints=[dict(name=j.name, limits=read_limits(j.jointMotion), values={p:getattr(j.jointMotion,p) for p in ('rotationValue','slideValue') if hasattr(j.jointMotion,p)}) for j in r.asBuiltJoints], matrices=[list(o.transform2.asArray()) for o in r.occurrences], timeline=d.timeline.count, pending=d.snapshots.hasPendingSnapshot)
`;
function guard() { return `doc = app.activeDocument
assert doc and doc.creationId == ${py(identity.creationId)} and doc.name == ${py(name)} and not doc.isSaved
assert [d for d in environment()['documents'] if d['creationId'] != doc.creationId] == ${py(baseline.documents)}
assert app.userInterface.activeCommand in ('', 'SelectCommand')
d = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
`; }
async function send(label, script, readOnly) {
  assert.ok(!uncertain || readOnly);
  const row = { label, readOnly, script }; run.requests.push(row); persist();
  try { row.output = await client.callTool({ featureType: 'script', object: { script, readOnly } }); }
  catch (e) { uncertain = true; row.error = e.message; persist(); throw e; }
  persist(); return row.output;
}
async function script(label, body, owned = true, readOnly = true) {
  const out = await send(label, helpers + '\ndef run(_context: str):\n' + ((owned ? guard() : '') + body).split('\n').map(l => '    ' + l).join('\n'), readOnly);
  if (out.failed) throw new Error(out.text);
  const lines = out.text.split('\n').filter(l => l.startsWith('LIMITS_PROBE '));
  if (lines.length !== 1) { uncertain = true; throw new Error('Missing result marker'); }
  return JSON.parse(lines[0].slice(13));
}
const emit = expr => `print('LIMITS_PROBE ' + json.dumps(${expr}))`;
async function cad(op, data) {
  return executeCad({ callTool: request => send(op, request.object.script + '\n' + helpers + '\n_original_run = run\ndef run(_context: str):\n' + guard().split('\n').map(l => '    ' + l).join('\n') + '\n    _original_run(_context)\n', request.object.readOnly) }, op, data, { doc: name, component: 'root' });
}
const spec = axis => ({ minimumValue: axis === 'rotation' ? '-90 deg' : '-10 mm', maximumValue: axis === 'rotation' ? '90 deg' : '20 mm', restValue: axis === 'rotation' ? '10 deg' : '2 mm', isMinimumValueEnabled: true, isMaximumValueEnabled: true, isRestValueEnabled: true });
async function main() {
  report.runs.push(run); run.name = name; persist();
  baseline = await script('baseline-and-runtime-docs', `assert app.userInterface.activeCommand in ('', 'SelectCommand')
${emit("dict(environment(), docs={p:getattr(adsk.fusion.JointLimits,p).__doc__ for p in VALUES+FLAGS})")}`, false);
  run.baseline = baseline;
  try {
    identity = await script('create-scratch', `assert environment()['documents'] == ${py(baseline.documents)}
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = ${py(name)}
${emit('dict(creationId=doc.creationId)')}`, false, false);
    run.identity = identity; persist();
    fixture(name, identity.creationId);
    if (run.mode === 'diagnose') {
      run.cases = await script('native-transfer-and-setter-orders', `r = d.rootComponent
rows = []
for kind in ('Revolute','Slider','Cylindrical'):
    one = r.occurrences.addNewComponent(adsk.core.Matrix3D.create())
    two = r.occurrences.addNewComponent(adsk.core.Matrix3D.create())
    one.isGrounded = True
    inp = r.asBuiltJoints.createInput(one,two,adsk.fusion.JointGeometry.createByPoint(r.originConstructionPoint))
    assert getattr(inp,'setAs'+kind+'JointMotion')(adsk.fusion.JointDirections.ZAxisJointDirection)
    axes = ('rotation','slide') if kind == 'Cylindrical' else ('rotation',) if kind == 'Revolute' else ('slide',)
    for a in axes:
        l = getattr(inp.jointMotion,a+'Limits')
        for p,v in zip(VALUES,(-math.pi/2,math.pi/2,math.pi/18) if a == 'rotation' else (-1,2,.2)): setattr(l,p,v)
        for p in FLAGS: setattr(l,p,True)
    before = read_limits(inp.jointMotion)
    j = r.asBuiltJoints.add(inp)
    row = dict(kind=kind,input=before,postAdd=read_limits(j.jointMotion),orders=[])
    for order in ('values_then_flags','flags_then_values'):
        for a in axes:
            l = getattr(j.jointMotion,a+'Limits')
            for p in FLAGS: setattr(l,p,False)
            values = dict(zip(VALUES,(-math.pi/2,math.pi/2,math.pi/18) if a == 'rotation' else (-1,2,.2)))
            steps = []
            assignments = list(values.items()) + [(p,True) for p in FLAGS] if order == 'values_then_flags' else [(p,True) for p in FLAGS] + list(values.items())
            for p,v in assignments:
                setattr(l,p,v)
                steps.append(dict(property=p,value=v,actual=read_limits(j.jointMotion)))
            row['orders'].append(dict(axis=a,order=order,steps=steps))
    rows.append(row)
${emit('rows')}`, true, false);
      run.separateRead = await script('separate-native-getters', emit('state(d)'));
    } else {
      const anchor = (await cad('component.create', { name: 'anchor' })).result.occurrence;
      await cad('assembly.ground', { occurrence: anchor });
      for (const kind of ['revolute', 'slider', 'cylindrical']) {
        const occurrence = (await cad('component.create', { name: kind })).result.occurrence;
        const axes = kind === 'cylindrical' ? ['rotation', 'slide'] : [kind === 'slider' ? 'slide' : 'rotation'];
        const limits = Object.fromEntries(axes.map(a => [a, spec(a)]));
        const made = await cad('joint.' + kind, { name: kind, occurrenceOne: occurrence, occurrenceTwo: anchor, point: 'origin', axis: 'Z', limits, confirm: true });
        const joint = { token: made.result.joint.token };
        const created = await script('native-created-' + kind, emit('state(d)'));
        const check = (actual, edited) => {
          for (const a of axes) {
            const expected = a === 'rotation' ? [-Math.PI/2, Math.PI/2, edited ? Math.PI/12 : Math.PI/18] : [-1, 2, edited ? .3 : .2];
            for (const [i,p] of ['minimumValue','maximumValue','restValue'].entries()) assert.ok(Math.abs(actual[a][p]-expected[i]) < 1e-10, `${kind} ${a} ${p}: ${actual[a][p]}`);
            for (const p of ['isMinimumValueEnabled','isMaximumValueEnabled','isRestValueEnabled']) assert.equal(actual[a][p],true);
          }
        };
        check(created.joints.at(-1).limits, false);
        await cad('joint.limits', { joint, confirm: true, limits: Object.fromEntries(axes.map(a => [a,{restValue:a==='rotation'?'15 deg':'3 mm',isRestValueEnabled:true}])) });
        const edited = await script('native-edited-' + kind, emit('state(d)')); check(edited.joints.at(-1).limits,true);
        let rejected = 0;
        for (const a of axes) for (const v of a==='rotation'?['-91 deg','91 deg']:['-11 mm','21 mm']) {
          await assert.rejects(() => cad('joint.drive',{joint,...(kind==='cylindrical'?{rotation:'20 deg',slide:'5 mm'}:{}),[a]:v}), /outside joint limits/);
          assert.deepEqual(await script('rejection-no-change',emit('state(d)')),edited); rejected++;
        }
        run.cases.push({kind,created,edited,rejected,status:'pass'}); persist();
      }
    }
    run.status = 'pass';
  } finally {
    if (identity && !uncertain) run.cleanup = await script('close-owned-only', `assert doc.close(False)
original = [x for x in app.documents if x.creationId == ${py(baseline.active)}]
if original and app.activeDocument != original[0]: assert original[0].activate()
assert environment()['documents'] == ${py(baseline.documents)}
assert environment()['active'] == ${py(baseline.active)}
assert environment()['workspace'] == ${py(baseline.workspace)}
${emit('environment()')}`,true,false);
    persist();
  }
}
if (!process.argv.includes('--run')) { console.error('Requires exclusive permission and --run'); process.exitCode=2; }
else main().catch(e => { run.status='fail'; run.error=e.stack; persist(); console.error(e); process.exitCode=1; });
