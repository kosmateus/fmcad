function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function contains(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}
function entry(
  catalog: Record<string, OperationDeclaration>,
  key: string,
): OperationDeclaration {
  const value = catalog[key];
  if (!value) throw new Error("Missing datum catalog entry: " + key);
  return value;
}
// GM04 owns its public extensions, validation and SDK handler (assets/cad/datum.py).
import * as entityQuery from "./entity-query";
import type { OperationDeclaration } from "../../catalog";

const frameHelp =
  "root, component, context, or {component:REF}, {occurrence:REF,datum?:NAME}, {component:REF,datum:NAME}, {sketch:REF}. Full nested occurrence paths are supported; repeated definitions require explicit occurrence context.";
const schema = {
  schemaVersion:
    "Optional integer 1. Version 1 frame creation defaults onExisting to error.",
};
const descriptors: Record<string, OperationDeclaration> = {
  "datum.transform": {
    summary:
      "Convert points, vectors and directed point differences between explicit rigid frames. Returns matrix and arrays with units; no mutation.",
    required: ["from", "to"],
    readOnly: true,
    example: {
      from: "component",
      to: "root",
      points: [["1 mm", "2 mm", "3 mm"]],
      vectors: [[0, 0, 2]],
    },
    inputs: {
      ...schema,
      from: frameHelp,
      to: frameHelp,
      points: "Array of [x,y,z] length-expression triples.",
      vectors:
        "Array of finite unitless triples. Magnitudes and zero vectors are preserved; translation is excluded.",
      differences:
        "Array of {from:[length expressions],to:[length expressions]}. Computes to minus from, then rotates only. Results are cm.",
    },
    limitations: [
      "Snapshot, not equations. Matrix is row-major with column vectors: inverse(to-to-root) * from-to-root; translation entries in cm. Scale, shear and reflections are refused.",
    ],
  },
  "datum.plane-on-path": {
    summary:
      "Create a native plane normal to a connected 3D path using proportional or physical distance. Preflight rejects out-of-range positions instead of native clamping.",
    required: ["name", "path", "position"],
    readOnly: false,
    example: {
      name: "Section",
      path: { curves: [{ token: "curve-token" }], chain: "none" },
      position: { mode: "proportional", value: "0.5" },
      representation: "native",
    },
    inputs: {
      ...schema,
      name: "Unique new datum name.",
      path: "Existing path descriptor {curves:[refs],chain?:none|connected|tangent,kind?:path}; reuses the modeling path builder.",
      position:
        "{mode:proportional,value:unitless expression string in [0,1]} or {mode:length,value:length expression in [0,pathLength]}. Endpoints included; never auto-clamped.",
      orientation:
        "{direction:[finite unitless values],frame:FRAME}. Projects the direction into the section plane to report a snapshot sectionFrame; parallel directions are refused before creation.",
      representation:
        "native only. Missing setByPath or PathDistanceTypes gives blocked, no fallback.",
    },
    limitations: [
      "Native SDK runtime acceptance pending. Parametric mode retains the distance expression and path reference; direct mode is snapshot.",
      "Orientation controls returned snapshot section-frame metadata, not native plane/sketch roll. Later native parameter/path edits may clamp physical distance; rerun preflight after edits.",
      "Non-atomic: post-add readback errors can retain the plane. No implicit save or retries.",
    ],
  },
  "joint.frame": {
    summary:
      "Inspect current joint geometry frames, signed motion axes, occurrence paths and limits in an explicit output frame.",
    required: ["joint"],
    readOnly: true,
    example: { joint: { token: "joint-token" }, to: "root" },
    inputs: {
      ...schema,
      joint:
        "Joint/AsBuiltJoint reference; native or explicit occurrence proxy.",
      to: frameHelp,
    },
    limitations: [
      "Snapshot inspection, not a new joint. JointGeometry primary=Z, secondary=X, third=Y. Unavailable rigid/inferred geometry gives unknown, not an invented frame.",
      "Frame/sign native acceptance pending; existing limits are reported as stored, including disabled limits.",
    ],
  },
};

