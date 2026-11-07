import {
  assertText,
  object,
  number,
  text,
  list,
  quantity as q,
  output as out,
  context,
  envelope,
  commonFields,
  type Context,
  type EngineeringRuntime,
} from "./common";
const positive = Number.MIN_VALUE;

function direction3(value: unknown, label: string) {
  object(value, ["x", "y", "z"], label, ["x", "y", "z"]);
  const v = (["x", "y", "z"] as const).map((k) =>
    number(value[k]!, `${label}.${k}`),
  );
  const n = Math.hypot(...v);
  if (!(n > 0)) throw new Error(`${label} must be nonzero`);
  return v.map((x) => x / n);
}
function vec3(value: unknown, label: string, c: Context, prefix: string) {
  object(value, ["x", "y", "z"], label, ["x", "y", "z"]);
  const coords = (["x", "y", "z"] as const).map((k) =>
    q(value[k]!, "length", `${prefix}.${k}`, c),
  );
  return coords.some((v) => v === null) ? null : (coords as number[]);
}
function eulerMatrix(roll: number, pitch: number, yaw: number) {
  const [cr, sr] = [Math.cos(roll), Math.sin(roll)];
  const [cp, sp] = [Math.cos(pitch), Math.sin(pitch)];
  const [cy, sy] = [Math.cos(yaw), Math.sin(yaw)];
  return [
    [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
    [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
    [-sp, cp * sr, cp * cr],
  ];
}
function parseCavity(data: { cavity: unknown; gravity: unknown }, c: Context) {
  object(data.cavity, ["type", "length", "width", "height"], "cavity", [
    "type",
    "length",
    "width",
    "height",
  ]);
  if (data.cavity.type !== "box") throw new Error("cavity.type must be box");
  const L = q(data.cavity.length, "length", "cavity.length", c, positive);
  const W = q(data.cavity.width, "length", "cavity.width", c, positive);
  const H = q(data.cavity.height, "length", "cavity.height", c, positive);
  if (L === null || W === null || H === null) return null;
  object(data.gravity, ["direction"], "gravity", ["direction"]);
  const dir = direction3(data.gravity.direction, "gravity.direction");
  if (
    Math.abs(dir[0]!) > 1e-9 ||
    Math.abs(dir[1]!) > 1e-9 ||
    Math.abs(Math.abs(dir[2]!) - 1) > 1e-9
  )
    throw new Error(
      "Local analytic fill requires gravity aligned with the declared frame Z axis",
    );
  return { L, W, H, up: dir[2]! < 0 ? 1 : -1 };
}
function parseClosure(data: { closure: unknown }, c: Context) {
  if (data.closure === undefined) {
    c.missing.push("closure");
    return null;
  }
  object(data.closure, ["closedDomain", "errors"], "closure", ["closedDomain"]);
  if (typeof data.closure.closedDomain !== "boolean")
    throw new Error("closure.closedDomain must be boolean");
  let errors: string[] = [];
  if (data.closure.closedDomain === false) {
    errors = list(data.closure.errors, "closure.errors", 1, 16).map((e, i) =>
      text(e, `closure.errors[${i}]`),
    );
  } else if (data.closure.errors !== undefined)
    throw new Error("closure.errors is only valid when closedDomain is false");
  return { closed: data.closure.closedDomain, errors };
}
function parseDisplacers(data: { displacers: unknown }, c: Context) {
  if (data.displacers === undefined) return [];
  const ids = new Set<string>();
  return list(data.displacers, "displacers", 0, 12)
    .map((d, i) => {
      c.tick();
      object(
        d,
        ["id", "length", "width", "height", "position", "rotation"],
        `displacers[${i}]`,
        ["id", "length", "width", "height", "position"],
      );
      assertText(d.id, "displacer.id");
      if (ids.has(d.id)) throw new Error("Duplicate displacer id");
      ids.add(d.id);
      const dims = (["length", "width", "height"] as const).map((k) =>
        q(d[k]!, "length", `${d.id}.${k}`, c, positive),
      );
      const position = vec3(
        d.position,
        `${d.id}.position`,
        c,
        `${d.id}.position`,
      );
      let rotation = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
      if (d.rotation !== undefined) {
        object(d.rotation, ["roll", "pitch", "yaw"], `${d.id}.rotation`, [
          "roll",
          "pitch",
          "yaw",
        ]);
        const rotationInput = d.rotation;
        const angles = (["roll", "pitch", "yaw"] as const).map((k) =>
          q(rotationInput[k]!, "angle", `${d.id}.rotation.${k}`, c),
        );
        if (angles.every((a): a is number => a !== null)) {
          for (const a of angles)
            if (
              Math.abs(a - (Math.round(a / (Math.PI / 2)) * Math.PI) / 2) > 1e-9
            )
              throw new Error(
                `${d.id}: displacers must be axis-aligned (rotation a multiple of 90 degrees)`,
              );
          rotation = eulerMatrix(angles[0]!, angles[1]!, angles[2]!);
        }
      }
      if (dims.includes(null) || position === null) return null;
      const sizes = [0, 1, 2].map(
        (axis) =>
          Math.abs(rotation[axis]![0]!) * dims[0]! +
          Math.abs(rotation[axis]![1]!) * dims[1]! +
          Math.abs(rotation[axis]![2]!) * dims[2]!,
      );
      return { id: d.id, center: position, sizes };
    })
    .filter((d) => d !== null);
}
function boxMeasure(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
) {
  const v = (x1 - x0) * (y1 - y0) * (z1 - z0);
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const dx = x1 - x0,
    dy = y1 - y0,
    dz = z1 - z0;
  return {
    v,
    c,
    inertiaUnit: [
      (v * (dy * dy + dz * dz)) / 12,
      (v * (dx * dx + dz * dz)) / 12,
      (v * (dx * dx + dy * dy)) / 12,
    ],
  };
}
function intersectBoxes(boxes: number[][]) {
  let x0 = -Infinity,
    y0 = -Infinity,
    z0 = -Infinity,
    x1 = Infinity,
    y1 = Infinity,
    z1 = Infinity;
  for (const b of boxes) {
    x0 = Math.max(x0, b[0]!);
    y0 = Math.max(y0, b[1]!);
    z0 = Math.max(z0, b[2]!);
    x1 = Math.min(x1, b[3]!);
    y1 = Math.min(y1, b[4]!);
    z1 = Math.min(z1, b[5]!);
  }
  if (x0 > x1 || y0 > y1 || z0 > z1) return null;
  return boxMeasure(x0, y0, z0, x1, y1, z1);
}
function unionMeasures(boxes: number[][], c: Context) {
  let vol = 0;
  const moment = [0, 0, 0],
    inertiaUnit = [0, 0, 0];
  const dfs = (start: number, chosen: number[]) => {
    for (let i = start; i < boxes.length; i++) {
      chosen.push(i);
      c.tick();
      const inter = intersectBoxes(chosen.map((j) => boxes[j]!));
      if (inter) {
        const sign = chosen.length % 2 === 1 ? 1 : -1;
        vol += sign * inter.v;
        for (let k = 0; k < 3; k++) {
          moment[k]! += sign * inter.v * inter.c[k]!;
          const d2 =
            inter.c[0]! * inter.c[0]! +
            inter.c[1]! * inter.c[1]! +
            inter.c[2]! * inter.c[2]!;
          inertiaUnit[k]! +=
            sign *
            (inter.inertiaUnit[k]! +
              inter.v * (d2 - inter.c[k]! * inter.c[k]!));
        }
        dfs(i + 1, chosen);
      }
      chosen.pop();
    }
  };
  dfs(0, []);
  return { vol, moment, inertiaUnit };
}
type Cavity = NonNullable<ReturnType<typeof parseCavity>>;
type Displacers = ReturnType<typeof parseDisplacers>;
function measuresAtLevel(
  cavity: Cavity,
  level: number,
  displacers: Displacers,
  c: Context,
) {
  const zLo = cavity.up > 0 ? 0 : cavity.H - level;
  const zHi = cavity.up > 0 ? level : cavity.H;
  const gross = boxMeasure(0, 0, zLo, cavity.L, cavity.W, zHi);
  const boxes = displacers.map((d) => {
    const half = d.sizes.map((s) => s / 2);
    return [
      Math.max(0, d.center[0]! - half[0]!),
      Math.max(0, d.center[1]! - half[1]!),
      Math.max(zLo, d.center[2]! - half[2]!),
      Math.min(cavity.L, d.center[0]! + half[0]!),
      Math.min(cavity.W, d.center[1]! + half[1]!),
      Math.min(zHi, d.center[2]! + half[2]!),
    ];
  });
  const union = unionMeasures(boxes, c);
  const grossD2 =
    gross.c[0]! * gross.c[0]! +
    gross.c[1]! * gross.c[1]! +
    gross.c[2]! * gross.c[2]!;
  const grossOrigin = gross.inertiaUnit.map(
    (unit, k) => unit + gross.v * (grossD2 - gross.c[k]! * gross.c[k]!),
  );
  const net = {
    volume: gross.v - union.vol,
    moment: [0, 1, 2].map((k) => gross.v * gross.c[k]! - union.moment[k]!),
    inertiaUnit: [0, 1, 2].map((k) => grossOrigin[k]! - union.inertiaUnit[k]!),
  };
  return { gross, union, net };
}
function liquidResult(
  cavity: Cavity | null,
  level: number | null,
  displacers: Displacers,
  density: number | null,
  c: Context,
) {
  if (cavity === null || level === null) return null;
  const m = measuresAtLevel(cavity, level, displacers, c);
  const volume = m.net.volume;
  const cg = volume > 0 ? m.net.moment.map((x) => x / volume) : null;
  let inertia = null;
  if (density !== null && cg !== null) {
    const d2 = cg[0]! * cg[0]! + cg[1]! * cg[1]! + cg[2]! * cg[2]!;
    const off = [
      density * volume * (d2 - cg[0]! * cg[0]!),
      density * volume * (d2 - cg[1]! * cg[1]!),
      density * volume * (d2 - cg[2]! * cg[2]!),
    ];
    inertia = {
      ixx: density * m.net.inertiaUnit[0]! - off[0]!,
      iyy: density * m.net.inertiaUnit[1]! - off[1]!,
      izz: density * m.net.inertiaUnit[2]! - off[2]!,
      ixy: -density * volume * cg[0]! * cg[1]!,
      ixz: -density * volume * cg[0]! * cg[2]!,
      iyz: -density * volume * cg[1]! * cg[2]!,
    };
  }
  return {
    grossVolume: m.gross.v,
    unionVolume: m.union.vol,
    volume,
    cg,
    inertia,
    mass: density === null ? null : density * volume,
  };
}
export function fillVolume(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(
    data,
    [
      "cavity",
      "level",
      "density",
      "gravity",
      "displacers",
      "closure",
      "minimumVolume",
      "maximumVolume",
    ],
    runtime,
  );
  object(data, [
    ...commonFields,
    ...([
      "cavity",
      "level",
      "density",
      "gravity",
      "displacers",
      "closure",
      "minimumVolume",
      "maximumVolume",
    ] as const),
  ]);
  const cavity = parseCavity(data, c);
  const level = q(data.level, "length", "level", c, 0);
  const density = q(data.density, "density", "density", c, positive);
  const closure = parseClosure(data, c);
  const displacers = parseDisplacers(data, c);
  const minimum =
    data.minimumVolume === undefined
      ? null
      : q(data.minimumVolume, "volume", "minimumVolume", c, 0);
  const maximum =
    data.maximumVolume === undefined
      ? null
      : q(data.maximumVolume, "volume", "maximumVolume", c, 0);
  if (minimum !== null && maximum !== null && minimum > maximum)
    throw new Error("minimumVolume exceeds maximumVolume");
  if (cavity !== null && level !== null && level > cavity.H)
    throw new Error("level exceeds cavity height");
  if (closure !== null && !closure.closed) {
    c.limitations.push(
      "An open or ambiguous cavity is not a computable fluid domain. Closed analytic geometry or native boundary-fill evidence is required; the container material alone does not define the interior.",
    );
    return envelope(
      "measure.fill-volume",
      data,
      c,
      {
        closureErrors: closure.errors,
        grossVolume: null,
        displacedUnionVolume: null,
        netVolume: null,
        liquidMass: null,
        liquidCG: null,
        liquidInertia: null,
      },
      "blocked",
    );
  }
  const liquid = liquidResult(cavity, level, displacers, density, c);
  let failed = false;
  if (
    liquid !== null &&
    ((minimum !== null && liquid.volume < minimum) ||
      (maximum !== null && liquid.volume > maximum))
  )
    failed = true;
  c.limitations.push(
    "Analytic axis-aligned box cavity with box displacers, clipped to the declared fill level. Overlapping displacers are unioned through inclusion-exclusion; they are never double subtracted. Curved solids and arbitrary cavities require native boundary-fill, which has its own availability gate (blocked here).",
  );
  return envelope(
    "measure.fill-volume",
    data,
    c,
    {
      closureErrors: closure ? closure.errors : null,
      level: out(level, "m"),
      grossVolume: out(liquid && liquid.grossVolume, "m3"),
      displacedUnionVolume: out(liquid && liquid.unionVolume, "m3"),
      netVolume: out(liquid && liquid.volume, "m3"),
      liquidMass: out(liquid && liquid.mass, "kg"),
      liquidCG:
        liquid && liquid.cg
          ? {
              x: out(liquid.cg[0]!, "m"),
              y: out(liquid.cg[1]!, "m"),
              z: out(liquid.cg[2]!, "m"),
            }
          : null,
      liquidInertia:
        liquid && liquid.inertia
          ? {
              ixx: out(liquid.inertia.ixx, "kg*m2"),
              iyy: out(liquid.inertia.iyy, "kg*m2"),
              izz: out(liquid.inertia.izz, "kg*m2"),
              ixy: out(liquid.inertia.ixy, "kg*m2"),
              ixz: out(liquid.inertia.ixz, "kg*m2"),
              iyz: out(liquid.inertia.iyz, "kg*m2"),
            }
          : null,
    },
    failed
      ? "fail"
      : minimum === null && maximum === null
        ? "notEvaluated"
        : "pass",
  );
}
export function levelCurve(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(
    data,
    [
      "cavity",
      "density",
      "gravity",
      "displacers",
      "closure",
      "levels",
      "criteria",
    ],
    runtime,
  );
  object(data, [
    ...commonFields,
    ...([
      "cavity",
      "density",
      "gravity",
      "displacers",
      "closure",
      "levels",
      "criteria",
    ] as const),
  ]);
  const cavity = parseCavity(data, c);
  const density = q(data.density, "density", "density", c, positive);
  const closure = parseClosure(data, c);
  const displacers = parseDisplacers(data, c);
  const levels = list(data.levels, "levels").map((l, i) => {
    c.tick();
    const value = q(l, "length", `levels[${i}]`, c, 0);
    if (value !== null && value > (cavity ? cavity.H : Infinity))
      throw new Error(`levels[${i}] exceeds cavity height`);
    return value;
  });
  for (let i = 1; i < levels.length; i++)
    if (
      levels[i]! !== null &&
      levels[i - 1]! !== null &&
      levels[i]! <= levels[i - 1]!
    )
      throw new Error("levels must be strictly increasing");
  const criteria = (
    data.criteria === undefined ? [] : list(data.criteria, "criteria", 0, 64)
  ).map((crit, i) => {
    c.tick();
    object(crit, ["id", "level", "kind", "volume"], `criteria[${i}]`, [
      "id",
      "level",
      "kind",
      "volume",
    ]);
    assertText(crit.id, "criterion.id");
    if (crit.kind !== "minimum" && crit.kind !== "maximum")
      throw new Error("criterion.kind must be minimum or maximum");
    return {
      id: crit.id,
      kind: crit.kind,
      level: q(crit.level, "length", `${crit.id}.level`, c, 0),
      volume: q(crit.volume, "volume", `${crit.id}.volume`, c, 0),
    };
  });
  if (closure !== null && !closure.closed) {
    c.limitations.push(
      "An open or ambiguous cavity is not a computable fluid domain; a monotonic level curve requires the declared closed cavity.",
    );
    return envelope(
      "fluid.level-curve",
      data,
      c,
      {
        closureErrors: closure.errors,
        curve: null,
        monotonic: null,
        criteria: null,
      },
      "blocked",
    );
  }
  const curve = levels.map((level) => {
    c.tick();
    const liquid = liquidResult(cavity, level, displacers, density, c);
    return {
      level: out(level, "m"),
      volume: out(liquid && liquid.volume, "m3"),
      liquidMass: out(liquid && liquid.mass, "kg"),
    };
  });
  let monotonic = true,
    violation = null;
  for (let i = 1; i < curve.length; i++) {
    if (
      curve[i]!.volume !== null &&
      curve[i - 1]!.volume !== null &&
      curve[i]!.volume!.value <= curve[i - 1]!.volume!.value
    ) {
      monotonic = false;
      violation = i - 1;
      break;
    }
  }
  const criteriaResults = criteria.map((crit) => {
    const liquid = liquidResult(cavity, crit.level, displacers, density, c);
    const valid =
      liquid === null || crit.volume === null
        ? null
        : crit.kind === "minimum"
          ? liquid.volume >= crit.volume
          : liquid.volume <= crit.volume;
    return {
      id: crit.id,
      kind: crit.kind,
      level: out(crit.level, "m"),
      requiredVolume: out(crit.volume, "m3"),
      actualVolume: out(liquid && liquid.volume, "m3"),
      status: valid === null ? "unknown" : valid ? "pass" : "fail",
    };
  });
  const failed = !monotonic || criteriaResults.some((r) => r.status === "fail");
  c.limitations.push(
    "Level curve is evaluated at strictly increasing declared levels on the closed analytic cavity. A non-strictly-increasing curve is reported as a closure/monotonicity failure. MIN/MAX criteria compare the level volume against declared bounds; they do not model surface tension, sloshing or meniscus effects.",
  );
  return envelope(
    "fluid.level-curve",
    data,
    c,
    {
      closureErrors: closure ? closure.errors : null,
      curve,
      monotonic,
      monotonicViolation:
        violation === null
          ? null
          : { fromIndex: violation, toIndex: violation + 1 },
      criteria: criteriaResults,
    },
    failed ? "fail" : "pass",
  );
}
export function drainCheck(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(
    data,
    [
      "cavity",
      "gravity",
      "density",
      "outlet",
      "drainLevel",
      "maximumResidual",
      "pockets",
    ],
    runtime,
  );
  object(data, [
    ...commonFields,
    ...([
      "cavity",
      "gravity",
      "density",
      "outlet",
      "drainLevel",
      "maximumResidual",
      "pockets",
    ] as const),
  ]);
  const cavity = parseCavity(data, c);
  const density = q(data.density, "density", "density", c, positive);
  object(data.outlet, ["position", "diameter"], "outlet", [
    "position",
    "diameter",
  ]);
  const position = vec3(
    data.outlet.position,
    "outlet.position",
    c,
    "outlet.position",
  );
  q(data.outlet.diameter, "length", "outlet.diameter", c, positive);
  const drainLevel = q(data.drainLevel, "length", "drainLevel", c, 0);
  const maximumResidual =
    data.maximumResidual === undefined
      ? null
      : q(data.maximumResidual, "volume", "maximumResidual", c, 0);
  const pockets = (
    data.pockets === undefined ? [] : list(data.pockets, "pockets", 0, 64)
  ).map((p, i) => {
    c.tick();
    object(p, ["id", "volume", "drains", "position"], `pockets[${i}]`, [
      "id",
      "volume",
      "drains",
    ]);
    assertText(p.id, "pocket.id");
    if (typeof p.drains !== "boolean")
      throw new Error("pocket.drains must be boolean");
    return {
      id: p.id,
      volume: q(p.volume, "volume", `${p.id}.volume`, c, 0),
      drains: p.drains,
      position:
        p.position === undefined
          ? null
          : vec3(p.position, `${p.id}.position`, c, `${p.id}.position`),
    };
  });
  if (
    cavity !== null &&
    position !== null &&
    (position[0]! < 0 ||
      position[0]! > cavity.L ||
      position[1]! < 0 ||
      position[1]! > cavity.W ||
      position[2]! < 0 ||
      position[2]! > cavity.H)
  )
    throw new Error("outlet position is outside the cavity");
  if (cavity !== null && drainLevel !== null && drainLevel > cavity.H)
    throw new Error("drainLevel exceeds cavity height");
  const outletLevel =
    cavity === null || position === null
      ? null
      : cavity.up > 0
        ? position[2]!
        : cavity.H - position[2]!;
  const poolVolume = liquidResult(cavity, outletLevel, [], density, c);
  const reachable =
    drainLevel === null || outletLevel === null
      ? null
      : drainLevel >= outletLevel - 1e-12;
  const residualAt = (level: number) =>
    liquidResult(cavity, level, [], density, c);
  const target =
    drainLevel === null || outletLevel === null
      ? null
      : reachable
        ? Math.max(drainLevel, outletLevel)
        : outletLevel;
  const residualLiquid = target === null ? null : residualAt(target);
  const pocketResidual = pockets.some((p) => p.volume === null)
    ? null
    : pockets.reduce((s, p) => s + (p.drains ? 0 : p.volume!), 0);
  const residual =
    residualLiquid === null || pocketResidual === null
      ? null
      : residualLiquid.volume + pocketResidual;
  let failed = false;
  if (reachable === false) failed = true;
  if (
    !failed &&
    maximumResidual !== null &&
    residual !== null &&
    residual > maximumResidual
  )
    failed = true;
  c.limitations.push(
    "Geometric drain check on the analytic box cavity: residual liquid is the volume below the outlet port bottom or the requested drain level, whichever is higher, plus declared non-draining pockets. A drain level below the outlet port is geometrically unreachable. Flat cavity floor assumed; sloped floors must be modeled as declared pockets. Drain geometry does not certify wetting, hygiene, film retention or complete emptying.",
  );
  return envelope(
    "fluid.drain",
    data,
    c,
    {
      outletLevel: out(outletLevel, "m"),
      poolVolume: out(poolVolume && poolVolume.volume, "m3"),
      residualVolume: out(residual, "m3"),
      drainStatus:
        reachable === null
          ? "unknown"
          : !reachable
            ? "fail"
            : maximumResidual === null
              ? "notEvaluated"
              : residual !== null && residual > maximumResidual
                ? "fail"
                : "pass",
      pockets: pockets.map((p) => ({
        id: p.id,
        volume: out(p.volume, "m3"),
        drains: p.drains,
        countedInResidual: !p.drains,
      })),
      floor: "flat (declared)",
    },
    failed ? "fail" : maximumResidual === null ? "notEvaluated" : "pass",
  );
}
export function cleaningAccess(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(
    data,
    [
      "cavity",
      "gravity",
      "tool",
      "accesses",
      "pockets",
      "slopes",
      "maximumSlope",
    ],
    runtime,
  );
  object(data, [
    ...commonFields,
    ...([
      "cavity",
      "gravity",
      "tool",
      "accesses",
      "pockets",
      "slopes",
      "maximumSlope",
    ] as const),
  ]);
  parseCavity(data, c);
  object(data.tool, ["type", "length", "diameter"], "tool", ["type"]);
  if (
    data.tool.type !== "brush" &&
    data.tool.type !== "nozzle" &&
    data.tool.type !== "wipe"
  )
    throw new Error("tool.type must be brush, nozzle or wipe");
  const toolLength = q(data.tool.length, "length", "tool.length", c, positive);
  const toolDiameter = q(
    data.tool.diameter,
    "length",
    "tool.diameter",
    c,
    positive,
  );
  const accesses = list(data.accesses, "accesses").map((a, i) => {
    c.tick();
    object(
      a,
      ["id", "at", "direction", "depth", "openingDiameter"],
      `accesses[${i}]`,
      ["id", "at", "direction", "depth", "openingDiameter"],
    );
    assertText(a.id, "access.id");
    return {
      id: a.id,
      at: vec3(a.at, `${a.id}.at`, c, `${a.id}.at`),
      direction: direction3(a.direction, `${a.id}.direction`),
      depth: q(a.depth, "length", `${a.id}.depth`, c, 0),
      openingDiameter: q(
        a.openingDiameter,
        "length",
        `${a.id}.openingDiameter`,
        c,
        positive,
      ),
    };
  });
  function check(a: { depth: number | null; openingDiameter: number | null }) {
    const reach =
      toolLength === null || a.depth === null ? null : toolLength >= a.depth;
    const fit =
      toolDiameter === null || a.openingDiameter === null
        ? null
        : toolDiameter <= a.openingDiameter;
    const status =
      reach === null || fit === null
        ? "unknown"
        : reach && fit
          ? "pass"
          : "fail";
    return { reach, fit, status };
  }
  const accessResults = accesses.map((a) => {
    const r = check(a);
    return {
      id: a.id,
      depth: out(a.depth, "m"),
      openingDiameter: out(a.openingDiameter, "m"),
      reach: r.reach,
      fits: r.fit,
      status: r.status,
    };
  });
  const pockets = (
    data.pockets === undefined ? [] : list(data.pockets, "pockets", 0, 64)
  ).map((p, i) => {
    c.tick();
    object(p, ["id", "depth", "openingDiameter", "at"], `pockets[${i}]`, [
      "id",
      "depth",
      "openingDiameter",
      "at",
    ]);
    assertText(p.id, "pocket.id");
    const depth = q(p.depth, "length", `${p.id}.depth`, c, 0),
      opening = q(
        p.openingDiameter,
        "length",
        `${p.id}.openingDiameter`,
        c,
        positive,
      );
    const reach =
      toolLength === null || depth === null ? null : toolLength >= depth;
    const fit =
      toolDiameter === null || opening === null
        ? null
        : toolDiameter <= opening;
    return {
      id: p.id,
      depth: out(depth, "m"),
      openingDiameter: out(opening, "m"),
      reach,
      toolFits: fit,
      status:
        reach === null || fit === null
          ? "unknown"
          : reach && fit
            ? "pass"
            : "fail",
    };
  });
  const slopes = (
    data.slopes === undefined ? [] : list(data.slopes, "slopes", 0, 64)
  ).map((s, i) => {
    c.tick();
    object(s, ["id", "angle", "direction"], `slopes[${i}]`, [
      "id",
      "angle",
      "direction",
    ]);
    assertText(s.id, "slope.id");
    return {
      id: s.id,
      angle: q(s.angle, "angle", `${s.id}.angle`, c, 0, Math.PI / 2),
      direction: direction3(s.direction, `${s.id}.direction`),
    };
  });
  const maximumSlope =
    data.maximumSlope === undefined
      ? null
      : q(data.maximumSlope, "angle", "maximumSlope", c, 0, Math.PI / 2);
  let failed = false;
  if (accessResults.some((r) => r.status === "fail")) failed = true;
  if (
    maximumSlope !== null &&
    slopes.some((s) => (s.angle === null ? false : s.angle > maximumSlope))
  )
    failed = true;
  c.limitations.push(
    "Declared tool/brush geometry is checked for reach (tool length versus pocket depth) and diameter fit against declared openings. Pocket/slope reports are declared geometry, not a flow field. Tool access does not certify hygiene, wetting, detergent contact, biofilm removal or drying.",
  );
  return envelope(
    "fluid.cleaning-access",
    data,
    c,
    {
      tool: {
        type: data.tool.type,
        length: out(toolLength, "m"),
        diameter: out(toolDiameter, "m"),
      },
      accesses: accessResults,
      pockets,
      slopes: slopes.map((s) => ({
        id: s.id,
        angle: out(s.angle, "rad"),
        status:
          s.angle === null
            ? "unknown"
            : maximumSlope === null
              ? "notEvaluated"
              : s.angle <= maximumSlope
                ? "pass"
                : "fail",
      })),
      maximumSlope: out(maximumSlope, "rad"),
    },
    failed ? "fail" : "pass",
  );
}
