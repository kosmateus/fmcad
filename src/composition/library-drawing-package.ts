import { createRequire } from "node:module";
import type { OperationDeclaration } from "@fmcad/core";
const load = createRequire(__filename);
const {
  createDrawingPackage,
  digest,
}: typeof import("../../packages/node-adapters/src/persistence/drawing-package.js") =
  load("../node-adapters/persistence/drawing-package.js");
const {
  envelope,
}: typeof import("../../packages/core/src/application/drawing/report.js") =
  load("../core/application/drawing/report.js");
const {
  buildScene,
}: typeof import("../../packages/core/src/application/drawing/scene.js") = load(
  "../core/application/drawing/scene.js",
);
const {
  OPERATION,
  SOURCE_STATUSES,
  FORMATS,
  fail,
  text,
  safeId,
  number,
  quantity,
  length,
  angleRad,
  point,
  source,
  arcEndpoints,
  resolvePoint,
  measureDimension,
  dimensionStatus,
  fitStatus,
  collectSources,
  checkRows,
  aggregateStatus,
}: typeof import("../../packages/core/src/application/drawing/model.js") = load(
  "../core/application/drawing/model.js",
);

const model: typeof import("../../packages/core/src/application/drawing/model.js") =
  load("../core/application/drawing/model.js");
const SHEET: typeof model.SHEET = model.SHEET;

const inputs = {
  package: {
    schemaVersion: "Required 1.",
    representation:
      "Optional external (default) or native. native is blocked with the manual workflow; never silently replaced by external artifacts.",
    documentIdentity:
      "Required {name, revision?}: declared model/revision identity of the drawing package.",
    sheet:
      "Required {format:A0-A4|LETTER|custom, orientation?:landscape|portrait (default landscape), custom?:[w,h], titleBlock?:{drawingNumber?,author?,date?,scale?}}.",
    views:
      "Required nonempty [{id,kind:projection|section|detail,orientation?(projection),parent?(section/detail; listed earlier),cutFrom/cutTo?(section, parent-local),detailFrom/detailRadius?(detail, parent-local),scale?,origin:[sheet mm],geometry:[entities]}]. Entities: line{from,to}, circle{center,r}, arc{center,r,startDeg,sweepDeg}, polyline{points,closed?}, hatch{boundary,spacing,angleDeg?}, text{at,text,height}; optional ids. View-local mm.",
    dimensions:
      "Optional [{id,view,kind:linear|radius|diameter|angle, points as [x,y] or {entity,role,index?}, value unit expression (optional for radius/diameter), offset?(linear), tolerance?:{upper,lower} (CONFIRMED source only), source:{path,status}}].",
    datums:
      "Optional [{id,view,kind:plane|axis,at,label?,direction? (plane),source}].",
    controls:
      "Optional GD&T frames [{id,view,kind:flatness|position|parallelism|perpendicularity,target,value,datums? (required except flatness),anchor?,source}].",
    notes:
      "Optional [{id,text,kind:material|process|general|finish,at:[sheet mm],height?,source}].",
    items:
      "Optional item table [{item,qty,partId,description,purchased?,source}].",
    balloons:
      "Optional [{id,view,item,at,anchor}]; unique balloon ids and one balloon per item per view.",
    fits: "Optional axis/hole pairs [{id,view,shaft,bore,clearance:{min,max,source}}]; both circles in the same view.",
    axisTolerance: "Optional concentricity length, default 0.05 mm.",
    out: "NEW output directory with existing parent.",
  },
  check: {
    schemaVersion: "Required 1.",
    package:
      "Existing drawing.package report.json; identity and scene hashes are rechecked.",
    out: "NEW output directory with existing parent.",
  },
  export: {
    schemaVersion: "Required 1.",
    package:
      "Existing drawing.package report.json; identity and scene hashes are rechecked.",
    formats: "Nonempty unique subset of [svg, pdf, dxf].",
    out: "NEW output directory with existing parent.",
  },
};

const packageExample = {
  schemaVersion: 1,
  documentIdentity: { name: "Seal Subassembly", revision: "A" },
  sheet: {
    format: "A3",
    titleBlock: { drawingNumber: "CW-100", scale: "1:1" },
  },
  views: [
    {
      id: "front",
      kind: "projection",
      orientation: "front",
      scale: 1,
      origin: [40, 40],
      geometry: [
        {
          id: "plate",
          kind: "polyline",
          points: [
            [0, 0],
            [60, 0],
            [60, 40],
            [0, 40],
          ],
          closed: true,
        },
        { id: "bore", kind: "circle", center: [30, 20], r: 5 },
        { id: "shaft", kind: "circle", center: [30, 20], r: 3 },
      ],
    },
  ],
  dimensions: [
    {
      id: "width",
      view: "front",
      kind: "linear",
      a: [0, 0],
      b: [60, 0],
      offset: -10,
      value: "60 mm",
      tolerance: { upper: "0.1 mm", lower: "-0.1 mm" },
      source: { path: "specs/seal.json", status: "CONFIRMED" },
    },
    {
      id: "bore-dia",
      view: "front",
      kind: "diameter",
      circle: "bore",
      value: "10 mm",
      source: { path: "specs/seal.json", status: "CONFIRMED" },
    },
  ],
  items: [
    {
      item: 1,
      partId: "P020",
      description: "Housing",
      qty: 1,
      source: { path: "BOM.csv", status: "CONFIRMED" },
    },
  ],
  balloons: [
    {
      id: "b1",
      view: "front",
      item: 1,
      at: [70, 55],
      anchor: { entity: "plate", role: "vertex", index: 2 },
    },
  ],
  fits: [
    {
      id: "seal-fit",
      view: "front",
      shaft: "shaft",
      bore: "bore",
      clearance: {
        min: "1.9 mm",
        max: "2.1 mm",
        source: { path: "tolerance-strategy.md", status: "CONFIRMED" },
      },
    },
  ],
  out: "drawing-output",
};

