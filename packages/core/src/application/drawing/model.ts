import type {
  Point,
  Source,
  EntityFields,
  Entity,
  View,
  Dimension,
  Datum,
  Control,
  Note,
  Item,
  Balloon,
  Fit,
  Sheet,
  Model,
  DrawingInput,
  CheckRow,
} from "./types";

export const OPERATION = "drawing.package";

export const SHEET: Record<string, Point> = {
  A0: [841, 1189],
  A1: [594, 841],
  A2: [420, 594],
  A3: [297, 420],
  A4: [210, 297],
  LETTER: [215.9, 279.4],
};
export const SOURCE_STATUSES = ["CONFIRMED", "ESTIMATED", "OPEN", "DERIVED"];
const LENGTH_UNITS: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};
const ANGLE_UNITS: Record<string, number> = { deg: Math.PI / 180, rad: 1 };
const VIEW_KINDS = ["projection", "section", "detail"];
const ORIENTATIONS = [
  "front",
  "side",
  "rear",
  "top",
  "bottom",
  "left",
  "right",
  "custom",
];
const DIM_KINDS = ["linear", "radius", "diameter", "angle"];
const CONTROL_KINDS = [
  "flatness",
  "position",
  "parallelism",
  "perpendicularity",
];
const NOTE_KINDS = ["material", "process", "general", "finish"];
export const FORMATS = ["svg", "pdf", "dxf"];

export function fail(message: string): never {
  throw new Error(message);
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function text(value: unknown, what = "value"): string {
  if (typeof value !== "string" || !value["trim"]())
    fail("Expected nonempty string for " + what);
  return value;
}
export function safeId(value: unknown, what = "id"): string {
  const id = text(value, what);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))
    fail("Invalid " + what + ": " + id);
  return id;
}
export function number(
  value: unknown,
  minimum?: number,
  what = "number",
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (minimum !== undefined && value < minimum)
  ) {
    fail(
      "Expected finite " +
        what +
        (minimum === undefined ? "" : " >= " + minimum),
    );
  }
  return value;
}
export function quantity(
  value: unknown,
  angle = false,
  what = "quantity",
): number {
  const units = angle ? ANGLE_UNITS : LENGTH_UNITS;
  const match =
    typeof value === "string"
      ? value["trim"]().match(
          /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(mm|cm|m|in|ft|deg|rad)$/,
        )
      : null;
  if (!match || !(match[2]! in units))
    fail(
      "Expected explicit " +
        (angle ? "angle" : "length") +
        " expression for " +
        what,
    );
  return parseFloat(match[1]!) * units[match[2]!]!;
}
export const length = (value: unknown, what?: string) =>
  quantity(value, false, what);
export const angleRad = (value: unknown, what?: string) =>
  quantity(value, true, what);
export function point(value: unknown, what = "point"): Point {
  if (!Array.isArray(value) || value["length"] !== 2)
    fail("Expected [x,y] " + what);
  return [
    number(value[0], undefined, what + " x"),
    number(value[1], undefined, what + " y"),
  ];
}
export function source(value: unknown, what = "source"): Source {
  if (!isObject(value)) fail("Expected " + what + " object");
  text(value["path"], what + ".path");
  if (!SOURCE_STATUSES.includes(value["status"] as string))
    fail("Invalid " + what + ".status");
  if (
    value["status"] === "DERIVED" &&
    (!Array.isArray(value["derivedFrom"]) || !value["derivedFrom"].length)
  )
    fail("DERIVED source requires derivedFrom");
  if (value["status"] !== "DERIVED" && "derivedFrom" in value)
    fail("derivedFrom requires DERIVED status");
  return {
    path: value["path"] as string,
    status: value["status"] as string,
    ...(value["derivedFrom"]
      ? { derivedFrom: value["derivedFrom"] as unknown[] }
      : {}),
  };
}

export function arcEndpoints(entity: Extract<Entity, { kind: "arc" }>) {
  const a0 = (entity.startDeg * Math.PI) / 180;
  const a1 = ((entity.startDeg + entity.sweepDeg) * Math.PI) / 180;
  return [a0, a1].map((a): Point => [
    entity.center[0] + entity.r * Math.cos(a),
    entity.center[1] + entity.r * Math.sin(a),
  ]);
}

