import type { JsonValue } from "../packages/core/src/domain/contracts";
import type { Reference } from "../src/queue-epoch-lineage";
import type { TestContext } from "node:test";
import type {
  AuditReader,
  AuditWire,
} from "../packages/node-adapters/src/execution/recovery-audit";
import type { RecoveryWireInput } from "../packages/node-adapters/src/execution/recovery-python";
import type {
  EvidenceRef,
  FirstSaveGrant,
  NativeDestination,
  ObservedDocument,
  Publication,
  SavedEpoch,
  SavedMessage,
  SourceIdentity,
} from "../packages/core/src/application/cad/saved-fixture-contracts";

/** Consumed surface of the retained CJS fixtures, which still create their real
 * temporary ledgers and scoped synthetic process evidence. No fixture behavior
 * or admission decisions are replaced by these declarations. */
export interface FirstSaveRequest {
  kind: string;
  clientId: string;
  requestId: string;
  inputFiles: unknown[];
  payload: {
    version: 1;
    kind: "cad";
    operation: string;
    doc: string;
    docId: string;
    docFileId?: string;
    data: Record<string, JsonValue>;
  };
  argv: string[];
}
export interface FixtureState {
  epoch: SavedEpoch & { succession?: Reference };
  data: {
    jobs: Record<string, unknown>;
    paused: boolean;
  };
  pause(value: boolean, reason: string): void;
}
export interface FirstSaveFixture {
  dir: string;
  base: string;
  clientId: string;
  identity: SourceIdentity;
  state: FixtureState;
  clients: Record<string, string> & { native: string };
  p: {
    dir: string;
    state: FixtureState;
    buildHash: string;
    clients(): Record<string, string> & { native: string };
    assertControl(control: unknown): void;
    fence(): void;
  };
  message: Omit<SavedMessage, "jobId">;
  readinessJob: { id: string };
  nativeDestination: NativeDestination;
  request(changes?: Record<string, unknown>): FirstSaveRequest;
  grant(): FirstSaveGrant;
}
export type FirstSaveFixtureFactory = (
  context: TestContext,
  repository: string,
) => FirstSaveFixture;
export interface EvidenceFixture extends Omit<FirstSaveFixture, "grant"> {
  grant: FirstSaveGrant;
  job: { id: string };
  observed: ObservedDocument;
}
export type ControlFixtureFactory = (
  context: TestContext,
  repository: string,
) => FirstSaveFixture | EvidenceFixture;

/** These wire-facing tests deliberately exercise incomplete or malformed input.
 * Preserve the actual JS entrypoint and canonical checked output contract. */
export interface FirstSaveTestApi {
  grantSavedFirstSave(
    ports: FirstSaveFixture["p"],
    message: FirstSaveFixture["message"],
    clientId: string,
  ): FirstSaveGrant;
  firstSaveAdmission(
    epoch: SavedEpoch,
    request: FirstSaveRequest,
    grant: FirstSaveGrant,
    identity: SourceIdentity,
  ): void;
  firstSavePublication(
    grant: FirstSaveGrant,
    reply: unknown,
    observed: unknown,
  ): Publication;
}
export interface FixtureControlPorts {
  dir: string;
  state: FixtureState;
  clients(): Record<string, string>;
  assertControl(control: unknown): void;
  snapshot(): unknown;
  fence(): void;
  auditPorts: object;
  closed(epoch: SavedEpoch): void;
}
export interface FixtureControl {
  probe(message: unknown, clientId: string): Promise<unknown>;
  observe(message: unknown, clientId: string): Promise<unknown>;
  retain(message: unknown, clientId: string): Promise<unknown>;
}
export type FixturePhase = keyof FixtureControl;
export interface ClosedProofTestApi {
  closedEpochProof(
    directory: string,
    epoch: SavedEpoch,
    reference: EvidenceRef,
  ): { proof: Record<string, unknown> };
}
export type RecoveryWireTestApi = Omit<
  typeof import("../src/queue-atomic-recovery-audit"),
  "prepareRecoveryAuditWire"
> & {
  // The wire builder consumes only the prepared artifact; sourceFile/sourceSha256
  // belong to reader preparation and are intentionally absent in direct wires.
  prepareRecoveryAuditWire(
    input: Omit<RecoveryWireInput, "reader"> & {
      reader: Pick<AuditReader, "artifact">;
    },
  ): AuditWire;
};
