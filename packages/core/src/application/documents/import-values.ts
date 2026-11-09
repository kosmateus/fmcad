// Pure import parsing and explicit-unit transform validation.
export function object(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error(`${label} must be an object`);
  return v as Record<string, unknown>;
}
export function fields(
  v: unknown,
  allowed: readonly string[],
  label: string,
): asserts v is Record<string, unknown> {
  object(v, label);
  const extra = Object.keys(v as Record<string, unknown>).filter(
    (k) => !allowed.includes(k),
  );
  if (extra.length)
    throw new Error(`${label}: unknown fields ${extra.join(", ")}`);
}
export function text(v: unknown, label: string): string {
  if (typeof v !== "string" || !v["trim"]())
    throw new Error(`${label} must be nonempty text`);
  return v;
}
export function integer(v: unknown, label: string, min = 0): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min)
    throw new Error(`${label} must be an integer >= ${min}`);
  return v;
}
export function stable(v: unknown): string | undefined {
  if (Array.isArray(v)) return "[" + v["map"](stable).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) + ":" + stable((v as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
export function at(v: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (a, k) =>
        a && Object.hasOwn(Object(a), k)
          ? (Object(a) as Record<string, unknown>)[k]
          : undefined,
      v,
    );
}

// Strict RFC-4180-style records, including embedded CR/LF and escaped quotes.
export function csv(
  source: string,
  delimiter: unknown = ",",
): { value: Record<string, string>; line: number }[] {
  if (
    typeof delimiter !== "string" ||
    delimiter.length !== 1 ||
    /["\r\n]/.test(delimiter)
  )
    throw new Error("Invalid CSV delimiter");
  source = source.replace(/^\uFEFF/, "");
  const rows: { cells: string[]; line: number }[] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false,
    line = 1,
    start = 1;
  function emit() {
    row.push(cell);
    cell = "";
    closed = false;
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        cell += c;
        if (c === "\n") line++;
      }
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === delimiter) emit();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      emit();
      rows.push({ cells: row, line: start });
      row = [];
      line++;
      start = line;
    } else {
      if (closed || c === '"')
        throw new Error(`Malformed CSV quoting at line ${line}`);
      cell += c;
    }
  }
  if (quoted) throw new Error("Unterminated CSV quoted field");
  if (cell || closed || row.length) {
    emit();
    rows.push({ cells: row, line: start });
  }
  if (!rows.length) throw new Error("CSV has no header");
  const headers = rows.shift()!.cells;
  if (headers.some((h) => !h) || new Set(headers).size !== headers.length)
    throw new Error("CSV headers must be nonempty and unique");
  return rows.map((r) => {
    if (r.cells.length !== headers.length)
      throw new Error(`CSV column count at line ${r.line}`);
    return {
      value: Object.fromEntries(headers.map((h, i) => [h, r.cells[i]!])),
      line: r.line,
    };
  });
}

