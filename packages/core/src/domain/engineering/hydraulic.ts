import {
  assertText,
  object,
  number,
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
function pressure(
  value: unknown,
  label: string,
  c: Context,
  atmosphere: number | null,
) {
  if (value === undefined || value === null) {
    c.missing.push(label);
    return null;
  }
  object(value, ["reference", "value"], label, ["reference", "value"]);
  if (value.reference !== "gauge" && value.reference !== "absolute")
    throw new Error(`${label}.reference must be gauge or absolute`);
  const p = q(
    value.value,
    value.reference === "gauge" ? "pressureGauge" : "pressureAbsolute",
    label,
    c,
  );
  if (p === null) return null;
  if (value.reference === "absolute") return p;
  if (atmosphere === null) {
    c.missing.push(`${label}.atmosphere`);
    return null;
  }
  return number(p + atmosphere, `${label} absolute pressure`, 0);
}
export function valve(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(
    data,
    [
      "seatDiameter",
      "preload",
      "rate",
      "lift",
      "friction",
      "flow",
      "density",
      "dischargeCoefficient",
      "flowArea",
      "availablePressure",
    ],
    runtime,
  );
  object(data, [
    ...commonFields,
    ...([
      "seatDiameter",
      "preload",
      "rate",
      "lift",
      "friction",
      "flow",
      "density",
      "dischargeCoefficient",
      "flowArea",
      "availablePressure",
    ] as const),
  ]);
  const diameter = q(data.seatDiameter, "length", "seatDiameter", c, positive);
  const preload = q(data.preload, "force", "preload", c, 0),
    rate = q(data.rate, "stiffness", "rate", c, 0);
  const lift = q(data.lift, "length", "lift", c, 0),
    friction = q(data.friction, "force", "friction", c, 0);
  const area = diameter === null ? null : (Math.PI * diameter ** 2) / 4;
  const cracking =
    preload === null || friction === null || area === null
      ? null
      : (preload + friction) / area;
  const holding =
    cracking === null || rate === null || lift === null
      ? null
      : cracking + (rate * lift) / area!;
  const flow = q(data.flow, "flow", "flow", c, 0),
    rho = q(data.density, "density", "density", c, positive);
  const cd = q(
    data.dischargeCoefficient,
    "scalar",
    "dischargeCoefficient",
    c,
    positive,
    1,
  );
  const flowArea = q(data.flowArea, "area", "flowArea", c, 0);
  let flowDrop = null;
  if (flow !== null && rho !== null && cd !== null && flowArea !== null) {
    if (flowArea === 0 && flow > 0)
      throw new Error("Positive flow through zero flowArea");
    flowDrop = flow === 0 ? 0 : (rho / 2) * (flow / (cd * flowArea)) ** 2;
  }
  if (lift === 0 && flow !== null && flow > 0)
    throw new Error("Closed valve cannot carry positive flow in this model");
  const required =
    holding === null || flowDrop === null ? null : Math.max(holding, flowDrop);
  const available =
    data.availablePressure === undefined
      ? null
      : q(
          data.availablePressure,
          "pressureDifference",
          "availablePressure",
          c,
          0,
        );
  c.tick();
  c.limitations.push(
    "Quasi-static opening force and incompressible orifice evaluated separately at specified lift. Required pressure is a lower bound max(force balance, flow loss), not their sum. Lift is prescribed, not solved; coupled valve equilibrium, leakage, hysteresis and dynamics are not certified.",
  );
  return envelope(
    "engineering.valve",
    data,
    c,
    {
      seatArea: out(area, "m2"),
      crackingPressure: out(cracking, "Pa"),
      holdingPressure: out(holding, "Pa"),
      flowPressureDrop: out(flowDrop, "Pa"),
      requiredPressureLowerBound: out(required, "Pa"),
      availablePressure: out(available, "Pa"),
      equilibriumStatus: "notEvaluated",
    },
    available === null
      ? "notEvaluated"
      : required === null
        ? "unknown"
        : available < required
          ? "fail"
          : "notEvaluated",
  );
}
export function piston(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(
    data,
    [
      "bore",
      "stroke",
      "preload",
      "rate",
      "initialCompression",
      "friction",
      "backPressure",
      "atmosphere",
      "deadVolume",
    ],
    runtime,
  );
  object(data, [
    ...commonFields,
    ...([
      "bore",
      "stroke",
      "preload",
      "rate",
      "initialCompression",
      "friction",
      "backPressure",
      "atmosphere",
      "deadVolume",
    ] as const),
  ]);
  const bore = q(data.bore, "length", "bore", c, positive),
    stroke = q(data.stroke, "length", "stroke", c, positive);
  const preload = q(data.preload, "force", "preload", c, 0),
    rate = q(data.rate, "stiffness", "rate", c, 0);
  const initial = q(
      data.initialCompression,
      "length",
      "initialCompression",
      c,
      0,
    ),
    friction = q(data.friction, "force", "friction", c, 0);
  if (initial !== null && stroke !== null && initial < stroke)
    throw new Error(
      "stroke exceeds initialCompression for a releasing compression spring",
    );
  const atmosphere =
    data.atmosphere === undefined
      ? null
      : q(data.atmosphere, "pressureAbsolute", "atmosphere", c, 0);
  const back = pressure(data.backPressure, "backPressure", c, atmosphere);
  const dead = q(data.deadVolume, "volume", "deadVolume", c, 0);
  const area = bore === null ? null : (Math.PI * bore ** 2) / 4;
  const displacement = area === null || stroke === null ? null : area * stroke;
  const known =
    preload !== null &&
    rate !== null &&
    initial !== null &&
    friction !== null &&
    stroke !== null;
  const start = known ? preload + rate * initial : null,
    end = known ? preload + rate * (initial - stroke) : null;
  const energy = known
    ? preload * stroke + (rate * (initial ** 2 - (initial - stroke) ** 2)) / 2
    : null;
  const work = energy === null ? null : energy - friction! * stroke!;
  const p1 =
      start === null || area === null ? null : (start - friction!) / area,
    p2 = end === null || area === null ? null : (end - friction!) / area;
  const stalled = end !== null && end <= friction!;
  c.tick();
  c.limitations.push(
    "Linear compression spring releasing over the prescribed stroke; constant opposing friction. Quasi-static positive-direction pressure relative to back pressure. No spring geometry design, nozzle dose guarantee, compressibility, inertia or leakage. Negative net force means the requested stroke cannot be driven.",
  );
  return envelope(
    "engineering.spring-piston",
    data,
    c,
    {
      area: out(area, "m2"),
      displacement: out(displacement, "m3"),
      deadVolume: out(dead, "m3"),
      springForceStart: out(start, "N"),
      springForceEnd: out(end, "N"),
      springWork: out(energy, "J"),
      fluidWork: out(work, "J"),
      differentialPressureStart: out(p1, "Pa"),
      differentialPressureEnd: out(p2, "Pa"),
      fluidPressureStart:
        back === null || p1 === null || stalled
          ? null
          : out(number(back + p1, "fluid absolute pressure", 0), "Pa(a)"),
      fluidPressureEnd:
        back === null || p2 === null || stalled
          ? null
          : out(number(back + p2, "fluid absolute pressure", 0), "Pa(a)"),
      stalled,
    },
    stalled ? "fail" : "notEvaluated",
  );
}
export function floating(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(
    data,
    [
      "density",
      "gravity",
      "mass",
      "magnetMass",
      "displacedVolume",
      "waterplaneArea",
      "height",
      "guideFriction",
      "level",
      "lowerStop",
      "upperStop",
    ],
    runtime,
  );
  object(data, [
    ...commonFields,
    ...([
      "density",
      "gravity",
      "mass",
      "magnetMass",
      "displacedVolume",
      "waterplaneArea",
      "height",
      "guideFriction",
      "level",
      "lowerStop",
      "upperStop",
    ] as const),
  ]);
  const rho = q(data.density, "density", "density", c, positive),
    g = q(data.gravity, "acceleration", "gravity", c, positive);
  const mass = q(data.mass, "mass", "mass", c, 0),
    magnet = q(data.magnetMass, "mass", "magnetMass", c, 0);
  const volume = q(data.displacedVolume, "volume", "displacedVolume", c, 0),
    area = q(data.waterplaneArea, "area", "waterplaneArea", c, positive);
  const height = q(data.height, "length", "height", c, positive),
    friction = q(data.guideFriction, "force", "guideFriction", c, 0);
  const level = q(data.level, "length", "level", c),
    lower = q(data.lowerStop, "length", "lowerStop", c),
    upper = q(data.upperStop, "length", "upperStop", c);
  if (lower !== null && upper !== null && lower > upper)
    throw new Error("lowerStop exceeds upperStop");
  if (
    volume !== null &&
    area !== null &&
    height !== null &&
    volume > area * height * (1 + 1e-12)
  )
    throw new Error("displacedVolume exceeds prismatic float capacity");
  const weight =
    mass === null || magnet === null || g === null ? null : (mass + magnet) * g;
  const buoyancy =
    rho === null || g === null || volume === null ? null : rho * g * volume;
  const required =
    mass === null || magnet === null || rho === null
      ? null
      : (mass + magnet) / rho;
  let equilibrium = null,
    status = "unknown";
  if (
    required !== null &&
    friction !== null &&
    rho !== null &&
    g !== null &&
    area !== null &&
    height !== null &&
    level !== null &&
    lower !== null &&
    upper !== null
  ) {
    const depthLow = Math.max(0, (required - friction / (rho * g)) / area);
    const depthHigh = Math.min(
      height,
      (required + friction / (rho * g)) / area,
    );
    const roundoff =
      64 *
      Number.EPSILON *
      Math.max(weight!, rho * g * area * height, friction);
    const fullImmersionSupported =
      Math.abs(rho * g * area * height - weight!) <= friction + roundoff;
    const drySupported = weight! <= friction + roundoff;
    const minPosition = fullImmersionSupported
      ? lower
      : Math.max(lower, level - depthHigh);
    const maxPosition = drySupported
      ? upper
      : Math.min(upper, level - depthLow);
    const feasible =
      (depthLow <= depthHigh || fullImmersionSupported || drySupported) &&
      minPosition <= maxPosition;
    equilibrium = {
      minimumBottom: feasible ? out(minPosition, "m") : null,
      maximumBottom: feasible ? out(maxPosition, "m") : null,
      feasible,
      requiredVolume: out(required, "m3"),
    };
    status = feasible ? "pass" : "fail";
  }
  c.tick();
  c.limitations.push(
    "Vertical prismatic float with constant waterplane area; mass excludes separately specified magnet mass. Guide friction gives a static force band, not dynamic tracking. Stop coordinates and level share the declared vertical datum; output position locates float bottom. No magnetic side load or capillary model.",
  );
  return envelope(
    "float.evaluate",
    data,
    c,
    {
      weight: out(weight, "N"),
      buoyancy: out(buoyancy, "N"),
      netUpwardForce:
        weight === null || buoyancy === null
          ? null
          : out(buoyancy - weight, "N"),
      equilibrium,
    },
    status,
  );
}

export function network(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(
    data,
    [
      "nodes",
      "lines",
      "density",
      "viscosity",
      "atmosphere",
      "flowTolerance",
      "pressureTolerance",
    ],
    runtime,
  );
  object(data, [
    ...commonFields,
    ...([
      "nodes",
      "lines",
      "density",
      "viscosity",
      "atmosphere",
      "flowTolerance",
      "pressureTolerance",
    ] as const),
  ]);
  const rho = q(data.density, "density", "density", c, positive);
  const mu =
    data.viscosity === undefined
      ? null
      : q(data.viscosity, "viscosity", "viscosity", c, positive);
  const atmosphere =
    data.atmosphere === undefined
      ? null
      : q(data.atmosphere, "pressureAbsolute", "atmosphere", c, 0);
  const ft = q(data.flowTolerance, "flow", "flowTolerance", c, 0),
    pt = q(
      data.pressureTolerance,
      "pressureDifference",
      "pressureTolerance",
      c,
      0,
    );
  interface Node {
    id: string;
    kind: string;
    balance: number | null;
    knownFlows: boolean;
    pressure: number | null;
  }
  const nodes = new Map<string, Node>();
  list(data.nodes, "nodes", 2).forEach((n) => {
    c.tick();
    object(n, ["id", "kind", "externalFlow", "pressure"], "node", [
      "id",
      "kind",
    ]);
    assertText(n.id, "node.id");
    if (nodes.has(n.id)) throw new Error("Duplicate node id");
    assertText(n.kind, "node.kind");
    if (!["junction", "reservoir", "source", "outlet"].includes(n.kind))
      throw new Error("Invalid node.kind");
    nodes.set(n.id, {
      id: n.id,
      kind: n.kind,
      balance: q(n.externalFlow, "flow", `${n.id}.externalFlow`, c),
      pressure:
        n.pressure === undefined
          ? null
          : pressure(n.pressure, `${n.id}.pressure`, c, atmosphere),
      knownFlows: true,
    });
  });
  const ids = new Set<string>();
  const lines = list(data.lines, "lines").map((e) => {
    c.tick();
    object(
      e,
      [
        "id",
        "from",
        "to",
        "kind",
        "flow",
        "diameter",
        "length",
        "deadVolume",
        "lossCoefficient",
        "frictionModel",
        "darcyFactor",
        "crackingPressure",
        "gain",
      ],
      "line",
      ["id", "from", "to", "kind"],
    );
    assertText(e.id, "line.id");
    if (ids.has(e.id)) throw new Error("Duplicate line id");
    ids.add(e.id);
    assertText(e.from, "line.from");
    assertText(e.to, "line.to");
    assertText(e.kind, "line.kind");
    if (!nodes.has(e.from) || !nodes.has(e.to) || e.from === e.to)
      throw new Error("Line requires distinct declared nodes");
    if (!["line", "valve", "relief", "pump"].includes(e.kind))
      throw new Error("Invalid line.kind");
    if (e.kind === "relief" && nodes.get(e.to)!.kind !== "reservoir")
      throw new Error("Relief must return to an explicit reservoir node");
    if (
      (e.kind === "line" &&
        (e.crackingPressure !== undefined || e.gain !== undefined)) ||
      (e.kind !== "pump" && e.gain !== undefined) ||
      (!["valve", "relief"].includes(e.kind) &&
        e.crackingPressure !== undefined)
    )
      throw new Error("Incompatible line fields");
    const flow = q(e.flow, "flow", `${e.id}.flow`, c, 0);
    const from = nodes.get(e.from)!,
      to = nodes.get(e.to)!;
    if (flow === null) {
      from.knownFlows = false;
      to.knownFlows = false;
    } else {
      if (from.balance !== null) from.balance -= flow;
      if (to.balance !== null) to.balance += flow;
    }
    const diameter = q(e.diameter, "length", `${e.id}.diameter`, c, positive),
      length = q(e.length, "length", `${e.id}.length`, c, 0);
    const dead = q(e.deadVolume, "volume", `${e.id}.deadVolume`, c, 0);
    const k = q(e.lossCoefficient, "scalar", `${e.id}.lossCoefficient`, c, 0);
    if (e.frictionModel !== "laminar" && e.frictionModel !== "darcy")
      throw new Error("frictionModel must be laminar or darcy");
    if (e.frictionModel === "laminar" && e.darcyFactor !== undefined)
      throw new Error("laminar excludes darcyFactor");
    const f =
      e.frictionModel === "darcy"
        ? q(e.darcyFactor, "scalar", `${e.id}.darcyFactor`, c, 0)
        : null;
    const cracking = ["valve", "relief"].includes(e.kind)
      ? q(
          e.crackingPressure,
          "pressureDifference",
          `${e.id}.crackingPressure`,
          c,
          0,
        )
      : 0;
    const gain =
      e.kind === "pump"
        ? q(e.gain, "pressureDifference", `${e.id}.gain`, c, 0)
        : 0;
    let drop = null,
      reynolds = null;
    if (
      flow !== null &&
      diameter !== null &&
      length !== null &&
      k !== null &&
      rho !== null &&
      cracking !== null &&
      gain !== null
    ) {
      const area = (Math.PI * diameter ** 2) / 4,
        velocity = flow / area;
      if (mu !== null) reynolds = (rho * velocity * diameter) / mu;
      let frictionDrop = null;
      if (e.frictionModel === "laminar") {
        if (mu === null) c.missing.push(`${e.id}.viscosity`);
        else if (reynolds! > 2300) c.missing.push(`${e.id}.nonlaminarLossLaw`);
        else
          frictionDrop = (128 * mu * length * flow) / (Math.PI * diameter ** 4);
      } else if (f !== null)
        frictionDrop = (((f * length) / diameter) * rho * velocity ** 2) / 2;
      if (frictionDrop !== null)
        drop = frictionDrop + (k * rho * velocity ** 2) / 2 + cracking - gain;
    }
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      kind: e.kind,
      flow,
      drop,
      cracking,
      reynolds,
      closed: ["valve", "relief"].includes(e.kind) && flow === 0,
      volume:
        diameter === null || length === null || dead === null
          ? null
          : ((Math.PI * diameter ** 2) / 4) * length + dead,
    };
  });
  // Propagate prescribed-flow pressure drops from all supplied pressure anchors.
  // Closed check valves impose an inequality, not an equality or fictitious flow.
  let progress = true;
  while (progress) {
    progress = false;
    for (const e of lines) {
      c.tick();
      if (e.drop === null || e.closed) continue;
      const a = nodes.get(e.from)!,
        b = nodes.get(e.to)!;
      if (a.pressure !== null && b.pressure === null) {
        b.pressure = a.pressure - e.drop;
        progress = true;
      } else if (b.pressure !== null && a.pressure === null) {
        a.pressure = b.pressure + e.drop;
        progress = true;
      }
    }
  }
  let failed = false;
  const nodeResults = [...nodes.values()].map((n) => {
    c.tick();
    const residual = n.knownFlows ? n.balance : null;
    if (n.pressure === null) c.missing.push(`${n.id}.pressureAnchor`);
    const valid =
      residual === null || ft === null ? null : Math.abs(residual!) <= ft;
    if (valid === false || (n.pressure !== null && n.pressure < 0))
      failed = true;
    return {
      id: n.id,
      continuityResidual: out(residual, "m3/s"),
      continuityStatus: valid === null ? "unknown" : valid ? "pass" : "fail",
      pressure: out(n.pressure, "Pa(a)"),
    };
  });
  const edgeResults = lines.map((e) => {
    const a = nodes.get(e.from)!.pressure,
      b = nodes.get(e.to)!.pressure;
    const actual = a === null || b === null ? null : a - b;
    const residual =
      actual === null || e.drop === null ? null : actual - e.drop;
    const valid =
      pt === null ||
      actual === null ||
      (e.closed ? e.cracking === null : residual === null)
        ? null
        : e.closed
          ? actual <= e.cracking! + pt
          : Math.abs(residual!) <= pt;
    if (valid === false) failed = true;
    if (valid === null) c.missing.push(`${e.id}.pressureCheck`);
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      kind: e.kind,
      flow: out(e.flow, "m3/s"),
      pressureDrop: out(e.closed ? null : e.drop, "Pa"),
      actualPressureDifference: out(actual, "Pa"),
      pressureResidual: out(e.closed ? null : residual, "Pa"),
      pressureStatus: valid === null ? "unknown" : valid ? "pass" : "fail",
      reynolds: out(e.reynolds, "1"),
      deadVolume: out(e.volume, "m3"),
      closed: e.closed,
    };
  });
  c.limitations.push(
    "Steady incompressible prescribed-flow network, not a flow solver or CFD. Positive externalFlow injects into a node; line flow follows from→to. No elevation head (pressures refer to equal hydraulic datum). Valve/relief flowing law is explicitly cracking offset plus specified resistance; this phenomenological law is not inferred from cracking alone. Reservoir return is explicit. Dead volume is tube volume plus supplied additional cavity volume. No compressibility, cavitation certification or nozzle-dose prediction.",
  );
  return envelope(
    "hydraulic.network",
    data,
    c,
    {
      nodes: nodeResults,
      lines: edgeResults,
      deadVolume: out(
        lines.some((e) => e.volume === null)
          ? null
          : lines.reduce((s, e) => s + e.volume!, 0),
        "m3",
      ),
    },
    failed ? "fail" : "pass",
  );
}
