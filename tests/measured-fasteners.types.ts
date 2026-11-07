import type {
  MeasuredFastenersCheckInput,
  MeasuredFastenersCheckResult,
  MeasuredFastenersInvocation,
} from "../src/api";

const request = {
  schemaVersion: 1,
  mode: "native",
  native: {
    schemaVersion: 1,
    frame: {
      space: "assembly",
      component: { kind: "component", name: "root" },
    },
    tolerance: {
      axisOffset: "0.05 mm",
      axisAngle: "1 deg",
      minimumEngagement: "4 mm",
    },
    screw: {
      axis: { kind: "axis", name: "ScrewAxis" },
      headBearing: { kind: "point", name: "HeadBearing" },
      tip: { kind: "point", name: "ScrewTip" },
      threadStart: { kind: "point", name: "ScrewThreadStart" },
      threadEnd: { kind: "point", name: "ScrewThreadEnd" },
    },
    receptacle: {
      kind: "blind",
      axis: { kind: "axis", name: "HoleAxis" },
      threadStart: { kind: "point", name: "HoleThreadStart" },
      threadEnd: { kind: "point", name: "HoleThreadEnd" },
      bottom: { kind: "point", name: "HoleBottom" },
    },
    layers: [
      {
        id: "bracket",
        start: { kind: "point", name: "StackNear" },
        end: { kind: "point", name: "StackFar" },
      },
    ],
  },
  declaredEvidence: {
    operation: "fastener.check",
    schemaVersion: 1,
    frame: "component",
    screw: { length: "12 mm", threadLength: "10 mm" },
    stack: [{ id: "bracket", thickness: "5 mm" }],
    minimumEngagement: "4 mm",
  },
  toolAccess: {
    tool: { diameter: "4 mm", length: "30 mm" },
    target: {
      origin: { kind: "point", name: "HeadBearing" },
      axis: { kind: "axis", name: "ScrewAxis" },
    },
    entry: {
      origin: { kind: "point", name: "ToolEntry" },
      direction: { kind: "axis", name: "ToolApproach" },
    },
    nativeObstacles: [
      { name: "Wall", body: { kind: "body", name: "WallBody" } },
    ],
    declaredObstacles: [
      {
        name: "Fixture",
        box: {
          min: ["-5 mm", "-5 mm", "8 mm"],
          max: ["5 mm", "5 mm", "12 mm"],
        },
      },
    ],
  },
} satisfies MeasuredFastenersCheckInput;

const invocation = {
  version: 1,
  kind: "cad",
  operation: "fastener.measured-check",
  doc: "Synthetic",
  data: request,
} satisfies MeasuredFastenersInvocation;

const blocked: MeasuredFastenersCheckResult["status"] = "fail";
const measured: MeasuredFastenersCheckResult["nativeMeasurements"]["measurements"]["actualEngagement"] =
  {
    status: "measured",
    value: 3,
    units: "mm",
    sourceVersion: 1,
    provenance: [
      {
        source: "Fusion native entity geometry",
        sourceRef: { kind: "point", name: "ScrewThreadEnd" },
        sourceVersion: 1,
        frame: request.native.frame,
        coverage: "selected axial boundary",
      },
    ],
  };

void [invocation, blocked, measured];

// @ts-expect-error Native mode cannot silently become declared-only arithmetic.
const badMode: MeasuredFastenersCheckInput = { ...request, mode: "declared" };
const badFrame: MeasuredFastenersCheckInput = {
  ...request,
  // @ts-expect-error Versioned native inputs require an explicit coordinate frame.
  native: { ...request.native, frame: undefined },
};
void [badMode, badFrame];