function validateEntity(
  value: unknown,
  ids: Set<string>,
  viewId: string,
): Entity {
  if (!isObject(value)) fail("view " + viewId + ": entity must be an object");
  const kind = value["kind"] as string;
  const entity: EntityFields = {};
  if (value["id"] !== undefined) {
    entity.id = safeId(value["id"], "entity id in " + viewId);
    if (ids.has(entity.id)) fail("Duplicate entity id " + entity.id);
    ids.add(entity.id);
  }
  switch (kind) {
    case "line":
      entity.from = point(value["from"]);
      entity.to = point(value["to"]);
      break;
    case "circle":
      entity.center = point(value["center"]);
      entity.r = number(value["r"], 0);
      if (entity.r === 0) fail("circle radius must be positive");
      break;
    case "arc":
      entity.center = point(value["center"]);
      entity.r = number(value["r"], 0);
      entity.startDeg = number(value["startDeg"]);
      entity.sweepDeg = number(value["sweepDeg"], 0);
      if (entity.r === 0 || entity.sweepDeg <= 0 || entity.sweepDeg > 360)
        fail("arc requires positive radius and sweep in (0,360]");
      break;
    case "polyline":
      if (!Array.isArray(value["points"]) || value["points"].length < 2)
        fail("polyline requires at least two points");
      entity.points = value["points"].map((p) => point(p));
      if (value["closed"] !== undefined && typeof value["closed"] !== "boolean")
        fail("polyline closed must be boolean");
      entity.closed = value["closed"] === true;
      break;
    case "hatch":
      if (!Array.isArray(value["boundary"]) || value["boundary"].length < 3)
        fail("hatch boundary requires at least three points");
      entity.boundary = value["boundary"].map((p) => point(p));
      entity.spacing = number(value["spacing"], 0);
      if (entity.spacing === 0) fail("hatch spacing must be positive");
      entity.angleDeg =
        value["angleDeg"] === undefined ? 45 : number(value["angleDeg"]);
      break;
    case "text":
      entity.at = point(value["at"]);
      entity.text = text(value["text"], "entity text");
      entity.height = number(value["height"], 0);
      if (entity.height === 0) fail("text height must be positive");
      break;
    default:
      fail("view " + viewId + ": unsupported entity kind " + kind);
  }
  return { kind, ...entity } as Entity;
}

export function resolvePoint(view: View, spec: unknown, what = "point"): Point {
  if (Array.isArray(spec)) return point(spec, what);
  if (!isObject(spec)) fail("Expected [x,y] or entity reference for " + what);
  const entity =
    view.entities.find((e) => e.id === spec["entity"]) ||
    fail(what + ": unknown entity " + spec["entity"] + " in view " + view.id);
  const role = spec["role"] === undefined ? "center" : text(spec["role"]);
  switch (entity.kind) {
    case "circle":
      if (role !== "center") fail(what + ": circle role must be center");
      return [...entity.center];
    case "arc": {
      if (role === "center") return [...entity.center];
      const ends = arcEndpoints(entity);
      if (role === "start") return ends[0]!;
      if (role === "end") return ends[1]!;
      fail(what + ": arc roles are center, start, end");
    }
    case "line":
      if (role === "start") return [...entity.from];
      if (role === "end") return [...entity.to];
      fail(what + ": line roles are start, end");
    case "polyline":
      if (
        role === "vertex" &&
        Number.isInteger(spec["index"]) &&
        Number(spec["index"]) >= 0 &&
        Number(spec["index"]) < entity.points.length
      )
        return [...entity.points[spec["index"] as number]!];
      fail(what + ": polyline role vertex requires a valid index");
    default:
      fail(what + ": entity kind " + entity.kind + " exposes no points");
  }
}

