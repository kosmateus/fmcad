import type {
  ConsoleArtifactLocator,
  ConsoleQueryReadPort,
} from "../packages/control-center/src/server/query/port.js";
import type {
  ConsoleArtifactChannel,
  ConsoleLogRecord as ContractLogRecord,
} from "../packages/control-center/src/contracts/query.js";
import { createConsoleArtifactReader } from "../packages/node-adapters/src/control-center/artifact-reader.js";
import type { ConsoleArtifactLocator as NodeArtifactLocator } from "../packages/node-adapters/src/control-center/artifact-reader.js";

type Reference = Parameters<ConsoleQueryReadPort["readArtifact"]>[0];
const reader = createConsoleArtifactReader({
  projectRoot: () => null,
  queueDirectory: "/private/queue",
});
const readArtifact: ConsoleQueryReadPort["readArtifact"] = reader.readArtifact;
declare const retainedLocator: NodeArtifactLocator;
const locator: ConsoleArtifactLocator = retainedLocator;
const stdoutChannel: ConsoleArtifactChannel = {
  state: "available",
  artifactId: "stdout-artifact",
  sourceHash: "a".repeat(64),
  provenance: "retained-owned-result",
};
const numericLog: ContractLogRecord = {
  id: "log",
  timestamp: 1_798_024_320_000,
};
const retainedRawTime: ContractLogRecord = {
  id: "log-raw-time",
  timestamp: 1_798_024_320_000,
  timestampRaw: "2026-10-30T00:00:00Z",
};
const unknownTimeLog: ContractLogRecord = {
  id: "log-unknown",
  timestamp: null,
};
type AssertFalse<T extends false> = T;
type IsoTimestampRejected = AssertFalse<
  string extends ContractLogRecord["timestamp"] ? true : false
>;
void locator;
void stdoutChannel;
void numericLog;
void retainedRawTime;
void unknownTimeLog;
const isoTimestampRejected: IsoTimestampRejected = false;
void isoTimestampRejected;
declare const reference: Reference;
void reference;
void readArtifact;
