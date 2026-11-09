import type { DataImportFiles } from "../../ports/data-import-files";
import { sha256 as hash } from "../../domain/engineering/sha256";
import {
  object,
  fields,
  text,
  stable,
  at,
  csv,
  MODEL_EXTENSIONS,
} from "./import-values";

interface ImportSchema extends Record<string, unknown> {
  recordsPath?: string;
  columns?: Record<string, string>;
  defaults?: Record<string, unknown>;
  values?: Record<string, Record<string, unknown>>;
  delimiter?: unknown;
}
export interface ImportProvenance extends Record<string, unknown> {
  path: string | null;
  sha256: string;
  revision: unknown;
  pathHost: string;
}
export interface LoadedImport {
  rows: {
    row: Record<string, unknown>;
    provenance: ImportProvenance & { row: number };
  }[];
  provenance: ImportProvenance;
  baseDir: string;
}
/** Parse and hash a single source snapshot before any model mutation. */
export function load(
  data: Record<string, unknown>,
  limit: number,
  files: DataImportFiles,
): LoadedImport {
  if ((data["source"] !== undefined) === (data["records"] !== undefined))
    throw new Error("Provide exactly one of source or records");
  if (
    data["baseDir"] !== undefined &&
    (typeof data["baseDir"] !== "string" || !files.isAbsolute(data["baseDir"]))
  )
    throw new Error("baseDir must be an absolute CLI-host directory");
  const baseDir = (data["baseDir"] as string | undefined) || files.cwd();
  const schema = (data["schema"] || {}) as ImportSchema;
  fields(
    schema,
    ["recordsPath", "columns", "defaults", "values", "delimiter"],
    "schema",
  );
  if (schema.columns) {
    object(schema.columns, "schema.columns");
    for (const v of Object.values(schema.columns)) text(v, "column path");
  }
  if (schema.defaults) object(schema.defaults, "schema.defaults");
  if (schema.values) {
    object(schema.values, "schema.values");
    for (const v of Object.values(schema.values)) object(v, "schema value map");
  }
  let rows: unknown,
    provenance: ImportProvenance,
    isCsv = false;
  if (data["source"] !== undefined) {
    const file = files.resolve(baseDir, text(data["source"], "source"));
    const stat = files.stat(file);
    if (!stat.regular || stat.size > 32 * 1024 * 1024)
      throw new Error("Source must be a regular file <=32 MiB");
    const snapshot = files.snapshot(file);
    provenance = {
      path: file,
      sha256: snapshot.sha256,
      revision: data["revision"] ?? null,
      pathHost: "CLI",
    };
    isCsv = files.extension(file) === ".csv";
    if (isCsv) {
      if (schema.recordsPath)
        throw new Error("recordsPath applies only to JSON");
      rows = csv(snapshot.text, schema.delimiter);
    } else {
      if (files.extension(file) !== ".json")
        throw new Error("Source must be CSV or JSON");
      const value = JSON.parse(snapshot.text.replace(/^\uFEFF/, ""));
      rows = schema.recordsPath ? at(value, schema.recordsPath) : value;
    }
  } else {
    rows = data["records"];
    provenance = {
      path: null,
      sha256: hash(stable(rows)!),
      revision: data["revision"] ?? null,
      pathHost: "inline",
    };
  }
  if (!Array.isArray(rows) || !rows.length || rows.length > limit)
    throw new Error(`records must contain 1..${limit} entries`);
  const mappedRows = (rows as unknown[]).map((entry, i) => {
    const csvEntry = entry as { value: Record<string, string>; line: number };
    const source = object(isCsv ? csvEntry.value : entry, `row ${i + 1}`);
    const row = schema.columns
      ? Object.fromEntries(
          Object.entries(schema.columns)
            .map(([k, v]) => [k, at(source, v)])
            .filter(([, v]) => v !== undefined),
        )
      : { ...source };
    if (isCsv)
      for (const [key, value] of Object.entries(row)) {
        if (value === "") {
          if (key !== "unit") delete row[key];
          continue;
        }
        if (
          [
            "quantity",
            "purchaseQuantity",
            "contents",
            "placement",
            "model",
            "material",
            "motionMembership",
            "functionalGroups",
            "allocation",
            "mass",
            "derivation",
          ].includes(key)
        ) {
          try {
            row[key] = JSON.parse(value as string);
          } catch {
            throw new Error(`row ${csvEntry.line}: ${key} must be JSON`);
          }
        }
      }
    const mapped: Record<string, unknown> = { ...schema.defaults, ...row };
    for (const [key, values] of Object.entries(schema.values || {})) {
      if (mapped[key] === undefined) continue;
      if (!Object.hasOwn(values, String(mapped[key])))
        throw new Error(`row ${i + 1}: unmapped ${key} value`);
      mapped[key] = values[String(mapped[key])];
    }
    // Relationship lists may arrive as a single source label or a ';'-delimited
    // string; normalize to the canonical text array so functional-group and
    // motion-membership labels stay separate from the rigid physical parent.
    for (const key of ["functionalGroups", "motionMembership"]) {
      if (typeof mapped[key] === "string")
        mapped[key] = mapped[key]
          .split(";")
          .map((v) => v.trim())
          .filter(Boolean);
    }
    // A scalar model column maps to a geometry file path. Wrap it into the
    // canonical model descriptor (envelope). Non-path placeholders (e.g. a
    // "to be created in CAD" note) carry no model and are dropped, not errors.
    if (typeof mapped["model"] === "string") {
      const file = mapped["model"].trim();
      if (MODEL_EXTENSIONS.includes(files.extension(file)))
        mapped["model"] = { path: file, representation: "envelope" };
      else delete mapped["model"];
    }
    return {
      row: mapped,
      provenance: { ...provenance, row: isCsv ? csvEntry.line : i + 1 },
    };
  });
  return { rows: mappedRows, provenance, baseDir };
}