function validateView(
  value: unknown,
  entityIds: Set<string>,
  viewIds: Set<string>,
  index: number,
  allViews: View[],
): View {
  if (!isObject(value)) fail("view must be an object");
  const id = safeId(value["id"], "view id");
  if (viewIds.has(id)) fail("Duplicate view id " + id);
  viewIds.add(id);
  const kind = value["kind"] as string;
  if (!VIEW_KINDS.includes(kind))
    fail("view " + id + ": unsupported kind " + kind);
  const view = {
    id,
    kind,
    scale:
      value["scale"] === undefined
        ? 1
        : number(value["scale"], 0, "view " + id + " scale"),
    origin: point(value["origin"], "view " + id + " origin"),
  } as View;
  if (view.scale === 0) fail("view " + id + ": scale must be positive");
  if (kind === "projection") {
    const orientation =
      value["orientation"] === undefined
        ? "custom"
        : (value["orientation"] as string);
    if (!ORIENTATIONS.includes(orientation))
      fail("view " + id + ": invalid orientation");
    view.orientation = orientation;
  } else {
    view.parent = safeId(value["parent"], "view " + id + " parent");
    const parent = allViews.slice(0, index).find((v) => v.id === view.parent);
    if (!parent)
      fail(
        "view " + id + ": parent " + view.parent + " must be listed earlier",
      );
    if (kind === "section") {
      view.cutFrom = resolvePoint(parent, value["cutFrom"], "section cutFrom");
      view.cutTo = resolvePoint(parent, value["cutTo"], "section cutTo");
      if (
        view.cutFrom[0] === view.cutTo[0] &&
        view.cutFrom[1] === view.cutTo[1]
      )
        fail("section cut line must have distinct endpoints");
    } else {
      view.detailFrom = resolvePoint(
        parent,
        value["detailFrom"],
        "detail center",
      );
      view.detailRadius = number(value["detailRadius"], 0, "detail radius");
      if (view.detailRadius === 0) fail("detail radius must be positive");
    }
  }
  if (!Array.isArray(value["geometry"]) || !value["geometry"].length)
    fail("view " + id + ": geometry must be nonempty");
  view.entities = value["geometry"].map((e) =>
    validateEntity(e, entityIds, id),
  );
  return view;
}

function findView(views: View[], id: unknown, what: string): View {
  return views.find((v) => v.id === id) || fail(what + ": unknown view " + id);
}

function validateDimension(
  value: unknown,
  views: View[],
  ids: Set<string>,
): Dimension {
  if (!isObject(value)) fail("dimension must be an object");
  const id = safeId(value["id"], "dimension id");
  if (ids.has(id)) fail("Duplicate dimension id " + id);
  ids.add(id);
  const kind = value["kind"] as string;
  if (!DIM_KINDS.includes(kind))
    fail("dimension " + id + ": unsupported kind " + kind);
  const view = findView(views, value["view"], "dimension " + id);
  const dim = {
    id,
    view: view.id,
    kind,
    source: source(value["source"], "dimension " + id + " source"),
    toleranceMm: null,
  } as Dimension;
  if (kind === "linear") {
    dim.a! = resolvePoint(view, value["a"], "dimension " + id + " a");
    dim.b! = resolvePoint(view, value["b"], "dimension " + id + " b");
    dim.offset = number(
      value["offset"] === undefined ? 8 : value["offset"],
      undefined,
      "dimension " + id + " offset",
    );
    dim.valueMm! = length(value["value"], "dimension " + id + " value");
    if (dim.valueMm! <= 0) fail("dimension " + id + ": value must be positive");
  } else if (kind === "angle") {
    dim.vertex! = resolvePoint(
      view,
      value["vertex"],
      "dimension " + id + " vertex",
    );
    dim.a! = resolvePoint(view, value["a"], "dimension " + id + " a");
    dim.b! = resolvePoint(view, value["b"], "dimension " + id + " b");
    dim.valueRad! = angleRad(value["value"], "dimension " + id + " value");
    if (!(dim.valueRad! > 0) || dim.valueRad! > Math.PI)
      fail("dimension " + id + ": angle value must be in (0, 180 deg]");
    if (value["tolerance"] !== undefined)
      fail("dimension " + id + ": angle tolerances are not supported");
  } else {
    const circle =
      view.entities.find(
        (e) => e.id === value["circle"] && e.kind === "circle",
      ) ||
      fail(
        "dimension " +
          id +
          ": circle must reference a circle entity in its view",
      )!;
    dim.circle = circle.id;
    if (value["value"] !== undefined) {
      dim.valueMm! = length(value["value"], "dimension " + id + " value");
      if (dim.valueMm! <= 0)
        fail("dimension " + id + ": value must be positive");
    }
  }
  if (value["tolerance"] !== undefined) {
    if (dim.source.status !== "CONFIRMED")
      fail(
        "dimension " +
          id +
          ": production tolerance requires CONFIRMED source; ESTIMATED/OPEN/DERIVED values must not become production tolerances",
      );
    if (!isObject(value["tolerance"]))
      fail("dimension " + id + ": tolerance must be an object");
    const upper = length(
      value["tolerance"]["upper"],
      "dimension " + id + " tolerance upper",
    );
    const lower = length(
      value["tolerance"]["lower"],
      "dimension " + id + " tolerance lower",
    );
    if (upper < 0 || lower > 0)
      fail("dimension " + id + ": tolerance upper must be >= 0 and lower <= 0");
    dim.toleranceMm = { upper, lower };
  }
  return dim;
}

