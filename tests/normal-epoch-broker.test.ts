import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

interface Auth {
  clientId: string;
  clientToken: string;
}
interface Fixture {
  dir: string;
  cfg: unknown;
  clientId: string;
  token: string;
  epoch: { root: string; currentInstance: unknown };
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

async function syntheticChild(root: string, upgrade: boolean): Promise<void> {
  const repo = path.resolve(
    process.env["FMCAD_TEST_RUNTIME"] || path.join(__dirname, "../.."),
  );
  const runtimeRequire = createRequire(path.join(repo, "src/queue-broker.js"));
  const fixture = createRequire(__filename)(
    "../../tests/fixtures/closed-epoch-successor.cjs",
  ) as (root: string, repo: string, admissionMode: string) => Fixture;
  const f = fixture(root, repo, "normal-multidocument");
  const identityFile = path.join(f.epoch.root, "instance.json");
  const previousIdentity = record(
    JSON.parse(fs.readFileSync(identityFile, "utf8")) as unknown,
  );
  if (upgrade)
    fs.writeFileSync(
      identityFile,
      JSON.stringify({
        ...previousIdentity,
        buildHash: "older-synthetic-build",
      }),
    );
  const observation = {
    ...record(f.epoch.currentInstance),
    activeCommand: "SelectCommand",
    documents: [],
  };
  const history = fs.readFileSync(path.join(f.dir, "queue-state.json"));
  fs.unlinkSync(path.join(f.dir, "broker.lock")); // Only this just-created synthetic fixture.
  let sdk = 0;
  let probes = 0;
  const broker = runtimeRequire("./queue-broker") as {
    serve(
      config: unknown,
      options: {
        dir: string;
        confirmOwnership: boolean;
        autoReconcile: boolean;
        createBackend(): unknown;
      },
    ): Promise<unknown>;
  };
  await broker.serve(f.cfg, {
    dir: f.dir,
    confirmOwnership: true,
    autoReconcile: false,
    createBackend: () => ({
      server: { timeoutMs: 1000 },
      _parse: (text: string): unknown => JSON.parse(text),
      _post() {
        sdk++;
        assert.fail("SDK forbidden in this paused offline fixture");
      },
      callTool(args: unknown) {
        assert.equal(
          upgrade,
          true,
          "Same-build reopen must remain metadata-only",
        );
        const body = record(record(args)["object"]);
        assert.equal(body["readOnly"], true);
        assert.ok(
          typeof body["script"] === "string" &&
            body["script"].includes("FMCAD_QUEUE_INSTANCE "),
        );
        probes++;
        return Promise.resolve({
          failed: false,
          text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(observation),
        });
      },
    }),
  });
  const { request } = runtimeRequire("./queue-connection") as {
    request(dir: string, message: Record<string, unknown>): Promise<unknown>;
  };
  const call = async (
    action: string,
    rest: Record<string, unknown> = {},
    auth: Auth = { clientId: f.clientId, clientToken: f.token },
  ): Promise<Record<string, unknown>> =>
    record(await request(f.dir, { action, auth, ...rest }));
  const status = await call("queue-summary"),
    control = record(status["control"]);
  assert.equal(status["held"], null);
  assert.equal(status["admissionScope"], "normal-multidocument");
  assert.equal(probes, upgrade ? 1 : 0);
  assert.equal(
    record(JSON.parse(fs.readFileSync(identityFile, "utf8")) as unknown)[
      "buildHash"
    ],
    status["buildHash"],
  );
  await call("pause", {
    control: {
      requestId: "offline-pause",
      instanceId: control["instanceId"],
      expectedGeneration: control["generation"],
    },
  });
  for (const clientId of ["new-a", "new-b"]) {
    const auth = { clientId, clientToken: clientId.repeat(16) };
    await request(f.dir, { action: "register", ...auth });
    const input = {
      kind: "rpc",
      requestId: clientId + ":new",
      timeoutMs: 1000,
      backend: "addin",
      buildHash: status["buildHash"],
      payload: { jsonrpc: "2.0", id: clientId, method: "ping" },
    };
    const job = await call("submit", { request: input }, auth);
    const found = await call(
      "find-request",
      { requestId: input.requestId, expectedRequest: input },
      auth,
    );
    assert.equal(record(found["job"])["id"], job["id"]);
    assert.equal(found["requestMatched"], true);
    await assert.rejects(
      call(
        "find-request",
        {
          requestId: input.requestId,
          expectedRequest: { ...input, timeoutMs: 2000 },
        },
        auth,
      ),
      { code: "REQUEST_CONFLICT" },
    );
  }
  assert.deepEqual(
    fs.readFileSync(path.join(f.dir, "queue-state.json")),
    history,
  );
  assert.equal(sdk, 0);
  console.log("NORMAL_EPOCH_OFFLINE_PASS");
}

if (
  process.argv[2] === "--synthetic-child" ||
  process.argv[2] === "--synthetic-upgrade-child"
) {
  const root = process.argv[3];
  assert.ok(root);
  void syntheticChild(
    root,
    process.argv[2] === "--synthetic-upgrade-child",
  ).then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
} else {
  for (const upgrade of [false, true]) {
    test(
      upgrade
        ? "FAKE new runtime uses existing read-only startup after proven normal release, preserving history"
        : "FAKE broker reopens owner-released normal admission, preserves history and matches lost-ACK input",
      { timeout: 30000 },
      (t) => {
        const root = fs.mkdtempSync(path.join(tmpdir(), "normal-epoch-broker-"));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const result = spawnSync(
          process.execPath,
          [
            __filename,
            upgrade ? "--synthetic-upgrade-child" : "--synthetic-child",
            root,
          ],
          { encoding: "utf8", timeout: 25000 },
        );
        assert.equal(result.status, 0, result.stderr || String(result.error));
        assert.match(result.stdout, /NORMAL_EPOCH_OFFLINE_PASS/);
      },
    );
  }
}
