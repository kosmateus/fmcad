import type { OperationDeclaration } from "../../catalog";
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function contains(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}
// GM09 feature parameter/extent rework. Schema owner for feature.inspect/feature.edit v1.
// Descriptors are mirrored in src/catalog/feature.json for the catalog auto-loader; the
// Python dispatch in assets/cad/feature.py selects v1 vs legacy by payload shape.
const common = {
  schemaVersion:
    "Optional integer 1 selecting the GM09 v1 contract; omitted keeps the legacy assembly contract.",
  frame:
    'Optional "component" (GM09 v1); features resolve in the selected component only. Omitted keeps the legacy assembly contract.',
  feature: "Unambiguous native feature ref in the selected component.",
};
const entryFields =
  "Array of {name?, role?, expression}. The selector must be unambiguous: name is the actual owned model parameter name; role is read from the feature structure (distance, distanceTwo, startOffset, offset, taperAngle, angle, depth, diameter, twistAngle, ...), never assumed from a generic label such as AlongDistance. expression is the new unit-compatible expression string.";
const extentFields =
  "Native in-place extent edit. Extrude: distance|throughAll|toEntity|symmetric|twoSides. Revolve: angle|twoSideAngle|toEntity (angle may be signed; 360 deg is full). Hole: distance|throughAll|toEntity. Fields are operation-specific: distance/distanceTwo, angle/angleTwo, target, offset, direction, symmetric, reverse, matchShape, taper and isFullLength are conditionally validated by the native handler.";