function validateDatum(raw: unknown, views: View[], ids: Set<string>): Datum {
  const value = raw as Record<string, unknown>;
  const id = safeId(value["id"], "datum id");
  if (ids.has(id)) fail("Duplicate datum id " + id);
  ids.add(id);
  const kind = value["kind"] as string;
  if (!["plane", "axis"].includes(kind))
    fail("datum " + id + ": kind must be plane or axis");
  const view = findView(views, value["view"], "datum " + id);
  const datum = {
    id,
    view: view.id,
    kind,
    at: resolvePoint(view, value["at"], "datum " + id + " at"),
    label:
      value["label"] === undefined
        ? id
        : text(value["label"], "datum " + id + " label"),
    source: source(value["source"], "datum " + id + " source"),
  } as Datum;
  if (kind === "plane") {
    datum.direction =
      value["direction"] === undefined ? "horizontal" : value["direction"];
    if (
      datum.direction !== "horizontal" &&
      datum.direction !== "vertical" &&
      typeof datum.direction !== "number"
    )
      fail(
        "datum " +
          id +
          ": plane direction must be horizontal, vertical or degrees",
      );
  }
  return datum;
}

function validateControl(
  raw: unknown,
  views: View[],
  datumIds: Set<string>,
  dimensions: Dimension[],
  ids: Set<string>,
): Control {
  const value = raw as Record<string, unknown>;
  const id = safeId(value["id"], "control id");
  if (ids.has(id)) fail("Duplicate control id " + id);
  ids.add(id);
  const kind = value["kind"] as string;
  if (!CONTROL_KINDS.includes(kind))
    fail(
      "control " +
        id +
        ": unsupported GD&T kind; supported range: " +
        CONTROL_KINDS.join(", "),
    );
  const view = findView(views, value["view"], "control " + id);
  const control = {
    id,
    view: view.id,
    kind,
    valueMm: length(value["value"], "control " + id + " value"),
    source: source(value["source"], "control " + id + " source"),
  } as Control;
  if (control.valueMm < 0)
    fail("control " + id + ": value must be nonnegative");
  const target = text(value["target"], "control " + id + " target");
  const targetIsEntity = view.entities.some((e) => e.id === target);
  const targetIsDimension = dimensions.some(
    (d) => d.id === target && d.view === view.id,
  );
  if (!targetIsEntity && !targetIsDimension)
    fail(
      "control " + id + ": target must be an entity or dimension in its view",
    );
  control.target = target;
  if (kind === "flatness") {
    if (value["datums"] !== undefined)
      fail("control " + id + ": flatness does not use datums");
  } else {
    if (!Array.isArray(value["datums"]) || !value["datums"].length)
      fail("control " + id + ": " + kind + " requires datum references");
    for (const datum of value["datums"]) {
      const key = text(datum, "control " + id + " datum");
      if (!datumIds.has(key)) fail("control " + id + ": unknown datum " + key);
    }
    control.datums = value["datums"].map((d) => text(d));
  }
  if (value["anchor"] !== undefined)
    control.anchor = resolvePoint(
      view,
      value["anchor"],
      "control " + id + " anchor",
    );
  return control;
}

function validateNote(raw: unknown, ids: Set<string>): Note {
  const value = raw as Record<string, unknown>;
  const id = safeId(value["id"], "note id");
  if (ids.has(id)) fail("Duplicate note id " + id);
  ids.add(id);
  const kind =
    value["kind"] === undefined ? "general" : (value["kind"] as string);
  if (!NOTE_KINDS.includes(kind))
    fail("note " + id + ": unsupported kind " + kind);
  const note = {
    id,
    kind,
    text: text(value["text"], "note " + id + " text"),
    at: point(value["at"], "note " + id + " at"),
    height:
      value["height"] === undefined
        ? 3.5
        : number(value["height"], 0, "note " + id + " height"),
    source: source(value["source"], "note " + id + " source"),
  };
  if (note.height === 0) fail("note " + id + ": height must be positive");
  return note;
}

