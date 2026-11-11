const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

// Full build is intentional and separate: ordinary build:code test runs must
// not fetch definitions. Invoke after npm run build with the explicit switch.
test('installed tarball checks real SDK types offline outside checkout', {skip:process.env.FMCAD_TEST_CHECKER_TARBALL !== '1'}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'fmcad-checker-installed-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const [packed] = JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',directory],{encoding:'utf8',maxBuffer:4*1024*1024}));
  await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({name:'checker-consumer',private:true}));
  execFileSync('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',path.join(directory,packed.filename)],{cwd:directory,encoding:'utf8'});
  const script = `
    const path = require('node:path');
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const base = path.resolve('node_modules/fmcad');
    const {createPythonChecker,preparePythonArtifact} = require(path.join(base,'dist/src/python'));
    const checker = createPythonChecker({typingRoot:path.join(base,'dist/runtime/python/typing'),definitionsRoot:path.join(base,'dist/runtime/python/typing')});
    const source = 'import adsk.core\\np = adsk.core.Point3D.create("bad", 0, 0)\\nprint(p.x)\\nif p is not None:\\n    p.nonexistent()\\nopen("executed", "w").write("BAD")';
    (async()=>{
      const artifact = preparePythonArtifact([{id:'user',filename:'installed.py',role:'user',source}]);
      const result = await checker.check({artifact,context:{kind:'run'}});
      assert.equal(result.status,'failed',JSON.stringify(result));
      for(const rule of ['reportArgumentType','reportOptionalMemberAccess','reportAttributeAccessIssue']) assert.ok(result.diagnostics.some(d=>d.rule===rule && d.filename==='installed.py'));
      assert.ok(!result.diagnostics.some(d=>d.rule==='reportMissingImports'));
      assert.ok(!fs.existsSync('executed'));
      const good = preparePythonArtifact([{id:'good',filename:'guarded.py',role:'user',source:'import adsk.core\\np = adsk.core.Point3D.create(0, 0, 0)\\nif p is not None:\\n    print(p.x)\\nopen("executed", "w").write("BAD")'}]);
      const accepted = await checker.check({artifact:good,context:{kind:'run'}});
      assert.equal(accepted.status,'passed',JSON.stringify(accepted));
      assert.ok(!fs.existsSync('executed'));
      console.log(JSON.stringify({status:result.status,provenance:result.provenance,rules:result.diagnostics.map(d=>d.rule)}));
    })().catch(e=>{console.error(e);process.exitCode=1;});
  `;
  const result = JSON.parse(execFileSync(process.execPath,['-e',script],{cwd:directory,encoding:'utf8',env:{PATH:process.env.PATH,HOME:directory,npm_config_offline:'true',HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1'}}));
  assert.equal(result.provenance.checkerVersion,'1.40.2');
  assert.equal(result.provenance.cache,'disabled');
  t.diagnostic(JSON.stringify(result));
});
