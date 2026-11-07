import type { JsonValue } from "./contracts";

export type SelectionRuleCardinalityRange =
  | { readonly min: number; readonly max?: number }
  | { readonly min?: never; readonly max: number };

export interface SelectionRuleQueryFields {
  readonly schemaVersion?: 1;
  readonly kind: string;
  readonly frame?: JsonValue;
  readonly filters?: Readonly<Record<string, JsonValue>>;
  readonly expect: number | SelectionRuleCardinalityRange;
  readonly groupBy?: readonly string[];
}

type SelectionRuleNestedScope =
  | {
      readonly component: JsonValue;
      readonly occurrence?: JsonValue;
      readonly body?: JsonValue;
      readonly feature?: never;
    }
  | {
      readonly component?: JsonValue;
      readonly occurrence: JsonValue;
      readonly body?: JsonValue;
      readonly feature?: never;
    }
  | {
      readonly component?: JsonValue;
      readonly occurrence?: JsonValue;
      readonly body: JsonValue;
      readonly feature?: never;
    }
  | {
      readonly component?: JsonValue;
      readonly occurrence?: JsonValue;
      readonly body?: never;
      readonly feature: JsonValue;
    };

export type SelectionRuleQuery = SelectionRuleQueryFields &
  (
    | {
        readonly component: JsonValue;
        readonly occurrence?: JsonValue;
        readonly scope?: never;
        readonly instances?: boolean;
      }
    | {
        readonly component?: JsonValue;
        readonly occurrence: JsonValue;
        readonly scope?: never;
        readonly instances?: boolean;
      }
    | {
        readonly component?: never;
        readonly occurrence?: never;
        readonly scope: SelectionRuleNestedScope;
        readonly instances?: boolean;
      }
    | {
        readonly component?: JsonValue;
        readonly occurrence?: JsonValue;
        readonly scope?: never;
        readonly instances: true;
      }
  );

export interface SelectionRuleDefinitionInput {
  readonly schemaVersion?: 1;
  readonly ruleId: string;
  readonly query: SelectionRuleQuery;
  readonly exclude?: readonly Readonly<Record<string, JsonValue>>[];
}

export interface SelectionRuleArtifactReference {
  readonly [key: string]: JsonValue;
  readonly version: 1;
  readonly artifactId: string;
  readonly projectId: string;
  readonly documentFileId: string;
  readonly documentCreationId: string | null;
  readonly sha256: string;
}

export type SelectionRuleResolutionStatus =
  "resolved" | "split" | "merge" | "missing" | "stale" | "ambiguous";