function validateItem(raw: unknown, numbers: Set<number>): Item {
  const value = raw as Record<string, unknown>;
  const item = number(value["item"], 1, "item number");
  if (!Number.isInteger(item)) fail("item number must be an integer");
  if (numbers.has(item)) fail("Duplicate item number " + item);
  numbers.add(item);
  return {
    item,
    partId: text(value["partId"], "item partId"),
    description: text(value["description"], "item description"),
    qty: number(value["qty"], 1, "item qty"),
    purchased: value["purchased"] === true,
    source: source(value["source"], "item " + item + " source"),
  };
}

function validateBalloon(
  raw: unknown,
  views: View[],
  numbers: Set<number>,
  ids: Set<string>,
  pairs: Set<string>,
): Balloon {
  const value = raw as Record<string, unknown>;
  const id = safeId(value["id"], "balloon id");
  if (ids.has(id)) fail("Duplicate balloon id " + id);
  ids.add(id);
  const view = findView(views, value["view"], "balloon " + id);
  const item = number(value["item"], 1, "balloon " + id + " item");
  if (!Number.isInteger(item))
    fail("balloon " + id + ": item must be an integer");
  if (!numbers.has(item)) fail("balloon " + id + ": unknown item " + item);
  const pair = view.id + ":" + item;
  if (pairs.has(pair))
    fail(
      "Duplicate balloon for item " +
        item +
        " in view " +
        view.id +
        "; balloon to BOM mapping must be unique",
    );
  pairs.add(pair);
  return {
    id,
    view: view.id,
    item,
    at: resolvePoint(view, value["at"], "balloon " + id + " at"),
    anchor: resolvePoint(view, value["anchor"], "balloon " + id + " anchor"),
  };
}

function validateFit(raw: unknown, views: View[], ids: Set<string>): Fit {
  const value = raw as Record<string, unknown>;
  const id = safeId(value["id"], "fit id");
  if (ids.has(id)) fail("Duplicate fit id " + id);
  ids.add(id);
  const view = findView(views, value["view"], "fit " + id);
  const findCircle = (what: string, key: string) => {
    const circle =
      view.entities.find((e) => e.id === value[key] && e.kind === "circle") ||
      fail(
        "fit " +
          id +
          ": " +
          what +
          " must reference a circle entity in its view",
      )!;
    return circle.id;
  };
  const clearance = value["clearance"];
  if (!isObject(clearance)) fail("fit " + id + ": clearance must be an object");
  const minMm = length(clearance["min"], "fit " + id + " min");
  const maxMm = length(clearance["max"], "fit " + id + " max");
  if (minMm < 0 || maxMm < minMm)
    fail("fit " + id + ": clearance requires 0 <= min <= max");
  return {
    id,
    view: view.id,
    shaft: findCircle("shaft", "shaft"),
    bore: findCircle("bore", "bore"),
    clearance: {
      minMm,
      maxMm,
      source: source(clearance["source"], "fit " + id + " clearance source"),
    },
  };
}

function validateSheet(value: unknown): Sheet {
  if (!isObject(value)) fail("sheet must be an object");
  let size: Point;
  if (typeof value["format"] === "string" && SHEET[value["format"]])
    size = [...SHEET[value["format"]]!] as Point;
  else if (value["format"] === "custom")
    size = point(value["custom"], "sheet custom size");
  else fail("sheet format must be A0-A4, LETTER or custom");
  const orientation =
    value["orientation"] === undefined
      ? "landscape"
      : (value["orientation"] as string);
  if (!["landscape", "portrait"].includes(orientation))
    fail("sheet orientation must be landscape or portrait");
  const [a, b] = size;
  if (a <= 0 || b <= 0) fail("sheet size must be positive");
  const titleBlock: Record<string, string> = {};
  if (value["titleBlock"] !== undefined) {
    if (!isObject(value["titleBlock"])) fail("titleBlock must be an object");
    for (const key of ["drawingNumber", "author", "date", "scale"]) {
      if (value["titleBlock"][key] !== undefined)
        titleBlock[key] = text(value["titleBlock"][key], "titleBlock." + key);
    }
  }
  return {
    format: value["format"],
    orientation,
    sizeMm:
      orientation === "portrait"
        ? [Math.min(a, b), Math.max(a, b)]
        : [Math.max(a, b), Math.min(a, b)],
    titleBlock,
  };
}

