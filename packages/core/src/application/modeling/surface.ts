import type { OperationDeclaration } from "../../catalog";
function entries(value: unknown): [string, unknown][] {
  const boxed: object = Object(value);
  return Object.entries(boxed);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
// GM08 schema owner. Native model variants reuse the model feature implementation.
const common = {
  schemaVersion: "Required 1.",
  frame: "Required component; native refs in the selected component only.",
  representation:
    "native (default); unsupported installed SDK returns blocked, never substitutes geometry.",
  name: "Optional unique feature name; collisions fail.",
  onExisting: "error only (default).",
  protected:
    "Optional body/face/edge refs. Conservative whole-body exclusion for modifying operations.",
  maxItems: "Integer 1..10000, default 1000.",
  budgetMs: "Integer 1..120000, default 10000; cooperative only.",
};
const schemas = {
  patch: {
    boundary:
      "Profile ref or existing path descriptor {kind:path,curves,chain:none}; closed boundary required.",
    interior: "Optional curves/points/path descriptors to interpolate.",
    continuity:
      "G0 (default), G1, G2; G1/G2 require BRep boundary, never silently applied to sketch curves.",
    weight: "Positive numeric continuity weight, default 0.5.",
    reverse: "Flip continuity direction; boolean.",
  },
  stitch: {
    bodies: "Nonempty open surface body refs.",
    tolerance: "Required positive length expression.",
    expectSolid: "Optional boolean; verify actual resulting bodies.",
  },
  trim: {
    tool: "Surface body, face, construction plane, or sketch curve ref.",
    mode: "plan or apply. Planning starts native partial compute and always cancels it; not read-only.",
    plan: "Required for apply: exact returned plan containing document identity, cells and tool.",
    removeCells:
      "Apply: nonempty unique indexes into the verified plan; selected cells are removed.",
  },
  extend: {
    edges: "Outer edge refs from one open body.",
    distance:
      "Required length expression; positive except perpendicular may be negative.",
    type: "natural (default), tangent, perpendicular.",
    tangentChain:
      "Boolean, default false; true incompatible with protected zones.",
  },
  offset: {
    faces: "Nonempty face refs.",
    distance:
      "Required signed length expression; positive follows face normal, zero copies.",
    tangentChain:
      "Boolean, default false; true incompatible with protected zones.",
  },
  check: {
    bodies: "Nonempty body refs.",
    expectSolid: "Optional expected solid status.",
    expectClosed: "Optional boolean: compare free-edge absence.",
    allowedOpenEdges:
      "Explicit permitted free edge refs when expectClosed:true.",
    seams:
      "Optional [{edgeA,faceA,edgeB,faceB,reverse?}] for measured G0/G1/G2; faces must use specified edges.",
    samples:
      "Integer 2..1001, default 17 per seam, at equal arc-length fractions.",
    tolerance: "Positive seam distance tolerance; default 0.001 mm.",
    angleTolerance: "Positive angle; default 0.1 deg.",
    curvatureTolerance:
      "Positive numeric value with 1/cm units, default 0.001 1/cm. Frobenius norm of world curvature tensor difference.",
  },
};
const required: Record<string, string[]> = {
  patch: ["boundary"],
  stitch: ["bodies", "tolerance"],
  trim: ["tool", "mode"],
  extend: ["edges", "distance"],
  offset: ["faces", "distance"],
  check: ["bodies"],
};
const examples: Record<string, Record<string, unknown>> = {
  patch: { boundary: { kind: "profile", sketch: "Section", index: 0 } },
  stitch: { bodies: ["SurfaceA", "SurfaceB"], tolerance: "0.01 mm" },
  trim: { tool: "XZ", mode: "plan" },
  extend: { edges: [{ token: "edge-token" }], distance: "2 mm" },
  offset: { faces: [{ token: "face-token" }], distance: "1 mm" },
  check: { bodies: ["SurfaceA"] },
};
export const descriptors: Record<string, OperationDeclaration> =
  Object.fromEntries(
    Object.entries(schemas).map(([mode, inputs]) => [
      "surface." + mode,
      {
        summary: `Native surface ${mode} with explicit availability and measured-evidence limits (GM08 v1).`,
        required: ["schemaVersion", "frame", ...(required[mode] ?? [])],
        readOnly: mode === "check",
        surface: true,
        inputs: { ...common, ...inputs },
        example: { schemaVersion: 1, frame: "component", ...examples[mode] },
        limitations: [
          "See docs/SURFACE.md. Native acceptance pending. Continuity labels on creation are requested conditions, not measurements. No automatic retry/rollback or inferred styling.",
        ],
      },
    ]),
  );
export function configure(catalog: Record<string, OperationDeclaration>): void {
  for (const mode of ["loft", "sweep", "revolve"]) {
    const entry = catalog["model." + mode];
    if (!entry) throw new Error("Missing surface catalog entry: " + mode);
    Object.assign(entry.inputs, {
      schemaVersion:
        "Surface variant format 1; default 1 for legacy solid:false.",
      frame: "Surface variant component frame.",
      representation: "Surface variant native only.",
      onExisting: "Surface variant error only.",
      protected: common.protected,
    });
    if (mode === "loft")
      entry.inputs["endConditions"] =
        "solid:false only: {start?,end?}, each {type:free|direction|tangent|smooth,angle?,weight?}. Tangent/smooth require edge-based section; direction requires sketch section.";
    entry.inputs[mode === "loft" ? "profiles" : "profile"] +=
      " Surface variant also accepts {kind:openProfile,curves:[refs]} using Component.createOpenProfile/createBRepEdgeProfile; loft may use existing path descriptors.";
  }
}
export function validate(operation: string, data: unknown): void {
  if (!isRecord(data)) throw new Error("Surface input must be an object");
  const model = ["model.loft", "model.sweep", "model.revolve"].includes(
    operation,
  );
  if (
    !descriptors[operation] &&
    !(
      model &&
      (data["solid"] === false ||
        [
          "representation",
          "protected",
          "endConditions",
          "schemaVersion",
          "frame",
          "onExisting",
        ].some((k) => k in data))
    )
  )
    return;
  if (model && data["solid"] !== false)
    throw new Error("GM08 model fields require solid:false");
  if (
    (data["schemaVersion"] ?? (model ? 1 : null)) !== 1 ||
    (data["frame"] ?? (model ? "component" : null)) !== "component"
  )
    throw new Error("GM08 requires schemaVersion:1 and frame:component");
  if (
    data["representation"] !== undefined &&
    data["representation"] !== "native"
  )
    throw new Error("Only native representation is implemented");
  if (data["onExisting"] !== undefined && data["onExisting"] !== "error")
    throw new Error("onExisting supports error only");
  for (const key of ["reverse", "tangentChain", "expectSolid", "expectClosed"])
    if (key in data && typeof data[key] !== "boolean")
      throw new Error(`${key} must be boolean`);
  for (const key of [
    "bodies",
    "faces",
    "edges",
    "protected",
    "interior",
    "allowedOpenEdges",
    "seams",
  ])
    if (key in data && (!Array.isArray(data[key]) || !data[key].length))
      throw new Error(`${key} must be nonempty`);
  for (const [key, min, max] of [
    ["samples", 2, 1001],
    ["maxItems", 1, 10000],
    ["budgetMs", 1, 120000],
  ] as const)
    if (
      key in data &&
      (typeof data[key] !== "number" ||
        !Number.isInteger(data[key]) ||
        data[key] < min ||
        data[key] > max)
    )
      throw new Error(`Invalid ${key} budget`);
  for (const key of [
    "distance",
    "tolerance",
    "angleTolerance",
    "curvatureTolerance",
  ])
    if (
      key in data &&
      (typeof data[key] !== "string" ||
        !data[key].trim() ||
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
          data[key].trim(),
        ))
    )
      throw new Error(`${key} requires a unit expression`);
  if (
    "weight" in data &&
    (typeof data["weight"] !== "number" ||
      !(data["weight"] > 0) ||
      !Number.isFinite(data["weight"]))
  )
    throw new Error("weight must be positive numeric");
  if (
    "type" in data &&
    !["natural", "tangent", "perpendicular"].some(
      (value) => value === data["type"],
    )
  )
    throw new Error("Unsupported extend type");
  if (
    "continuity" in data &&
    !["G0", "G1", "G2"].some((value) => value === data["continuity"])
  )
    throw new Error("Unsupported continuity");
  if (
    Array.isArray(data["protected"]) &&
    data["protected"].length &&
    data["tangentChain"]
  )
    throw new Error("Protected zones require explicit unchained selections");
  if (operation === "surface.trim") {
    if (!["plan", "apply"].some((value) => value === data["mode"]))
      throw new Error("trim mode must be plan or apply");
    if (data["mode"] === "plan" && ("plan" in data || "removeCells" in data))
      throw new Error("Plan mode cannot select cells");
    if (
      data["mode"] === "apply" &&
      (!data["plan"] ||
        !Array.isArray(data["removeCells"]) ||
        !data["removeCells"].length ||
        data["removeCells"].some((i) => !Number.isInteger(i) || i < 0) ||
        new Set(data["removeCells"]).size !== data["removeCells"].length)
    )
      throw new Error("Apply requires reviewed plan and unique removeCells");
  }
  for (const seam of Array.isArray(data["seams"]) ? data["seams"] : []) {
    if (
      !isRecord(seam) ||
      ["edgeA", "faceA", "edgeB", "faceB"].some(
        (k) => !Object.hasOwn(seam, k),
      ) ||
      Object.keys(seam).some(
        (k) => !["edgeA", "faceA", "edgeB", "faceB", "reverse"].includes(k),
      ) ||
      ("reverse" in seam && typeof seam["reverse"] !== "boolean")
    )
      throw new Error("Invalid seam mapping");
  }
  if (data["endConditions"]) {
    if (operation !== "model.loft" || data["closed"])
      throw new Error("End conditions require non-closed surface loft");
    for (const [end, c] of entries(data["endConditions"])) {
      if (
        !["start", "end"].includes(end) ||
        !isRecord(c) ||
        !["free", "direction", "tangent", "smooth"].some(
          (value) => value === c["type"],
        ) ||
        Object.keys(c).some((k) => !["type", "angle", "weight"].includes(k)) ||
        ("angle" in c && c["type"] !== "direction") ||
        (c["type"] === "free" && "weight" in c)
      )
        throw new Error("Invalid loft end condition");
      for (const key of ["angle", "weight"])
        if (key in c && typeof c[key] !== "string")
          throw new Error("End condition values require expressions");
    }
  }
}
export const manuals = Object.fromEntries(
  Object.entries(descriptors).map(([op, spec]) => [
    op,
    {
      sections: [
        { title: "Return Contract", text: spec.summary },
        { title: "Source And Limitations", text: spec.limitations.join(" ") },
      ],
      examples: [
        {
          label: op,
          requires:
            "Existing body/face/edge refs from discovery. See docs/SURFACE.md.",
          data: spec.example,
          output:
            "Versioned native-surface envelope; inspect status, limitations and provenance.",
        },
      ],
      audit: {
        sources: ["src/surface.js", "docs/SURFACE.md"],
        verified: [
          "native surface variant schema and explicit availability limits",
          "continuity labels are requested conditions not measurements",
          "trim plan/apply cell selection and protected-zone exclusions",
          "offset/extend signed distance and tangent-chain guards",
        ],
        tests: ["tests/surface.test.js", "tests/surface_test.py"],
        gaps: [],
        bugs: [
          "Native acceptance pending; continuity labels are not measured evidence.",
        ],
      },
    },
  ]),
);
