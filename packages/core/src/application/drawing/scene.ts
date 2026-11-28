import type { Point, Model, View, Dimension, Primitive, Scene } from "./types";
import { fail, measureDimension, collectSources } from "./model";

export function buildScene(model: Model): Scene {
  const primitives: Primitive[] = [];
  const semantics: Scene["semantics"] = {
    sourceMap: { dimensions: {}, items: {}, notes: {} },
  };
  const put = (primitive: Primitive) => primitives.push(primitive);
  const toSheet = (view: View, p: Point): Point => [
    view.origin[0] + p[0] * view.scale,
    view.origin[1] + p[1] * view.scale,
  ];
  const scaleLabel = (s: number) =>
    Number.isInteger(s) ? s + ":1" : "1:" + Math.round((1 / s) * 100) / 100;
  const label = (view: View, extra?: string) => {
    const kindText =
      view.kind === "projection"
        ? (view.orientation || "").toUpperCase()
        : view.kind === "section"
          ? "SECTION " + view.id.toUpperCase()
          : "DETAIL " + view.id.toUpperCase();
    put({
      type: "text",
      at: [view.origin[0], view.origin[1] - 7],
      text:
        kindText + " " + scaleLabel(view.scale) + (extra ? " — " + extra : ""),
      height: 3.5,
      align: "start",
    });
  };
  const hatch = (polygon: Point[], spacing: number, angleDeg: number) => {
    const angle = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(angle),
      sin = Math.sin(angle);
    const rotated = polygon.map((p): Point => [
      p[0] * cos + p[1] * sin,
      -p[0] * sin + p[1] * cos,
    ]);
    const yMin = Math.min(...rotated.map((p) => p[1])),
      yMax = Math.max(...rotated.map((p) => p[1]));
    const lines: Primitive[] = [];
    for (let y = yMin + spacing / 2; y < yMax; y += spacing) {
      const xs: number[] = [];
      for (let i = 0; i < rotated.length; i++) {
        const p1 = rotated[i]!,
          p2 = rotated[(i + 1) % rotated.length]!;
        if ((p1[1] <= y && p2[1] > y) || (p2[1] <= y && p1[1] > y))
          xs.push(p1[0] + ((y - p1[1]) * (p2[0] - p1[0])) / (p2[1] - p1[1]));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const back = (x: number, yy: number): Point => [
          x * cos - yy * sin,
          x * sin + yy * cos,
        ];
        lines.push({
          type: "line",
          from: back(xs[i]!, y),
          to: back(xs[i + 1]!, y),
          width: 0.18,
        });
      }
    }
    lines.forEach(put);
  };
  for (const view of model.views) {
    for (const entity of view.entities) {
      if (entity.kind === "line")
        put({
          type: "line",
          from: toSheet(view, entity.from),
          to: toSheet(view, entity.to),
          width: 0.35,
        });
      else if (entity.kind === "circle")
        put({
          type: "circle",
          center: toSheet(view, entity.center),
          r: entity.r * view.scale,
        });
      else if (entity.kind === "arc")
        put({
          type: "arc",
          center: toSheet(view, entity.center),
          r: entity.r * view.scale,
          startDeg: entity.startDeg,
          sweepDeg: entity.sweepDeg,
        });
      else if (entity.kind === "polyline")
        put({
          type: "polyline",
          points: entity.points.map((p) => toSheet(view, p)),
          closed: entity.closed,
        });
      else if (entity.kind === "hatch")
        hatch(
          entity.boundary.map((p) => toSheet(view, p)),
          entity.spacing * view.scale,
          entity.angleDeg,
        );
      else if (entity.kind === "text")
        put({
          type: "text",
          at: toSheet(view, entity.at),
          text: entity.text,
          height: entity.height * view.scale,
          align: "start",
        });
    }
    label(view);
    if (view.kind === "section") {
      const parent = model.views.find((v) => v.id === view.parent)!;
      const from = toSheet(parent, view.cutFrom!),
        to = toSheet(parent, view.cutTo!);
      put({ type: "line", from, to, width: 0.5 });
      put({
        type: "text",
        at: from,
        text: view.id.toUpperCase(),
        height: 3.5,
        align: "start",
      });
      put({
        type: "text",
        at: to,
        text: view.id.toUpperCase(),
        height: 3.5,
        align: "start",
      });
    } else if (view.kind === "detail") {
      const parent = model.views.find((v) => v.id === view.parent)!;
      put({
        type: "circle",
        center: toSheet(parent, view.detailFrom!),
        r: view.detailRadius! * parent.scale,
      });
    }
  }
  const arrow = (tip: Point, direction: Point) => {
    const size = 2.5;
    const perp: Point = [-direction[1], direction[0]];
    put({
      type: "solid",
      points: [
        tip,
        [
          tip[0] - direction[0] * size + perp[0] * 1,
          tip[1] - direction[1] * size + perp[1] * 1,
        ],
        [
          tip[0] - direction[0] * size - perp[0] * 1,
          tip[1] - direction[1] * size - perp[1] * 1,
        ],
      ],
    });
  };
  const centerMark = (center: Point) => {
    put({
      type: "line",
      from: [center[0] - 1.5, center[1]],
      to: [center[0] + 1.5, center[1]],
      width: 0.18,
    });
    put({
      type: "line",
      from: [center[0], center[1] - 1.5],
      to: [center[0], center[1] + 1.5],
      width: 0.18,
    });
  };
  const dimensionText = (dim: Dimension) => {
    let value;
    if (dim.kind === "angle")
      value = Math.round(((dim.valueRad! * 180) / Math.PI) * 100) / 100 + "°";
    else if (dim.valueMm! !== undefined) value = String(dim.valueMm!);
    else {
      const view = model.views.find((v) => v.id === dim.view)!;
      value =
        Math.round(measureDimension(dim, view) * 1000) / 1000 + " (measured)";
    }
    if (dim.kind === "radius") value = "R" + value;
    if (dim.kind === "diameter") value = "⌀" + value;
    if (dim.toleranceMm)
      value += " +" + dim.toleranceMm.upper + "/" + dim.toleranceMm.lower;
    return value;
  };
  for (const dim of model.dimensions) {
    const view = model.views.find((v) => v.id === dim.view)!;
    const textValue = dimensionText(dim);
    if (dim.kind === "linear") {
      const a = toSheet(view, dim.a!),
        b = toSheet(view, dim.b!);
      const dx = b[0] - a[0],
        dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      const unit: Point = [dx / len, dy / len];
      const perp: Point = [-unit[1], unit[0]];
      const offset = dim.offset! * view.scale;
      const d1: Point = [a[0] + perp[0] * offset, a[1] + perp[1] * offset];
      const d2: Point = [b[0] + perp[0] * offset, b[1] + perp[1] * offset];
      put({
        type: "line",
        from: a,
        to: [a[0] + perp[0] * (offset + 2), a[1] + perp[1] * (offset + 2)],
        width: 0.18,
      });
      put({
        type: "line",
        from: b,
        to: [b[0] + perp[0] * (offset + 2), b[1] + perp[1] * (offset + 2)],
        width: 0.18,
      });
      put({ type: "line", from: d1, to: d2, width: 0.35 });
      arrow(a, unit);
      arrow(b, [-unit[0], -unit[1]]);
      const mid: Point = [(d1[0] + d2[0]) / 2, (d1[1] + d2[1]) / 2];
      put({
        type: "text",
        at: [mid[0] + perp[0] * 1.5, mid[1] + perp[1] * 1.5],
        text: textValue,
        height: 3.5,
        align: "middle",
      });
    } else if (dim.kind === "angle") {
      const vertex = toSheet(view, dim.vertex!),
        a = toSheet(view, dim.a!),
        b = toSheet(view, dim.b!);
      const angleOf = (p: Point) =>
        Math.atan2(p[1] - vertex[1], p[0] - vertex[0]);
      const r =
        Math.min(
          Math.hypot(a[0] - vertex[0], a[1] - vertex[1]),
          Math.hypot(b[0] - vertex[0], b[1] - vertex[1]),
          12,
        ) * 0.6;
      let a0 = angleOf(a),
        a1 = angleOf(b);
      if (a1 < a0) {
        const t = a0;
        a0 = a1;
        a1 = t;
      }
      if (a1 - a0 > Math.PI) {
        a0 += Math.PI * 2;
        const t = a0;
        a0 = a1;
        a1 = t;
      }
      const sweep = ((a1 - a0) * 180) / Math.PI;
      put({
        type: "arc",
        center: vertex,
        r,
        startDeg: (a0 * 180) / Math.PI,
        sweepDeg: sweep,
      });
      const pa: Point = [
        vertex[0] + r * Math.cos(a0),
        vertex[1] + r * Math.sin(a0),
      ];
      const pb: Point = [
        vertex[0] + r * Math.cos(a1),
        vertex[1] + r * Math.sin(a1),
      ];
      arrow(pa, [-Math.sin(a0), Math.cos(a0)]);
      arrow(pb, [Math.sin(a1), -Math.cos(a1)]);
      const midAngle = (a0 + a1) / 2;
      put({
        type: "text",
        at: [
          vertex[0] + (r + 4) * Math.cos(midAngle),
          vertex[1] + (r + 4) * Math.sin(midAngle),
        ],
        text: textValue,
        height: 3.5,
        align: "middle",
      });
    } else {
      const circle = view.entities.find((e) => e.id === dim.circle)!;
      const center = toSheet(view, circle.center!);
      const r = circle.r! * view.scale;
      centerMark(center);
      const angle = (45 * Math.PI) / 180;
      const u: Point = [Math.cos(angle), Math.sin(angle)];
      const onCircle: Point = [center[0] + u[0] * r, center[1] + u[1] * r];
      if (dim.kind === "diameter") {
        const far: Point = [center[0] - u[0] * r, center[1] - u[1] * r];
        put({ type: "line", from: far, to: onCircle, width: 0.35 });
        arrow(far, u);
        arrow(onCircle, [-u[0], -u[1]]);
        put({
          type: "text",
          at: [center[0] - u[0] * 0, center[1] + 3.5 + 1.5],
          text: textValue,
          height: 3.5,
          align: "middle",
        });
      } else {
        put({ type: "line", from: center, to: onCircle, width: 0.35 });
        arrow(onCircle, u);
        put({
          type: "text",
          at: [onCircle[0] + u[0] * 2, onCircle[1] + u[1] * 2],
          text: textValue,
          height: 3.5,
          align: "start",
        });
      }
    }
  }
  for (const datum of model.datums) {
    const view = model.views.find((v) => v.id === datum.view)!;
    const at = toSheet(view, datum.at);
    if (datum.kind === "plane") {
      put({
        type: "rect",
        from: [at[0] - 2.5, at[1] - 2.5],
        to: [at[0] + 2.5, at[1] + 2.5],
      });
    } else {
      put({ type: "circle", center: at, r: 2.5 });
      centerMark(at);
    }
    put({
      type: "text",
      at: [at[0], at[1] - 0.9],
      text: datum.label,
      height: 3.5,
      align: "middle",
    });
  }
  for (const control of model.controls) {
    const view = model.views.find((v) => v.id === control.view)!;
    let local: Point;
    if (control.anchor !== undefined) local = control.anchor;
    else {
      const entity = view.entities.find((e) => e.id === control.target);
      if (entity && (entity.kind === "circle" || entity.kind === "arc"))
        local = [...entity.center];
      else {
        const dim = model.dimensions.find(
          (d) => d.id === control.target && d.view === view.id,
        );
        if (dim && dim.kind === "linear")
          local = [(dim.a![0] + dim.b![0]) / 2, (dim.a![1] + dim.b![1]) / 2];
        else if (dim && dim.kind === "angle") local = [...dim.vertex!];
        else
          fail(
            "control " + control.id + ": anchor required for this target kind",
          );
      }
    }
    const at: Point = [
      toSheet(view, local)[0] + 14,
      toSheet(view, local)[1] + 10,
    ];
    const symbol = (
      {
        flatness: "⏥",
        position: "⌖",
        perpendicularity: "⟂",
        parallelism: "∥",
      } as Record<string, string>
    )[control.kind]!;
    const boxes = [
      symbol,
      String(control.valueMm),
      (control.datums || []).join(" "),
    ];
    const widths = boxes.map((box) => box.length * 2.2 + 4);
    let x = at[0];
    for (let i = 0; i < boxes.length; i++) {
      put({
        type: "rect",
        from: [x, at[1] - 3.5],
        to: [x + widths[i]!, at[1] + 3.5],
      });
      put({
        type: "text",
        at: [x + widths[i]! / 2, at[1] - 1.1],
        text: boxes[i]!,
        height: 3.5,
        align: "middle",
      });
      x += widths[i]!;
    }
    put({ type: "line", from: at, to: toSheet(view, local), width: 0.18 });
  }
  for (const balloon of model.balloons) {
    const view = model.views.find((v) => v.id === balloon.view)!;
    const at = toSheet(view, balloon.at),
      anchor = toSheet(view, balloon.anchor);
    put({ type: "circle", center: at, r: 3.5 });
    put({ type: "line", from: at, to: anchor, width: 0.35 });
    put({
      type: "text",
      at: [at[0], at[1] - 1.1],
      text: String(balloon.item),
      height: 3.5,
      align: "middle",
    });
  }
  for (const note of model.notes)
    put({
      type: "text",
      at: note.at,
      text: note.text,
      height: note.height,
      align: "start",
    });
  for (const dim of model.dimensions)
    semantics.sourceMap.dimensions[dim.id] = dim.source;
  for (const item of model.items)
    semantics.sourceMap.items[String(item.item)] = item.source;
  for (const note of model.notes)
    semantics.sourceMap.notes[note.id] = note.source;
  semantics.items = model.items.map((item) => ({
    item: item.item,
    partId: item.partId,
    description: item.description,
    qty: item.qty,
    purchased: item.purchased,
    source: item.source,
  }));
  semantics.balloons = model.balloons.map((b) => ({
    id: b.id,
    view: b.view,
    item: b.item,
  }));
  semantics.dimensions = model.dimensions.map((d) => ({
    id: d.id,
    view: d.view,
    kind: d.kind,
    valueMm: d.valueMm,
    toleranceMm: d.toleranceMm,
    source: d.source,
  }));
  const [w] = model.sheet.sizeMm;
  put({ type: "rect", from: [w - 120, 6], to: [w - 6, 40] });
  put({ type: "line", from: [w - 120, 28], to: [w - 6, 28], width: 0.35 });
  put({ type: "line", from: [w - 70, 28], to: [w - 70, 40], width: 0.35 });
  put({
    type: "text",
    at: [w - 116, 32],
    text: model.documentIdentity.name,
    height: 3.5,
    align: "start",
  });
  put({
    type: "text",
    at: [w - 116, 14],
    text:
      (model.sheet.titleBlock["drawingNumber"] || "") +
      "  REV " +
      (model.documentIdentity.revision || "-"),
    height: 3,
    align: "start",
  });
  put({
    type: "text",
    at: [w - 66, 32],
    text: model.sheet.titleBlock["scale"] || "",
    height: 3,
    align: "start",
  });
  put({
    type: "text",
    at: [w - 116, 22],
    text: model.sheet.titleBlock["date"] || "",
    height: 3,
    align: "start",
  });
  const statuses = collectSources(model);
  const confirmed = statuses.filter((s) => s.status === "CONFIRMED").length;
  put({
    type: "text",
    at: [6, 6],
    text:
      "fmcad drawing package v1 - provenance: " +
      confirmed +
      " CONFIRMED, " +
      (statuses.length - confirmed) +
      " non-confirmed sources; full map in report.json sourceMap",
    height: 2.5,
    align: "start",
  });
  return {
    schemaVersion: 1,
    sheet: { sizeMm: model.sheet.sizeMm },
    primitives,
    semantics,
  };
}