export function measureDimension(dim: Dimension, view: View): number {
  if (dim.kind === "linear")
    return Math.hypot(dim.b![0] - dim.a![0], dim.b![1] - dim.a![1]);
  if (dim.kind === "angle") {
    const angleOf = (p: Point) =>
      Math.atan2(p[1] - dim.vertex![1], p[0] - dim.vertex![0]);
    let diff = Math.abs(angleOf(dim.b!) - angleOf(dim.a!));
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    return diff;
  }
  const circle = view.entities.find((e) => e.id === dim.circle)!;
  return dim.kind === "radius" ? circle.r! : 2 * circle.r!;
}

export function dimensionStatus(dim: Dimension, measured: number) {
  if (dim.source.status === "OPEN") return "blocked";
  const value = dim.kind === "angle" ? dim.valueRad! : dim.valueMm!;
  const within = dim.toleranceMm
    ? measured >= value + dim.toleranceMm.lower &&
      measured <= value + dim.toleranceMm.upper
    : Math.abs(measured - value) <= 1e-6 * Math.max(1, Math.abs(value));
  if (!within) return "fail";
  return dim.source.status === "CONFIRMED" ? "pass" : "unknown";
}

export function fitStatus(fit: Fit, view: View, axisToleranceMm: number) {
  if (fit.clearance["source"].status === "OPEN") return "blocked";
  const shaft = view.entities.find((e) => e.id === fit.shaft)!;
  const bore = view.entities.find((e) => e.id === fit.bore)!;
  const clearance = bore.r! - shaft.r!;
  if (clearance < fit.clearance["minMm"] || clearance > fit.clearance["maxMm"])
    return "fail";
  const centers = Math.hypot(
    bore.center![0] - shaft.center![0],
    bore.center![1] - shaft.center![1],
  );
  if (centers > axisToleranceMm) return "fail";
  return fit.clearance["source"].status === "CONFIRMED" ? "pass" : "unknown";
}

export function collectSources(model: Model): Source[] {
  return [
    ...model.dimensions.map((d) => d.source),
    ...model.datums.map((d) => d.source),
    ...model.controls.map((c) => c.source),
    ...model.notes.map((n) => n.source),
    ...model.items.map((i) => i.source),
    ...model.fits.map((f) => f.clearance["source"]),
  ];
}

export function checkRows(model: Model): CheckRow[] {
  const rows: CheckRow[] = [];
  const views = model.views;
  const balloonPairs = new Set();
  let balloonsUnique = true;
  for (const balloon of model.balloons) {
    const pair = balloon.view + ":" + balloon.item;
    if (balloonPairs.has(pair)) {
      balloonsUnique = false;
      break;
    }
    balloonPairs.add(pair);
  }
  rows.push({
    id: "balloon-unique",
    kind: "balloon-unique",
    status: balloonsUnique ? "pass" : "fail",
    detail: "Unique balloon ids and one balloon per item per view",
  });
  const itemNumbers = new Set(model.items.map((i) => i.item));
  const balloonMapped = model.balloons.every((b) => itemNumbers.has(b.item));
  rows.push({
    id: "balloon-item-map",
    kind: "balloon-item-map",
    status: balloonMapped ? "pass" : "fail",
    detail: "Every balloon references an item table entry",
  });
  rows.push({
    id: "dimension-membership",
    kind: "dimension-membership",
    status: "pass",
    detail: model.dimensions.length + " dimensions bound to declared views",
  });
  for (const dim of model.dimensions) {
    const view = findView(views, dim.view, "dimension " + dim.id);
    const measured = measureDimension(dim, view);
    const status = dimensionStatus(dim, measured);
    const value =
      dim.kind === "angle"
        ? (dim.valueRad! * 180) / Math.PI + " deg"
        : dim.valueMm! + " mm";
    rows.push({
      id: dim.id,
      kind: "dimension-consistency",
      view: dim.view,
      status,
      detail:
        "declared " +
        value +
        " vs measured " +
        Math.round(measured * 1000) / 1000 +
        (dim.kind === "angle" ? " deg" : " mm"),
    });
    if (dim.toleranceMm)
      rows.push({
        id: dim.id,
        kind: "tolerance-source",
        view: dim.view,
        status: dim.source.status === "CONFIRMED" ? "pass" : "fail",
        detail: "Production tolerance requires CONFIRMED source",
      });
  }
  for (const control of model.controls) {
    const view = findView(views, control.view, "control " + control.id);
    const datumIds = new Set(
      model.datums.filter((d) => d.view === view.id).map((d) => d.id),
    );
    const ok = (control.datums || []).every((d) => datumIds.has(d));
    rows.push({
      id: control.id,
      kind: "control-datums",
      view: control.view,
      status: ok ? "pass" : "fail",
      detail: "Feature control datums exist in the same view",
    });
  }
  for (const fit of model.fits) {
    const view = findView(views, fit.view, "fit " + fit.id);
    const shaft = view.entities.find((e) => e.id === fit.shaft)!;
    const bore = view.entities.find((e) => e.id === fit.bore)!;
    const clearance = bore.r! - shaft.r!;
    rows.push({
      id: fit.id,
      kind: "fit-geometry",
      view: fit.view,
      status: fitStatus(fit, view, model.axisToleranceMm),
      detail:
        "radial clearance " +
        Math.round(clearance * 1000) / 1000 +
        " mm in [" +
        fit.clearance["minMm"] +
        ", " +
        fit.clearance["maxMm"] +
        "] mm",
    });
  }
  for (const item of model.items) {
    if (item.source.status === "OPEN")
      rows.push({
        id: "item-" + item.item,
        kind: "item-source",
        status: "blocked",
        detail: "Item " + item.item + " has an OPEN source",
      });
  }
  rows.push({
    id: "content-completeness",
    kind: "content-completeness",
    status: model.items.length && model.balloons.length ? "pass" : "unknown",
    detail: "Item table and balloons required for production acceptance",
  });
  return rows;
}

