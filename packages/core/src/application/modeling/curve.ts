import type { OperationDeclaration } from "../../catalog";
const common = {
  schemaVersion: "Required 1.",
  sketch: "Existing native sketch reference.",
  frame: "Required sketch: coordinates in the selected sketch frame.",
  tolerance: "Positive length, default 0.001 mm; closure and stroke tolerance.",
  maxSamples:
    "Integer 2..10000, default 2000. Bounds input and native strokes.",
  budgetMs:
    "Integer 1..120000, default 10000; cooperative budget, cannot interrupt SDK calls.",
};
const source = {
  source: "CLI-host CSV/JSON path, exclusive with records.",
  records: "Inline sample records.",
  baseDir:
    "Absolute source directory; default CLI cwd. Never parsed in Fusion.",
  format: "csv or json; inferred from source suffix if omitted.",
  columns:
    "Exact mapping {x,y}, {x,y,z}, or {angle,radius}; optional loop/status. Values are source field names or array indexes.",
  recordsPath: "Optional dotted JSON path to record array.",
  delimiter: "CSV delimiter, default comma.",
  units:
    "Required {length:mm|cm|m|in|ft, angle?:deg|rad}. Unit-bearing cells override column units.",
  plane:
    "Required sketchXY: XY/polar are local; XYZ must have z within tolerance (no implicit projection).",
  closed:
    "Required boolean. Closed data must already repeat the first endpoint within tolerance; never adds a missing chord.",
  winding:
    "preserve (default), cw, ccw. Orientation requests require closed loops.",
  interpolation:
    "lines (default) or spline. Native interpolating fit, not smoothing.",
  revision: "Optional source revision retained in provenance.",
};
export const descriptors: Record<string, OperationDeclaration> = {};
for (const op of [
  "sketch.profile-file",
  "curve.fit",
  "curve.inspect",
  "curve.offset",
]) {
  const fitting = ["sketch.profile-file", "curve.fit"].includes(op);
  descriptors[op] = {
    summary: `${op}: bounded native curve operation with explicit sample provenance (GM07 v1).`,
    required: [
      "schemaVersion",
      "sketch",
      "frame",
      ...(fitting ? ["columns", "units", "plane", "closed"] : ["entities"]),
      ...(op === "curve.offset" ? ["distance", "side"] : []),
    ],
    readOnly: op === "curve.inspect",
    curve: true,
    inputs: {
      ...common,
      ...(fitting
        ? source
        : { entities: "Nonempty native sketch curve refs, in flow order." }),
      ...(op === "curve.offset"
        ? {
            distance:
              "Positive length expression retained in native offset parameter.",
            side: "left or right relative to SDK flow; circles/ellipses flow counterclockwise.",
          }
        : {}),
    },
    example: fitting
      ? {
          schemaVersion: 1,
          sketch: "Profile",
          frame: "sketch",
          plane: "sketchXY",
          columns: { x: "x", y: "y" },
          units: { length: "mm" },
          closed: false,
          records: [
            { x: 0, y: 0 },
            { x: 10, y: 5 },
          ],
        }
      : {
          schemaVersion: 1,
          sketch: "Profile",
          frame: "sketch",
          entities: [{ token: "curve-token" }],
          ...(op === "curve.offset" ? { distance: "1 mm", side: "right" } : {}),
        },
    limitations: [
      "See docs/GM07.md. Imported coordinates are importedReference; offsets retain native expressions/references. Native acceptance pending; sampled checks do not certify global regularity.",
    ],
  };
}
descriptors["curve.offset-edit"] = {
  summary:
    "curve.offset-edit: edit the native offset dimension expression of an existing curve offset (GM07 v1).",
  required: ["schemaVersion", "frame", "parameter", "distance"],
  readOnly: false,
  curve: true,
  inputs: {
    schemaVersion: "Required 1.",
    frame: "Required sketch.",
    parameter:
      'Native offset dimension parameter name (e.g. d203) or {token,name,kind:"parameter"} reference.',
    distance:
      "New length expression for the native offset dimension; the sign preserves the offset side.",
  },
  example: {
    schemaVersion: 1,
    frame: "sketch",
    parameter: "d203",
    distance: "8 mm",
  },
  limitations: [
    "See docs/GM07.md. The native offset dimension must still exist; a deleted dimension cannot be edited. The expression is retained by Fusion and can reference other parameters.",
  ],
};