export function configure(catalog: Record<string, OperationDeclaration>): void {
  Object.assign(catalog, descriptors);
  const extensions: Record<string, Record<string, string>> = {
    "datum.frame": {
      frame: frameHelp,
      onExisting:
        "error (version 1 default), reuse (identical inputs only), or update with confirm:true. Metadata snapshot only.",
    },
    "datum.point": {
      frame: frameHelp,
      associativity:
        "snapshot required when converting coordinate inputs from another frame.",
    },
    "datum.plane": {
      frame: frameHelp,
      associativity:
        "snapshot required for mode:frame. Creates a plane through constant helper points along frame X/Y.",
    },
    "datum.axis": {
      frame: frameHelp,
      associativity:
        "snapshot required for mode:frame. Creates an axis through constant helper points along frame +Z.",
    },
    "occurrence.transform": {
      frame: frameHelp,
      sharedParentPolicy:
        "error (default) or allInstances for a nested native occurrence reused through multiple parent instances.",
      placement:
        "Absolute translation/axis/angle as before, or {matrix:[16 row-major finite numbers],translationUnits:mm|cm|m|in|ft}. Proper rigid transforms only; from occurrence-local to frame (default root).",
    },
    "occurrence.align": {
      source:
        "Optional frame descriptor explicitly scoped to the moved occurrence (usually {occurrence:REF,datum:NAME}). Defaults to occurrence origin.",
      target:
        "Occurrence reference as before, or an explicit frame descriptor (including named datum/sketch).",
      sharedParentPolicy:
        "error or allInstances; nested native placement edits all repeated parent-definition instances.",
    },
  };
  for (const mode of ["rigid", "revolute", "slider", "cylindrical"]) {
    extensions["joint." + mode] = {
      occurrenceOne:
        "Explicit full-path occurrence reference, including nested instances.",
      occurrenceTwo:
        "Distinct non-ancestor occurrence reference, including nested instances.",
    };
    if (mode !== "rigid") {
      Object.assign(extensions["joint." + mode] ?? {}, {
        frame:
          "Optional FRAME descriptor replacing point+axis. Uses frame +Z and snapshot helper geometry. Does not reposition occurrences.",
        associativity:
          "snapshot required with frame; the resulting joint natively references constant helpers.",
        axis: "X, Y, Z or {ref:ConstructionAxis reference}. Explicit axes must belong to root or one input occurrence. Raw vectors are not accepted.",
      });
      entry(catalog, "joint." + mode).required = [
        "name",
        "occurrenceOne",
        "occurrenceTwo",
      ];
    }
  }
  for (const [op, inputs] of Object.entries(extensions)) {
    catalog[op] = {
      ...entry(catalog, op),
      inputs: { ...entry(catalog, op).inputs, ...schema, ...inputs },
      limitations: [
        "GM04 extended contract: see docs/GM04.md. Native acceptance pending; offline tests are not kernel evidence.",
        "Full nested rigid frames are supported. Reflections, scale, ambiguous repeated component frames and external assembly mutations are refused.",
        "Datums retain native expressions/references for legacy native modes; frame-derived helpers and placement are snapshots. No automatic save, regeneration or rollback.",
      ],
    };
    if (op === "datum.axis" || op === "datum.plane")
      entry(catalog, op).inputs["mode"] +=
        " Also frame, requiring frame and associativity:snapshot.";
    if (op.startsWith("occurrence."))
      entry(catalog, op).inputs["occurrence"] =
        "Explicit ungrounded occurrence, including a full nested path. Shared parent edits require allInstances policy.";
  }
}

