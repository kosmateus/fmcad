import type { JsonValue } from "./contracts";

export type SectionWitnessEntityRef =
  string | Readonly<Record<string, JsonValue>>;

export interface SectionWitnessFrame {
  readonly space: "assembly" | "component local";
  readonly component: SectionWitnessEntityRef;
}

export interface SectionWitnessLimits {
  readonly stations?: number;
  readonly edges?: number;
  readonly kernelCalls?: number;
  readonly bytes?: number;
  readonly timeMs?: number;
}

export interface SectionSeriesInput {
  readonly body: SectionWitnessEntityRef;
  readonly frame: SectionWitnessFrame;
  readonly origin: readonly [string, string, string];
  readonly normal: readonly [number, number, number];
  readonly stations: readonly string[];
  readonly limits?: SectionWitnessLimits;
}

export interface WitnessCheckInput {
  readonly body: SectionWitnessEntityRef;
  readonly witness: SectionWitnessEntityRef;
  readonly frame: SectionWitnessFrame;
  readonly expect: "material" | "void";
  readonly volumeTolerance: string;
  readonly limits?: Pick<
    SectionWitnessLimits,
    "kernelCalls" | "bytes" | "timeMs"
  >;
}

export interface SectionWitnessLoop {
  readonly role: "outer" | "inner";
  readonly closed: true;
  readonly area: number;
  readonly diameter: number | null;
  readonly equivalentAreaDiameter: number;
  readonly curves: readonly Readonly<Record<string, JsonValue>>[];
}

export interface SectionWitnessStation {
  readonly index: number;
  readonly offset: number;
  readonly status: "complete" | "unknown";
  readonly loops: readonly SectionWitnessLoop[] | null;
  readonly area: number | null;
  readonly equivalentAreaDiameter?: number;
  readonly reason?: string;
}

export interface SectionSeriesResult {
  readonly schemaVersion: 1;
  readonly operation: "measure.section-series";
  readonly status: "complete" | "unknown";
  readonly frame: SectionWitnessFrame;
  readonly associativity: "snapshot";
  readonly affected: readonly JsonValue[];
  readonly warnings: readonly string[];
  readonly method: string;
  readonly units: {
    readonly length: "cm";
    readonly area: "cm^2";
    readonly volume: "cm^3";
    readonly angle: "rad";
  };
  readonly precision: "kernel";
  readonly precisionDetail: {
    readonly method: "native BRep kernel";
    readonly exact: false;
    readonly kernelTolerance: string;
  };
  readonly origin: readonly number[];
  readonly normal: readonly number[];
  readonly stations: readonly SectionWitnessStation[];
  readonly coverage: "partial" | "unknown";
  readonly coverageDetail: {
    readonly kind: "discrete stations only";
    readonly continuous: false;
    readonly requested: number;
    readonly complete: number;
  };
  readonly kernelCalls: number;
  readonly limitations: readonly string[];
}

interface WitnessCheckResultBase {
  readonly schemaVersion: 1;
  readonly operation: "measure.witness-check";
  readonly frame: SectionWitnessFrame;
  readonly associativity: "snapshot";
  readonly affected: readonly JsonValue[];
  readonly warnings: readonly string[];
  readonly method: string;
  readonly expect: "material" | "void";
  readonly coverage: "pass" | "unknown";
  readonly coverageDetail: {
    readonly kind: "finite solid Boolean";
    readonly sampled: false;
  };
  readonly witnessVolume: number;
  readonly volumeTolerance: number;
  readonly units: {
    readonly length: "cm";
    readonly area: "cm^2";
    readonly volume: "cm^3";
    readonly angle: "rad";
  };
  readonly precision: "kernel";
  readonly precisionDetail: {
    readonly method: "native BRep kernel";
    readonly exact: false;
    readonly kernelTolerance: string;
  };
  readonly kernelCalls: number;
  readonly limitations: readonly string[];
}

export type WitnessCheckResult = WitnessCheckResultBase &
  (
    | {
        readonly status: "pass" | "fail";
        readonly passed: boolean;
        readonly residualVolume: number;
      }
    | {
        readonly status: "unknown";
        readonly passed: null;
        readonly residualVolume: null;
        readonly reason: string;
      }
  );