export function aggregateStatus(rows: CheckRow[], sources: Source[]) {
  if (
    rows.some((r) => r.status === "blocked") ||
    sources.some((s) => s.status === "OPEN")
  )
    return "blocked";
  if (rows.some((r) => r.status === "fail")) return "fail";
  if (
    rows.some((r) => r.status === "unknown") ||
    sources.some((s) => s.status !== "CONFIRMED")
  )
    return "unknown";
  return "pass";
}

export function buildModel(data: DrawingInput): Model {
  const documentIdentity = isObject(data.documentIdentity)
    ? {
        name: text(data.documentIdentity["name"], "documentIdentity.name"),
        revision:
          data.documentIdentity["revision"] === undefined
            ? ""
            : text(
                data.documentIdentity["revision"],
                "documentIdentity.revision",
              ),
      }
    : fail("documentIdentity must be an object");
  const sheet = validateSheet(data.sheet);
  const entityIds = new Set<string>();
  const viewIds = new Set<string>();
  const views: View[] = [];
  const allViews: View[] = [];
  data.views.forEach((value, index) => {
    const view = validateView(value, entityIds, viewIds, index, allViews);
    allViews.push(view);
    views.push(view);
  });
  const ids = new Set<string>();
  const dimensions = (data.dimensions === undefined ? [] : data.dimensions).map(
    (v) => validateDimension(v, views, ids),
  );
  const datums = (data.datums === undefined ? [] : data.datums).map((v) =>
    validateDatum(v, views, ids),
  );
  const datumIds = new Set(datums.map((d) => d.id));
  const controls = (data.controls === undefined ? [] : data.controls).map((v) =>
    validateControl(v, views, datumIds, dimensions, ids),
  );
  const notes = (data.notes === undefined ? [] : data.notes).map((v) =>
    validateNote(v, ids),
  );
  const numbers = new Set<number>();
  const items = (data.items === undefined ? [] : data.items).map((v) =>
    validateItem(v, numbers),
  );
  const balloonIds = new Set<string>();
  const pairs = new Set<string>();
  const balloons = (data.balloons === undefined ? [] : data.balloons).map((v) =>
    validateBalloon(v, views, numbers, balloonIds, pairs),
  );
  const fits = (data.fits === undefined ? [] : data.fits).map((v) =>
    validateFit(v, views, ids),
  );
  const axisToleranceMm =
    data.axisTolerance === undefined
      ? 0.05
      : length(data.axisTolerance, "axisTolerance");
  return {
    documentIdentity,
    sheet,
    views,
    dimensions,
    datums,
    controls,
    notes,
    items,
    balloons,
    fits,
    axisToleranceMm,
  };
}