function object(
  value: unknown,
  allowed: string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length)
    throw new Error(`${label}: unknown fields ${unknown.join(", ")}`);
}
function triple(value: unknown, dimensional = false): void {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((v) =>
      dimensional
        ? typeof v !== "string" || !v["trim"]()
        : typeof v !== "number" || !Number.isFinite(v),
    )
  )
    throw new Error(
      dimensional
        ? "Expected three length expression strings"
        : "Expected three finite unitless numbers",
    );
}
function frame(value: unknown): void {
  // Reuse the GM03 frame descriptor schema instead of inventing another dialect.
  entityQuery.validate("entity.find", {
    schemaVersion: 1,
    kind: "body",
    frame: value,
  });
}
function rigid(matrix: unknown): void {
  if (
    !Array.isArray(matrix) ||
    matrix.length !== 16 ||
    matrix.some((v) => typeof v !== "number" || !Number.isFinite(v))
  )
    throw new Error("Expected 16 finite row-major matrix values");
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const dot = [0, 1, 2]["reduce"](
        (v, r) => v + matrix[4 * r + i] * matrix[4 * r + j],
        0,
      );
      if (Math.abs(dot - +(i === j)) > 1e-8)
        throw new Error("Matrix must be rigid; scale/shear refused");
    }
  const m = matrix;
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[1] * (m[4] * m[10] - m[6] * m[8]) +
    m[2] * (m[4] * m[9] - m[5] * m[8]);
  if (
    Math.abs(det - 1) > 1e-8 ||
    [0, 0, 0, 1]["some"]((v, i) => Math.abs(m[i + 12] - v) > 1e-8)
  )
    throw new Error(
      "Matrix must be proper rigid; reflections/projective transforms refused",
    );
}
export function validate(op: string, data: unknown): void {
  if (
    !/^(datum\.|joint\.(frame|rigid|revolute|slider|cylindrical)$|occurrence\.(align|transform)$)/.test(
      op,
    )
  )
    return;
  if (!isRecord(data)) throw new Error("Datum input must be an object");
  if (data["schemaVersion"] !== undefined && data["schemaVersion"] !== 1)
    throw new Error("GM04 schemaVersion must be 1");
  for (const key of [
    "frame",
    ...(op === "datum.transform" ? ["from", "to"] : []),
    ...(op === "joint.frame" ? ["to"] : []),
  ])
    if (data[key] !== undefined) frame(data[key]);
  if (
    data["onExisting"] !== undefined &&
    !contains(["error", "reuse", "update"], data["onExisting"])
  )
    throw new Error("onExisting must be error, reuse or update");
  if (
    data["sharedParentPolicy"] !== undefined &&
    !contains(["error", "allInstances"], data["sharedParentPolicy"])
  )
    throw new Error("sharedParentPolicy must be error or allInstances");
  if (op === "datum.transform") {
    for (const key of ["points", "vectors", "differences"])
      if (data[key] !== undefined) {
        if (!Array.isArray(data[key]))
          throw new Error(`${key} must be an array`);
        for (const v of data[key]) {
          if (key === "differences") {
            object(v, ["from", "to"], "difference");
            triple(v["from"], true);
            triple(v["to"], true);
          } else triple(v, key === "points");
        }
      }
  }
  if (op === "datum.frame") {
    triple(data["origin"], true);
    triple(data["xAxis"]);
    triple(data["yAxis"]);
  }
  if (
    (["datum.plane", "datum.axis"].includes(op) && data["mode"] === "frame") ||
    (op === "datum.point" && data["frame"] !== undefined)
  ) {
    if (data["frame"] === undefined || data["associativity"] !== "snapshot")
      throw new Error(
        "Frame-derived datums require frame and associativity:snapshot",
      );
  }
  if (op === "datum.plane-on-path") {
    object(data["position"], ["mode", "value"], "position");
    if (
      !contains(["proportional", "length"], data["position"]["mode"]) ||
      typeof data["position"]["value"] !== "string" ||
      !data["position"]["value"].trim()
    )
      throw new Error(
        "position requires mode proportional|length and an expression string",
      );
    const n = Number(data["position"]["value"]);
    if (
      data["position"]["mode"] === "proportional" &&
      Number.isFinite(n) &&
      (n < 0 || n > 1)
    )
      throw new Error("Position outside path endpoints; no automatic clamping");
    object(data["path"], ["curves", "chain", "kind", "name"], "path");
    if (
      !Array.isArray(data["path"]["curves"]) ||
      !data["path"]["curves"].length
    )
      throw new Error("path requires nonempty curves");
    if (
      data["path"]["chain"] !== undefined &&
      !contains(["none", "connected", "tangent"], data["path"]["chain"])
    )
      throw new Error("Unsupported path chain");
    if (
      data["representation"] !== undefined &&
      data["representation"] !== "native"
    )
      throw new Error("representation must be native");
    if (data["orientation"] !== undefined) {
      object(data["orientation"], ["direction", "frame"], "orientation");
      triple(data["orientation"]["direction"]);
      frame(data["orientation"]["frame"]);
    }
  }
  if (op === "occurrence.transform") {
    if (data["source"] !== undefined)
      throw new Error("source is for align only");
    object(
      data["placement"],
      ["matrix", "translationUnits", "translation", "axis", "angle"],
      "placement",
    );
    if (data["placement"]["matrix"] !== undefined) {
      object(
        data["placement"],
        ["matrix", "translationUnits"],
        "matrix placement",
      );
      rigid(data["placement"]["matrix"]);
      if (
        !contains(
          ["mm", "cm", "m", "in", "ft"],
          data["placement"]["translationUnits"],
        )
      )
        throw new Error("Explicit translationUnits required");
    } else {
      if (data["placement"]["translationUnits"] !== undefined)
        throw new Error("translationUnits is for matrix placement");
      if (
        (data["placement"]["axis"] !== undefined) !==
        (data["placement"]["angle"] !== undefined)
      )
        throw new Error("Rotation requires axis and angle");
      if (data["placement"]["translation"] !== undefined)
        triple(data["placement"]["translation"], true);
      if (data["placement"]["axis"] !== undefined)
        triple(data["placement"]["axis"]);
    }
  }
  if (op === "occurrence.align" && data["source"] !== undefined)
    frame(data["source"]);
  if (/^joint\.(revolute|slider|cylindrical)$/.test(op)) {
    if (data["frame"] !== undefined) {
      if (
        data["point"] !== undefined ||
        data["axis"] !== undefined ||
        data["associativity"] !== "snapshot"
      )
        throw new Error(
          "frame replaces point/axis and requires associativity:snapshot",
        );
    } else {
      if (data["associativity"] !== undefined)
        throw new Error(
          "associativity is only an input for frame-derived joint helpers",
        );
      if (data["point"] === undefined || data["axis"] === undefined)
        throw new Error("Joint requires point and axis, or frame");
    }
    if (
      data["axis"] !== undefined &&
      !contains(["X", "Y", "Z"], data["axis"])
    ) {
      object(data["axis"], ["ref"], "axis");
      if (!data["axis"]["ref"]) throw new Error("Custom axis requires ref");
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
            "Existing curve/joint refs from discovery and an explicit frame descriptor. See docs/GM04.md.",
          data: spec.example,
          output:
            "Versioned datum/joint envelope; inspect status, units, frame and provenance.",
        },
      ],
      audit: {
        sources: ["src/datum.js", "docs/GM04.md"],
        verified: [
          "rigid frame transforms with unit conversion and reflection/shear refusal",
          "plane-on-path position range preflight without native clamping",
          "joint frame inspection with explicit signed axes and limits",
        ],
        tests: ["tests/datum.test.ts", "tests/datum_test.py"],
        gaps: [],
        bugs: [
          "Native frame/sign acceptance pending; reported limits are stored values, not revalidated.",
        ],
      },
    },
  ]),
);
