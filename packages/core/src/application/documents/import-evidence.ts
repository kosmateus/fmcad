import type { DataImportFiles } from "../../ports/data-import-files";
import { fields, text, MODEL_EXTENSIONS } from "./import-values";

/** Evidence records preserve uncertainty; geometry files retain their exact host path and digest. */
export function evidence(
  row: Record<string, unknown>,
  provenance: Record<string, unknown>,
  unresolved: unknown[],
  label: string,
) {
  if (
    row["status"] !== undefined &&
    !["CONFIRMED", "ESTIMATED", "OPEN", "DERIVED"].some(
      (status) => status === row["status"],
    )
  )
    throw new Error(`${label}: invalid source status`);
  if (row["status"] === undefined || row["status"] === "OPEN")
    unresolved.push({ id: label, field: "status", status: "unknown" });
  if (row["status"] === "DERIVED" && !row["derivation"])
    throw new Error(`${label}: DERIVED requires derivation evidence`);
  if (!row["source"] && !provenance["path"])
    unresolved.push({ id: label, field: "source", status: "unknown" });
  return {
    ...provenance,
    status: row["status"] || "OPEN",
    source: row["source"] ?? null,
    derivation: row["derivation"] ?? null,
  };
}

export function mass(value: unknown, unresolved: unknown[], id: string) {
  if (value === undefined || value === null) return null;
  fields(
    value,
    ["value", "unit", "status", "source", "derivation"],
    `${id}.mass`,
  );
  if (
    typeof value["value"] !== "number" ||
    !Number.isFinite(value["value"]) ||
    value["value"] <= 0 ||
    !["kg", "g", "lb"].some((unit) => unit === value["unit"])
  )
    throw new Error(
      `${id}.mass requires positive finite value and kg|g|lb unit`,
    );
  evidence(value, {}, unresolved, `${id}.mass`);
  return value;
}

export function model(
  v: unknown,
  baseDir: string,
  unresolved: unknown[],
  id: string,
  files: DataImportFiles,
) {
  if (v == null) return null;
  fields(
    v,
    [
      "path",
      "representation",
      "source",
      "status",
      "revision",
      "sha256",
      "includedItems",
    ],
    `${id}.model`,
  );
  if (
    v["includedItems"] !== undefined &&
    (!Array.isArray(v["includedItems"]) ||
      v["includedItems"].some((id) => typeof id !== "string" || !id) ||
      new Set(v["includedItems"]).size !== v["includedItems"].length)
  )
    throw new Error("model.includedItems must be an array of unique item IDs");
  if (
    !["vendor", "envelope"].some(
      (representation) => representation === v["representation"],
    )
  )
    throw new Error(`${id}.model requires representation vendor|envelope`);
  const file = files.resolve(baseDir, text(v["path"], "model.path"));
  if (!MODEL_EXTENSIONS.includes(files.extension(file)))
    throw new Error(`${id}: unsupported model format`);
  if (!files.exists(file)) {
    unresolved.push({ id, field: "model", status: "unknown", path: file });
    return { ...v, path: file, missing: true };
  }
  if (!files.stat(file).regular)
    throw new Error(`${id}: model must be a regular file`);
  const digest = files.snapshot(file).sha256;
  if (v["sha256"] !== undefined && v["sha256"] !== digest)
    throw new Error(`${id}: model SHA256 mismatch`);
  evidence(v, {}, unresolved, id + ".model");
  if (!v["source"])
    unresolved.push({ id, field: "model.source", status: "unknown" });
  return { ...v, path: file, sha256: digest };
}
