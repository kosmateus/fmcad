#!/usr/bin/env node
// Generate only local, new fixture files. Native execution belongs to the live owner.
const fs = require('node:fs');
const path = require('node:path');

function generate(directory) {
  directory = path.resolve(directory);
  if (!fs.statSync(path.dirname(directory)).isDirectory()) throw new Error('Fixture parent must exist');
  fs.mkdirSync(directory); // EEXIST intentionally refuses to overwrite prior evidence.
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const pose = (x = '0 mm', frame = 'parent') => ({ frame, translation: [x, '0 mm', '0 mm'], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
  const envelope = path.join(directory, 'old.step');
  const model = { path: envelope, representation: 'envelope', status: 'ESTIMATED', source: 'Native fixture box export; not vendor geometry' };
  const header = { version: 1, owner: 'GM02_fixture', revision: 'r1', baseDir: directory, budgetMs: 120000 };
  const item = (id, extra = {}) => ({ id, name: id, parent: null, quantity: 1, kind: 'part', status: 'CONFIRMED', source: 'GM02 analytical fixture', placement: pose(), ...extra });
  write('parameters.csv', 'name,value,unit,status,comment\ncsv_width,4,mm,CONFIRMED,fixture\ncsv_count,4,,ESTIMATED,unitless count\n');
  write('param-csv.json', { ...header, source: 'parameters.csv', schema: { columns: { name: 'name', expression: 'value', unit: 'unit', status: 'status', comment: 'comment' } } });
  write('param.json', { ...header, records: [{ name: 'width', expression: '4 mm', unit: 'mm', status: 'CONFIRMED', source: 'fixture' },
    { name: 'double', expression: '2 * width', unit: 'mm', status: 'DERIVED', source: 'fixture', derivation: { inputs: ['width'], rule: '2 * width', inputStatus: 'CONFIRMED' } }] });
  write('param-bad.json', { ...header, records: [{ name: 'must_not_exist', expression: '4 mm', unit: 'mm' }, { name: 'bad', expression: 'missing_parameter * 2', unit: 'mm' }] });
  const records = [item('GM02_Board', { kind: 'pcba', quantity: 2, purchaseQuantity: 2, contents: [{ id: 'GM02_Module', quantity: 4 }], placement: pose('10 mm') }),
    item('GM02_Module', { parent: 'GM02_Board', quantity: 4, kind: 'purchased', allocation: { owner: 'GM02_Board', quantity: 8 }, placement: pose('2 mm'), model }),
    item('GM02_Sensor', { kind: 'purchased', quantity: 2, model, placement: pose('30 mm'), mass: { value: 4, unit: 'g', status: 'CONFIRMED', source: 'analytical fixture' } })];
  const catalog = { ...header, records, bom: [{ id: 'GM02_Module', quantity: 8, basis: 'physical' }, { id: 'GM02_Module', quantity: 8, basis: 'contents' }, { id: 'GM02_Board', quantity: 2, basis: 'purchase' }] };
  write('catalog.json', catalog);
  write('catalog-check.json', { ...catalog, inspectModel: true });
  write('catalog-reuse.json', { ...catalog, onExisting: 'reuse' });
  write('catalog-no-allocation.json', { ...catalog, records: records.map(r => r.id === 'GM02_Module' ? { ...r, allocation: undefined } : r) });
  write('placement.json', { ...header, records: [{ id: 'sensor1', occurrence: 'GM02_Sensor:1', status: 'CONFIRMED', source: 'fixture', placement: pose('40 mm', 'root') },
    { id: 'sensor2', occurrence: 'GM02_Sensor:2', status: 'CONFIRMED', source: 'fixture', placement: pose('50 mm', 'root') }] });
  write('placement-missing-optics.json', { ...header, records: [{ id: 'camera', occurrence: 'GM02_Sensor:1', status: 'OPEN', source: 'Lens roll and offset not specified', placement: null }] });
  const replacement = { ...header, revision: 'r2', expectedRevision: 'r1', target: 'GM02_Sensor', model: { ...model, path: path.join(directory, 'new.step') },
    occurrencePolicy: 'all', datumMap: [{ name: 'mount', old: pose('10 mm', 'component'), new: pose('2 mm', 'component') },
      { name: 'lens', old: pose('20 mm', 'component'), new: pose('12 mm', 'component') }],
    impacts: Object.fromEntries(['matingParts', 'routings', 'refs', 'mass'].map(k => [k, { status: 'unknown', items: [] }])), acceptInvalidation: true };
  write('replace.json', replacement);
  write('replace-board-preserve.json', { ...replacement, target: 'GM02_Board', childrenPolicy: 'preserve', model: { ...replacement.model, includedItems: [] } });
  const baseline = Array.from({ length: 145 }, (_, i) => item(`GM02_Baseline_${i + 1}`, i < 36 ? { model } : {}));
  write('baseline-145-36.json', { ...header, records: baseline, budgetMs: 300000 });
  write('HANDOFF.md', `# GM-02 native handoff (not executed)\n\nAll files are synthetic test data; 145/36 tests scale, not CWG source reconciliation.\nUse the single authorized Generic Methods document, freshly verified empty and editable.\nUse discovered exact --doc, --doc-id and --doc-file-id on every native command.\nNo script here contacts Fusion or saves a document.\n\n1. Create old STEP in that document: fmcad shape box --doc DOC --name GM02_Old --width '4 mm' --depth '5 mm' --height '6 mm'.\n2. Export with fmcad cad export step --doc DOC --path '${envelope}' (root export). Preserve evidence, clear the same authorized document.\n3. Create new box 8 x 5 x 6 mm and export to '${path.join(directory, 'new.step')}'. Preserve evidence, clear again. These are analytical envelopes, never vendor models.\n4. fmcad param import --doc DOC --file '${path.join(directory, 'param.json')}' --json. Inspect width=4 mm, double=8 mm; set width to 5 mm using the existing parameter API and prove double=10 mm. param-bad.json must create neither new parameter. Clear before the catalog case.\n5. fmcad catalog import --doc DOC --file '${path.join(directory, 'catalog.json')}' --json. Inspect 3 definitions, 12 catalog instance paths: 2 boards, 8 allocated modules, 2 sensors. Vendor-import internal occurrences may add raw paths: do not count these as extra purchased modules. Module root X=12 mm. Check imported module volume=120 mm3 per instance.\n6. fmcad catalog check --doc DOC --file '${path.join(directory, 'catalog-check.json')}' --json. Missing board/module mass must remain unknown. catalog-no-allocation.json must refuse before writes. catalog-reuse.json must create no new objects. Modify a pose externally and prove reuse conflicts, then clear/rebuild for later cases.\n7. Confirm the actual returned sensor paths before using placement.json; replace example refs with returned exact refs if native names differ. fmcad placement import --doc DOC --file '${path.join(directory, 'placement.json')}' --json. Inspect root X=40/50 mm and run placement check with the same records plus inspectModel:true. Missing-optics fixture must block, never move to origin. Shared nested module changes require all affected paths.\n8. fmcad cots replace --doc DOC --file '${path.join(directory, 'replace.json')}' --json. For unchanged sensor placement X=30 mm, new occurrence X=38 mm; if step7 ran, X=48/58 mm. Mount and lens world transforms must remain unchanged; new volume=240 mm3; status remains unknown for unmeasured impacts/mass. Old geometry refs and catalog occurrence manifest are explicitly invalidated. Repeat in a fresh case with occurrencePolicy:selected and one exact sensor ref, verify the other sensor unchanged.\n9. Inject a missing STEP and a reflected matrix before import; prove zero mutation. For an SDK failure after creation, preserve partial state, never retry blindly.\n10. Separate scale fixture: clear, then import baseline-145-36.json; inspect 145 IDs and 36 declared imported models, history health, bounds/volume, and full instance map. This is not evidence of the actual CWG baseline contents.\n11. Preserve requested exports/results, clear and verify zero model counts, save the same authorized cloud ID as directed by the live owner. Do not create another cloud file.\n`);
  return { directory, nativeExecuted: false, sourceBaselineReconciled: false };
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('Usage: node tests/data_import-fixtures.js <new-directory>');
  console.log(JSON.stringify(generate(process.argv[2])));
}
module.exports = { generate };
