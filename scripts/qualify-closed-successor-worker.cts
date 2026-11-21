#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const load = createRequire(__filename);
interface Fixture {
  dir: string;
  epoch: { root: string; epochId: string };
  p: { marker: { pid: number; birth: string } };
  cfg: unknown;
  clientId: string;
  token: string;
  approvalFile: string;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
async function main(): Promise<void> {
  const [fixture, runtime, base] = process.argv.slice(2);
  assert.ok(fixture && runtime && base);
  const factory = load(fixture) as (base: string, runtime: string) => Fixture;
  const f = factory(base, runtime);
  assert.equal(f.dir, path.join(base, "queue"));
  assert.equal(fs.realpathSync(f.dir), f.dir);
  assert.equal(
    f.epoch.root,
    path.join(f.dir, "admission-epochs", f.epoch.epochId),
  );
  const api = load(runtime + "/src/queue-instance") as {
    readJson(file: string): unknown;
    processBirth(): string;
  };
  assert.deepEqual(api.readJson(path.join(f.dir, "broker.lock")), f.p.marker);
  assert.equal(f.p.marker.pid, process.pid);
  assert.equal(f.p.marker.birth, api.processBirth());
  const before = fs.readFileSync(path.join(f.epoch.root, "queue-state.json"));
  fs.unlinkSync(path.join(f.dir, "broker.lock")); // Only this child's synthetic marker.
  let sdk = 0;
  const host = load(runtime + "/src/queue-broker") as {
    serve(
      cfg: unknown,
      options: {
        dir: string;
        confirmOwnership: true;
        autoReconcile: false;
        createBackend(): {
          server: { timeoutMs: number };
          _parse: typeof JSON.parse;
          _post(): never;
          callTool(): never;
        };
      },
    ): Promise<unknown>;
  };
  await host.serve(f.cfg, {
    dir: f.dir,
    confirmOwnership: true,
    autoReconcile: false,
    createBackend: () => ({
      server: { timeoutMs: 1000 },
      _parse: JSON.parse,
      _post() {
        sdk++;
        assert.fail("No SDK in installed closed-successor qualification");
      },
      callTool() {
        sdk++;
        assert.fail("No probe in installed metadata qualification");
      },
    }),
  });
  const connection = load(runtime + "/src/queue-connection") as {
    request(dir: string, message: unknown): Promise<unknown>;
  };
  const call = (action: string, rest: Record<string, unknown> = {}) =>
    connection.request(f.dir, {
      action,
      auth: { clientId: f.clientId, clientToken: f.token },
      ...rest,
    });
  const status = object(await call("queue-summary"));
  const sourceControl = object(status["control"]);
  const control = {
    instanceId: sourceControl["instanceId"],
    generation: sourceControl["generation"],
    contextEpoch: sourceControl["contextEpoch"],
    buildHash: sourceControl["buildHash"],
  };
  const lineage = load(runtime + "/src/queue-epoch-lineage") as {
    reference(file: string): unknown;
  };
  const approval = lineage.reference(f.approvalFile);
  const result = object(
    await call("authorize-closed-successor", { approval, control }),
  );
  assert.equal(result["sdkRequestsSent"], 0);
  assert.deepEqual(
    await call("authorize-closed-successor", { approval, control }),
    result,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(f.epoch.root, "queue-state.json")),
    before,
  );
  assert.equal(sdk, 0);
  console.log(
    JSON.stringify({
      passed: true,
      installedBrokerDispatch: true,
      metadataOnly: true,
      sdkRequestsSent: 0,
      historyUnchanged: true,
    }),
  );
  process.exit(0); // Only this isolated synthetic child; no real physical backend.
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
