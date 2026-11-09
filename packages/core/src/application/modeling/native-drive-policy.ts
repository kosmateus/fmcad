const OPERATION = "mechanism.drive-test";
const MOTION_LINK_OPERATION = "mechanism.motion-link.create";
const MOTION_LINK_FIELDS = [
  "schemaVersion",
  "frame",
  "confirm",
  "jointOne",
  "jointTwo",
  "valueOne",
  "valueTwo",
  "isReversed",
];
const TOP_LEVEL = [
  "schemaVersion",
  "confirm",
  "driver",
  "waypoints",
  "followers",
  "budgetSeconds",
  "driverTolerance",
  "restoreTolerance",
];

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
) {
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length)
    throw new Error(label + " requires " + missing.join(", "));
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length)
    throw new Error("Unexpected " + label + " fields: " + unknown.join(", "));
}

function finite(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(label + " must be a finite number");
  }
  return value;
}

function nativeRef(value: unknown, label: string) {
  if (typeof value === "string" && value.trim()) return;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length
  )
    return;
  throw new Error(label + " must be a nonempty native entity reference");
}

function bounded(
  data: Record<string, unknown>,
  name: string,
  fallback: number,
  maximum: number,
) {
  const value = data[name] === undefined ? fallback : finite(data[name], name);
  if (value <= 0 || value > maximum)
    throw new Error(name + " must be positive and <= " + maximum);
  return value;
}

function validate(operation: string, input: unknown) {
  if (operation === MOTION_LINK_OPERATION) {
    const data = record(input, MOTION_LINK_OPERATION);
    exactKeys(
      data,
      MOTION_LINK_FIELDS,
      [
        "schemaVersion",
        "frame",
        "confirm",
        "jointOne",
        "jointTwo",
        "valueOne",
        "valueTwo",
      ],
      MOTION_LINK_OPERATION,
    );
    if (data["schemaVersion"] !== 1 || data["frame"] !== "component") {
      throw new Error(
        MOTION_LINK_OPERATION + " requires schemaVersion:1 and frame:component",
      );
    }
    if (data["confirm"] !== true)
      throw new Error(MOTION_LINK_OPERATION + " requires confirm:true");
    nativeRef(data["jointOne"], "jointOne");
    nativeRef(data["jointTwo"], "jointTwo");
    if (JSON.stringify(data["jointOne"]) === JSON.stringify(data["jointTwo"])) {
      throw new Error("motion-link requires two distinct joints");
    }
    for (const key of ["valueOne", "valueTwo"]) {
      if (
        typeof data[key] !== "string" ||
        !data[key].trim() ||
        data[key].length > 256 ||
        /[\x00-\x1f\x7f]/u.test(data[key])
      ) {
        throw new Error(key + " must be a bounded angle expression");
      }
    }
    if (
      data["isReversed"] !== undefined &&
      typeof data["isReversed"] !== "boolean"
    ) {
      throw new Error("isReversed must be boolean");
    }
    return;
  }
  if (operation !== OPERATION) return;
  const data = record(input, OPERATION);
  exactKeys(
    data,
    TOP_LEVEL,
    ["schemaVersion", "confirm", "driver", "waypoints", "followers"],
    OPERATION,
  );
  if (data["schemaVersion"] !== 1)
    throw new Error(OPERATION + " requires schemaVersion:1");
  if (data["confirm"] !== true)
    throw new Error(OPERATION + " requires confirm:true");
  nativeRef(data["driver"], "driver");

  if (
    !Array.isArray(data["waypoints"]) ||
    data["waypoints"].length < 2 ||
    data["waypoints"].length > 240
  ) {
    throw new Error(
      "waypoints must contain 2..240 absolute driver angles in radians",
    );
  }
  const waypoints = data["waypoints"].map((value) => finite(value, "waypoint"));
  if (
    waypoints.every(
      (value) => Math.abs(value - (waypoints[0] ?? Number.NaN)) <= 1e-6,
    )
  ) {
    throw new Error("waypoints must exercise nonzero motion");
  }
  for (const [index, value] of waypoints.entries()) {
    if (
      index &&
      Math.abs(value - (waypoints[index - 1] ?? Number.NaN)) >= Math.PI / 2
    ) {
      throw new Error("driver waypoint increments must be less than pi/2");
    }
  }

  if (
    !Array.isArray(data["followers"]) ||
    data["followers"].length < 1 ||
    data["followers"].length > 32
  ) {
    throw new Error("followers must contain 1..32 observations");
  }
  const followers = data["followers"].map((value, index) => {
    const label = "followers[" + index + "]";
    const item = record(value, label);
    exactKeys(
      item,
      ["joint", "coordinate", "ratio", "phase", "tolerance"],
      ["joint", "coordinate", "ratio", "phase", "tolerance"],
      label,
    );
    nativeRef(item["joint"], label + ".joint");
    if (!new Set<unknown>(["rotation", "slide"]).has(item["coordinate"])) {
      throw new Error(label + ".coordinate must be rotation or slide");
    }
    const ratio = finite(item["ratio"], label + ".ratio");
    const phase = finite(item["phase"], label + ".phase");
    const tolerance = finite(item["tolerance"], label + ".tolerance");
    if (ratio === 0 || tolerance <= 0)
      throw new Error(label + " ratio must be nonzero and tolerance positive");
    return { ratio, phase, tolerance, coordinate: item["coordinate"] };
  });

  bounded(data, "budgetSeconds", 10, 30);
  const driverTolerance = bounded(data, "driverTolerance", 1e-7, 0.01);
  bounded(data, "restoreTolerance", 1e-7, 0.001);
  const excursion = Math.max(...waypoints) - Math.min(...waypoints);
  if (excursion <= 2 * driverTolerance)
    throw new Error("driver excursion must exceed twice its tolerance");
  for (const follower of followers) {
    if (Math.abs(follower.ratio) * excursion <= 2 * follower.tolerance) {
      throw new Error(
        "expected follower excursion must exceed twice its tolerance",
      );
    }
    if (follower.coordinate === "rotation") {
      for (const [index, value] of waypoints.entries()) {
        const expected = follower.ratio * value + follower.phase;
        if (!Number.isFinite(expected))
          throw new Error("expected follower must be finite");
        if (
          index &&
          Math.abs(
            (value - (waypoints[index - 1] ?? Number.NaN)) * follower.ratio,
          ) >=
            Math.PI / 2
        ) {
          throw new Error(
            "expected follower increments must be less than pi/2",
          );
        }
      }
    } else {
      for (const value of waypoints) {
        if (!Number.isFinite(follower.ratio * value + follower.phase)) {
          throw new Error("expected follower must be finite");
        }
      }
    }
  }
}

function validates(operation: string) {
  return operation === OPERATION;
}

export { validate, validates };
