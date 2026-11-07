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
  type EngineeringRuntime,
} from "./common";
const positive = Number.MIN_VALUE;
export function thermal(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(
    data,
    ["heatLoads", "ambient", "contacts", "ambientPath", "maximumTemperature"],
    runtime,
  );
  object(data, [
    ...commonFields,
    ...([
      "heatLoads",
      "ambient",
      "contacts",
      "ambientPath",
      "maximumTemperature",
    ] as const),
  ]);
  const loadIds = new Set<string>();
  const heatLoads = list(data.heatLoads, "heatLoads").map((load) => {
    c.tick();
    object(load, ["id", "power"], "heatLoad", ["id"]);
    assertText(load.id, "heatLoad.id");
    if (loadIds.has(load.id)) throw new Error("Duplicate heatLoad id");
    loadIds.add(load.id);
    return {
      id: load.id,
      power: q(load.power, "power", `${load.id}.power`, c, 0),
    };
  });
  const power = heatLoads.some((l) => l.power === null)
    ? null
    : heatLoads.reduce((s, l) => s + l.power!, 0);
  const ambient = q(data.ambient, "temperature", "ambient", c, 0);
  const maximum =
    data.maximumTemperature === undefined
      ? null
      : q(data.maximumTemperature, "temperature", "maximumTemperature", c, 0);
  let failed = false;
  const ids = new Set<string>();
  const contacts = list(data.contacts, "contacts").map((contact) => {
    c.tick();
    object(
      contact,
      [
        "id",
        "model",
        "contactPresent",
        "resistance",
        "area",
        "thickness",
        "conductivity",
        "compression",
        "gap",
        "allowableCompression",
        "interfaceResistance",
      ],
      "contact",
      ["id", "model"],
    );
    assertText(contact.id, "contact.id");
    if (ids.has(contact.id)) throw new Error("Duplicate contact id");
    ids.add(contact.id);
    if (contact.model !== "pad" && contact.model !== "resistance")
      throw new Error("contact.model must be pad or resistance");
    if (
      contact.contactPresent !== undefined &&
      typeof contact.contactPresent !== "boolean"
    )
      throw new Error("contactPresent must be boolean");
    if (contact.contactPresent === false) failed = true;
    if (contact.contactPresent === undefined)
      c.missing.push(`${contact.id}.contactPresent`);
    let nominal = null,
      low = null,
      high = null,
      compression = null,
      thickness = null,
      sensitivity = null;
    if (contact.model === "resistance") {
      for (const key of [
        "area",
        "thickness",
        "conductivity",
        "compression",
        "gap",
        "allowableCompression",
        "interfaceResistance",
      ] as const)
        if (contact[key]! !== undefined)
          throw new Error(`resistance contact excludes ${key}`);
      nominal =
        low =
        high =
          q(
            contact.resistance,
            "thermalResistance",
            `${contact.id}.resistance`,
            c,
            0,
          );
    } else {
      if (contact.resistance !== undefined)
        throw new Error("pad excludes resistance; use interfaceResistance");
      if (contact.compression !== undefined && contact.gap !== undefined)
        throw new Error("pad accepts compression or gap, not both");
      const area = q(contact.area, "area", `${contact.id}.area`, c, positive),
        free = q(
          contact.thickness,
          "length",
          `${contact.id}.thickness`,
          c,
          positive,
        );
      const conductivity = q(
        contact.conductivity,
        "conductivity",
        `${contact.id}.conductivity`,
        c,
        positive,
      );
      const interfaceR = q(
        contact.interfaceResistance,
        "thermalResistance",
        `${contact.id}.interfaceResistance`,
        c,
        0,
      );
      const range = contact.compression || contact.gap;
      const rangeName = contact.compression ? "compression" : "gap";
      let values = null;
      if (range === undefined) c.missing.push(`${contact.id}.compressionOrGap`);
      else {
        object(
          range,
          ["nominal", "minimum", "maximum"],
          `${contact.id}.${rangeName}`,
        );
        values = (["nominal", "minimum", "maximum"] as const).map((key) =>
          q(
            range[key]!,
            rangeName === "compression" ? "scalar" : "length",
            `${contact.id}.${rangeName}.${key}`,
            c,
            rangeName === "compression" ? 0 : positive,
            rangeName === "compression" ? 1 - Number.EPSILON : Infinity,
          ),
        );
        const [n, a, b] = values as [
          number | null,
          number | null,
          number | null,
        ];
        if (n !== null && a !== null && b !== null && (a > b || n < a || n > b))
          throw new Error("Invalid compression/gap interval");
      }
      if (values && !values.includes(null) && free !== null) {
        const [n, a, b] = values as [number, number, number];
        if (rangeName === "gap") {
          if (b > free) {
            failed = true;
            c.limitations.push(
              `${contact.id}: gap exceeds free pad thickness; contact is not established.`,
            );
          }
          compression = {
            nominal: 1 - n / free,
            minimum: 1 - b / free,
            maximum: 1 - a / free,
          };
          thickness = { nominal: n, minimum: a, maximum: b };
        } else {
          compression = { nominal: n, minimum: a, maximum: b };
          thickness = {
            nominal: free * (1 - n),
            minimum: free * (1 - b),
            maximum: free * (1 - a),
          };
        }
      }
      if (contact.allowableCompression === undefined)
        c.missing.push(`${contact.id}.allowableCompression`);
      else {
        object(
          contact.allowableCompression,
          ["minimum", "maximum"],
          "allowableCompression",
        );
        const a = q(
          contact.allowableCompression.minimum,
          "scalar",
          "allowableCompression.minimum",
          c,
          0,
          1 - Number.EPSILON,
        );
        const b = q(
          contact.allowableCompression.maximum,
          "scalar",
          "allowableCompression.maximum",
          c,
          0,
          1 - Number.EPSILON,
        );
        if (a !== null && b !== null) {
          if (a > b) throw new Error("Invalid allowable compression interval");
          if (
            compression &&
            (compression.minimum < a - 16 * Number.EPSILON ||
              compression.maximum > b + 16 * Number.EPSILON)
          )
            failed = true;
        }
      }
      if (
        thickness &&
        area !== null &&
        conductivity !== null &&
        interfaceR !== null &&
        (!compression || compression.minimum >= 0)
      ) {
        nominal = thickness.nominal / (conductivity * area) + interfaceR;
        low = thickness.minimum / (conductivity * area) + interfaceR;
        high = thickness.maximum / (conductivity * area) + interfaceR;
        sensitivity = {
          resistancePerCompression: out(-free! / (conductivity * area), "K/W"),
          resistancePerConductivity: out(
            -thickness.nominal / (conductivity ** 2 * area),
            "m*K2/W2",
          ),
          resistancePerArea: out(
            -thickness.nominal / (conductivity * area ** 2),
            "K/(W*m2)",
          ),
        };
      }
    }
    if (contact.contactPresent !== true) {
      nominal = low = high = null;
      sensitivity = null;
    }
    return {
      id: contact.id,
      nominal,
      low,
      high,
      compression,
      thickness,
      sensitivity,
    };
  });
  let ambientR = null;
  if (data.ambientPath === undefined) c.missing.push("ambientPath");
  else {
    object(
      data.ambientPath,
      ["model", "resistance", "coefficient", "area"],
      "ambientPath",
      ["model"],
    );
    if (data.ambientPath.model === "resistance") {
      if (
        data.ambientPath.coefficient !== undefined ||
        data.ambientPath.area !== undefined
      )
        throw new Error("Ambient resistance excludes convection fields");
      ambientR = q(
        data.ambientPath.resistance,
        "thermalResistance",
        "ambientPath.resistance",
        c,
        0,
      );
    } else if (data.ambientPath.model === "convection") {
      if (data.ambientPath.resistance !== undefined)
        throw new Error("Ambient convection excludes resistance");
      const h = q(
          data.ambientPath.coefficient,
          "convection",
          "ambientPath.coefficient",
          c,
          positive,
        ),
        a = q(data.ambientPath.area, "area", "ambientPath.area", c, positive);
      ambientR = h === null || a === null ? null : 1 / (h * a);
    } else
      throw new Error("ambientPath.model must be resistance or convection");
  }
  const sum = (key: "nominal" | "low" | "high") =>
    contacts.some((t) => t[key]! === null)
      ? null
      : contacts.reduce((s, t) => s + t[key]!, 0);
  const total = (key: "nominal" | "low" | "high") => {
    const value = sum(key);
    return ambientR === null || value === null ? null : ambientR + value;
  };
  const temperature = (resistance: number | null) =>
    resistance === null || power === null || ambient === null
      ? null
      : number(ambient + power * resistance, "temperature", 0);
  let downstream = ambientR;
  const contactResults = [...contacts]
    .reverse()
    .map((t) => {
      c.tick();
      const cold = temperature(downstream);
      downstream =
        t.nominal === null || downstream === null
          ? null
          : downstream + t.nominal;
      return {
        id: t.id,
        resistance: out(t.nominal, "K/W"),
        minimumResistance: out(t.low, "K/W"),
        maximumResistance: out(t.high, "K/W"),
        compression:
          t.compression &&
          Object.fromEntries(
            Object.entries(t.compression).map(([k, v]) => [k, out(v, "1")]),
          ),
        installedThickness:
          t.thickness &&
          Object.fromEntries(
            Object.entries(t.thickness).map(([k, v]) => [k, out(v, "m")]),
          ),
        coldTemperature: out(cold, "K"),
        hotTemperature: out(temperature(downstream), "K"),
        sensitivity: t.sensitivity,
      };
    })
    .reverse();
  const hottest = temperature(total("high"));
  if (maximum !== null && hottest !== null && hottest > maximum) failed = true;
  c.limitations.push(
    "Steady 1D series thermal path; all heat loads enter the same hot node and traverse every contact. Constant conductivity and area; compression changes thickness only. No spreading resistance unless supplied explicitly. Compression bounds are conditional on nominal material/load data. No CFD/FEA, transient, radiation or thermal certification.",
  );
  return envelope(
    "thermal.contact-budget",
    data,
    c,
    {
      heatLoads: heatLoads.map((l) => ({ id: l.id, power: out(l.power, "W") })),
      heatLoad: out(power, "W"),
      contacts: contactResults,
      contactResistance: out(sum("nominal"), "K/W"),
      ambientResistance: out(ambientR, "K/W"),
      totalResistance: out(total("nominal"), "K/W"),
      sourceTemperature: out(temperature(total("nominal")), "K"),
      minimumSourceTemperature: out(temperature(total("low")), "K"),
      maximumSourceTemperature: out(hottest, "K"),
      sensitivity: {
        temperaturePerPower: out(total("nominal"), "K/W"),
        temperaturePerResistance: out(power, "W"),
      },
      heatRejected:
        ambientR === null || sum("nominal") === null || ambient === null
          ? null
          : out(power, "W"),
    },
    failed
      ? "fail"
      : maximum === null
        ? "notEvaluated"
        : hottest === null
          ? "unknown"
          : "pass",
  );
}
