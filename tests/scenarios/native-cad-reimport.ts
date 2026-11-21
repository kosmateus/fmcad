import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ScenarioSession } from "./runner";
import { record, number } from "./contracts";
import { emit, program } from "./programs";
import {
  nativeModelingHarness,
  nativeResultUncertain,
  values,
} from "./native-modeling-support";
const literal = (value: unknown): string =>
  JSON.stringify(JSON.stringify(value));
interface OwnedExport {
  fusionPath: string;
  wslMapping: string;
  owned: true;
}
type Cad = (
  operation: string,
  data?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** The opt-in retained checkpoint child remains bound to its original parent request. */
export async function nativeCadReimport(
  session: ScenarioSession,
  harness: Awaited<ReturnType<typeof nativeModelingHarness>>,
  files: readonly OwnedExport[],
  cad: Cad,
): Promise<void> {
  for (const file of files.filter((file) => file.owned)) {
    const before = await harness.state();
    const verified = await cad("export.verify", {
      path: file.fusionPath,
      reimport: true,
      ref: "root",
      lengthTolerance: "0.001 mm",
    });
    assert.equal(verified["reimported"], true);
    assert.equal(record(verified["comparison"])["withinTolerance"], true);
    assert.deepEqual(
      (await harness.state())["documents"],
      before["documents"],
      "Verification must close only its temporary import",
    );
  }
  const source = await cad("audit");
  const sourceVolume = number(
    (await cad("measure.volume", { ref: "root", units: "mm3" }))["value"],
  );
  const sourceBounds = await cad("measure.bounds", {
    ref: "root",
    units: "mm",
  });
  const file = files[0];
  assert.ok(file, "Owned reimport requires its verified export");
  assert.ok(
    file.owned && fs.existsSync(file.wslMapping),
    "Owned export must be present through its actual local mapping",
  );
  const assetDirectory = path.resolve(__dirname, "../../../assets/cad");
  const bundle = [
    "core.py",
    ...fs
      .readdirSync(assetDirectory)
      .filter((file) => file.endsWith(".py") && file !== "core.py")
      .sort(),
  ]
    .map((file) => fs.readFileSync(path.join(assetDirectory, file), "utf8"))
    .join("\n\n");
  await harness.guard();
  const result = await session.execute(
    "native-cad-owned-reimport",
    (requestId) => {
      const receipt = session.prepareChildReceipt(
        "native-cad-owned-reimport",
        requestId,
        file.wslMapping,
      );
      return (
        bundle +
        "\n\n" +
        program(`import adsk.core, adsk.fusion, json, os, math
app = adsk.core.Application.get()
parent_id = ${JSON.stringify(session.document.creationId)}
parent_name = ${JSON.stringify(session.document.name)}
parents = [d for d in app.documents if d.creationId == parent_id and d.name == parent_name]
assert len(parents) == 1 and parents[0] == app.activeDocument and not parents[0].isSaved and parents[0].dataFile is None
parent = parents[0]
def inventory():
    return sorted([dict(name=d.name, creationId=d.creationId, saved=d.isSaved, modified=d.isModified, fileId=d.dataFile.id if d.dataFile else None) for d in app.documents], key=lambda d: d['creationId'])
before = inventory()
input_path = ${JSON.stringify(file.fusionPath)}
receipt_path = ${JSON.stringify(receipt)}
assert not os.path.lexists(receipt_path), 'Never overwrite an existing child receipt'
assert os.path.isfile(input_path) and not os.path.islink(input_path), 'Owned export must be a regular file'
opened = CadContext(parent_name, 'root').call('checkpoint.open', dict(path=input_path))
target = opened['document']
assert target['creationId'] != parent_id
assert not any(d['creationId'] == target['creationId'] for d in before)
added = [d for d in app.documents if d.creationId not in [old['creationId'] for old in before]]
assert len(added) == 1 and added[0].creationId == target['creationId'] and added[0].name == target['name']
child = added[0]
assert not child.isSaved and child.dataFile is None and app.activeDocument == child
receipt_value = dict(requestId=${JSON.stringify(requestId)}, clientId=${JSON.stringify(session.report.owner.clientId)}, parentCreationId=parent_id, path=input_path, creationId=child.creationId, name=child.name, saved=False, fileId=None)
def write_receipt(status):
    receipt_value['status'] = status
    temp = receipt_path + '.new'
    assert not os.path.lexists(temp), 'Never overwrite a child receipt staging file'
    with open(temp, 'x', encoding='utf-8') as stream:
        json.dump(receipt_value, stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, receipt_path)
write_receipt('created')
uncertain = False
def unknown(value):
    if isinstance(value, dict):
        if value.get('status') in ('unknown', 'started', 'running', 'pending') or value.get('executionOutcome') == 'unknown' or value.get('completed') is False:
            return True
        return any(unknown(item) for item in value.values())
    return isinstance(value, list) and any(unknown(item) for item in value)
def call(operation, data):
    nonlocal uncertain
    matches = [d for d in app.documents if d.name == receipt_value['name']]
    assert len(matches) == 1 and matches[0].creationId == receipt_value['creationId'] and matches[0] == app.activeDocument and not matches[0].isSaved and matches[0].dataFile is None, 'Owned identity changed before child readback'
    assert [d for d in inventory() if d['creationId'] != child.creationId] == before, 'Non-child documents changed during imported readback'
    value = CadContext(child.name, 'root').call(operation, data)
    if unknown(value):
        uncertain = True
        raise RuntimeError('Indeterminate child mutation; retain its original receipt and never replay')
    return value
readback = dict(document=target)
try:
    imported = call('audit', {})
    readback['audit'] = imported
    assert imported['counts'] == json.loads(${literal(source["counts"])}), 'Native reimport preserves definition/history counts'
    bounds = call('measure.bounds', dict(ref='root', units='mm'))
    readback['bounds'] = bounds
    assert bounds['units'] == 'mm' and len(bounds['size']) == 3
    expected_size = json.loads(${literal(sourceBounds["size"])})
    assert len(expected_size) == 3
    for actual, expected in zip(bounds['size'], expected_size):
        assert math.isfinite(actual) and abs(actual - expected) <= 0.001
    measured = call('measure.volume', dict(ref='root', units='mm3'))
    readback['volume'] = measured
    assert measured['units'] == 'mm3'
    expected_volume = ${JSON.stringify(sourceVolume)}
    assert math.isfinite(measured['value']) and abs(measured['value'] - expected_volume) <= max(0.001, expected_volume * 0.00001)
    assert imported['issues'] == []
finally:
    if not uncertain:
        matches = [d for d in app.documents if d.creationId == receipt_value['creationId'] and d.name == receipt_value['name']]
        assert len(matches) == 1 and matches[0] == child and not child.isSaved and child.dataFile is None, 'Owned child identity changed; leave open'
        assert [d for d in inventory() if d['creationId'] != child.creationId] == before, 'Non-child documents changed; leave open'
        assert child.close(False), 'Owned close failed'
        assert not any(d.creationId == receipt_value['creationId'] for d in app.documents)
        assert inventory() == before, 'Verification must close only its temporary import'
        assert parent.activate() and app.activeDocument.creationId == parent_id
        write_receipt('closed')
${emit("dict(creationId=parent_id, result=readback)")}`)
      );
    },
  );
  if (nativeResultUncertain(result))
    session.deferCleanup(
      "Checkpoint child result is unknown/pending; inspect the original receipt",
    );
  const readback = record(result["result"]),
    target = record(readback["document"]);
  assert.ok(
    !values(harness.baseline["documents"])
      .map(record)
      .some((d) => d["creationId"] === target["creationId"]),
  );
  assert.notEqual(target["creationId"], session.document.creationId);
  assert.deepEqual(
    record(readback["audit"])["counts"],
    source["counts"],
    "Native reimport preserves definition/history counts",
  );
  assert.deepEqual(record(readback["audit"])["issues"], []);
  await harness.guard();
}
