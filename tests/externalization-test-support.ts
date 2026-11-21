import type { ExternalizationInput } from "../packages/core/src/application/documents/externalization-input-types";
import type {
  ExternalizationResult,
  ExternalizationPending,
  ExternalizationReceipt,
  ExternalizationState,
  ExternalizationEntry,
} from "../packages/core/src/application/documents/externalization";
export interface InputFixture extends Record<string, unknown> {
  schemaVersion: number;
  operationId: string;
  reportPath: string;
  mode: string;
  phase: string;
  source: ExternalizationInput["source"];
  items: ExternalizationInput["items"];
  destinationDocument?: ExternalizationInput["destinationDocument"];
  extractionGroups?: ExternalizationInput["extractionGroups"];
  expectedInventory: Record<
    string,
    { bodies: number; occurrences: number; history: number }
  > & { module: { bodies: number; occurrences: number; history: number } };
  linearTolerance: string;
  angularTolerance: string;
  volumeTolerance: string;
  save?: boolean;
}
export interface StepPayload extends Record<string, unknown> {
  pending?: ExternalizationPending | null;
  phase: string;
  itemId: string;
  stepId: string;
  copyIntent?: CopyIntent;
  result: ObservedResult;
  manifest: ExternalizationInput;
}
export interface NativeCall extends Record<string, unknown> {
  action: string;
  phase: string;
  itemId: string;
  stepId: string;
  readOnly: boolean;
}
export interface Dependencies {
  fs?: typeof import("node:fs/promises");
  step(
    action: string,
    payload: StepPayload,
    readOnly: boolean,
  ): Promise<Partial<ObservedState> & Record<string, unknown>>;
  refresh?(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export type ExternalApi =
  typeof import("../packages/core/src/application/documents/externalization-input") &
    Pick<
      typeof import("../packages/core/src/application/documents/externalization"),
      "initial" | "completeMigration"
    > & {
      slot(entry: unknown, phase: string): ObservedState;
      restoreKnownPendingEvidence(result: unknown, records: unknown): void;
      preserveKnownCursor(state: unknown, output: unknown): void;
      restoreBlockedCheckpoints(result: unknown, records: unknown): void;
      execute(
        client: unknown,
        input: unknown,
        context: unknown,
        deps?: Dependencies,
      ): Promise<ObservedResult>;
    };
export interface RefreshReceipt extends Record<string, unknown> {
  invocationStatus: string;
  failureStage: string;
  planId: string;
  updates: { method: string }[];
  blocked: { reason: string }[];
}
export interface CopyIntent extends Record<string, unknown> {
  source: unknown;
  component: unknown;
  destination: unknown;
  nonce: string;
  description: string;
  finalDescription: string;
}
export interface ObservedReceipt extends ExternalizationReceipt {
  refreshReceipt?: RefreshReceipt;
}
export interface ObservedState extends ExternalizationState {
  receipt: ObservedReceipt | null;
}
export interface ObservedEntry extends ExternalizationEntry {
  phaseResults: {
    copy: ObservedState;
    verify: { sources: ObservedState; assembly: ObservedState };
    stage: ObservedState;
    retire: ObservedState;
    finalize: ObservedState;
  };
}
export interface ObservedResult extends ExternalizationResult {
  byItem: Record<string, ObservedEntry> & { module: ObservedEntry };
  lifecycleEffects: { type: string; docid?: string }[];
  inspection: {
    invocationStatus: string;
    writerActive: boolean;
    status: string;
    candidateByName: { isComplete: boolean };
  };
}
