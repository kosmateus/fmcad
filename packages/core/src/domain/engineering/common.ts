import { sha256 } from "./sha256";

export type SourceStatus = "CONFIRMED" | "ESTIMATED" | "OPEN";
export interface Source {
  field: string;
  status: SourceStatus;
  source: string | null;
  uncertainty: { minus: number; plus: number } | null;
}
export interface Budget {
  maxEvaluations: number;
  timeMs: number;
}
export interface EvaluationClock {
  now(): number;
}
export interface EngineeringRuntime {
  clock: EvaluationClock;
}
export interface Context {
  sources: Source[];
  missing: string[];
  limitations: string[];
  evaluations: number;
  budget: Budget;
  runtime: EngineeringRuntime;
  tick(count?: number): void;
}
// Logical default: identical inputs/budgets are independent of CPU speed and load.
// An application may supply a monotonic elapsed-time clock explicitly.
export const deterministicRuntime: EngineeringRuntime = {
  clock: { now: () => 0 },
};
export interface Unit {
  dimension: string;
  scale: number;
  offset: number;
}
export const units: Record<string, Unit> = {};
function unit(dimension: string, entries: [string, number, number?][]): void {
  for (const [name, scale, offset = 0] of entries)
    units[name] = { dimension, scale, offset };
}
unit("length", [
  ["m", 1],
  ["mm", 0.001],
  ["cm", 0.01],
  ["in", 0.0254],
]);
unit("area", [
  ["m2", 1],
  ["mm2", 1e-6],
  ["cm2", 1e-4],
]);
unit("volume", [
  ["m3", 1],
  ["mL", 1e-6],
  ["L", 0.001],
  ["mm3", 1e-9],
]);
unit("angle", [
  ["rad", 1],
  ["deg", Math.PI / 180],
]);
unit("force", [
  ["N", 1],
  ["mN", 0.001],
  ["kN", 1000],
]);
unit("stiffness", [
  ["N/m", 1],
  ["N/mm", 1000],
]);
unit("energy", [
  ["J", 1],
  ["mJ", 0.001],
]);
unit("torque", [
  ["N*m", 1],
  ["N*mm", 0.001],
]);
unit("momentOfInertia", [
  ["kg*m2", 1],
  ["kg*mm2", 1e-6],
  ["g*mm2", 1e-9],
  ["g*cm2", 1e-7],
]);
unit("angularVelocity", [
  ["rad/s", 1],
  ["rpm", Math.PI / 30],
  ["deg/s", Math.PI / 180],
]);
unit("angularAcceleration", [
  ["rad/s2", 1],
  ["rpm/s", Math.PI / 30],
  ["deg/s2", Math.PI / 180],
]);
unit("pressureDifference", [
  ["Pa", 1],
  ["kPa", 1000],
  ["bar", 1e5],
]);
unit("pressureGauge", [
  ["Pa(g)", 1],
  ["kPa(g)", 1000],
  ["bar(g)", 1e5],
]);
unit("pressureAbsolute", [
  ["Pa(a)", 1],
  ["kPa(a)", 1000],
  ["bar(a)", 1e5],
]);
unit("mass", [
  ["kg", 1],
  ["g", 0.001],
]);
unit("density", [
  ["kg/m3", 1],
  ["g/cm3", 1000],
]);
unit("acceleration", [["m/s2", 1]]);
unit("time", [
  ["s", 1],
  ["ms", 0.001],
]);
unit("flow", [
  ["m3/s", 1],
  ["mL/s", 1e-6],
  ["L/min", 1 / 60000],
]);
unit("temperature", [
  ["K", 1],
  ["degC", 1, 273.15],
]);
unit("temperatureDelta", [
  ["deltaK", 1],
  ["deltaC", 1],
]);
unit("expansion", [
  ["1/K", 1],
  ["ppm/K", 1e-6],
]);
unit("power", [
  ["W", 1],
  ["mW", 0.001],
]);
unit("conductivity", [["W/(m*K)", 1]]);
unit("thermalResistance", [["K/W", 1]]);
unit("convection", [["W/(m2*K)", 1]]);
unit("viscosity", [
  ["Pa*s", 1],
  ["mPa*s", 0.001],
]);
unit("scalar", [
  ["1", 1],
  ["%", 0.01],
]);