export const lengthUnits: Record<string, number> = {
  mm: 0.1,
  cm: 1,
  m: 100,
  in: 2.54,
  ft: 30.48,
};
export const angleUnits: Record<string, number> = {
  rad: 1,
  deg: Math.PI / 180,
};
export const MODEL_EXTENSIONS = [
  ".step",
  ".stp",
  ".f3d",
  ".iges",
  ".igs",
  ".sat",
  ".smt",
];
export function quantity(
  v: unknown,
  units: Record<string, number>,
  label: string,
): number {
  const m =
    typeof v === "string" &&
    v["trim"]().match(
      /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([A-Za-z]+)$/i,
    );
  if (
    !m ||
    !Object.hasOwn(units, m[2]!) ||
    !Number.isFinite(Number(m[1]) * units[m[2]!]!)
  )
    throw new Error(
      `${label} requires a finite value with units (${Object.keys(units).join("|")})`,
    );
  return Number(m[1]) * units[m[2]!]!;
}
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function multiply(a: readonly number[], b: readonly number[]): number[] {
  return Array.from({ length: 16 }, (_, i) => {
    const r = Math.floor(i / 4),
      c = i % 4;
    return [0, 1, 2, 3].reduce((s, k) => s + a[r * 4 + k]! * b[k * 4 + c]!, 0);
  });
}
export function inverse(a: readonly number[]): number[] {
  const b = identity();
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) b[r * 4 + c] = a[c * 4 + r]!;
    b[r * 4 + 3] = -[0, 1, 2].reduce(
      (s, c) => s + a[c * 4 + r]! * a[c * 4 + 3]!,
      0,
    );
  }
  return b;
}
export function rigid(m: unknown, label?: string): number[] {
  if (
    !Array.isArray(m) ||
    m.length !== 16 ||
    m.some((x) => typeof x !== "number" || !Number.isFinite(x))
  )
    throw new Error(`${label}: matrix must contain 16 finite numbers`);
  if (
    [12, 13, 14, 15].some((i, j) => Math.abs(m[i] - (j === 3 ? 1 : 0)) > 1e-9)
  )
    throw new Error(`${label}: invalid homogeneous row`);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      const dot = [0, 1, 2].reduce(
        (s, k) => s + m[k * 4 + r] * m[k * 4 + c],
        0,
      );
      if (Math.abs(dot - (r === c ? 1 : 0)) > 1e-9)
        throw new Error(`${label}: scaling/shear is not a rigid transform`);
    }
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[1] * (m[4] * m[10] - m[6] * m[8]) +
    m[2]! * (m[4] * m[9] - m[5] * m[8]);
  if (Math.abs(det - 1) > 1e-9)
    throw new Error(`${label}: reflection/handedness reversal is unsupported`);
  return m as number[];
}
export function transform(v: unknown, label = "transform") {
  fields(v, ["matrix", "unit", "translation", "rotation", "frame"], label);
  if (!["root", "parent", "component"].some((frame) => frame === v["frame"])) {
    fields(v["frame"], ["occurrence", "datum", "component"], `${label}.frame`);
    if (v["frame"]["datum"] !== undefined) {
      text(v["frame"]["datum"], "datum frame name");
      if (
        (v["frame"]["occurrence"] !== undefined) ===
          (v["frame"]["component"] !== undefined) ||
        (v["frame"]["component"] !== undefined &&
          v["frame"]["component"] !== "root")
      )
        throw new Error(
          "Named datum requires occurrence:REF or component:root",
        );
    } else if (
      Object.keys(v["frame"]).length !== 1 ||
      v["frame"]["occurrence"] === undefined
    )
      throw new Error(`${label}.frame requires occurrence:REF`);
  }
  let m: number[];
  if (v["matrix"] !== undefined) {
    if (v["translation"] !== undefined || v["rotation"] !== undefined)
      throw new Error(`${label}: matrix excludes translation/rotation`);
    if (!(
      typeof v["unit"] === "string" && Object.hasOwn(lengthUnits, v["unit"])
    ))
      throw new Error(`${label}: matrix requires explicit length unit`);
    m = [...rigid(v["matrix"], label)];
    for (const i of [3, 7, 11]) m[i] = m[i]! * lengthUnits[v["unit"]]!;
  } else {
    if (v["unit"] !== undefined)
      throw new Error(`${label}: unit is only for matrices`);
    if (!Array.isArray(v["translation"]) || v["translation"].length !== 3)
      throw new Error(
        `${label}: full translation required; lens offset cannot be inferred`,
      );
    if (!Array.isArray(v["rotation"]) || v["rotation"].length !== 9)
      throw new Error(
        `${label}: full 3x3 rotation required; optical normal does not define roll`,
      );
    const raw: unknown[] = identity();
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) raw[r * 4 + c] = v["rotation"][r * 3 + c];
      raw[r * 4 + 3] = quantity(v["translation"][r], lengthUnits, label);
    }
    m = rigid(raw, label);
  }
  return {
    matrix: m,
    frame: v["frame"],
    units: "cm",
    convention: "row-major; column vectors; local-to-frame; parent * local",
  };
}
