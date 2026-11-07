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

function vec3(value: unknown, label: string, c: Context, prefix: string) {
  object(value, ["x", "y", "z"], label, ["x", "y", "z"]);
  const coords = (["x", "y", "z"] as const).map((k) =>
    q(value[k]!, "length", `${prefix}.${k}`, c),
  );
  return coords.some((v) => v === null) ? null : (coords as number[]);
}
function direction3(value: unknown, label: string) {
  object(value, ["x", "y", "z"], label, ["x", "y", "z"]);
  const v = (["x", "y", "z"] as const).map((k) =>
    number(value[k]!, `${label}.${k}`),
  );
  const n = Math.hypot(...v);
  if (!(n > 0)) throw new Error(`${label} must be nonzero`);
  return v.map((x) => x / n);
}
const vSub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]!);
const vAdd = (a: number[], b: number[]) => a.map((x, i) => x + b[i]!);
const vScale = (a: number[], s: number) => a.map((x) => x * s);
const dot = (a: number[], b: number[]) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: number[], b: number[]) => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
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
const identity = () => [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
function matVec(m: number[][], v: number[]) {
  return [dot(m[0]!, v), dot(m[1]!, v), dot(m[2]!, v)];
}
function matMul(a: number[][], b: number[][]) {
  const t = b[0]!.map((_, j) => [b[0]![j]!, b[1]![j]!, b[2]![j]!]);
  return a.map((row) => t.map((col) => dot(row, col)));
}
function parallelAxis(mass: number, d: number[]) {
  const d2 = dot(d, d);
  return [
    [mass * (d2 - d[0]! * d[0]!), -mass * d[0]! * d[1]!, -mass * d[0]! * d[2]!],
    [-mass * d[1]! * d[0]!, mass * (d2 - d[1]! * d[1]!), -mass * d[1]! * d[2]!],
    [-mass * d[2]! * d[0]!, -mass * d[2]! * d[1]!, mass * (d2 - d[2]! * d[2]!)],
  ];
}
function addMatrix(a: number[][], b: number[][]) {
  return a.map((row, i) => row.map((x, j) => x + b[i]![j]!));
}
function eigen3(M: number[][], tick: () => void) {
  const A = M.map((r) => [...r]);
  const V = identity();
  const scale = Math.max(1, ...A.flat().map(Math.abs));
  for (let sweep = 0; sweep < 64; sweep++) {
    let p = 0,
      q = 1,
      max = 0;
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++) {
        const v = Math.abs(A[i]![j]!);
        if (v > max) {
          max = v;
          p = i;
          q = j;
        }
      }
    if (max <= 1e-14 * scale) break;
    tick();
    const phi = 0.5 * Math.atan2(2 * A[p]![q]!, A[q]![q]! - A[p]![p]!);
    const c = Math.cos(phi),
      s = Math.sin(phi);
    for (let k = 0; k < 3; k++) {
      if (k === p || k === q) continue;
      const akp = A[k]![p]!,
        akq = A[k]![q]!;
      A[k]![p]! = A[p]![k]! = c * akp - s * akq;
      A[k]![q]! = A[q]![k]! = s * akp + c * akq;
    }
    const app = A[p]![p]!,
      aqq = A[q]![q]!,
      apq = A[p]![q]!;
    A[p]![p]! = c * c * app - 2 * s * c * apq + s * s * aqq;
    A[q]![q]! = s * s * app + 2 * s * c * apq + c * c * aqq;
    A[p]![q]! = A[q]![p]! = 0;
    for (let k = 0; k < 3; k++) {
      const vkp = V[k]![p]!,
        vkq = V[k]![q]!;
      V[k]![p]! = c * vkp - s * vkq;
      V[k]![q]! = s * vkp + c * vkq;
    }
  }
  const eigenvalues = [A[0]![0]!, A[1]![1]!, A[2]![2]!];
  if (eigenvalues.some((v) => !Number.isFinite(v)))
    throw new Error("Principal axes did not converge");
  const order = [0, 1, 2].sort((a, b) => eigenvalues[a]! - eigenvalues[b]!);
  return order.map((i) => {
    const axis = [V[0]![i]!, V[1]![i]!, V[2]![i]!];
    const flip = axis.reduce(
      (s, x, j) => (Math.abs(x) > Math.abs(axis[s]!) ? j : s),
      0,
    );
    if (axis[flip]! < 0) for (let j = 0; j < 3; j++) axis[j]! = -axis[j]!;
    return { value: eigenvalues[i]!, axis };
  });
}
function parseItems(raw: unknown, c: Context) {
  const ids = new Set<string>();
  const items = list(raw, "items").map((item) => {
    c.tick();
    object(
      item,
      [
        "id",
        "count",
        "mass",
        "density",
        "volume",
        "massOverride",
        "referenceExclusion",
        "ownedContents",
        "cg",
        "inertia",
        "placement",
        "rotation",
      ],
      `item`,
      ["id"],
    );
    assertText(item.id, "item.id");
    if (ids.has(item.id)) throw new Error("Duplicate item id");
    ids.add(item.id);
    const count =
      item.count === undefined
        ? 1
        : number(item.count, `${item.id}.count`, 1, 1000000);
    if (!Number.isInteger(count))
      throw new Error(`${item.id}.count must be integer`);
    if (
      item.referenceExclusion !== undefined &&
      typeof item.referenceExclusion !== "boolean"
    )
      throw new Error("referenceExclusion must be boolean");
    const exclusion = item.referenceExclusion === true;
    let mass = null,
      massSource = null;
    if (exclusion) {
      if (
        item.mass !== undefined ||
        item.density !== undefined ||
        item.volume !== undefined
      )
        throw new Error(
          `${item.id}: referenceExclusion cannot combine with mass/density/volume`,
        );
      mass =
        item.massOverride === undefined
          ? null
          : q(item.massOverride, "mass", `${item.id}.massOverride`, c, 0);
      if (mass === null) {
        c.missing.push(
          `${item.id}: reference-excluded without a massOverride replacement`,
        );
        massSource = "reference-excluded";
      } else massSource = "override";
    } else {
      const direct = item.mass !== undefined,
        derived = item.density !== undefined || item.volume !== undefined;
      if (direct === derived)
        throw new Error(
          `${item.id}: exactly one of mass or (density, volume) is required`,
        );
      massSource = direct ? "declared" : "derived";
      if (direct) mass = q(item.mass, "mass", `${item.id}.mass`, c, 0);
      else {
        const density = q(
          item.density,
          "density",
          `${item.id}.density`,
          c,
          positive,
        );
        const volume = q(
          item.volume,
          "volume",
          `${item.id}.volume`,
          c,
          positive,
        );
        mass = density === null || volume === null ? null : density * volume;
      }
      if (item.massOverride !== undefined) {
        const override = q(
          item.massOverride,
          "mass",
          `${item.id}.massOverride`,
          c,
          0,
        );
        mass = override;
        massSource = "override";
      }
    }
    let ownedContents = null;
    if (item.ownedContents !== undefined) {
      if (exclusion)
        throw new Error(
          `${item.id}: referenceExclusion items cannot declare ownedContents`,
        );
      ownedContents = list(
        item.ownedContents,
        `${item.id}.ownedContents`,
        1,
        64,
      ).map((id) => text(id, "ownedContents id"));
      if (ownedContents.includes(item.id))
        throw new Error(`${item.id} cannot own itself`);
    }
    let cg = null;
    if (item.cg !== undefined)
      cg = vec3(item.cg, `${item.id}.cg`, c, `${item.id}.cg`);
    else c.missing.push(`${item.id}.cg`);
    let inertia = null;
    if (item.inertia !== undefined) {
      object(
        item.inertia,
        ["ixx", "iyy", "izz", "ixy", "ixz", "iyz"],
        `${item.id}.inertia`,
        ["ixx", "iyy", "izz", "ixy", "ixz", "iyz"],
      );
      const tensorInput = item.inertia;
      const entries = (["ixx", "iyy", "izz", "ixy", "ixz", "iyz"] as const).map(
        (k) =>
          q(tensorInput[k]!, "momentOfInertia", `${item.id}.inertia.${k}`, c),
      );
      if (!entries.includes(null))
        inertia = [
          [entries[0]!, entries[3]!, entries[4]!],
          [entries[3]!, entries[1]!, entries[5]!],
          [entries[4]!, entries[5]!, entries[2]!],
        ];
    } else c.missing.push(`${item.id}.inertia`);
    let placement = null;
    if (item.placement !== undefined)
      placement = vec3(
        item.placement,
        `${item.id}.placement`,
        c,
        `${item.id}.placement`,
      );
    else c.missing.push(`${item.id}.placement`);
    let rotation: number[][] | null = identity();
    if (item.rotation !== undefined) {
      object(item.rotation, ["roll", "pitch", "yaw"], `${item.id}.rotation`, [
        "roll",
        "pitch",
        "yaw",
      ]);
      const rotationInput = item.rotation;
      const angles = (["roll", "pitch", "yaw"] as const).map((k) =>
        q(rotationInput[k]!, "angle", `${item.id}.rotation.${k}`, c),
      );
      if (angles.includes(null)) rotation = null;
      else rotation = eulerMatrix(angles[0]!, angles[1]!, angles[2]!);
    }
    const worldCg =
      placement === null || cg === null || rotation === null
        ? null
        : vAdd(placement, matVec(rotation, cg));
    return {
      id: item.id,
      count,
      mass,
      massSource,
      ownedContents,
      cg,
      inertia,
      placement,
      rotation,
      worldCg,
      exclusion,
    };
  });
  const ownedBy = new Map<string, string>();
  for (const item of items)
    if (item.ownedContents)
      for (const child of item.ownedContents) {
        c.tick();
        if (!ids.has(child))
          throw new Error(
            `${item.id}: ownedContents references unknown item ${child}`,
          );
        if (ownedBy.has(child))
          throw new Error(
            `${child} is owned by both ${ownedBy.get(child)} and ${item.id}; double counting refused`,
          );
        ownedBy.set(child, item.id);
      }
  for (const item of items) {
    const chain = new Set([item.id]);
    let current = item.id;
    while (ownedBy.has(current)) {
      c.tick();
      current = ownedBy.get(current)!;
      if (chain.has(current)) throw new Error("Cyclic ownedContents ownership");
      chain.add(current);
    }
  }
  return items.map((item) => {
    const includedIn = ownedBy.get(item.id);
    const role =
      item.exclusion &&
      item.mass === null &&
      item.massSource === "reference-excluded"
        ? "reference-excluded"
        : item.exclusion
          ? "contribution"
          : includedIn !== undefined
            ? "included-in-parent"
            : "contribution";
    return {
      ...item,
      counted: role === "contribution" && includedIn === undefined,
      role,
      includedIn,
    };
  });
}
function matrixOut(m: number[][] | null) {
  if (m === null) return null;
  return {
    ixx: out(m[0]![0]!, "kg*m2"),
    iyy: out(m[1]![1]!, "kg*m2"),
    izz: out(m[2]![2]!, "kg*m2"),
    ixy: out(m[0]![1]!, "kg*m2"),
    ixz: out(m[0]![2]!, "kg*m2"),
    iyz: out(m[1]![2]!, "kg*m2"),
  };
}
export function system(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(data, ["items", "aboutPoint", "maximumMass"], runtime);
  object(data, [
    ...commonFields,
    ...(["items", "aboutPoint", "maximumMass"] as const),
  ]);
  const items = parseItems(data.items, c);
  const aboutPoint =
    data.aboutPoint === undefined
      ? null
      : vec3(data.aboutPoint, "aboutPoint", c, "aboutPoint");
  const maximum =
    data.maximumMass === undefined
      ? null
      : q(data.maximumMass, "mass", "maximumMass", c, 0);
  const contrib = items.filter((i) => i.counted);
  const massTotal =
    contrib.length === 0 || contrib.some((i) => i.mass === null)
      ? null
      : contrib.reduce((s, i) => s + i.mass! * i.count, 0);
  const cg =
    contrib.length === 0 ||
    contrib.some((i) => i.mass === null || i.worldCg === null)
      ? null
      : vScale(
          contrib.reduce(
            (s, i) => vAdd(s, vScale(i.worldCg!, i.mass! * i.count)),
            [0, 0, 0],
          ),
          1 / massTotal!,
        );
  function aggregate(about: number[] | null) {
    if (about === null || contrib.length === 0) return null;
    if (
      contrib.some(
        (i) =>
          i.mass === null ||
          i.worldCg === null ||
          i.inertia === null ||
          i.rotation === null,
      )
    )
      return null;
    let total = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (const i of contrib) {
      c.tick();
      const d = vSub(i.worldCg!, about);
      const rotated = matMul(
        i.rotation!,
        matMul(
          i.inertia!,
          i.rotation!.map((r, k) => i.rotation!.map((col) => col[k]!)),
        ),
      );
      const contribution = addMatrix(rotated, parallelAxis(i.mass!, d));
      total = addMatrix(
        total,
        contribution.map((row) => row.map((x) => x * i.count)),
      );
    }
    return total;
  }
  const inertiaCG = aggregate(cg);
  const inertiaP = aboutPoint === null ? null : aggregate(aboutPoint);
  const principal =
    inertiaCG === null ? null : eigen3(inertiaCG, c.tick.bind(c));
  let failed = false;
  if (maximum !== null && massTotal !== null && massTotal > maximum)
    failed = true;
  const ledger = items.map((i) => ({
    id: i.id,
    count: i.count,
    role: i.role,
    includedIn: i.includedIn || null,
    mass: out(
      i.counted ? (i.mass === null ? null : i.mass! * i.count) : null,
      "kg",
    ),
    massStatus:
      i.role === "contribution"
        ? i.mass === null
          ? "missing"
          : "complete"
        : i.role,
    cgStatus:
      i.role === "contribution"
        ? i.worldCg === null
          ? "missing"
          : "complete"
        : i.role,
    inertiaStatus:
      i.role === "contribution"
        ? i.inertia === null
          ? "missing"
          : "complete"
        : i.role,
    massSource: i.massSource,
  }));
  c.limitations.push(
    "Rigid-body ledger in the declared frame. Rotation is ZYX Euler. Density×volume is derived arithmetic, not measured evidence. Parallel-axis (Steiner) aggregation is exact only for the declared rigid items and tensors. ownedContents declares that the parent mass already includes the children; children are never double counted. Liquid contents must be declared as items; fluid states are not derived from cavity geometry here.",
  );
  return envelope(
    "mass.system",
    data,
    c,
    {
      items: ledger,
      mass: out(massTotal, "kg"),
      cg:
        cg === null
          ? null
          : { x: out(cg[0]!, "m"), y: out(cg[1]!, "m"), z: out(cg[2]!, "m") },
      inertiaAboutCG: matrixOut(inertiaCG),
      inertiaAboutPoint: matrixOut(inertiaP),
      principal: principal && {
        moments: principal.map((p) => out(p.value, "kg*m2")),
        axes: principal.map((p) => ({
          x: p.axis[0]!,
          y: p.axis[1]!,
          z: p.axis[2]!,
        })),
      },
      completeness: {
        mass: contrib.length > 0 && contrib.every((i) => i.mass !== null),
        cg: contrib.length > 0 && contrib.every((i) => i.worldCg !== null),
        inertia: contrib.length > 0 && contrib.every((i) => i.inertia !== null),
      },
    },
    failed
      ? "fail"
      : maximum === null
        ? "notEvaluated"
        : massTotal === null
          ? "unknown"
          : "pass",
  );
}
export function loadAxis(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(
    data,
    [
      "items",
      "axis",
      "gravity",
      "accelerations",
      "angularAccelerations",
      "externalLoads",
      "angularSpeed",
      "friction",
      "efficiency",
      "availableTorque",
    ],
    runtime,
  );
  object(data, [
    ...commonFields,
    ...([
      "items",
      "axis",
      "gravity",
      "accelerations",
      "angularAccelerations",
      "externalLoads",
      "angularSpeed",
      "friction",
      "efficiency",
      "availableTorque",
    ] as const),
  ]);
  const items = parseItems(data.items, c).filter((i) => i.counted);
  object(data.axis, ["pivot", "direction"], "axis", ["pivot", "direction"]);
  const pivot = vec3(data.axis.pivot, "axis.pivot", c, "axis.pivot");
  const axis = direction3(data.axis.direction, "axis.direction");
  object(data.gravity, ["direction", "magnitude"], "gravity", [
    "direction",
    "magnitude",
  ]);
  const gravityDir = direction3(data.gravity.direction, "gravity.direction");
  const gravity = q(
    data.gravity.magnitude,
    "acceleration",
    "gravity.magnitude",
    c,
    positive,
  );
  const accelerations = (
    data.accelerations === undefined
      ? []
      : list(data.accelerations, "accelerations", 0, 64)
  ).map((a, i) => {
    c.tick();
    object(a, ["id", "direction", "magnitude"], `accelerations[${i}]`, [
      "id",
      "direction",
      "magnitude",
    ]);
    assertText(a.id, "acceleration.id");
    return {
      id: a.id,
      direction: direction3(a.direction, `${a.id}.direction`),
      magnitude: q(a.magnitude!, "acceleration", `${a.id}.magnitude`, c),
    };
  });
  const angularAccelerations = (
    data.angularAccelerations === undefined
      ? []
      : list(data.angularAccelerations, "angularAccelerations", 0, 64)
  ).map((a, i) => {
    c.tick();
    object(a, ["id", "angularAcceleration"], `angularAccelerations[${i}]`, [
      "id",
      "angularAcceleration",
    ]);
    assertText(a.id, "angularAcceleration.id");
    return {
      id: a.id,
      value: q(
        a.angularAcceleration,
        "angularAcceleration",
        `${a.id}.angularAcceleration`,
        c,
      ),
    };
  });
  const angularSpeed =
    data.angularSpeed === undefined
      ? null
      : q(data.angularSpeed, "angularVelocity", "angularSpeed", c, 0);
  const externalLoads = (
    data.externalLoads === undefined
      ? []
      : list(data.externalLoads, "externalLoads", 0, 64)
  ).map((l, i) => {
    c.tick();
    object(l, ["id", "force", "at"], `externalLoads[${i}]`, [
      "id",
      "force",
      "at",
    ]);
    assertText(l.id, "externalLoad.id");
    object(l.force, ["magnitude", "direction"], `${l.id}.force`, [
      "magnitude",
      "direction",
    ]);
    return {
      id: l.id,
      magnitude: q(l.force.magnitude, "force", `${l.id}.force.magnitude`, c),
      direction: direction3(l.force.direction, `${l.id}.force.direction`),
      at: vec3(l.at, `${l.id}.at`, c, `${l.id}.at`),
    };
  });
  const friction = q(data.friction, "torque", "friction", c, 0);
  const efficiency =
    data.efficiency === undefined
      ? 1
      : q(data.efficiency, "scalar", "efficiency", c, positive, 1);
  const available =
    data.availableTorque === undefined
      ? null
      : q(data.availableTorque, "torque", "availableTorque", c, 0);
  const complete = (i: ReturnType<typeof parseItems>[number]) =>
    i.mass !== null && i.worldCg !== null;
  const pivotNull = pivot === null;
  let gravityTorque = null,
    inertiaAxis = null;
  if (
    !pivotNull &&
    items.length > 0 &&
    items.every(complete) &&
    gravity !== null
  ) {
    gravityTorque = 0;
    inertiaAxis = 0;
    for (const i of items) {
      c.tick();
      const r = vSub(i.worldCg!, pivot);
      const gForce = vScale(gravityDir, gravity * i.mass! * i.count);
      gravityTorque += dot(cross(gForce, r), axis);
      const rho = vSub(r, vScale(axis, dot(r, axis)));
      if (i.inertia !== null && i.rotation !== null) {
        const rotated = matMul(
          i.rotation!,
          matMul(
            i.inertia!,
            i.rotation!.map((row, k) => i.rotation!.map((col) => col[k]!)),
          ),
        );
        if (inertiaAxis !== null)
          inertiaAxis +=
            i.count *
            (i.mass! * dot(rho, rho) + dot(axis, matVec(rotated, axis)));
      } else inertiaAxis = null;
    }
  }
  const accelTorques = accelerations.map((a) => {
    let torque = null;
    if (
      !pivotNull &&
      items.length > 0 &&
      items.every(complete) &&
      a.magnitude !== null
    ) {
      torque = 0;
      for (const i of items) {
        c.tick();
        torque += dot(
          cross(
            vScale(a.direction, a.magnitude! * i.mass! * i.count),
            vSub(i.worldCg!, pivot),
          ),
          axis,
        );
      }
    }
    return { id: a.id, torque: out(torque, "N*m") };
  });
  const dynamicTorque = angularAccelerations.reduce<number | null>((s, a) => {
    c.tick();
    const t =
      a.value === null || inertiaAxis === null ? null : inertiaAxis * a.value;
    return s === null || t === null ? null : s + t;
  }, 0);
  const externalTorques = externalLoads.map((l) => {
    let torque = null;
    if (!pivotNull && l.magnitude !== null && l.at !== null)
      torque = dot(
        cross(vScale(l.direction, l.magnitude!), vSub(l.at, pivot)),
        axis,
      );
    return { id: l.id, torque: out(torque, "N*m") };
  });
  let centrifugal = 0;
  if (
    angularSpeed !== null &&
    !pivotNull &&
    items.length > 0 &&
    items.every(complete)
  ) {
    for (const i of items) {
      c.tick();
      const r = vSub(i.worldCg!, pivot);
      const rho = vSub(r, vScale(axis, dot(r, axis)));
      centrifugal +=
        i.mass! * i.count * angularSpeed * angularSpeed * Math.hypot(...rho);
    }
  }
  let radialLoad = null;
  if (
    !pivotNull &&
    items.length > 0 &&
    items.every(complete) &&
    gravity !== null &&
    accelerations.every((a) => a.magnitude !== null) &&
    externalLoads.every((l) => l.magnitude !== null && l.at !== null)
  ) {
    let f = [0, 0, 0];
    for (const i of items) {
      f = vAdd(f, vScale(gravityDir, gravity * i.mass! * i.count));
      for (const a of accelerations)
        f = vAdd(f, vScale(a.direction, a.magnitude! * i.mass! * i.count));
    }
    for (const l of externalLoads) {
      c.tick();
      f = vAdd(f, vScale(l.direction, l.magnitude!));
    }
    const radial = vSub(f, vScale(axis, dot(f, axis)));
    radialLoad = Math.hypot(...radial) + centrifugal;
  }
  const components = [
    gravityTorque,
    ...accelTorques.map((a) => (a.torque ? a.torque.value : null)),
    ...externalTorques.map((l) => (l.torque ? l.torque.value : null)),
  ];
  const active =
    components.some((v) => v === null) || dynamicTorque === null
      ? null
      : components.reduce<number>((s, v) => s + v!, 0) + dynamicTorque;
  const netTorque =
    active === null || friction === null
      ? null
      : active - Math.sign(active) * friction;
  const required =
    active === null || friction === null || efficiency === null
      ? null
      : (Math.abs(active) + friction) / efficiency;
  const held = netTorque !== null && Math.abs(netTorque) <= 16 * Number.EPSILON;
  let failed = false;
  if (available !== null && required !== null && available < Math.abs(required))
    failed = true;
  c.limitations.push(
    "Quasi-static axis torques about the declared axis: gravitational, linear-acceleration, external-load and angular-acceleration contributions. Centrifugal load from the declared angular speed acts radially on bearings and has no torque about the axis itself. Friction opposes the active direction; required torque is (|active|+friction)/efficiency. Efficiency defaults to 1 (lossless) when not declared. Stall torque is not a continuous rating. No dynamics, flexibility or motor-performance certification.",
  );
  return envelope(
    "mass.load-axis",
    data,
    c,
    {
      gravitationalTorque: out(gravityTorque, "N*m"),
      accelerationTorques: accelTorques,
      dynamicTorque: out(dynamicTorque, "N*m"),
      externalTorques,
      radialLoad: out(radialLoad, "N"),
      inertiaAboutAxis: out(inertiaAxis, "kg*m2"),
      activeTorque: out(active, "N*m"),
      frictionTorque: out(
        active === null || friction === null
          ? null
          : -Math.sign(active) * friction,
        "N*m",
      ),
      netTorque: out(netTorque, "N*m"),
      requiredTorque: out(required, "N*m"),
      availableTorque: out(available, "N*m"),
      equilibrium: held
        ? "held"
        : netTorque === null
          ? "unknown"
          : "unbalanced",
    },
    failed
      ? "fail"
      : available === null
        ? "notEvaluated"
        : required === null
          ? "unknown"
          : "pass",
  );
}
export function stability(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(
    data,
    ["items", "supportPolygon", "gravity", "accelerations", "minimumMargin"],
    runtime,
  );
  object(data, [
    ...commonFields,
    ...([
      "items",
      "supportPolygon",
      "gravity",
      "accelerations",
      "minimumMargin",
    ] as const),
  ]);
  const items = parseItems(data.items, c).filter((i) => i.counted);
  object(data.gravity, ["direction", "magnitude"], "gravity", [
    "direction",
    "magnitude",
  ]);
  const gravityDir = direction3(data.gravity.direction, "gravity.direction");
  const gravity = q(
    data.gravity.magnitude,
    "acceleration",
    "gravity.magnitude",
    c,
    positive,
  );
  const accelerations = (
    data.accelerations === undefined
      ? []
      : list(data.accelerations, "accelerations", 0, 64)
  ).map((a, i) => {
    c.tick();
    object(a, ["id", "direction", "magnitude"], `accelerations[${i}]`, [
      "id",
      "direction",
      "magnitude",
    ]);
    assertText(a.id, "acceleration.id");
    return {
      id: a.id,
      direction: direction3(a.direction, `${a.id}.direction`),
      magnitude: q(a.magnitude!, "acceleration", `${a.id}.magnitude`, c),
    };
  });
  const minimum =
    data.minimumMargin === undefined
      ? null
      : q(data.minimumMargin, "length", "minimumMargin", c, 0);
  const points = list(data.supportPolygon, "supportPolygon", 3, 64).map(
    (p, i) => vec3(p, `supportPolygon[${i}]`, c, `supportPolygon[${i}]`),
  );
  if (points.some((p) => p === null)) {
    c.limitations.push("Support polygon requires complete vertex coordinates.");
    return envelope(
      "mass.stability",
      data,
      c,
      { margin: null, cg: null, tipPoint: null, tipTiltAngle: null },
      "unknown",
    );
  }
  let n = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    c.tick();
    const a = points[i]!,
      b = points[(i + 1) % points.length]!;
    n = vAdd(n, cross(vAdd(a!, b!), vSub(b!, a!)));
  }
  const nNorm = Math.hypot(...n);
  if (!(nNorm > 0)) throw new Error("Support polygon is degenerate");
  n = vScale(n, 1 / nNorm);
  const p0 = points[0]!;
  const scale = Math.max(1, ...points.flat().map((p) => Math.abs(p!)));
  for (const p of points)
    if (Math.abs(dot(vSub(p!, p0), n)) > 1e-9 * scale)
      throw new Error("Support polygon vertices must be coplanar");
  let ref = [1, 0, 0];
  if (Math.abs(dot(ref, n)) > 0.9) ref = [0, 1, 0];
  const u = vScale(cross(n, ref), 1 / Math.hypot(...cross(n, ref)));
  const v = cross(n, u);
  const polygon2d = points.map((p) => [
    dot(vSub(p!, p0), u),
    dot(vSub(p!, p0), v),
  ]);
  let area2 = 0;
  for (let i = 0; i < polygon2d.length; i++) {
    c.tick();
    const a = polygon2d[i]!,
      b = polygon2d[(i + 1) % polygon2d.length]!;
    area2 += a[0]! * b[1]! - b[0]! * a[1]!;
  }
  const winding = Math.sign(area2);
  if (winding === 0) throw new Error("Support polygon is degenerate");
  const massTotal =
    items.length === 0 || items.some((i) => i.mass === null)
      ? null
      : items.reduce((s, i) => s + i.mass! * i.count, 0);
  const cg =
    items.length === 0 ||
    items.some((i) => i.mass === null || i.worldCg === null)
      ? null
      : vScale(
          items.reduce(
            (s, i) => vAdd(s, vScale(i.worldCg!, i.mass! * i.count)),
            [0, 0, 0],
          ),
          1 / massTotal!,
        );
  if (
    cg === null ||
    gravity === null ||
    accelerations.some((a) => a.magnitude === null)
  ) {
    return envelope(
      "mass.stability",
      data,
      c,
      { margin: null, cg: null, tipPoint: null, tipTiltAngle: null },
      "unknown",
    );
  }
  const resultant = vScale(gravityDir, gravity).map(
    (x, i) =>
      x + accelerations.reduce((s, a) => s + a.magnitude! * a.direction[i]!, 0),
  );
  const height = Math.abs(dot(vSub(cg, p0), n));
  let tipPoint = null,
    margin = Infinity;
  const rn = dot(resultant, n);
  if (Math.abs(rn) > 1e-12 * Math.hypot(...resultant)) {
    const t = -dot(vSub(cg, p0), n) / rn;
    tipPoint = vAdd(cg, vScale(resultant, t));
    const pt2d = [dot(vSub(tipPoint, p0), u), dot(vSub(tipPoint, p0), v)];
    for (let i = 0; i < polygon2d.length; i++) {
      c.tick();
      const a = polygon2d[i]!,
        b = polygon2d[(i + 1) % polygon2d.length]!;
      const ex = b[0]! - a[0]!,
        ey = b[1]! - a[1]!;
      const len = Math.hypot(ex, ey);
      if (!(len > 0)) throw new Error("Support polygon has a zero-length edge");
      margin = Math.min(
        margin,
        ((ex * (pt2d[1]! - a[1]!) - ey * (pt2d[0]! - a[0]!)) / len) * winding,
      );
    }
  } else {
    c.limitations.push(
      "Resultant load direction is parallel to the support plane; no tipping line exists under the declared loads.",
    );
  }
  let failed = false;
  if (margin <= 0) failed = true;
  if (!failed && minimum !== null && margin !== Infinity && margin < minimum)
    failed = true;
  c.limitations.push(
    "Tip-over margin is the minimum signed distance from the resultant-load intersection point to the support polygon edges, static rigid-body line-of-action analysis. No friction at supports, no deformation or dynamic roll-over certification.",
  );
  return envelope(
    "mass.stability",
    data,
    c,
    {
      margin: margin === Infinity ? null : out(margin, "m"),
      cg: { x: out(cg[0]!, "m"), y: out(cg[1]!, "m"), z: out(cg[2]!, "m") },
      tipPoint: tipPoint && {
        x: out(tipPoint[0]!, "m"),
        y: out(tipPoint[1]!, "m"),
        z: out(tipPoint[2]!, "m"),
      },
      tipTiltAngle:
        margin === Infinity ? null : out(Math.atan2(margin, height), "rad"),
    },
    failed ? "fail" : minimum === null ? "notEvaluated" : "pass",
  );
}
