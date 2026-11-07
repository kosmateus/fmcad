import type { JsonValue } from "./contracts";

/** Finite solid evidence only. These DTOs never carry native/temporary handles. */
export type RegionalEntityRef = string | Readonly<Record<string, JsonValue>>;

export interface RegionalFrame {
  readonly space: "assembly" | "component local";
  readonly component: RegionalEntityRef;
}

/** Union(include) minus Union(exclude). Exclusions preserve real solid holes. */
export interface RegionalMask {
  readonly include: readonly RegionalEntityRef[];
  readonly exclude?: readonly RegionalEntityRef[];
}

export interface GeometryDeltaInput {
  readonly schemaVersion?: 1;
  readonly before: RegionalEntityRef;
  readonly after: RegionalEntityRef;
  readonly frame: RegionalFrame;
  readonly allowed?: RegionalMask;
  readonly protected?: RegionalMask;
  readonly operationBudget?: number;
  readonly timeBudgetMs?: number;
}

export interface GeometryCompareRegionInput extends GeometryDeltaInput {
  readonly allowed: RegionalMask;
}

export interface RegionalSolidEvidence {
  readonly empty: boolean;
  readonly volume: number;
  /** A localization envelope, not an occupancy/containment proof. Units: cm. */
  readonly bounds: readonly [readonly number[], readonly number[]] | null;
}

export interface RegionalDeltaEvidence {
  readonly total: RegionalSolidEvidence;
  readonly insideAllowed: RegionalSolidEvidence;
  readonly outsideAllowed: RegionalSolidEvidence;
  readonly insideProtected: RegionalSolidEvidence;
}

export interface RegionalProvenance {
  readonly reference: RegionalEntityRef;
  readonly entityToken: string;
  readonly revisionId: string;
  readonly frame: RegionalFrame;
  readonly transform: readonly number[];
  readonly ownership: "read-only source; private temporary BRep copy";
}

interface RegionalResultBase {
  readonly schemaVersion: 1;
  readonly operation: "geometry.delta" | "geometry.compare-region";
  readonly method: string;
  readonly frame: RegionalFrame;
  readonly units: { readonly length: "cm"; readonly volume: "cm^3" };
  readonly associativity: "snapshot";
  readonly documentIdentity: Readonly<Record<string, unknown>> | null;
  readonly mutation: {
    readonly documentModifiedByOperation: false;
    readonly temporaryCopiesOnly: true;
  };
  readonly limitations: readonly string[];
  readonly budget?: {
    readonly operationsUsed: number;
    readonly operationLimit: number;
    readonly timeLimitMs: number;
    readonly elapsedMs: number;
  };
}

export type RegionalGeometryResult = RegionalResultBase &
  (
    | {
        readonly status: "pass" | "fail";
        readonly passed: boolean;
        readonly success: boolean;
        readonly precision: "pass";
        readonly coverage: "pass";
        readonly delta: {
          readonly removed: RegionalDeltaEvidence;
          readonly added: RegionalDeltaEvidence;
        };
        readonly controls: {
          readonly outsideAllowedUnchanged: boolean;
          readonly protectedUnchanged: boolean;
        };
        readonly comparison: Readonly<Record<string, unknown>>;
        readonly provenance: readonly RegionalProvenance[];
      }
    | {
        readonly status: "unknown";
        readonly passed: null;
        readonly success: false;
        readonly precision: "unknown";
        readonly coverage: "unknown";
        readonly delta: null;
        readonly controls: null;
        readonly comparison: null;
        readonly provenance: readonly [];
        readonly reason: string;
        readonly message: string;
      }
  );
