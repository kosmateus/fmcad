import type { JsonValue } from "./contracts";

export type NativeDriveEntityRef =
  | string
  | Readonly<Record<string, JsonValue>>;

export interface NativeDriveFollowerInput {
  readonly joint: NativeDriveEntityRef;
  readonly coordinate: "rotation" | "slide";
  /** radians/radian for rotation, centimetres/radian for slide */
  readonly ratio: number;
  /** radians for rotation, centimetres for slide */
  readonly phase: number;
  readonly tolerance: number;
}

export interface NativeDriveTestInput {
  readonly schemaVersion: 1;
  readonly confirm: true;
  readonly driver: NativeDriveEntityRef;
  /** Absolute driver angles in radians; bounded adjacent increments. */
  readonly waypoints: readonly number[];
  readonly followers: readonly NativeDriveFollowerInput[];
  readonly budgetSeconds?: number;
  readonly driverTolerance?: number;
  readonly restoreTolerance?: number;
}

export interface NativeDriveMotionLinkInput {
  readonly schemaVersion: 1;
  readonly frame: "component";
  readonly confirm: true;
  readonly jointOne: NativeDriveEntityRef;
  readonly jointTwo: NativeDriveEntityRef;
  /** Positive angle expression passed unchanged to MotionLinkInput.valueOne. */
  readonly valueOne: string;
  /** Positive angle expression passed unchanged to MotionLinkInput.valueTwo. */
  readonly valueTwo: string;
  readonly isReversed?: boolean;
}

export interface NativeDriveMotionLinkResult {
  readonly schemaVersion: 1;
  readonly operation: "mechanism.motion-link.create";
  readonly status: "pass" | "fail" | "blocked" | "unknown";
  readonly success: boolean;
  readonly nativeMotionLink: boolean;
  readonly motionLink?: NativeDriveEntityRef;
  readonly reason?: string;
  readonly readback?: {
    readonly status: "pass" | "fail" | "unknown";
    readonly joints?: Readonly<{
      readonly jointOne: NativeDriveEntityRef;
      readonly jointTwo: NativeDriveEntityRef;
    }>;
    readonly motions?: Readonly<{ readonly jointOne: number; readonly jointTwo: number }>;
    readonly values?: Readonly<{
      readonly jointOne: { readonly value: number; readonly expression: string | null; readonly units: "rad" };
      readonly jointTwo: { readonly value: number; readonly expression: string | null; readonly units: "rad" };
    }>;
    readonly isReversed?: boolean;
    readonly isSuppressed?: boolean;
    readonly healthState?: number;
    readonly errorOrWarningMessage?: string | null;
    readonly errors?: readonly string[];
  };
  readonly qualified: false;
  readonly createdLinkRetained?: boolean;
  readonly documentIdentity?: { readonly creationId: string; readonly name: string };
  readonly limitations: readonly string[];
}

export interface NativeDrivePose {
  readonly joints: Readonly<
    Record<string, { readonly rotation?: number; readonly slide?: number }>
  >;
  readonly transforms: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
}

export interface NativeDriveTestResult {
  readonly schemaVersion: 1;
  readonly operation: "mechanism.drive-test";
  readonly status: "pass" | "fail";
  readonly passed: boolean;
  readonly outcome: "complete" | "cancelled" | "budget-exceeded" | "error";
  readonly commandedMathTrack: readonly {
    readonly index: number;
    readonly driver: number;
    readonly followers: readonly number[];
  }[];
  readonly actualSolver: {
    readonly status: "pass" | "fail" | "unknown";
    readonly samples: readonly {
      readonly index: number;
      readonly actual: NativeDrivePose;
      readonly unwrappedPhase: Readonly<Record<string, number>>;
      readonly driverResidual: number;
      readonly followerResiduals: readonly number[];
      readonly passed: boolean;
    }[];
  };
  readonly nativeCapability: {
    readonly status: "unknown";
    readonly motionLinkCreation: "separate-operation-not-run";
    readonly qualified: false;
    readonly evidence: string;
  };
  readonly capture: NativeDrivePose;
  readonly documentIdentity?: {
    readonly creationId: string;
    readonly name: string;
  };
  readonly observations?: {
    readonly joints: Readonly<Record<string, NativeDriveEntityRef>>;
    readonly occurrences: Readonly<Record<string, NativeDriveEntityRef>>;
  };
  readonly restore: {
    readonly status: "pass" | "fail" | "unknown";
    readonly readback: NativeDrivePose | null;
    readonly errors: readonly string[];
  };
  readonly errors: readonly string[];
  readonly units: {
    readonly rotation: "rad";
    readonly slide: "cm";
    readonly transformTranslation: "cm";
  };
  readonly limitations: readonly string[];
}
