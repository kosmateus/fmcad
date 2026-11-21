import * as defaultFs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { BinaryLike } from "node:crypto";
import {
  OPERATION,
  fail,
  text,
  buildModel,
  checkRows,
  collectSources,
  aggregateStatus,
} from "../../../core/src/application/drawing/model";
import { buildScene } from "../../../core/src/application/drawing/scene";
import { envelope } from "../../../core/src/application/drawing/report";
import type {
  Model,
  DrawingInput,
  Scene,
} from "../../../core/src/application/drawing/types";
import { publishDirectory } from "./drawing-output";

export interface PackageModel extends Model {
  scene: { path: string; sha256: string };
  sourceMap: Scene["semantics"]["sourceMap"];
}
export interface PackageReport extends Record<string, unknown> {
  schemaVersion: number;
  operation: string;
  status: string;
  result: PackageModel;
}
export function digest(data: BinaryLike): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Model preparation is pure; only the exclusively owned directory is cleaned on failure. */
export function createDrawingPackage(
  descriptors: Record<string, unknown>,
  fs: typeof defaultFs = defaultFs,
) {
  function validate(operation: string, data: Record<string, unknown>) {
    if (!descriptors[operation]) return;
    if (data["schemaVersion"] !== 1)
      fail(operation + " schemaVersion must be 1");
    const required =
      operation === "drawing.package"
        ? ["documentIdentity", "sheet", "views", "out"]
        : operation === "drawing.check"
          ? ["package", "out"]
          : ["package", "formats", "out"];
    for (const key of required)
      if (!Object.hasOwn(data, key)) fail(operation + " requires " + key);
  }

  function outputDirectory(value: unknown) {
    const dir = path.resolve(text(value, "out"));
    if (fs.existsSync(dir) || !fs.existsSync(path.dirname(dir)))
      fail("out must be NEW with existing parent");
    return dir;
  }

  function execute(operation: string, data: DrawingInput) {
    validate(operation, data);
    const out = outputDirectory(data["out"]);
    if (data["representation"] === "native") {
      return envelope(
        OPERATION,
        {
          documentIdentity: data.documentIdentity,
          reason:
            "native drawing authoring is not available through the public SDK; no silent replacement.",
          workflow:
            "See docs/DRAWING.md native handoff: create the native drawing in Fusion UI, then compare it against this package report.",
        },
        "blocked",
        [],
        [],
        [],
      );
    }
    if (
      data["representation"] !== undefined &&
      data["representation"] !== "external"
    )
      fail("representation must be external or native");
    const model = buildModel(data);
    const rows = checkRows(model);
    const sources = collectSources(model);
    const status = aggregateStatus(rows, sources);
    const warnings: string[] = [];
    for (const item of model.items)
      if (!model.balloons.some((b) => b.item === item.item))
        warnings.push("Item " + item.item + " has no balloon in any view");
    const scene = buildScene(model);
    const sceneJson = JSON.stringify(scene, null, 2);
    return publishDirectory(out, fs, () => {
      fs.writeFileSync(path.join(out, "scene.json"), sceneJson, { flag: "wx" });
      const report = envelope(
        OPERATION,
        {
          schemaVersion: 1,
          documentIdentity: model.documentIdentity,
          sheet: model.sheet,
          views: model.views,
          dimensions: model.dimensions,
          datums: model.datums,
          controls: model.controls,
          notes: model.notes,
          items: model.items,
          balloons: model.balloons,
          fits: model.fits,
          axisToleranceMm: model.axisToleranceMm,
          checks: rows,
          statusSummary: status,
          sourceMap: scene.semantics.sourceMap,
          scene: {
            path: path.join(out, "scene.json"),
            sha256: digest(sceneJson),
          },
          artifacts: {
            status: "pending",
            instruction:
              'Run drawing export --file {"package":"<report.json>","formats":["svg","pdf","dxf"],"out":"<dir>"}',
          },
          nativeDrawing: {
            status: "blocked",
            reason:
              "SDK gate; external representation was requested or defaulted.",
            manualWorkflow: "docs/DRAWING.md",
          },
        },
        status,
        warnings,
        sources,
        [path.join(out, "scene.json"), path.join(out, "report.json")],
      );
      const reportJson = JSON.stringify(report, null, 2);
      fs.writeFileSync(path.join(out, "report.json"), reportJson, {
        flag: "wx",
      });
      return { ...report, reportPath: path.join(out, "report.json") };
    });
  }

  function readPackage(filename: unknown, expected: string) {
    const resolved = path.resolve(text(filename, "package"));
    const raw = fs.readFileSync(resolved);
    const report = JSON.parse(raw.toString()) as PackageReport;
    if (report.schemaVersion !== 1 || report.operation !== expected)
      fail("Wrong drawing report kind/version");
    const sceneRaw = fs.readFileSync(report.result.scene.path);
    if (digest(sceneRaw) !== report.result.scene.sha256)
      fail("Stale drawing scene: sha256 mismatch");
    const scene = JSON.parse(sceneRaw.toString()) as Scene;
    return { report, identity: { path: resolved, sha256: digest(raw) }, scene };
  }

  return { validate, execute, outputDirectory, readPackage };
}
