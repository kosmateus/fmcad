import assert from "node:assert/strict";
import type { Document } from "./contracts";
import { number, record } from "./contracts";

function ownedDesign(document: Document): string {
  return `import adsk.core, adsk.fusion, json
from typing import cast
app = adsk.core.Application.get()
matches = [d for d in app.documents if d.creationId == ${JSON.stringify(document.creationId)}]
assert len(matches) == 1, 'Owned creationId is unavailable or ambiguous'
doc = matches[0]
assert doc.name == ${JSON.stringify(document.name)} and not doc.isSaved and doc.dataFile is None
design = cast(adsk.fusion.Design, doc.products.itemByProductType('DesignProductType'))`;
}

const descriptor = `def describe(info: adsk.fusion.ThreadInfo) -> dict[str, object]:
    return dict(threadType=info.threadType, designation=info.threadDesignation,
                threadClass=info.threadClass, nominalSize=info.threadSize,
                internal=info.isInternal, tapered=info.isTapered, rightHanded=info.isRightHanded,
                majorDiameterMm=info.majorDiameter * 10.0,
                minorDiameterMm=info.minorDiameter * 10.0,
                pitchDiameterMm=info.pitchDiameter * 10.0, pitchMm=info.threadPitch * 10.0)`;

/** Lookup the installed native table, not the separate curated thread.catalog. */
export function threadInfoBody(document: Document): string {
  return `${ownedDesign(document)}
${descriptor}
info = adsk.fusion.ThreadInfo.create(False, False, 'ISO Metric profile', 'M10x1.5', '6g', True)
assert info is not None and info.isValid
thread_result = describe(info)`;
}

export function threadReadbackBody(
  document: Document,
  bodyToken: string,
  featureToken: string,
): string {
  return `${ownedDesign(document)}
${descriptor}
computed = design.computeAll()
bodies = [cast(adsk.fusion.BRepBody, item) for item in design.findEntityByToken(${JSON.stringify(bodyToken)}) if item.objectType == adsk.fusion.BRepBody.classType() and item.isValid]
threads = [cast(adsk.fusion.ThreadFeature, item) for item in design.findEntityByToken(${JSON.stringify(featureToken)}) if item.objectType == adsk.fusion.ThreadFeature.classType() and item.isValid]
assert len(bodies) == 1 and len(threads) == 1, 'Exact owned body/feature tokens must resolve uniquely'
body, thread = bodies[0], threads[0]
surfaces = [body.faces.item(i).geometry for i in range(body.faces.count)]
cylinders = [cast(adsk.core.Cylinder, surface) for surface in surfaces if surface.objectType == adsk.core.Cylinder.classType()]
assert len(cylinders) == 1, 'Cosmetic thread must retain one smooth cylinder'
box = body.boundingBox
accuracy = cast(adsk.fusion.CalculationAccuracy, adsk.fusion.CalculationAccuracy.HighCalculationAccuracy)
thread_result = dict(creationId=doc.creationId, descriptor=describe(thread.threadInfo),
                    computed=computed, modeled=thread.isModeled, modeledIsBoolean=type(thread.isModeled) is bool,
                    suppressed=thread.isSuppressed, solid=body.isSolid,
                    radiusMm=cylinders[0].radius * 10.0, heightMm=(box.maxPoint.z-box.minPoint.z)*10.0,
                    faceCount=body.faces.count, edgeCount=body.edges.count,
                    surfaceTypes=sorted(surface.objectType for surface in surfaces),
                    bodyVolumeMm3=body.volume * 1000.0,
                    physicalVolumeMm3=body.getPhysicalProperties(accuracy).volume * 1000.0)`;
}

export function threadMajorRadiusMm(value: unknown): number {
  const info = record(value);
  assert.equal(info["threadType"], "ISO Metric profile");
  assert.equal(info["designation"], "M10x1.5");
  assert.equal(info["threadClass"], "6g");
  assert.equal(Number(info["nominalSize"]), 10);
  assert.equal(info["internal"], false);
  assert.equal(info["tapered"], false);
  assert.equal(info["rightHanded"], true);
  assert.ok(Math.abs(number(info["pitchMm"]) - 1.5) <= 1e-9);
  const major = number(info["majorDiameterMm"]);
  const pitch = number(info["pitchDiameterMm"]);
  const minor = number(info["minorDiameterMm"]);
  assert.ok(10 > major && major > pitch && pitch > minor && minor > 0);
  return major / 2;
}

export function assertCosmeticCylinder(value: unknown, info: unknown): void {
  const result = record(value);
  assert.deepEqual(result["descriptor"], info);
  assert.equal(result["computed"], true);
  assert.equal(result["modeledIsBoolean"], true);
  assert.equal(result["modeled"], false);
  assert.equal(result["suppressed"], false);
  assert.equal(result["solid"], true);
  assert.equal(result["faceCount"], 3);
  assert.equal(result["edgeCount"], 2);
  assert.deepEqual(result["surfaceTypes"], [
    "adsk::core::Cylinder",
    "adsk::core::Plane",
    "adsk::core::Plane",
  ]);
  const radius = threadMajorRadiusMm(info);
  assert.ok(Math.abs(number(result["radiusMm"]) - radius) <= 1e-9);
  assert.ok(Math.abs(number(result["heightMm"]) - 20) <= 1e-9);
  const expected = Math.PI * radius ** 2 * 20;
  for (const key of ["bodyVolumeMm3", "physicalVolumeMm3"])
    assert.ok(Math.abs(number(result[key]) - expected) <= 0.001, key);
}
