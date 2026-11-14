import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { createRequire } from "node:module";
import type { OperationDeclaration } from "../packages/core/src/catalog";
import type {
  SavedEpoch,
  SourceIdentity,
} from "../packages/core/src/application/cad/saved-fixture-contracts";

const load = createRequire(__filename);
const { readJson, hash, buildHash } = load("./queue-instance") as {
  readJson(file: string): unknown;
  hash(value: string): string;
  buildHash(): string;
};
const { fileHash, exclusive } = load(
  "./queue-atomic-migration-files",
) as typeof import("./queue-atomic-migration-files");
const { resolveRuntimePaths } = load(
  "./dist/config-platform",
) as typeof import("../packages/node-adapters/src/config-platform/runtime-paths");
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: unknown): Record<string, unknown> {
  return record(value) ? value : {};
}
const REGIONAL_OPERATIONS = [
  "document.status",
  "entity.inspect",
  "entity.list",
  "geometry.compare-region",
  "measure.volume",
  "shape.box",
  "shape.cylinder",
  "shape.ring",
  "snapshot",
];
export type FixtureContract = {
  fixtureId: string;
  manifestSha256: string;
} & (
  | {
      kind: "fixed-run-v1";
      operations: [];
      script: string;
      scriptSha256: string;
      helperVersion: string;
    }
  | { kind: "typed-cad-v1"; operations: string[] }
);
export function fixtureContract(fixtureId: unknown): FixtureContract {
  const installation = resolveRuntimePaths({ anchor: __filename }).installation;
  if (
    typeof fixtureId === "string" &&
    [
      "containment-program-v1",
      "sections-program-v1",
      "sketch-proof-program-v1",
      "measured-fasteners-program-v1",
      "drive-motion-program-v1",
      "drive-precision-program-v1",
      "gm12-spring-program-v1",
      "gm07-curves-program-v1",
      "data-import-program-v1",
    ].includes(fixtureId)
  ) {
    const name = fixtureId.slice(0, -"-program-v1".length);
    const file = path.join(
      installation,
      "assets/native-qualification/" + name + "-program.json",
    );
    const fixture = fields(readJson(file));
    const script = "assets/native-qualification/" + name + ".py";
    if (
      fixture["version"] !== 1 ||
      fixture["fixtureId"] !== fixtureId ||
      fixture["kind"] !== "fixed-run-v1" ||
      fixture["script"] !== script ||
      fixture["helperVersion"] !== "cad-v1" ||
      !same(fixture["argumentKeys"], [
        "approved",
        "creationId",
        "expectedFusionVersion",
        "fixturePrefix",
      ])
    )
      fail(
        "NATIVE_FIXTURE_CHANGED",
        "Installed fixed program differs from its bounded source contract",
      );
    return {
      fixtureId,
      kind: "fixed-run-v1",
      operations: [],
      manifestSha256: fileHash(file).sha256,
      script,
      scriptSha256: fileHash(path.join(installation, script)).sha256,
      helperVersion: "cad-v1",
    };
  }
  if (fixtureId !== "regional-geometry-v1")
    fail(
      "NATIVE_FIXTURE_UNSUPPORTED",
      "Only explicitly registered native fixtures are supported",
    );
  const file = path.join(
    installation,
    "assets/native-qualification/regional-geometry.json",
  );
  const fixture = fields(readJson(file));
  if (
    fixture["version"] !== 1 ||
    fixture["fixtureId"] !== fixtureId ||
    !same(fixture["operations"], REGIONAL_OPERATIONS)
  )
    fail(
      "NATIVE_FIXTURE_CHANGED",
      "Installed fixture operations differ from the bounded source contract",
    );
  const { catalog } = load("./catalog") as {
    catalog: Record<string, OperationDeclaration | undefined>;
  };
  const { isTransactional } = load("./batch-atomic") as {
    isTransactional(
      operation: string,
      declaration: OperationDeclaration,
    ): boolean;
  };
  for (const operation of REGIONAL_OPERATIONS) {
    const declaration = catalog[operation];
    if (!declaration || !isTransactional(operation, declaration))
      fail(
        "NATIVE_FIXTURE_CHANGED",
        "Every fixture operation must retain its typed transactional scope",
      );
  }
  return {
    fixtureId,
    kind: "typed-cad-v1",
    operations: [...REGIONAL_OPERATIONS],
    manifestSha256: fileHash(file).sha256,
  };
}
export interface GrantPorts {
  dir: string;
  buildHash: string;
  state: {
    epoch: SavedEpoch | null;
    assertEpoch(): void;
    data: {
      jobs: Record<string, unknown>;
      active?: unknown;
      blocked?: unknown;
      lease?: unknown;
      localUnknown?: unknown;
      controlBlocked?: unknown;
    };
  };
  clients(): Record<string, string>;
  assertControl(value: unknown): void;
  fence(): void;
}
function onlySuccessfulReadinessQueries(
  jobs: Record<string, unknown>,
  epoch: SavedEpoch,
): boolean {
  return Object.values(jobs).every((value) => {
    const job = fields(value),
      payload = fields(fields(job["request"])["payload"]),
      dispatch = fields(job["dispatch"]);
    const count = dispatch["rpcCount"];
    return (
      job["state"] === "succeeded" &&
      fields(job["details"])["sdkSettled"] === true &&
      job["kind"] === "command" &&
      payload["kind"] === "cad" &&
      (payload["operation"] === "document.status" ||
        payload["operation"] === "snapshot") &&
      payload["doc"] === epoch.document.name &&
      payload["docId"] === epoch.document.creationId &&
      !job["sequenceId"] &&
      typeof count === "number" &&
      count > 0 &&
      dispatch["completedCount"] === count
    );
  });
}
// This grants an exact operation/source scope, never arbitrary Python or file work.
export function grantNativeFixture(
  p: GrantPorts,
  input: unknown,
  clientId: string,
) {
  if (
    !record(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          "action",
          "auth",
          "control",
          "epochId",
          "grantClientId",
          "fixtureId",
          "requestId",
        ].includes(key),
    ) ||
    input["action"] !== "grant-native-fixture" ||
    typeof input["requestId"] !== "string" ||
    !input["requestId"].trim() ||
    input["requestId"].length > 180
  )
    fail(
      "INVALID_REQUEST",
      "Exact fixture, epoch, registered client and stable grant request are required",
    );
  const epoch = p.state.epoch,
    clients = p.clients();
  if (
    !epoch ||
    clientId !== epoch.ownerClientId ||
    clients[clientId] !== epoch.ownerTokenHash
  )
    fail(
      "NOT_OWNER",
      "Only the original scratch owner may issue native fixture scope",
    );
  p.state.assertEpoch();
  p.assertControl(input["control"]);
  p.fence();
  const { epochControlDirectory } = load("./queue-epoch-lineage") as {
    epochControlDirectory(dir: string, epoch: SavedEpoch): string;
  };
  const controlRoot = epochControlDirectory(p.dir, epoch);
  if (fs.existsSync(path.join(epoch.root, "saved-first-save-scope.json")))
    fail(
      "SAVED_FIRST_SAVE_PENDING",
      "First-save transition forbids unrelated native fixture authority",
    );
  if (
    fs.existsSync(
      path.join(controlRoot, "isolated-scratch-close", "intent.json"),
    )
  )
    fail(
      "EPOCH_CLEANUP_PENDING",
      "Cleanup closes all new fixture authority even after an uncertain reply",
    );
  const grantee = input["grantClientId"];
  if (
    input["epochId"] !== epoch.epochId ||
    typeof grantee !== "string" ||
    !Object.hasOwn(clients, grantee) ||
    !/^[a-f0-9]{64}$/.test(clients[grantee] ?? "") ||
    grantee === epoch.ownerClientId
  )
    fail(
      "NATIVE_FIXTURE_CLIENT_REQUIRED",
      "A separate registered fixture client and exact new epoch are required",
    );
  const clientTokenHash = clients[grantee];
  if (!clientTokenHash)
    fail(
      "NATIVE_FIXTURE_CLIENT_REQUIRED",
      "A separate registered fixture client and exact new epoch are required",
    );
  const identity = fields(readJson(path.join(epoch.root, "instance.json")));
  const sourceCommit = identity["sourceCommit"];
  if (
    identity["buildHash"] !== p.buildHash ||
    p.buildHash !== buildHash() ||
    typeof sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(sourceCommit)
  )
    fail(
      "BUILD_CHANGED",
      "The native fixture grant must pin this exact qualified runtime",
    );
  const fixture = fixtureContract(input["fixtureId"]);
  const grant = {
    epochId: epoch.epochId,
    clientId: grantee,
    clientTokenHash,
    document: epoch.document,
    nativeFixture: {
      version: 1,
      ...fixture,
      requestId: input["requestId"],
      sourceCommit,
      buildHash: p.buildHash,
    },
  };
  const file = path.join(
    epoch.root,
    "access-" + hash(grant.clientId + "\0" + grant.clientTokenHash) + ".json",
  );
  const result = {
    epochId: epoch.epochId,
    clientId: grant.clientId,
    document: epoch.document,
    nativeFixture: grant.nativeFixture,
  };
  if (fs.existsSync(file)) {
    if (!same(readJson(file), grant))
      fail(
        "GRANT_SCOPE_CONFLICT",
        "Never silently broaden or replace an existing scratch grant",
      );
    return result;
  }
  if (
    !onlySuccessfulReadinessQueries(p.state.data.jobs, epoch) ||
    p.state.data.active ||
    p.state.data.blocked ||
    p.state.data.lease ||
    p.state.data.localUnknown ||
    p.state.data.controlBlocked
  )
    fail(
      "NATIVE_FIXTURE_FRESH_EPOCH_REQUIRED",
      "A fresh scratch permits only settled typed readiness queries, never prior model work or unknown execution",
    );
  const proof = fields(readJson(epoch.qualificationReceipt.path)),
    summary = fields(proof["summary"]);
  if (
    fileHash(epoch.qualificationReceipt.path).sha256 !==
      epoch.qualificationReceipt.sha256 ||
    proof["status"] !== "complete" ||
    summary["independent"] !== true ||
    summary["empty"] !== true ||
    summary["unsaved"] !== true ||
    !same(summary["document"], epoch.document)
  )
    fail(
      "NATIVE_FIXTURE_FRESH_EPOCH_REQUIRED",
      "Known independent empty unsaved creation proof required",
    );
  exclusive(file, grant);
  return result;
}
export function validateFixtureGrant(
  grant: unknown,
  identity: unknown,
): FixtureContract | null {
  const scope = fields(grant)["nativeFixture"];
  if (!scope) return null;
  const approved = fields(scope),
    current = fields(identity);
  const fixture = fixtureContract(approved["fixtureId"]);
  if (
    typeof current["buildHash"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(current["buildHash"]) ||
    typeof current["sourceCommit"] !== "string" ||
    !/^[a-f0-9]{40}$/.test(current["sourceCommit"]) ||
    approved["version"] !== 1 ||
    approved["buildHash"] !== current["buildHash"] ||
    approved["sourceCommit"] !== current["sourceCommit"] ||
    (approved["kind"] || "typed-cad-v1") !== fixture.kind ||
    !same(approved["operations"], fixture.operations) ||
    approved["manifestSha256"] !== fixture.manifestSha256 ||
    (fixture.kind === "fixed-run-v1" &&
      (approved["script"] !== fixture.script ||
        approved["scriptSha256"] !== fixture.scriptSha256 ||
        approved["helperVersion"] !== fixture.helperVersion))
  )
    fail(
      "NATIVE_FIXTURE_CHANGED",
      "The exact owner-approved fixture source/build must remain current; never promote an old scope implicitly",
    );
  return fixture;
}
export function fixtureGrantOperations(
  grant: unknown,
  identity: SourceIdentity,
): string[] | null {
  const fixture = validateFixtureGrant(grant, identity);
  if (!fixture) return null;
  if (fixture.kind !== "typed-cad-v1")
    fail(
      "NATIVE_FIXTURE_SCOPE_REQUIRED",
      "This fixture grants only its fixed program, not arbitrary catalog operations",
    );
  return fixture.operations;
}
interface FixtureClient {
  call(
    action: "queue-summary",
  ): Promise<{
    control?: {
      buildHash: string;
      instanceId: string;
      generation: number;
      contextEpoch: number;
    };
  }>;
  call(
    action: "grant-native-fixture",
    input: Record<string, unknown>,
  ): Promise<unknown>;
}
export async function nativeFixtureAction(
  client: FixtureClient,
  options: Record<string, unknown>,
  codeHash: string,
): Promise<unknown> {
  const status = await client.call("queue-summary");
  if (status.control?.buildHash !== codeHash)
    fail(
      "BUILD_CHANGED",
      "CLI and broker must share the exact qualified runtime",
    );
  const { instanceId, generation, contextEpoch } = status.control;
  return client.call("grant-native-fixture", {
    ...options,
    control: { instanceId, generation, contextEpoch, buildHash: codeHash },
  });
}