export function object<const K extends string>(
  value: unknown,
  allowed: readonly K[],
  label = "input",
  required: readonly K[] = [],
): asserts value is Record<K, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (!(allowed as readonly string[]).includes(key))
      throw new Error(`${label}: unknown field ${key}`);
  for (const key of required)
    if (!Object.hasOwn(value, key)) throw new Error(`${label}: missing ${key}`);
}
export function number(
  value: unknown,
  label: string,
  min = -Infinity,
  max = Infinity,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${label} must be finite in [${min}, ${max}]`);
  return value;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048)
    throw new Error(`${label} must be a nonempty string (max 2048 characters)`);
  return value;
}
export function assertText(
  value: unknown,
  label: string,
): asserts value is string {
  text(value, label);
}
export function list(
  value: unknown,
  label: string,
  min = 1,
  max = 256,
): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new Error(`${label} requires ${min}..${max} entries`);
  return value as unknown[];
}
export function scalar(
  value: unknown,
  dimension: string,
  label: string,
): number {
  if (typeof value !== "string")
    throw new Error(`${label} requires a unit-bearing string`);
  const match = value
    .trim()
    .match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s+(.+)$/i);
  const u = match && units[match[2]!];
  if (!u || u.dimension !== dimension)
    throw new Error(`${label} requires ${dimension} units`);
  const result = number(Number(match![1]) * u.scale + u.offset, label);
  if (
    (dimension === "temperature" || dimension === "pressureAbsolute") &&
    result < 0
  )
    throw new Error(`${label} is below absolute zero`);
  return result;
}
export function quantity(
  value: unknown,
  dimension: string,
  label: string,
  context: Context,
  min = -Infinity,
  max = Infinity,
): number | null {
  if (value === undefined || value === null) {
    context.missing.push(label);
    return null;
  }
  let raw: unknown = value;
  let status: SourceStatus = "ESTIMATED",
    source: string | null = null,
    uncertainty: Source["uncertainty"] = null;
  if (typeof value === "object") {
    object(value, ["value", "status", "source", "uncertainty"], label, [
      "value",
      "status",
      "source",
    ]);
    raw = value.value;
    if (
      value.status !== "CONFIRMED" &&
      value.status !== "ESTIMATED" &&
      value.status !== "OPEN"
    )
      throw new Error(`${label}: invalid source status`);
    status = value.status;
    source = text(value.source, `${label}.source`);
    if (value.uncertainty !== undefined) {
      object(value.uncertainty, ["minus", "plus"], `${label}.uncertainty`, [
        "minus",
        "plus",
      ]);
      const dim =
        dimension === "temperature"
          ? "temperatureDelta"
          : dimension.startsWith("pressure")
            ? "pressureDifference"
            : dimension;
      uncertainty = {
        minus: scalar(value.uncertainty.minus, dim, label),
        plus: scalar(value.uncertainty.plus, dim, label),
      };
      number(uncertainty.minus, label, 0);
      number(uncertainty.plus, label, 0);
    }
  }
  context.sources.push({ field: label, status, source, uncertainty });
  if (status === "OPEN" || raw === null) {
    context.missing.push(label);
    return null;
  }
  return number(scalar(raw, dimension, label), label, min, max);
}
export function output(
  value: number | null,
  unit: string,
): { value: number; unit: string } | null {
  if (value === null) return null;
  number(value, "calculated output");
  return { value, unit };
}
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  return value;
}
export function hash(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)));
}
export const commonFields = [
  "schemaVersion",
  "identity",
  "frame",
  "assumptions",
  "budget",
] as const;
export function context(
  data: unknown,
  fields: string[],
  runtime: EngineeringRuntime = deterministicRuntime,
): Context {
  object(data, [...commonFields, ...fields], "input", [
    "schemaVersion",
    "identity",
    "frame",
    "assumptions",
  ]);
  if (data["schemaVersion"] !== 1) throw new Error("schemaVersion must be 1");
  object(data["identity"], ["model", "revision"], "identity", [
    "model",
    "revision",
  ]);
  text(data["identity"].model, "identity.model");
  text(data["identity"].revision, "identity.revision");
  text(data["frame"], "frame");
  list(data["assumptions"], "assumptions", 1, 64).forEach((x) =>
    text(x, "assumption"),
  );
  const raw = data["budget"] || { maxEvaluations: 4096, timeMs: 2000 };
  object(raw, ["maxEvaluations", "timeMs"], "budget", [
    "maxEvaluations",
    "timeMs",
  ]);
  const budget = {
    maxEvaluations: number(raw.maxEvaluations, "maxEvaluations", 1, 100000),
    timeMs: number(raw.timeMs, "timeMs", 1, 10000),
  };
  if (!Number.isInteger(budget.maxEvaluations))
    throw new Error("maxEvaluations must be integer");
  const start = number(runtime.clock.now(), "engineering clock");
  let previous = start;
  return {
    sources: [],
    missing: [],
    limitations: [],
    evaluations: 0,
    budget,
    runtime,
    tick(count = 1) {
      number(count, "evaluation count", 0);
      this.evaluations += count;
      const now = number(runtime.clock.now(), "engineering clock");
      if (now < previous)
        throw new Error("Engineering clock must be monotonic");
      previous = now;
      const elapsed = now - start;
      if (this.evaluations > budget.maxEvaluations || elapsed > budget.timeMs)
        throw new Error("Engineering evaluation budget exceeded");
    },
  };
}
export function envelope<T>(
  operation: string,
  data: { frame: unknown; identity: unknown; assumptions: unknown },
  c: Context,
  result: T,
  status = "notEvaluated",
) {
  c.tick(0);
  if (c.missing.length && status !== "fail" && status !== "blocked")
    status = "unknown";
  return {
    success: !["fail", "blocked"].includes(status),
    status,
    operation,
    documentIdentity: null,
    result,
    created: [] as string[],
    affected: [] as string[],
    units: "SI",
    frame: data.frame,
    associativity: "snapshot",
    warnings: c.missing.map((field) => `Missing data: ${field}`),
    method: "local-analytic-v1",
    limitations: [
      "Nominal calculations; source uncertainty is recorded, not a statistical confidence claim.",
      ...c.limitations,
    ],
    provenance: {
      identity: data.identity,
      sources: c.sources,
      status:
        c.sources.some((s) => s.status === "OPEN") || c.missing.length
          ? "OPEN"
          : c.sources.some((s) => s.status === "ESTIMATED")
            ? "ESTIMATED"
            : "DERIVED",
      assumptions: data.assumptions,
      uncertaintyStatus: c.sources.some((s) => !s.uncertainty)
        ? "notEvaluated"
        : "provided",
      cacheIdentity: hash({
        operation,
        method: "local-analytic-v1",
        input: data,
      }),
      cacheUsed: false,
    },
    work: { completed: c.evaluations, budget: c.budget },
  };
}