export interface CurveRow {
  value: unknown;
  index?: number;
  line?: number;
}
export interface CurveSource {
  read(data: Readonly<Record<string, unknown>>): {
    rows: readonly CurveRow[];
    filename: string | null;
    sha256: string;
  };
}
type Point = [number, number, number];
interface Sample {
  point: Point;
  originalPoint: Point;
  source: { line?: number; index?: number; status: string };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function oneOf(options: readonly string[], value: unknown): value is string {
  return typeof value === "string" && options.includes(value);
}
const lengths: Record<string, number> = {
  mm: 0.1,
  cm: 1,
  m: 100,
  in: 2.54,
  ft: 30.48,
};
export function quantity(
  value: unknown,
  unit?: unknown,
  angle = false,
): number {
  const table: Record<string, number> = angle
    ? { deg: Math.PI / 180, rad: 1 }
    : lengths;
  const match = String(value)
    .trim()
    .match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)$/i);
  const selected = match && (match[2] || unit);
  const factor =
    typeof selected === "string" && Object.hasOwn(table, selected)
      ? table[selected]
      : undefined;
  if (
    !match ||
    factor === undefined ||
    !Number.isFinite(Number(match[1]) * factor)
  )
    throw new Error("Sample requires finite compatible units");
  return Number(match[1]) * factor;
}
export function validate(operation: string, value: unknown): void {
  if (!Object.hasOwn(descriptors, operation)) return;
  if (!record(value)) throw new Error("Curve input must be an object");
  const data = value;
  if (data["schemaVersion"] !== 1 || data["frame"] !== "sketch")
    throw new Error("GM07 requires schemaVersion:1 and frame:sketch");
  for (const [key, fallback, min, max] of [
    ["maxSamples", 2000, 2, 10000],
    ["budgetMs", 10000, 1, 120000],
  ] as const) {
    const v = data[key] ?? fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
      throw new Error(`${key} outside ${min}..${max}`);
  }
  if (!(quantity(data["tolerance"] ?? "0.001 mm") > 0))
    throw new Error("tolerance must be positive");
  if (operation === "curve.offset") {
    if (!oneOf(["left", "right"], data["side"]))
      throw new Error("side must be left or right");
    if (typeof data["distance"] !== "string" || !data["distance"].trim())
      throw new Error("distance must be a length expression");
  }
  if (operation === "curve.offset-edit") {
    if (typeof data["distance"] !== "string" || !data["distance"].trim())
      throw new Error("distance must be a length expression");
    const parameter = data["parameter"];
    if (
      !(typeof parameter === "string" && parameter.trim()) &&
      !(record(parameter) && (parameter["token"] || parameter["name"]))
    )
      throw new Error("parameter must be a name or a parameter reference");
  }
  if (
    ["curve.offset", "curve.inspect"].includes(operation) &&
    (!Array.isArray(data["entities"]) || !data["entities"].length)
  )
    throw new Error("entities must be nonempty");
}
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("Insufficient loop samples");
  return value;
}
export function createCurvePreparation(source: CurveSource) {
  return function prepare(
    operation: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    validate(operation, data);
    if (!["sketch.profile-file", "curve.fit"].includes(operation)) return data;
    if (Object.hasOwn(data, "source") === Object.hasOwn(data, "records"))
      throw new Error("Supply source or records exclusively");
    if (data["plane"] !== "sketchXY")
      throw new Error(
        "Declare plane:sketchXY; spatial projection is not implicit",
      );
    if (typeof data["closed"] !== "boolean")
      throw new Error("closed must be boolean");
    if (
      !oneOf(["preserve", "cw", "ccw"], data["winding"] ?? "preserve") ||
      (!data["closed"] && data["winding"] && data["winding"] !== "preserve")
    )
      throw new Error("Winding requires closed loops");
    if (!oneOf(["lines", "spline"], data["interpolation"] ?? "lines"))
      throw new Error("interpolation must be lines or spline");
    const cols = data["columns"];
    if (!record(cols)) throw new Error("columns must be an object");
    const axes = Object.keys(cols)
      .filter((k) => !["loop", "status"].includes(k))
      .sort()
      .join(",");
    if (
      !["x,y", "x,y,z", "angle,radius"].includes(axes) ||
      Object.values(cols).some(
        (v) =>
          !(
            (typeof v === "string" && v.length) ||
            (typeof v === "number" && Number.isInteger(v) && v >= 0)
          ),
      )
    )
      throw new Error("columns must explicitly map XY, XYZ, or angle/radius");
    const units = data["units"];
    if (
      !record(units) ||
      typeof units["length"] !== "string" ||
      !Object.hasOwn(lengths, units["length"]) ||
      Object.keys(units).some((k) => !["length", "angle"].includes(k)) ||
      (axes === "angle,radius" && !oneOf(["deg", "rad"], units["angle"]))
    )
      throw new Error("Invalid column units");
    const { rows, filename, sha256 } = source.read(data);
    const max = data["maxSamples"] ?? 2000,
      tol = quantity(data["tolerance"] ?? "0.001 mm");
    if (typeof max !== "number" || rows.length < 2 || rows.length > max)
      throw new Error("Sample count exceeds bounds");
    const loops = new Map<string, Sample[]>();
    for (const row of rows) {
      const cell = (key: string): unknown => {
        const column = cols[key];
        if (
          row.value === null ||
          row.value === undefined ||
          (typeof column !== "string" && typeof column !== "number")
        )
          return undefined;
        const target: object = Object(row.value);
        return Reflect.get(target, column);
      };
      let point: Point;
      if (axes === "angle,radius") {
        const a = quantity(cell("angle"), units["angle"], true),
          r = quantity(cell("radius"), units["length"]);
        if (r < 0) throw new Error("Polar radius cannot be negative");
        point = [r * Math.cos(a), r * Math.sin(a), 0];
      } else
        point = [
          quantity(cell("x"), units["length"]),
          quantity(cell("y"), units["length"]),
          "z" in cols ? quantity(cell("z"), units["length"]) : 0,
        ];
      if (Math.abs(point[2]) > tol)
        throw new Error("XYZ samples are not on declared sketchXY plane");
      point[2] = 0;
      const id = "loop" in cols ? String(cell("loop") ?? "") : "0";
      if (!id) throw new Error("Missing loop ID");
      const status = "status" in cols ? cell("status") : "OPEN";
      if (!oneOf(["CONFIRMED", "ESTIMATED", "OPEN", "DERIVED"], status))
        throw new Error("Invalid source status");
      const samples = loops.get(id) ?? [];
      if (!loops.has(id)) loops.set(id, samples);
      const location = row.line
        ? { line: row.line }
        : row.index === undefined
          ? {}
          : { index: row.index };
      samples.push({
        point,
        originalPoint: [...point],
        source: { ...location, status },
      });
    }
    const geometry: Record<string, unknown>[] = [],
      sampleMap: Record<string, unknown>[] = [],
      preparedLoops: Record<string, unknown>[] = [];
    for (const [id, samples] of loops) {
      if (samples.length < (data["closed"] ? 4 : 2))
        throw new Error("Insufficient loop samples");
      const dist = (a: Point, b: Point) =>
        Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      for (let i = 1; i < samples.length; i++)
        if (dist(at(samples, i - 1).point, at(samples, i).point) <= 1e-12)
          throw new Error("Consecutive duplicate samples");
      const first = at(samples, 0),
        last = at(samples, samples.length - 1);
      const gap = dist(first.point, last.point);
      if (data["closed"] && gap > tol)
        throw new Error(
          "Closed input has missing endpoints; refusing to add a chord",
        );
      if (data["closed"]) last.point = [...first.point];
      const area =
        samples
          .slice(1)
          .reduce(
            (s, v, i) =>
              s +
              at(samples, i).point[0] * v.point[1] -
              v.point[0] * at(samples, i).point[1],
            0,
          ) / 2;
      if (data["winding"] && data["winding"] !== "preserve") {
        if (Math.abs(area) < 1e-15)
          throw new Error("Winding undefined for zero-area loop");
        if (area > 0 !== (data["winding"] === "ccw")) samples.reverse();
      }
      const points = samples.map((s) => s.point.map((v) => `${v} cm`)),
        start = geometry.length;
      if (data["interpolation"] === "spline")
        geometry.push({ type: "spline", points });
      else
        for (let i = 1; i < points.length; i++)
          geometry.push({
            type: "line",
            start: at(points, i - 1),
            end: at(points, i),
          });
      preparedLoops.push({
        id,
        geometryIndexes: Array.from(
          { length: geometry.length - start },
          (_, i) => start + i,
        ),
        closed: data["closed"],
        closureGap: gap,
      });
      samples.forEach((s, i) =>
        sampleMap.push({
          loop: id,
          sample: i,
          point: s.originalPoint,
          ...s.source,
        }),
      );
    }
    return {
      schemaVersion: 1,
      sketch: data["sketch"],
      frame: "sketch",
      tolerance: data["tolerance"] ?? "0.001 mm",
      maxSamples: max,
      budgetMs: data["budgetMs"] ?? 10000,
      geometry,
      loops: preparedLoops,
      sampleMap,
      provenance: {
        path: filename,
        sha256,
        revision: data["revision"] ?? null,
        columns: cols,
        units,
        status: "DERIVED",
      },
    };
  };
}
