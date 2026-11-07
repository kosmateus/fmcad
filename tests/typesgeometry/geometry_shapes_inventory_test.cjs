const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const fixture = require('./fixtures/geometry_shapes_inventory.json');
const { planCadScript } = require(path.join(root, 'src/dist/core/application/cad/prepare.js'));
const { catalog } = require(path.join(root, 'src/catalog'));
const { cadBundleUnits, prepareCadBundle } = require(path.join(root, 'packages/node-adapters/dist/python/bundle.js'));
const { pythonLiteral } = require(path.join(root, 'packages/node-adapters/dist/python/artifact.js'));

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('full shape request retains every source unit and prepared offset', () => {
  const plan = planCadScript(fixture.operation, fixture.data, fixture.context,
    catalog[fixture.operation], pythonLiteral);
  assert.equal(plan.profile, fixture.profile);

  const sourceUnits = cadBundleUnits(root, plan.profile);
  assert.deepEqual(sourceUnits.map((unit) => unit.id), fixture.sourceUnitIds);
  const artifact = prepareCadBundle(root, plan.wrapper,
    { request: plan.request, context: plan.context }, plan.profile);
  const preparedIDs = [...fixture.sourceUnitIds, fixture.wrapperUnitId];
  assert.equal(sourceUnits.length, fixture.sourceUnitCount);
  assert.equal(artifact.units.length, fixture.preparedUnitCount);
  assert.deepEqual(artifact.units.map((unit) => unit.id), preparedIDs);
  assert.deepEqual(artifact.sourceMap.map((entry) => entry.unitId), preparedIDs);
  assert.equal(artifact.sourceMap.length, fixture.preparedUnitCount);

  for (const [index, entry] of artifact.sourceMap.entries()) {
    const unit = artifact.units[index];
    const sourceLines = unit.source.split(/\r?\n/).length;
    assert.equal(entry.sourceStartLine, 1, unit.id);
    assert.equal(entry.generatedEndLine - entry.generatedStartLine + 1, sourceLines, unit.id);
    assert.equal(entry.generatedStartLine,
      index === 0 ? fixture.firstGeneratedLine :
        artifact.sourceMap[index - 1].generatedEndLine + fixture.separatorLines + 1,
      unit.id);
  }

  const changed = new Set(fixture.changedUnitIds);
  const contentRows = (predicate) => artifact.units
    .filter((unit) => predicate(unit.id))
    .map((unit) => [unit.id, unit.filename, unit.role, sha256(unit.source)]);
  assert.equal(sha256(JSON.stringify(contentRows((id) => !changed.has(id)))),
    fixture.unchangedUnitContentSha256);
  assert.equal(sha256(JSON.stringify(contentRows((id) => changed.has(id)))),
    fixture.afterChangedUnitContentSha256);
  assert.equal(artifact.artifactHash, fixture.afterArtifactHash);
  assert.equal(artifact.bytes.length, fixture.afterArtifactBytes);
});
