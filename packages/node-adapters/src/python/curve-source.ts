import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
interface CurveRow {
  value: unknown;
  index?: number;
  line?: number;
}
export interface CurveCsvPort {
  (raw: string, delimiter?: unknown): readonly CurveRow[];
}
function property(value: unknown, key: string): unknown {
  if (value !== null && typeof value === "object" && key in value)
    return Reflect.get(value, key);
  return undefined;
}
/** Host source adaptation is synchronous: validation/preparation never submits work. */
export function createCurveSource(csv: CurveCsvPort) {
  return {
    read(data: Readonly<Record<string, unknown>>) {
      const baseDir = data["baseDir"];
      if (
        baseDir !== undefined &&
        (typeof baseDir !== "string" || !path.isAbsolute(baseDir))
      )
        throw new Error("baseDir must be absolute");
      let raw: string,
        rows: readonly CurveRow[],
        filename: string | null = null;
      if ("source" in data) {
        if (typeof data["source"] !== "string" || !data["source"].trim())
          throw new Error("source must be a path");
        filename = path.resolve(baseDir || process.cwd(), data["source"]);
        if (fs.statSync(filename).size > 16 * 1024 * 1024)
          throw new Error("Source exceeds 16 MiB budget");
        raw = fs.readFileSync(filename, "utf8");
        const format =
          data["format"] || path.extname(filename).slice(1).toLowerCase();
        if (format === "csv") rows = csv(raw, data["delimiter"]);
        else if (format === "json") {
          let value: unknown = JSON.parse(raw);
          if (data["recordsPath"]) {
            if (typeof data["recordsPath"] !== "string")
              throw new Error("recordsPath must be text");
            for (const key of data["recordsPath"].split("."))
              value = property(value, key);
          }
          if (!Array.isArray(value))
            throw new Error("JSON recordsPath must select an array");
          rows = value.map((value: unknown, index: number) => ({
            value,
            index,
          }));
        } else throw new Error("format must be csv or json");
      } else {
        if (!Array.isArray(data["records"]))
          throw new Error("records must be an array");
        if (
          ["format", "recordsPath", "delimiter", "baseDir"].some(
            (k) => k in data,
          )
        )
          throw new Error("File options require source");
        raw = JSON.stringify(data["records"]);
        rows = data["records"].map((value: unknown, index: number) => ({
          value,
          index,
        }));
      }
      return {
        rows,
        filename,
        sha256: createHash("sha256").update(raw).digest("hex"),
      };
    },
  };
}
