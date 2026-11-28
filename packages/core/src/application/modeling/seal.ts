function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
// GM15 owner: O-rings, glands, gasket/poppet profiles and dock seal sequences.

const common = { schemaVersion: "Required 1.", frame: "Required component." };
export const descriptors = {
  "shape.o_ring": {
    summary:
      "Generate a free torus O-ring (revolve of a cross-section circle) and verify volume V = 2*pi^2*R*r^2 (GM15 v1).",
    required: ["schemaVersion", "frame", "name", "id", "cs"],
    readOnly: false,
    envelope: true,
    inputs: {
      ...common,
      name: "Feature name.",
      id: "Inner diameter length expression (positive).",
      cs: "Cross-section diameter length expression (positive, < id).",
      plane:
        "Construction plane for the section; must contain the revolve axis (default auto-picked: XZ for axis Z).",
      axis: "Revolve axis, default Z.",
      operation: "newBody, join, cut or intersect.",
    },
    example: {
      schemaVersion: 1,
      frame: "component",
      name: "ORing",
      id: "10 mm",
      cs: "2 mm",
    },
    limitations: [
      "Free torus only; an installed/compressed O-ring is a different deformed body.",
      "Recipe is not atomic.",
    ],
  },
  "seal.gland": {
    summary:
      "Compute a radial/face/dynamic gland groove and squeeze/fill/gap ranges from declared dimensions, tolerances, stretch/squeeze/swelling and hard stop (GM15 v1).",
    required: ["schemaVersion", "frame", "type", "oRing"],
    readOnly: true,
    envelope: true,
    inputs: {
      ...common,
      type: "radial, face or dynamic.",
      oRing: "O-ring {id, cs} length expressions.",
      gland:
        "Optional {depth,width} groove dimensions (exclusive with squeeze).",
      squeeze:
        "Optional target nominal squeeze fraction (exclusive with gland.depth).",
      swell: "Optional volume swell fraction (default 0).",
      stretch: "Optional installed stretch ratio (default 1).",
      squeezeMin:
        "Optional minimum acceptable squeeze fraction (default 0.08).",
      squeezeMax:
        "Optional maximum acceptable squeeze fraction (default 0.30).",
      fillMin: "Optional minimum fill fraction (default 0.60).",
      fillMax: "Optional maximum fill fraction (default 0.85).",
      tolerance:
        "Optional {depth:{minus,plus},width:{minus,plus}} length tolerances.",
      hardStop: "Optional {clearance} metallic hard stop.",
    },
    example: {
      schemaVersion: 1,
      frame: "component",
      type: "radial",
      oRing: { id: "10 mm", cs: "2 mm" },
      squeeze: 0.15,
      swell: 0.03,
      hardStop: { clearance: "0.05 mm" },
    },
    limitations: [
      "Geometric groove envelope only; no material/sealing solution is implied.",
      "Default squeeze/fill bounds are conventional targets, not a certification.",
    ],
  },
  "seal.profile": {
    summary:
      "Accept an approved cross-section and layout (gasket path or face/poppet revolution); a non-circular cross-section is never reclassified as an O-ring (GM15 v1).",
    required: ["schemaVersion", "frame", "crossSection", "layout"],
    readOnly: true,
    envelope: true,
    inputs: {
      ...common,
      crossSection:
        "{shape:circle,radius} or {shape:custom,points:[[x,y],...]} (closed).",
      layout: "gasket, face or poppet.",
      path: "Required for gasket: {closed:true,length}.",
      axis: "Revolve axis for face/poppet, default Z.",
      sweepLength: "Optional sweep length.",
    },
    example: {
      schemaVersion: 1,
      frame: "component",
      crossSection: {
        shape: "custom",
        points: [
          ["0 mm", "0 mm"],
          ["2 mm", "0 mm"],
          ["2 mm", "1.5 mm"],
          ["0 mm", "1.5 mm"],
          ["0 mm", "0 mm"],
        ],
      },
      layout: "gasket",
      path: { closed: true, length: "80 mm" },
    },
    limitations: [
      "Continuity is geometric closure only; no self-intersection or leak-tightness proof.",
      "P060 is a shaped gasket profile, not a plain O-ring.",
    ],
  },
  "seal.evaluate": {
    summary:
      "Evaluate an installed seal: squeeze, fill, gland volume, extrusion gap and hard stop against declared data (GM15 v1).",
    required: ["schemaVersion", "frame", "oRing", "gland"],
    readOnly: true,
    envelope: true,
    inputs: {
      ...common,
      oRing: "O-ring {id, cs}.",
      gland: "Installed groove {depth,width}.",
      type: "radial, face or dynamic (default radial).",
      gap: "Optional diametral clearance.",
      extrusionGapLimit:
        "Optional gap limit (requires pressure + hardness data).",
      swell: "Optional volume swell fraction.",
      stretch: "Optional installed stretch ratio.",
      hardStop: "Optional {clearance}.",
    },
    example: {
      schemaVersion: 1,
      frame: "component",
      oRing: { id: "10 mm", cs: "2 mm" },
      gland: { depth: "1.6 mm", width: "2.4 mm" },
      type: "radial",
    },
    limitations: [
      "Extrusion gap limit is reported unknown unless pressure and material hardness are declared.",
      "Geometric groove fit only; no leak-tightness or contact-pressure certification.",
    ],
  },
  "dock.sequence-check": {
    summary:
      "Resolve dock connect/disconnect event order in both directions and report the worst-case seal-before-open margin (GM15 v1).",
    required: ["schemaVersion", "frame", "connect"],
    readOnly: true,
    envelope: true,
    inputs: {
      ...common,
      connect:
        "Ordered [{event,at}] with a seal-contact and at least one valve-open event.",
      disconnect: "Optional [{event,at}]; defaults to reversed connect.",
      float: "Optional float travel length.",
      axialTolerance: "Optional axial tolerance.",
      locatorTolerance: "Optional locator tolerance.",
      minimumSealBeforeOpen: "Optional required margin, default 0.5 mm.",
    },
    example: {
      schemaVersion: 1,
      frame: "component",
      connect: [
        { event: "lead-in", at: "0 mm" },
        { event: "locator-engage", at: "2 mm" },
        { event: "seal-contact", at: "4 mm" },
        { event: "valve-open", at: "4.6 mm" },
        { event: "both-valve-open", at: "5 mm" },
      ],
      axialTolerance: "0.1 mm",
      minimumSealBeforeOpen: "0.5 mm",
    },
    limitations: [
      "Event order resolved from declared positions; no sealing or valve-function certification.",
      "Jumps and float are represented as worst-case axial/locator tolerances.",
    ],
  },
};

