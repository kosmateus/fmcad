import type { OperationDeclaration } from "@fmcad/core";
import type { CommandManual } from "./library-help-manual";
import { validate, execute } from "./library-reference";

const inputs = {
  layout: {
    schemaVersion: "1",
    original:
      "Source {path,status:CONFIRMED|ESTIMATED|OPEN|DERIVED,sha256?,revision?,uncertaintyPx,derivedFrom?}. Paths are CLI-local, relative to cwd.",
    frame:
      "Right-handed {name,origin:[length,length,length],xAxis:[number,number,number],yAxis:[number,number,number]}.",
    views:
      'Nonempty [{id,orientation:front|side|rear|top|bottom|left|right|custom,crop:[x,y,width,height],rotation:"0 deg",mirrorX?:boolean,camera:{projection:orthographic|perspective|unknown,orientation,frame,eye?,target?,up?}}]. Crop pixels use original raster coordinates.',
    conflicts:
      "Optional [{views:[id,...],reason,source}] recording known contradictions; never silently reconciled.",
    out: "NEW output directory with existing parent.",
  },
  calibrate: {
    schemaVersion: "1",
    layout:
      "Existing layout report.json; original and crop hashes are rechecked.",
    dimension:
      "One common {id,value:length expression,uncertainty:length expression,source:{path,status,derivedFrom?}}. OPEN is unresolved.",
    controls:
      "One per view being calibrated: {view,segment:[[originalX,originalY],[originalX,originalY]],anchor:[length,length],angle:angle expression}. All segments represent the SAME dimension; ONE least-squares scale is fitted across all views.",
    checks:
      "Optional [{id,view,segment,dimension}] independent dimensional checks; never used to refit.",
    tolerance:
      "Nonnegative length expression for residuals, excluding explicitly reported source uncertainty.",
    out: "NEW output directory with existing parent.",
  },
  compare: {
    schemaVersion: "1",
    calibration:
      "Existing calibration report.json; source chain and crop hashes are rechecked.",
    comparisons:
      "Nonempty [{view,render,camera,renderToView?:3x3 positive similarity,landmarks?:[{id,reference:[originalX,originalY],render:[x,y]}],referenceMask?:path,renderMask?:path,roiMask?:path,tolerancePx:number}]. Masks are binary 0/255; reference mask uses original raster, ROI uses oriented view raster. Render is a caller-captured model image; camera must describe it honestly.",
    out: "NEW output directory with existing parent.",
  },
};
const descriptors: Record<string, OperationDeclaration> = Object.fromEntries(
  Object.entries(inputs).map(([mode, fields]) => [
    `reference.${mode}`,
    {
      summary: `GM05 local reference ${mode}; source-preserving image artifacts and explicit uncertainty. No Fusion/backend.`,
      required: Object.keys(fields).filter(
        (k) => !["conflicts", "checks"].includes(k),
      ),
      inputs: {
        ...fields,
        python:
          "Optional local Python executable with Pillow, NumPy and SciPy; default python3. No installation or shell.",
      },
      readOnly: true,
      offline: true,
      nodeOnly: true,
      requiresDoc: false,
      usage: `reference ${mode} --file request.json [--python EXE] [--json] [--preview]`,
      example: {
        schemaVersion: 1,
        ...{
          layout: {
            original: {
              path: "source.png",
              status: "ESTIMATED",
              uncertaintyPx: 2,
            },
            frame: {
              name: "root",
              origin: ["0 mm", "0 mm", "0 mm"],
              xAxis: [1, 0, 0],
              yAxis: [0, 1, 0],
            },
            views: [
              {
                id: "front",
                orientation: "front",
                crop: [0, 0, 100, 200],
                rotation: "0 deg",
                camera: {
                  projection: "unknown",
                  orientation: "front",
                  frame: "root",
                },
              },
            ],
          },
          calibrate: {
            layout: "layout/report.json",
            dimension: {
              id: "height",
              value: "250 mm",
              uncertainty: "5 mm",
              source: { path: "brief.md", status: "ESTIMATED" },
            },
            controls: [
              {
                view: "front",
                segment: [
                  [50, 0],
                  [50, 199],
                ],
                anchor: ["0 mm", "0 mm"],
                angle: "90 deg",
              },
            ],
            tolerance: "1 mm",
          },
          compare: {
            calibration: "calibration/report.json",
            comparisons: [
              {
                view: "front",
                render: "front.png",
                camera: {
                  projection: "unknown",
                  orientation: "front",
                  frame: "root",
                },
                landmarks: [{ id: "tip", reference: [50, 0], render: [50, 0] }],
                tolerancePx: 2,
              },
            ],
          },
        }[mode],
        out: `${mode}-output`,
      },
      limitations: [
        "Paths resolve against invocation cwd. Output must not exist; partial I/O failures remain. --preview validates outer fields only; execution performs full image/schema validation.",
        "No automatic orthographic reconstruction, lens correction, vendor geometry scaling, native Canvas insertion or live acceptance. Native handoff: insert crop via UI, inspect its plane coordinates, then reuse reference image calibrate.",
        "See docs/GM05.md for coordinate transforms, masks, uncertainty, statuses and live handoff.",
      ],
    },
  ]),
);

