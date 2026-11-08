import type { DataImportFiles } from "../../ports/data-import-files";
export interface ImportPlan {
  version: number;
  operation: string;
  owner: unknown;
  revision: unknown;
  expectedRevision: unknown;
  onExisting: string;
  digest: string;
  provenance: unknown;
  result: Record<string, unknown>;
  unresolved: unknown[];
  warnings: string[];
  maxItems: number;
  budgetMs: number;
  observed?: unknown;
}
export interface ImportPreparation {
  inputs(operation: string): readonly string[] | null;
  fields(value: unknown, allowed: readonly string[], label: string): void;
  text(value: unknown, label: string): unknown;
  integer(value: unknown, label: string, minimum?: number): unknown;
  digest(value: unknown): string;
  records(
    operation: string,
    data: Record<string, unknown>,
    limit: number,
    unresolved: unknown[],
    warnings: string[],
    files: DataImportFiles,
  ): { result: Record<string, unknown>; provenance: unknown };
}
/** Shared preparation envelope; source/model reads go only through the supplied snapshot port. */
export function prepareDataImport(
  operation: string,
  data: Record<string, unknown>,
  files: DataImportFiles,
  rules: ImportPreparation,
): ImportPlan | null {
  const inputs = rules.inputs(operation);
  if (!inputs) return null;
  rules.fields(data, inputs, operation);
  if (data["version"] !== 1)
    throw new Error("Unsupported data adapter version; expected 1");
  const limit = data["maxItems"] ?? 10000;
  rules.integer(limit, "maxItems", 1);
  if (Number(limit) > 100000) throw new Error("maxItems exceeds 100000");
  const budgetMs = data["budgetMs"] ?? 120000;
  rules.integer(budgetMs, "budgetMs", 1);
  if (
    data["baseDir"] !== undefined &&
    (typeof data["baseDir"] !== "string" || !files.isAbsolute(data["baseDir"]))
  )
    throw new Error("baseDir must be an absolute CLI-host directory");
  const check = operation.endsWith(".check");
  if (
    data["inspectModel"] !== undefined &&
    (typeof data["inspectModel"] !== "boolean" || !check)
  )
    throw new Error("inspectModel is a boolean for check operations only");
  if (data["observed"] !== undefined && (!check || data["inspectModel"]))
    throw new Error("observed is for offline checks only");
  const policy = data["onExisting"] ?? "error";
  if (policy !== "error" && policy !== "reuse" && policy !== "update")
    throw new Error("onExisting must be error|reuse|update");
  if (!check) {
    rules.text(data["owner"], "owner");
    rules.text(data["revision"], "revision");
  }
  if (check && data["inspectModel"] === true)
    rules.text(data["owner"], "owner for live check");
  if (policy === "update")
    rules.text(data["expectedRevision"], "expectedRevision");
  const unresolved: unknown[] = [],
    warnings: string[] = [];
  const { result, provenance } = rules.records(
    operation,
    data,
    Number(limit),
    unresolved,
    warnings,
    files,
  );
  return {
    version: 1,
    operation,
    owner: data["owner"] ?? null,
    revision: data["revision"] ?? null,
    expectedRevision: data["expectedRevision"] ?? null,
    onExisting: policy,
    digest: rules.digest({
      operation,
      result,
      owner: data["owner"],
      revision: data["revision"],
    }),
    provenance,
    result,
    unresolved,
    warnings,
    maxItems: Number(limit),
    budgetMs: Number(budgetMs),
    ...(data["observed"] !== undefined ? { observed: data["observed"] } : {}),
  };
}
type Row = Record<string, unknown>;
function object(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Row;
}
function rows(value: unknown, label: string): Row[] {
  if (!Array.isArray(value)) throw new Error(label + " required");
  return value as Row[];
}
export interface ImportTransform {
  matrix: number[];
  frame: unknown;
}
export interface ImportGeometry {
  transform(value: unknown): ImportTransform;
  multiply(a: number[], b: number[]): number[];
  inverse(a: number[]): number[];
  stable(value: unknown): string | undefined;
}
/** Supplied observations remain historical evidence, never live model acceptance. */
export function offlineImportResult(
  plan: ImportPlan,
  preview: boolean,
  geometry: ImportGeometry,
): Row {
  const differences = [
    ...((plan.result["differences"] as Row[] | undefined) ?? []),
  ];
  if (plan.operation === "placement.check" && !plan.observed)
    differences.push({
      status: "unknown",
      reason: "No observed poses supplied; placement was not measured",
    });
  if (plan.observed !== undefined) {
    const observed = object(plan.observed, "observed");
    if (plan.operation === "catalog.check") {
      const actual = rows(observed["instances"], "observed.instances"),
        byId = new Map(actual.map((row) => [row["id"], row]));
      if (byId.size !== actual.length) throw new Error("Duplicate observed ID");
      for (const row of rows(plan.result["instances"], "instances")) {
        const current = byId.get(row["id"]);
        if (
          !current ||
          current["item"] !== row["item"] ||
          current["parent"] !== row["parent"]
        )
          differences.push({
            id: row["id"],
            expected: { item: row["item"], parent: row["parent"] },
            actual: current ?? null,
            status: "fail",
          });
        byId.delete(row["id"]);
      }
      for (const row of byId.values())
        differences.push({
          id: row["id"],
          expected: null,
          actual: row,
          status: "fail",
        });
    } else if (plan.operation === "placement.check") {
      const poses = rows(observed["poses"], "observed.poses"),
        actual = new Map(poses.map((row) => [row["id"], row]));
      if (actual.size !== poses.length)
        throw new Error("Duplicate observed pose ID");
      for (const row of rows(plan.result["poses"], "poses")) {
        const current = actual.get(row["id"]),
          transform = row["transform"] as ImportTransform | null;
        if (!current || !transform) {
          differences.push({
            id: row["id"],
            status: "unknown",
            reason: "Missing pose",
          });
          continue;
        }
        const t = geometry.transform(current["transform"]);
        if (geometry.stable(t.frame) !== geometry.stable(transform.frame))
          throw new Error(
            "Observed pose frame mismatch; supply transforms in the same explicit frame",
          );
        const delta = geometry.multiply(
          geometry.inverse(transform.matrix),
          t.matrix,
        );
        const distance = Math.hypot(delta[3]!, delta[7]!, delta[11]!);
        const angle = Math.acos(
          Math.max(
            -1,
            Math.min(1, (delta[0]! + delta[5]! + delta[10]! - 1) / 2),
          ),
        );
        differences.push({
          id: row["id"],
          status:
            distance <= Number(plan.result["tolerance"]) &&
            angle <= Number(plan.result["angleTolerance"])
              ? "pass"
              : "fail",
          distance,
          units: "cm",
          angle,
          angleUnits: "rad",
          frame: t.frame,
        });
      }
    }
  }
  const failed = differences.some((row) => row["status"] === "fail"),
    unknown =
      plan.unresolved.length ||
      differences.some((row) => row["status"] === "unknown");
  return {
    success: !failed,
    status: failed
      ? "fail"
      : unknown
        ? "unknown"
        : preview
          ? "notEvaluated"
          : "pass",
    operation: plan.operation,
    documentIdentity: null,
    result: { ...plan.result, differences },
    created: [],
    affected: [],
    units: plan.operation === "param.import" ? "per parameter" : "cm",
    frame: "explicit per row",
    associativity:
      plan.operation === "param.import"
        ? "nativeExpression"
        : plan.operation.startsWith("placement.")
          ? "snapshot"
          : "importedReference",
    provenance: plan.provenance,
    warnings: plan.warnings,
    unresolved: plan.unresolved,
    method: "CLI data preflight",
    limitations: [
      "No current Fusion model inspected; data consistency is not model acceptance.",
      ...(plan.observed
        ? [
            "Supplied observed evidence is historical; identity/revision are caller evidence, not revalidated.",
          ]
        : []),
    ],
    plan,
    mutation: false,
    modelValidated: false,
  };
}
