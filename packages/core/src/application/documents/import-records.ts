import type { DataImportFiles } from "../../ports/data-import-files";
import { sha256 as hash } from "../../domain/engineering/sha256";
import {
  fields,
  text,
  stable,
  transform,
  multiply,
  inverse,
  quantity,
  lengthUnits,
  angleUnits,
} from "./import-values";
import { evidence, mass, model } from "./import-evidence";
import { load } from "./import-source";
import { catalogPlan } from "./import-catalog";

interface ImportRecordInput extends Record<string, unknown> {
  expectedRevision?: unknown;
  revision?: unknown;
  onExisting?: unknown;
  target: string;
  occurrencePolicy: string;
  occurrences?: unknown[];
  childrenPolicy?: string;
  datumMap: unknown;
  impacts: Record<string, unknown>;
  acceptInvalidation?: unknown;
  mass?: unknown;
  model?: unknown;
  baseDir?: string;
  tolerance?: unknown;
  angleTolerance?: unknown;
}
/** Family record preparation runs synchronously and completes before mutation dispatch. */
export function prepareRecords(
  operation: string,
  input: Record<string, unknown>,
  limit: number,
  unresolved: unknown[],
  warnings: string[],
  files: DataImportFiles,
) {
  const data = input as ImportRecordInput;
  let result: Record<string, unknown>, provenance: Record<string, unknown>;
  if (operation === "cots.replace") {
    text(data.expectedRevision, "expectedRevision");
    if (data.revision === data.expectedRevision)
      throw new Error("Replacement revision must differ from expectedRevision");
    if (data.onExisting !== undefined)
      throw new Error(
        "cots.replace uses expectedRevision and occurrencePolicy, not onExisting",
      );
    for (const key of ["source", "records", "schema", "observed"])
      if (data[key] !== undefined)
        throw new Error(`cots.replace does not accept ${key}`);
    text(data.target, "target");
    if (!["all", "selected"].includes(data.occurrencePolicy))
      throw new Error("occurrencePolicy must be all|selected");
    if (
      data.occurrencePolicy === "selected" &&
      (!Array.isArray(data.occurrences) || !data.occurrences.length)
    )
      throw new Error("selected requires occurrences");
    if (data.occurrencePolicy === "all" && data.occurrences !== undefined)
      throw new Error("all excludes occurrences");
    if (
      data.childrenPolicy !== undefined &&
      !["error", "preserve"].includes(data.childrenPolicy)
    )
      throw new Error("childrenPolicy must be error|preserve");
    if (!Array.isArray(data.datumMap) || !data.datumMap.length)
      throw new Error(
        "Complete datumMap required; optical normal alone cannot locate a replacement",
      );
    const datums = (data.datumMap as Record<string, unknown>[]).map((d) => {
      fields(d, ["name", "old", "new"], "datumMap");
      text(d["name"], "datum name");
      const old = transform(d["old"]),
        next = transform(d["new"]);
      if (old.frame !== "component" || next.frame !== "component")
        throw new Error("Datum frames must be component");
      return {
        name: d["name"],
        old,
        new: next,
        delta: multiply(old.matrix, inverse(next.matrix)),
      };
    });
    if (new Set(datums.map((d) => d["name"])).size !== datums.length)
      throw new Error("Duplicate datum name");
    if (
      datums.some((d) =>
        d["delta"].some((v, i) => Math.abs(v - datums[0]!.delta[i]!) > 1e-8),
      )
    )
      throw new Error(
        "Datum map inconsistent: a single rigid replacement cannot preserve all interfaces",
      );
    fields(
      data.impacts,
      ["matingParts", "routings", "refs", "mass"],
      "impacts",
    );
    for (const key of ["matingParts", "routings", "refs", "mass"]) {
      const v = data.impacts[key];
      fields(v, ["status", "items", "source"], `impacts.${key}`);
      if (
        !["known", "unknown"].some((status) => status === v["status"]) ||
        !Array.isArray(v["items"])
      )
        throw new Error("Impacts require status known|unknown and items array");
      if (v["status"] === "unknown")
        unresolved.push({ id: data.target, field: key, status: "unknown" });
    }
    if (data.acceptInvalidation !== true)
      throw new Error(
        "Replacement requires acceptInvalidation:true; mating/routing/ref/mass checks will be invalidated",
      );
    if (data.mass === undefined)
      unresolved.push({
        id: data.target,
        field: "replacement.mass",
        status: "unknown",
      });
    const replacement = model(
      data.model,
      data.baseDir || files.cwd(),
      unresolved,
      data.target,
      files,
    );
    if (!replacement) throw new Error("Replacement model required");
    result = {
      target: data.target,
      model: replacement,
      datums,
      delta: datums[0]!.delta,
      occurrencePolicy: data.occurrencePolicy,
      occurrences: data.occurrences || [],
      childrenPolicy: data.childrenPolicy || "error",
      impacts: data.impacts,
      mass: mass(data.mass, unresolved, data.target),
    };
    provenance = {
      sha256: hash(stable(result)!),
      revision: data.revision,
      pathHost: "CLI",
    };
  } else {
    const loaded = load(data, limit, files);
    provenance = loaded.provenance;
    if (operation.startsWith("catalog."))
      result = catalogPlan(data, loaded, limit, unresolved, files);
    else if (operation === "param.import") {
      const parameters = loaded.rows.map(({ row: r, provenance }, i) => {
        fields(
          r,
          [
            "name",
            "expression",
            "unit",
            "comment",
            "status",
            "source",
            "derivation",
          ],
          `parameter ${i + 1}`,
        );
        if (
          typeof r["name"] !== "string" ||
          !/^[A-Za-z_][A-Za-z_0-9]*$/.test(r["name"])
        )
          throw new Error("Invalid parameter name");
        if (typeof r["unit"] !== "string" || r["unit"].toLowerCase() === "text")
          throw new Error(
            "Explicit numeric parameter unit required (empty string for unitless)",
          );
        let expression = r["expression"];
        if (typeof expression === "number" && Number.isFinite(expression))
          expression = `${expression}${r["unit"] ? " " + r["unit"] : ""}`;
        if (
          typeof expression === "string" &&
          r["unit"] &&
          /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(
            expression.trim(),
          )
        )
          expression = `${expression.trim()} ${r["unit"]}`;
        text(expression, "parameter expression");
        if (r["comment"] !== undefined && typeof r["comment"] !== "string")
          throw new Error("comment must be text");
        return {
          name: r["name"],
          expression,
          unit: r["unit"],
          ...(r["comment"] !== undefined ? { comment: r["comment"] } : {}),
          provenance: evidence(r, provenance, unresolved, r["name"]),
        };
      });
      if (new Set(parameters.map((r) => r["name"])).size !== parameters.length)
        throw new Error("Duplicate parameter name");
      result = { parameters };
      warnings.push(
        "Fusion validates expression grammar, units and the complete dependency graph before param.apply writes; offline preflight does not evaluate Fusion expressions.",
      );
    } else {
      const poses = loaded.rows.map(({ row: r, provenance }) => {
        fields(
          r,
          ["id", "occurrence", "placement", "status", "source", "derivation"],
          "placement row",
        );
        const id = text(r["id"], "placement.id");
        if (r["occurrence"] === undefined)
          throw new Error(
            "placement.occurrence required (exact full path or ref)",
          );
        const p = r["placement"] == null ? null : transform(r["placement"]);
        if (!p)
          unresolved.push({
            id: r["id"],
            field: "placement",
            status: "unknown",
          });
        if (p?.frame === "component")
          throw new Error(
            "Occurrence placement frame must be parent/root/{occurrence:REF}",
          );
        return {
          id: r["id"],
          occurrence: r["occurrence"],
          transform: p,
          provenance: evidence(r, provenance, unresolved, id),
        };
      });
      if (new Set(poses.map((p) => p.id)).size !== poses.length)
        throw new Error("Duplicate placement ID");
      const tolerance = quantity(
        data.tolerance || "0.001 mm",
        lengthUnits,
        "tolerance",
      );
      const angleTolerance = quantity(
        data.angleTolerance || "0.01 deg",
        angleUnits,
        "angleTolerance",
      );
      if (tolerance < 0 || angleTolerance < 0)
        throw new Error("Tolerances must be nonnegative");
      result = { poses, tolerance, angleTolerance };
    }
  }
  return { result, provenance };
}