function configure(catalog: Record<string, OperationDeclaration>) {
  Object.assign(catalog, descriptors);
  const image = catalog["reference.image"]!;
  image.required = ["mode", "ref"];
  image.inputs["mode"] =
    "calibrate (legacy plane-coordinate contract) or inspect (only mode/ref).";
  image.inputs["source"] =
    "Optional calibrate provenance {path,sha256,status,uncertainty,derivedFrom?}; records caller evidence, not pixel-to-canvas verification.";
  image.limitations.push(
    "GM05 inspect returns actual Canvas transform; source-aware calibration retains provenance and warns for non-confirmed sources. See docs/GM05.md.",
  );
}

const manuals: Record<string, CommandManual> = Object.fromEntries(
  Object.entries(descriptors).map(([operation, spec]) => [
    operation,
    {
      sections: [
        {
          title: "Local Return Contract",
          text: "Versioned GM05 envelope: success/status/operation/documentIdentity:null/result/created/affected/units/frame/associativity:snapshot/warnings/method/limitations/provenance/nativeAcceptance:notEvaluated. Files are CLI-local. pass refers only to declared image checks; physical geometry is never certified. fail/blocked returns CLI exit 1; unknown/notEvaluated remains a successful computation with unresolved evidence.",
        },
        {
          title: "Source And Coordinate Contract",
          text: "Read docs/GM05.md. Original bytes and SHA-256 are retained, with oriented crops and forward/inverse transforms. Raw stored raster pixel centers: integer x-right/y-down, no implicit EXIF transpose. A single shared least-squares scale fits common control segments. Masks are explicit binary rasters. Camera mismatch, missing measurements, uncertainty and perspective remain visible. NEW output directory only. Native Canvas work requires the live handoff.",
        },
      ],
      examples: [
        {
          label: operation + " local request",
          requires:
            "Existing source files and Pillow/NumPy/SciPy in the selected Python environment. Example paths and control points must be replaced with measured inputs.",
          data: spec.example,
          output:
            "Full report.json and requested image artifacts. Inspect status, checks/conflicts, provenance and nativeAcceptance.",
        },
      ],
      audit: {
        sources: [
          "src/reference.js",
          "assets/reference_images.py",
          "assets/cad/reference.py",
          "docs/GM05.md",
        ],
        verified: [
          "Local source-preserving raster processing",
          "shared scale and independent residuals",
          "image overlay/landmark/silhouette computation",
          "offline routing without backend",
        ],
        tests: [
          "tests/reference.test.js",
          "tests/reference_images_test.py",
          "tests/reference_native_test.py",
        ],
        gaps: [],
        bugs: [
          "Native canvas insertion, pixel-to-plane mapping and Fusion readback require live acceptance. Camera/source declarations are caller evidence, not authenticated metrology. Generated main command docs are deferred to the integration owner.",
        ],
      },
    },
  ]),
);

export { configure, validate, execute, descriptors, manuals };