export function validate(operation: string, data: unknown): void {
  if (!Object.hasOwn(descriptors, operation)) return;
  if (!isRecord(data)) throw new Error(`${operation} input must be an object`);
  if (data["schemaVersion"] !== 1 || data["frame"] !== "component")
    throw new Error(
      `${operation} requires schemaVersion:1 and frame:component`,
    );
  if (operation === "shape.o_ring") {
    for (const key of ["id", "cs"])
      if (typeof data[key] !== "string" || !data[key].trim())
        throw new Error(`${key} must be a length expression`);
  }
  if (operation === "seal.gland" || operation === "seal.evaluate") {
    if (
      !data["oRing"] ||
      typeof data["oRing"] !== "object" ||
      Array.isArray(data["oRing"])
    )
      throw new Error("oRing must be an object");
  }
  if (operation === "seal.evaluate") {
    if (
      !data["gland"] ||
      typeof data["gland"] !== "object" ||
      Array.isArray(data["gland"])
    )
      throw new Error("gland must be an object");
  }
  if (operation === "seal.profile") {
    if (
      !data["crossSection"] ||
      typeof data["crossSection"] !== "object" ||
      Array.isArray(data["crossSection"])
    )
      throw new Error("crossSection must be an object");
    if (!["gasket", "face", "poppet"].some((value) => value === data["layout"]))
      throw new Error("layout must be gasket, face or poppet");
  }
  if (operation === "dock.sequence-check") {
    if (!Array.isArray(data["connect"]) || !data["connect"].length)
      throw new Error("connect must be a nonempty event array");
  }
}
