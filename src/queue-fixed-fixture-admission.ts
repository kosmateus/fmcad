import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const { readJson } = load("./queue-instance") as {
  readJson(file: string): unknown;
};
const { validateFixtureGrant } = load("./queue-native-fixture-grant") as {
  validateFixtureGrant(
    grant: unknown,
    identity: unknown,
  ):
    | {
        kind: "fixed-run-v1";
        script: string;
        scriptSha256: string;
        helperVersion: string;
      }
    | { kind: "typed-cad-v1"; operations: string[] }
    | null;
};
const { resolveRuntimePaths } = load(
  "./dist/config-platform",
) as typeof import("../packages/node-adapters/src/config-platform/runtime-paths");
function fail(message: string): never {
  throw Object.assign(new Error(message), {
    code: "NATIVE_FIXTURE_SCOPE_REQUIRED",
  });
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
interface FixtureEpoch {
  root: string;
  document: { name: string; creationId: string };
  currentInstance: { version: string };
}
interface FixtureRequest {
  kind: string;
  payload: unknown;
  inputFiles?: { path: string; sha256: string }[];
  argv?: readonly string[];
}
// `original` is supplied only by the immutable-runtime evidence reader, never
// decoded from a client invocation. Normal live admission always uses defaults.
export function fixedFixtureAdmission(
  epoch: FixtureEpoch,
  request: FixtureRequest,
  grant: unknown,
  original: { identity?: unknown; installation?: string } = {},
): void {
  const fixture = validateFixtureGrant(
    grant,
    original.identity || readJson(path.join(epoch.root, "instance.json")),
  );
  if (!fixture || fixture.kind !== "fixed-run-v1")
    fail("An explicit source-pinned fixed fixture grant is required");
  const service = load(
    "./cad-service",
  ) as typeof import("./composition/cad-service");
  let payload;
  try {
    payload = service.decodeInvocation(request.payload);
  } catch {
    fail("A validated versioned fixed run invocation is required");
  }
  if (payload.kind !== "run")
    fail(
      "Only the exact registered source, cad-v1 helper, document pin and source snapshot are admitted; no outputs or other inputs",
    );
  const run = payload.request;
  const installation =
    original.installation ||
    resolveRuntimePaths({ anchor: __filename }).installation;
  const script = path.join(installation, fixture.script);
  if (
    request.kind !== "command" ||
    payload.output !== undefined ||
    !run ||
    run.name !== script ||
    fs.realpathSync(run.name) !== script ||
    run.doc !== epoch.document.name ||
    run.identity?.docId !== epoch.document.creationId ||
    Object.keys(run.identity).some(
      (key) => !["docId", "readOnly"].includes(key),
    ) ||
    run.identity.readOnly === true ||
    run.helperVersion !== fixture.helperVersion ||
    run.hasArgs !== true ||
    !Array.isArray(run.readOnlyOperations) ||
    run.readOnlyOperations.length ||
    !Array.isArray(request.inputFiles) ||
    request.inputFiles.length !== 1 ||
    request.inputFiles[0]?.path !== script ||
    request.inputFiles[0]?.sha256 !== fixture.scriptSha256 ||
    !same(request.argv, service.policyArguments(payload))
  )
    fail(
      "Only the exact registered source, cad-v1 helper, document pin and source snapshot are admitted; no outputs or other inputs",
    );
  const args = run.args;
  if (
    !object(args) ||
    Object.keys(args).sort().join(",") !==
      "approved,creationId,expectedFusionVersion,fixturePrefix" ||
    args["approved"] !== true ||
    args["creationId"] !== epoch.document.creationId ||
    args["expectedFusionVersion"] !== epoch.currentInstance.version ||
    typeof args["fixturePrefix"] !== "string" ||
    !/^[A-Z][A-Z0-9]{7,31}$/.test(args["fixturePrefix"])
  )
    fail(
      "Fixed fixture arguments cannot change source behavior or target another document/process version",
    );
}