export const descriptors: Record<string, OperationDeclaration> = {
  "feature.inspect": {
    summary:
      "GM09 v1 feature inspection: actual structural roles, units and expressions, extent readback, ownership classification. Payloads without schemaVersion keep the legacy assembly contract.",
    required: ["feature"],
    readOnly: true,
    featureRework: true,
    envelope: true,
    inputs: { ...common },
    example: {
      schemaVersion: 1,
      frame: "component",
      feature: { token: "extrude-feature-token" },
    },
    limitations: [
      "See docs/FEATURE.md. Role readback covers extrude/revolve/hole/sweep structures; anything unevaluable is explicit unknown. Legacy payloads without schemaVersion keep the assembly feature contract.",
    ],
  },
  "feature.edit": {
    summary:
      "GM09 v1 feature edit: native in-place feature property edits, model parameter expressions and marker-restored extents; unsupported fields are explicit. Payloads without schemaVersion keep the legacy name/parameters contract.",
    required: ["feature"],
    readOnly: false,
    featureRework: true,
    envelope: true,
    inputs: {
      ...common,
      name: "Optional nonempty new feature name; collisions fail.",
      parameters:
        "Legacy contract only: object keyed by exact owned model parameter names to expression strings; mutually exclusive with the v1 entries/extent selectors.",
      entries: entryFields,
      extent: extentFields,
      operationChange:
        "In-place operation change for ExtrudeFeature (newBody/join/cut) and SDK-supported Revolve/Sweep/Loft/Thicken operation properties. Expected must match current; non-Extrude changes require confirm:true.",
      nativeEdits:
        "Confirmed, type-specific native reference/property edits for the mandatory Extrude/Revolve/Fillet/Chamfer/Hole/Pattern/Mirror/Shell/Sweep/Loft/Thicken feature families. Native selectors are preflighted and applied only through documented in-place SDK setters; unsafe/unsupported type/property combinations fail before mutation.",
      preview:
        "Boolean; return the resolved plan without mutation (default false).",
      confirm:
        "Boolean true required for nativeEdits, hole type/position edits, and non-Extrude operationChange; false/missing confirmation does not mutate.",
    },
    example: {
      schemaVersion: 1,
      frame: "component",
      feature: { token: "extrude-feature-token" },
      entries: [
        { role: "startOffset", expression: "2 mm" },
        { role: "distance", expression: "10 mm" },
      ],
    },
    limitations: [
      "See docs/FEATURE.md. Non-atomic; failures never delete features. Cross-component extent targets are refused without explicit proxy/transform/ownership. Marker restore replays downstream features; it does not undo geometry.",
    ],
  },
};
const extentModes = [
  "distance",
  "throughAll",
  "toEntity",
  "symmetric",
  "twoSides",
  "angle",
  "twoSideAngle",
];
const extentKeys = [
  "mode",
  "distance",
  "distanceTwo",
  "startOffset",
  "taper",
  "taperTwo",
  "angle",
  "angleTwo",
  "target",
  "offset",
  "direction",
  "isFullLength",
  "symmetric",
  "reverse",
  "matchShape",
];
const expressionKeys = [
  "distance",
  "distanceTwo",
  "startOffset",
  "taper",
  "taperTwo",
  "angle",
  "offset",
];
export function validate(operation: string, data: unknown): void {
  const entry = descriptors[operation];
  if (!entry) return;
  if (!isRecord(data)) throw new Error("Feature input must be an object");
  const rework =
    data["schemaVersion"] !== undefined || data["frame"] !== undefined;
  if (rework && (data["schemaVersion"] !== 1 || data["frame"] !== "component"))
    throw new Error(
      "GM09 feature commands require schemaVersion:1 and frame:component",
    );
  if (operation !== "feature.edit") return;
  if (!rework) {
    if (
      data["parameters"] !== undefined &&
      (!isRecord(data["parameters"]) || !Object.keys(data["parameters"]).length)
    )
      throw new Error(
        "parameters must be a nonempty object keyed by model parameter name",
      );
    return;
  }
  if (
    !["name", "entries", "extent", "operationChange", "nativeEdits"].some(
      (key) => Object.hasOwn(data, key),
    )
  )
    throw new Error(
      "Provide at least one of name, entries, extent, operationChange or nativeEdits",
    );
  if (
    Object.hasOwn(data, "operationChange") &&
    ["name", "entries", "extent", "nativeEdits"].some((key) =>
      Object.hasOwn(data, key),
    )
  )
    throw new Error(
      "operationChange cannot be combined with other feature edits",
    );
  if (
    Object.hasOwn(data, "nativeEdits") &&
    ["name", "entries", "extent", "operationChange"].some((key) =>
      Object.hasOwn(data, key),
    )
  )
    throw new Error(
      "nativeEdits cannot be combined with name, entries, extent or operationChange",
    );
  if (
    Object.hasOwn(data, "nativeEdits") &&
    (!data["nativeEdits"] ||
      typeof data["nativeEdits"] !== "object" ||
      Array.isArray(data["nativeEdits"]) ||
      !Object.keys(data["nativeEdits"]).length)
  )
    throw new Error("nativeEdits must be a nonempty object");
  if (data["preview"] !== undefined && typeof data["preview"] !== "boolean")
    throw new Error("preview must be boolean");
  if (data["confirm"] !== undefined && typeof data["confirm"] !== "boolean")
    throw new Error("confirm must be boolean");
  if (
    data["name"] !== undefined &&
    (typeof data["name"] !== "string" || !data["name"].trim())
  )
    throw new Error("name must be a nonempty string");
  if (data["operationChange"] !== undefined) {
    const change = data["operationChange"];
    if (!isRecord(change)) throw new Error("operationChange must be an object");
    const unknown = Object.keys(change).filter(
      (key) =>
        !contains(
          ["expected", "value", "participants", "expectedResultBodyCount"],
          key,
        ),
    );
    if (unknown.length)
      throw new Error("Unknown operationChange fields: " + unknown.join(", "));
    if (
      !contains(["newBody", "join", "cut", "intersect"], change["expected"]) ||
      !contains(["newBody", "join", "cut", "intersect"], change["value"])
    )
      throw new Error(
        "operationChange expected/value must be newBody, join, cut or intersect",
      );
    if (
      typeof change["expectedResultBodyCount"] !== "number" ||
      !Number.isInteger(change["expectedResultBodyCount"]) ||
      change["expectedResultBodyCount"] < 1
    )
      throw new Error("expectedResultBodyCount must be an integer >= 1");
    if (change["value"] === "newBody") {
      if (Object.hasOwn(change, "participants"))
        throw new Error("newBody forbids participants");
    } else if (
      !Array.isArray(change["participants"]) ||
      !change["participants"].length ||
      change["participants"].some(
        (ref) =>
          !ref ||
          (typeof ref !== "string" &&
            (typeof ref !== "object" || Array.isArray(ref))),
      )
    ) {
      throw new Error(
        "join/cut/intersect require explicit nonempty participants",
      );
    }
  }
  if (data["entries"] !== undefined) {
    if (!Array.isArray(data["entries"]) || !data["entries"].length)
      throw new Error("entries must be a nonempty array");
    for (const item of data["entries"]) {
      if (!isRecord(item)) throw new Error("Each entry must be an object");
      const unknown = Object.keys(item).filter(
        (key) => !contains(["name", "role", "expression"], key),
      );
      if (unknown.length)
        throw new Error("Unknown entry fields: " + unknown.join(", "));
      if (!item["name"] && !item["role"])
        throw new Error("Each entry needs a name and/or role selector");
      for (const key of ["name", "role"])
        if (
          item[key] !== undefined &&
          (typeof item[key] !== "string" || !item[key].trim())
        )
          throw new Error("Entry " + key + " must be a nonempty string");
      if (typeof item["expression"] !== "string" || !item["expression"].trim())
        throw new Error("Entry expression must be a nonempty string");
    }
  }
  if (data["extent"] !== undefined) {
    const extent = data["extent"];
    if (!isRecord(extent)) throw new Error("extent must be an object");
    const unknown = Object.keys(extent).filter(
      (key) => !extentKeys.includes(key),
    );
    if (unknown.length)
      throw new Error("Unknown extent fields: " + unknown.join(", "));
    if (!contains(extentModes, extent["mode"]))
      throw new Error("Unsupported extent mode: " + extent["mode"]);
    const distanceModes = ["distance", "symmetric", "twoSides"];
    if (
      contains(distanceModes, extent["mode"]) !==
      Object.hasOwn(extent, "distance")
    )
      throw new Error(
        "distance is required for distance/symmetric/twoSides and forbidden otherwise",
      );
    if (
      (extent["mode"] === "twoSides") !==
      Object.hasOwn(extent, "distanceTwo")
    )
      throw new Error(
        "distanceTwo is required for twoSides and forbidden otherwise",
      );
    if ((extent["mode"] === "toEntity") !== Object.hasOwn(extent, "target"))
      throw new Error(
        "target is required for toEntity and forbidden otherwise",
      );
    if (
      contains(["angle", "twoSideAngle"], extent["mode"]) !==
      Object.hasOwn(extent, "angle")
    )
      throw new Error("angle is required for angle/twoSideAngle");
    if (
      (extent["mode"] === "twoSideAngle") !==
      Object.hasOwn(extent, "angleTwo")
    )
      throw new Error("angleTwo is required only for twoSideAngle");
    if (extent["mode"] !== "twoSides" && Object.hasOwn(extent, "taperTwo"))
      throw new Error("taperTwo requires twoSides");
    if (extent["mode"] !== "symmetric" && Object.hasOwn(extent, "isFullLength"))
      throw new Error("isFullLength requires symmetric mode");
    for (const key of ["symmetric", "reverse", "matchShape"])
      if (extent[key] !== undefined && typeof extent[key] !== "boolean")
        throw new Error(key + " must be boolean");
    if (
      extent["direction"] !== undefined &&
      !contains(["positive", "negative"], extent["direction"])
    )
      throw new Error("direction must be positive or negative");
    for (const key of expressionKeys)
      if (
        extent[key] !== undefined &&
        (typeof extent[key] !== "string" || !extent[key].trim())
      )
        throw new Error(key + " must be a unit expression");
  }
}
export function configure(catalog: Record<string, OperationDeclaration>): void {
  for (const [operation, descriptor] of Object.entries(descriptors)) {
    const existing = catalog[operation];
    if (existing && existing["featureRework"]) continue;
    catalog[operation] = descriptor;
  }
}
