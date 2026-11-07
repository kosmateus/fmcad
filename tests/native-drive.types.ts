import type {
  NativeDriveMotionLinkInvocation,
  NativeDriveMotionLinkInput,
  NativeDriveMotionLinkResult,
  NativeDriveInvocation,
  NativeDriveTestInput,
  NativeDriveTestResult,
  FmcadServices,
} from "../src/api";

const input = {
  schemaVersion: 1,
  confirm: true,
  driver: { kind: "joint", name: "Driver" },
  waypoints: [0.02, 0.04, 0.06],
  followers: [
    {
      joint: { kind: "joint", name: "Follower" },
      coordinate: "rotation",
      ratio: -2,
      phase: 0.3,
      tolerance: 0.000001,
    },
  ],
} satisfies NativeDriveTestInput;

const invocation = {
  version: 1,
  kind: "cad",
  operation: "mechanism.drive-test",
  doc: "Synthetic",
  data: input,
} satisfies NativeDriveInvocation;

const linkInput = {
  schemaVersion: 1,
  frame: "component",
  confirm: true,
  jointOne: { kind: "joint", name: "Driver" },
  jointTwo: { kind: "joint", name: "Follower" },
  valueOne: "1 rad",
  valueTwo: "2 rad",
  isReversed: false,
} satisfies NativeDriveMotionLinkInput;

const linkInvocation = {
  version: 1,
  kind: "cad",
  operation: "mechanism.motion-link.create",
  doc: "Synthetic",
  docId: "native-drive-document",
  data: linkInput,
} satisfies NativeDriveMotionLinkInvocation;
const linkResult: NativeDriveMotionLinkResult = {
  schemaVersion: 1,
  operation: "mechanism.motion-link.create",
  status: "pass",
  success: true,
  nativeMotionLink: true,
  motionLink: { kind: "motionLink", token: "created-link" },
  qualified: false,
  readback: { status: "pass", isReversed: false, healthState: 0 },
  createdLinkRetained: true,
  limitations: ["Creation is not solver qualification."],
};

declare const services: FmcadServices;
const receipt = services.execute(invocation, { requestId: "native-drive-request" });
const linkReceipt = services.execute(linkInvocation, { requestId: "native-motion-link-request" });

const capability: NativeDriveTestResult["nativeCapability"] = {
  status: "unknown",
  motionLinkCreation: "separate-operation-not-run",
  qualified: false,
  evidence: "sampling is not native qualification",
};
void [invocation, linkInvocation, linkResult, capability, receipt, linkReceipt];

// @ts-expect-error This mutating experiment requires explicit confirmation.
const unconfirmed: NativeDriveTestInput = { ...input, confirm: false };
// @ts-expect-error waypoints are native numeric radians, not expressions.
const expressionWaypoint: NativeDriveTestInput = { ...input, waypoints: ["0 deg", 0.1] };
// @ts-expect-error Native capability is never reported as qualified by sampling.
const overclaim: NativeDriveTestResult["nativeCapability"] = { ...capability, qualified: true };
void [unconfirmed, expressionWaypoint, overclaim];
