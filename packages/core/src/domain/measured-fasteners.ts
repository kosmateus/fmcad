import type { JsonValue } from "./contracts";

export type MeasuredFastenerEntityRef =
  string | Readonly<Record<string, JsonValue>>;

export interface MeasuredFastenerFrame {
  readonly space: "assembly" | "component local";
  readonly component: MeasuredFastenerEntityRef;
}

export interface MeasuredFastenerFrameResult extends MeasuredFastenerFrame {
  readonly status?: "unverified";
}

export interface MeasuredFastenerTolerance {
  readonly axisOffset: string;
  readonly axisAngle: string;
  readonly minimumEngagement?: string;
}

export interface MeasuredFastenerScrewRefs {
  readonly axis?: MeasuredFastenerEntityRef;
  readonly headBearing?: MeasuredFastenerEntityRef;
  readonly tip?: MeasuredFastenerEntityRef;
  readonly threadStart?: MeasuredFastenerEntityRef;
  readonly threadEnd?: MeasuredFastenerEntityRef;
}

export interface MeasuredFastenerReceptacleRefs {
  readonly kind: "blind" | "through" | "tapped" | "insert" | "nut";
  readonly axis?: MeasuredFastenerEntityRef;
  readonly threadStart?: MeasuredFastenerEntityRef;
  readonly threadEnd?: MeasuredFastenerEntityRef;
  readonly bottom?: MeasuredFastenerEntityRef;
}

export interface MeasuredFastenerLayerRefs {
  readonly id?: string;
  readonly start?: MeasuredFastenerEntityRef;
  readonly end?: MeasuredFastenerEntityRef;
}

export interface MeasuredFastenerNativeInput {
  readonly schemaVersion: 1;
  readonly frame: MeasuredFastenerFrame;
  readonly tolerance: MeasuredFastenerTolerance;
  readonly screw: MeasuredFastenerScrewRefs;
  readonly receptacle: MeasuredFastenerReceptacleRefs;
  readonly layers?: readonly MeasuredFastenerLayerRefs[];
}

export interface MeasuredFastenerDeclaredEvidenceInput {
  readonly operation: "fastener.stack" | "fastener.check";
  readonly schemaVersion: 1;
  readonly frame: "component";
  readonly screw: Readonly<Record<string, JsonValue>>;
  readonly stack: readonly Readonly<Record<string, JsonValue>>[];
  readonly [key: string]: JsonValue;
}

export type MeasuredFastenerToolObstacle = {
  readonly name?: string;
} & (
  | {
      readonly point: readonly [string, string, string];
      readonly radius?: string;
      readonly box?: never;
    }
  | {
      readonly point?: never;
      readonly radius?: never;
      readonly box: {
        readonly min: readonly [string, string, string];
        readonly max: readonly [string, string, string];
      };
    }
);

export interface MeasuredFastenerToolAccessInput {
  readonly tool: { readonly diameter: string; readonly length: string };
  readonly target: {
    readonly origin: MeasuredFastenerEntityRef;
    readonly axis: MeasuredFastenerEntityRef;
    readonly engagementDepth?: string;
  };
  readonly entry: {
    readonly origin: MeasuredFastenerEntityRef;
    readonly direction: MeasuredFastenerEntityRef;
  };
  readonly nativeObstacles?: readonly {
    readonly name?: string;
    readonly body: MeasuredFastenerEntityRef;
  }[];
  readonly declaredObstacles?: readonly MeasuredFastenerToolObstacle[];
  readonly minimumClearance?: string;
  readonly samples?: number;
}

export interface MeasuredFastenersCheckInput {
  readonly schemaVersion: 1;
  readonly mode: "native";
  readonly native: MeasuredFastenerNativeInput;
  readonly declaredEvidence?: MeasuredFastenerDeclaredEvidenceInput;
  readonly toolAccess?: MeasuredFastenerToolAccessInput;
}

export interface MeasuredFastenerProvenance {
  readonly source: string;
  readonly sourceRef: JsonValue;
  readonly sourceVersion: 1;
  readonly frame: MeasuredFastenerFrameResult;
  readonly coverage: string;
  readonly documentIdentity?: Readonly<Record<string, JsonValue>>;
}

export interface MeasuredFastenerScalar {
  readonly value: number;
  readonly units: string;
}

export interface MeasuredFastenerMetric {
  readonly status: "measured" | "notEvaluated";
  readonly value?: number | readonly number[];
  readonly units: string;
  readonly sourceVersion: 1;
  readonly provenance: readonly MeasuredFastenerProvenance[];
  readonly missing?: readonly string[];
  readonly method?: string;
}

