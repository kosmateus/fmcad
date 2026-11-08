import type {
  Model as DrawingModel,
  Source,
  CheckRow,
} from "../../../core/src/application/drawing/types";
import * as defaultFs from "node:fs";
import * as path from "node:path";
import { publishDirectory } from "./drawing-output";
import type {
  DrawingRequest,
  DrawingReport,
  DrawingExportPorts,
} from "./drawing-export";
interface Model extends DrawingModel {
  scene: { sha256: string };
  sourceMap: unknown;
}
export interface DrawingCheckPorts extends Pick<
  DrawingExportPorts,
  "familyDescriptors" | "envelope" | "outputDirectory"
> {
  readPackage(
    file: unknown,
    expected: string,
  ): { report: DrawingReport & { result: Model }; identity: unknown };
  checkRows(model: Model): CheckRow[];
  collectSources(model: Model): Source[];
  aggregateStatus(rows: CheckRow[], sources: Source[]): string;
}
export function createDrawingChecker(
  ports: DrawingCheckPorts,
  fs: typeof defaultFs = defaultFs,
) {
  const {
    familyDescriptors,
    readPackage,
    checkRows,
    aggregateStatus,
    collectSources,
    envelope,
    outputDirectory,
  } = ports;
  const descriptors: Record<string, unknown> = {
    "drawing.check": familyDescriptors["drawing.check"],
  };
  function validate(operation: string, data: DrawingRequest): void {
    if (!descriptors[operation]) return;
    if (data.schemaVersion !== 1)
      throw new Error(operation + " schemaVersion must be 1");
    for (const key of ["package", "out"])
      if (!Object.hasOwn(data, key))
        throw new Error(operation + " requires " + key);
  }

  function execute(operation: string, data: DrawingRequest) {
    validate(operation, data);
    const out = outputDirectory(data.out);
    const { report, identity } = readPackage(data.package, "drawing.package");
    const model = report.result;
    const rows = checkRows(model);
    const sources = collectSources(model);
    const status = aggregateStatus(rows, sources);
    const created = [path.join(out, "report.json")];
    const result = envelope(
      "drawing.check",
      {
        schemaVersion: 1,
        documentIdentity: model.documentIdentity,
        package: identity,
        scene: { sha256: model.scene.sha256 },
        checks: rows,
        statusSummary: status,
        sourceMap: model.sourceMap,
      },
      status,
      [
        "Checks recompute from the stored canonical model; package and scene hashes are verified. A passing check never certifies 3D geometry or manufacturing.",
      ],
      [identity, ...sources],
      created,
    );
    return publishDirectory(out, fs, () => {
      fs.writeFileSync(
        path.join(out, "report.json"),
        JSON.stringify(result, null, 2),
        { flag: "wx" },
      );
      return { ...result, reportPath: path.join(out, "report.json") };
    });
  }

  return { descriptors, validate, execute };
}