const familyDescriptors: Record<string, OperationDeclaration> =
  Object.fromEntries(
    Object.entries(inputs).map(([mode, fields]) => [
      "drawing." + mode,
      {
        summary: `GM35 local drawing ${mode}; external SVG/PDF/DXF artifacts with semantic dimensions, item table, balloons and source map. No Fusion/backend.`,
        required: Object.keys(fields).filter(
          (key) =>
            ![
              "representation",
              "dimensions",
              "datums",
              "controls",
              "notes",
              "items",
              "balloons",
              "fits",
              "axisTolerance",
            ].includes(key),
        ),
        inputs: fields,
        readOnly: true,
        offline: true,
        nodeOnly: true,
        requiresDoc: false,
        usage: `drawing ${mode} --file request.json [--json]`,
        example:
          mode === "package"
            ? packageExample
            : mode === "check"
              ? {
                  schemaVersion: 1,
                  package: "drawing-output/report.json",
                  out: "check-output",
                }
              : {
                  schemaVersion: 1,
                  package: "drawing-output/report.json",
                  formats: ["svg", "pdf", "dxf"],
                  out: "export-output",
                },
        limitations: [
          "No native Fusion Drawing authoring or associativity; the native gate stays blocked and documented in docs/DRAWING.md.",
          "GD&T supported range is datum features plus flatness/position/parallelism/perpendicularity; other controls are rejected.",
          "ESTIMATED sources never become production tolerances; OPEN sources block the package. Artifacts are 2D sheet evidence, not 3D model certification.",
        ],
      },
    ]),
  );

const descriptors = {
  "drawing.package": familyDescriptors["drawing.package"]!,
};
const workflow = createDrawingPackage(descriptors);
const validate: ReturnType<typeof createDrawingPackage>["validate"] =
  workflow.validate;
const execute: ReturnType<typeof createDrawingPackage>["execute"] =
  workflow.execute;
const outputDirectory: ReturnType<
  typeof createDrawingPackage
>["outputDirectory"] = workflow.outputDirectory;
const readPackage: ReturnType<typeof createDrawingPackage>["readPackage"] =
  workflow.readPackage;

const manuals = Object.fromEntries(
  Object.entries(familyDescriptors).map(([operation, spec]) => [
    operation,
    {
      sections: [
        {
          title: "Local Return Contract",
          text: "Versioned GM35 envelope: success/status/operation/documentIdentity/result/created/affected/units/frame/associativity:snapshot/warnings/provenance/method/limitations/nativeAcceptance:notEvaluated. pass means all declared checks passed with only CONFIRMED sources; unknown means unresolved evidence; blocked means OPEN sources or a native request; fail means a violated check. Only fail/blocked exits nonzero.",
        },
        {
          title: "Geometry And Source Contract",
          text: "View-local geometry is declared in mm; sheet placement is view.origin + geometry * view.scale. Dimensions resolve endpoints from coordinates or entity references (circle center, arc center/start/end, line start/end, polyline vertex). Item table entries carry qty/partId/description/purchased and a source with CONFIRMED/ESTIMATED/OPEN/DERIVED status. Balloons must be unique per item per view and always reference an item. ESTIMATED/DERIVED values cannot carry production tolerances; OPEN sources block. See docs/DRAWING.md.",
        },
        {
          title: "Native Drawing Gate",
          text: "Native Drawing authoring is blocked: no public SDK path is claimed. The external SVG/PDF/DXF package is the explicit alternative; the report documents the manual native workflow. Nothing is ever silently replaced by a screenshot or a static render.",
        },
      ],
      examples: [
        {
          label: operation + " local request",
          requires:
            "A new output directory parent and, for check/export, an existing drawing.package report. Example paths/values are placeholders.",
          data: spec.example,
          output:
            "Full report.json plus scene.json (package), checks (check), or sheet.svg/sheet.pdf/sheet.dxf with a manifest (export).",
        },
      ],
      audit: {
        sources: [
          "src/drawing-package.js",
          "src/drawing-check.js",
          "src/drawing-export.js",
          "docs/DRAWING.md",
        ],
        verified: [
          "External SVG/PDF/DXF emission with dimensions, balloons and item table",
          "balloon-to-BOM uniqueness, fit and dimension-vs-geometry checks",
          "source status policy (ESTIMATED never a tolerance, OPEN blocks)",
          "offline routing without backend",
        ],
        tests: ["tests/drawing.test.ts", "tests/drawing_test.py"],
        gaps: [],
        bugs: [
          "Native Fusion drawing authoring is an open SDK gate. Text metrics for PDF centering use Helvetica approximations. DXF R12 carries no units or line types; source maps live in report.json and DXF comments.",
        ],
      },
    },
  ]),
);

export {
  descriptors,
  familyDescriptors,
  validate,
  execute,
  manuals,
  OPERATION,
  SHEET,
  FORMATS,
  SOURCE_STATUSES,
  fail,
  text,
  safeId,
  number,
  quantity,
  length,
  angleRad,
  point,
  source,
  digest,
  arcEndpoints,
  resolvePoint,
  measureDimension,
  dimensionStatus,
  fitStatus,
  collectSources,
  checkRows,
  aggregateStatus,
  buildScene,
  envelope,
  outputDirectory,
  readPackage,
};