export interface MeasuredFastenerInterval {
  readonly status: "measured" | "notEvaluated";
  readonly start?: MeasuredFastenerScalar;
  readonly end?: MeasuredFastenerScalar;
  readonly units?: "mm";
  readonly sourceVersion: 1;
  readonly provenance: readonly MeasuredFastenerProvenance[];
  readonly missing?: readonly string[];
  readonly method?: string;
}

export interface MeasuredFastenerAxialLayer {
  readonly id: string;
  readonly status: "measured" | "notEvaluated";
  readonly start?: MeasuredFastenerScalar;
  readonly end?: MeasuredFastenerScalar;
  readonly sourceVersion: 1;
  readonly provenance: readonly MeasuredFastenerProvenance[];
  readonly missing?: readonly string[];
  readonly method?: string;
}

export interface MeasuredFastenerAxisMeasurement {
  readonly status: "measured" | "notEvaluated";
  readonly origin: MeasuredFastenerMetric;
  readonly direction: MeasuredFastenerMetric;
  readonly sourceVersion: 1;
}

export interface MeasuredFastenerBottoming {
  readonly clearance: MeasuredFastenerMetric;
  readonly bottomed: boolean;
}

export interface MeasuredFastenerCoverage {
  readonly status: "complete" | "incomplete";
  readonly frameStatus: "measured" | "unverified";
  readonly missingMeasurements: readonly string[];
  readonly threadRepresentation: string;
}

export interface MeasuredFastenerCheck {
  readonly check: string;
  readonly status: "pass" | "fail" | "unknown" | "notEvaluated";
  readonly message?: string;
  readonly measurement?: MeasuredFastenerMetric;
  readonly axisOffset?: MeasuredFastenerMetric;
  readonly axisAngle?: MeasuredFastenerMetric;
  readonly axisOffsetTolerance?: MeasuredFastenerScalar;
  readonly axisAngleTolerance?: MeasuredFastenerScalar;
  readonly required?: MeasuredFastenerScalar;
  readonly bottomed?: boolean;
  readonly result?: Readonly<Record<string, JsonValue>>;
}

export interface MeasuredFastenerNativeResult {
  readonly schemaVersion: 1;
  readonly sourceVersion: 1;
  readonly frame: MeasuredFastenerFrameResult;
  readonly status: "pass" | "fail" | "unknown";
  readonly measurements: {
    readonly actualEngagement: MeasuredFastenerMetric;
    readonly screwThreadInterval: MeasuredFastenerInterval;
    readonly receptacleThreadInterval: MeasuredFastenerInterval;
    readonly screwAxis: MeasuredFastenerAxisMeasurement;
    readonly receptacleAxis: MeasuredFastenerAxisMeasurement;
    readonly layerAxialIntervals: readonly MeasuredFastenerAxialLayer[];
    readonly protrusion: MeasuredFastenerMetric;
    readonly axisOffset: MeasuredFastenerMetric;
    readonly axisAngle: MeasuredFastenerMetric;
    readonly bottoming: MeasuredFastenerBottoming | null;
  };
  readonly checks: readonly MeasuredFastenerCheck[];
  readonly coverage: MeasuredFastenerCoverage;
  readonly limitations: readonly string[];
}

export interface MeasuredFastenersCheckResult {
  readonly schemaVersion: 1;
  readonly operation: "fastener.measured-check";
  readonly mode: "native";
  readonly status: "pass" | "fail" | "unknown";
  readonly success: boolean;
  readonly frame: MeasuredFastenerFrameResult;
  readonly units: { readonly length: "mm"; readonly angle: "rad" };
  readonly nativeMeasurements: MeasuredFastenerNativeResult;
  readonly declaredEvidence:
    | { readonly status: "notProvided" }
    | {
        readonly status: "reported";
        readonly operation: "fastener.stack" | "fastener.check";
        readonly sourceVersion: 1;
        readonly frame?: Readonly<Record<string, JsonValue>>;
        readonly units?: Readonly<Record<string, JsonValue>>;
        readonly result: Readonly<Record<string, JsonValue>>;
      };
  readonly toolAccess: {
    readonly status: "notEvaluated" | "pass" | "fail" | "unknown";
    readonly complete?: boolean;
    readonly frame?: MeasuredFastenerFrameResult;
    readonly result?: Readonly<Record<string, JsonValue>> | null;
    readonly nativeObstacleEvidence?: readonly Readonly<
      Record<string, JsonValue>
    >[];
    readonly declaredObstacleEvidence?: readonly Readonly<
      Record<string, JsonValue>
    >[];
    readonly coverage?: string;
  };
  readonly checks: readonly MeasuredFastenerCheck[];
  readonly limitations: readonly string[];
}
