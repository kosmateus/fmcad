import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";

const root = path.resolve(__dirname, "../..");
const runtimeRequire = createRequire(__filename);
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function lostProcessChild(directory: string): Promise<void> {
  const runtime = process.env["FMCAD_TEST_RUNTIME"] || root;
  const load = createRequire(path.join(runtime, "src/queue-broker.js"));
  const fixture = runtimeRequire(
    "../../tests/fixtures/current-epoch-upgrade.cjs",
  ) as (
    root: string,
    runtime: string,
  ) => {
    dir: string;
    cfg: unknown;
    clientId: string;
    token: string;
    pointer: {
      root: string;
      currentInstance: unknown;
      qualificationReceipt: { path: string; sha256: string };
    };
  };
  const f = fixture(directory, runtime);
  const api = load("./queue-instance") as {
    readJson(file: string): unknown;
    durable(file: string, value: unknown): void;
    hash(bytes: Buffer): string;
  };
  // Only the just-created, caller-owned fake fixture is shaped to process loss.
  // Never read or edit a user queue, document, namespace or shared pointer.
  const dead = {
    pid: 2147483645,
    birth: "dead:composition-fixture",
    version: "fixture",
  };
  f.pointer.currentInstance = dead;
  api.durable(f.pointer.qualificationReceipt.path, {
    ...record(api.readJson(f.pointer.qualificationReceipt.path)),
    currentInstance: dead,
  });
  f.pointer.qualificationReceipt.sha256 = api.hash(
    fs.readFileSync(f.pointer.qualificationReceipt.path),
  );
  const pointerFile = path.join(f.dir, "isolated-admission-epoch.json");
  api.durable(pointerFile, f.pointer);
  const identity = path.join(f.pointer.root, "instance.json");
  api.durable(identity, { ...record(api.readJson(identity)), instance: dead });
  for (const name of ["atomic-migration.lock", "recovery.lock"])
    fs.unlinkSync(path.join(f.dir, name));
  const protectedFiles = [
    pointerFile,
    identity,
    path.join(f.dir, "queue-state.json"),
    path.join(f.pointer.root, "queue-state.json"),
  ];
  const before = protectedFiles.map((file) => fs.readFileSync(file));
  let sdk = 0;
  const broker = load("./queue-broker") as {
    serve(
      config: unknown,
      options: {
        dir: string;
        confirmOwnership: boolean;
        createBackend(): unknown;
      },
    ): Promise<unknown>;
  };
  await broker.serve(f.cfg, {
    dir: f.dir,
    confirmOwnership: true,
    createBackend: () => ({
      server: { timeoutMs: 1000 },
      _parse: (raw: string): unknown => JSON.parse(raw),
      _post() {
        sdk++;
        assert.fail("No SDK in the lost-process metadata fixture");
      },
      callTool() {
        sdk++;
        assert.fail("No physical probe or renewal in metadata-only recovery");
      },
    }),
  });
  const { request } = load("./queue-connection") as {
    request(dir: string, message: unknown): Promise<unknown>;
  };
  for (const requestData of [{}, { timeoutMs: "not a number" }]) {
    await assert.rejects(
      request(f.dir, {
        action: "submit",
        auth: { clientId: f.clientId, clientToken: f.token },
        request: requestData,
        control: 42,
      }),
      { code: "EPOCH_PROCESS_UNAVAILABLE" },
    );
  }
  assert.equal(sdk, 0);
  assert.deepEqual(
    protectedFiles.map((file) => fs.readFileSync(file)),
    before,
  );
  console.log("PROCESS_FENCE_PRECEDENCE_SDK0_PASS");
}

if (process.argv[2] === "--lost-process-child") {
  const directory = process.argv[3];
  assert.ok(directory);
  void lostProcessChild(directory).then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
} else {
  const { matching } = runtimeRequire(
    path.join(root, "src/queue-broker.js"),
  ) as {
    matching(
      client: { _parse(raw: string): unknown },
      response: { status: number; raw: string },
      payload: { jsonrpc: string; id?: number; method: string },
    ): unknown;
  };

  test("emitted broker is byte-identical at source and installed staging seams", () => {
    const compiled = fs.readFileSync(
      path.join(root, "dist/library-build/src/queue-broker.js"),
    );
    for (const target of ["src/queue-broker.js", "dist/src/queue-broker.js"])
      assert.deepEqual(fs.readFileSync(path.join(root, target)), compiled);
  });

  test("unknown transport DTOs preserve ordinary broker reply identity and result semantics", () => {
    const payload = { jsonrpc: "2.0", id: 0, method: "ping" };
    const check = (value: unknown): unknown =>
      matching(
        { _parse: () => value },
        { status: 200, raw: "not reparsed by this explicit test port" },
        payload,
      );
    // The pre-port broker accepts arbitrary JSON-RPC result values. Do not narrow
    // its protocol to MCP tool-result objects while typing the unknown parser seam.
    for (const result of [null, false, 0, "metadata", [], {}]) {
      const reply = { jsonrpc: "2.0", id: 0, result, extension: "preserve" };
      assert.equal(check(reply), reply);
    }
    for (const invalid of [
      null,
      [],
      "reply",
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 0 },
      { jsonrpc: "2.0", id: 0, result: {}, error: {} },
      { jsonrpc: "2.0", id: 0, error: "unvalidated" },
    ])
      assert.throws(() => check(invalid), { code: "UNKNOWN_RPC" });
  });

  test("process/history fence precedes malformed DTO validation without an SDK call", (t) => {
    const directory = fs.mkdtempSync("/tmp/opencode/broker-process-fence-");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const child = spawnSync(
      process.execPath,
      [__filename, "--lost-process-child", directory],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr || String(child.error));
    assert.match(child.stdout, /PROCESS_FENCE_PRECEDENCE_SDK0_PASS/);
  });

  test(
    "actual installed npm broker reopens normal metadata, preserves history and matches original ACK with SDK0",
    (t) => {
      const directory = fs.mkdtempSync(
        "/tmp/opencode/broker-composition-installed-",
      );
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const packed: unknown = JSON.parse(
        execFileSync(
          "npm",
          [
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            directory,
          ],
          {
            cwd: root,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
          },
        ),
      );
      assert.ok(Array.isArray(packed));
      const first: unknown = packed[0];
      assert.ok(
        first &&
          typeof first === "object" &&
          "filename" in first &&
          typeof first.filename === "string",
      );
      execFileSync(
        "npm",
        [
          "install",
          "--offline",
          "--prefix",
          directory,
          "--ignore-scripts",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          path.join(directory, first.filename),
        ],
        {
          cwd: directory,
          encoding: "utf8",
        },
      );
      const installed = path.join(directory, "node_modules/fmcad/dist");
      assert.equal(
        fs.existsSync(path.join(installed, "src/queue-broker.ts")),
        false,
      );
      assert.deepEqual(
        fs.readFileSync(path.join(installed, "src/queue-broker.js")),
        fs.readFileSync(
          path.join(root, "dist/library-build/src/queue-broker.js"),
        ),
      );
      const fixture = path.join(directory, "synthetic-owner-state");
      fs.mkdirSync(fixture);
      const child = spawnSync(
        process.execPath,
        [
          path.join(__dirname, "normal-epoch-broker.test.js"),
          "--synthetic-child",
          fixture,
        ],
        {
          cwd: directory,
          encoding: "utf8",
          env: { ...process.env, FMCAD_TEST_RUNTIME: installed },
        },
      );
      assert.equal(child.status, 0, child.stderr || String(child.error));
      // The reused strict TS worker asserts zero physical calls, immutable history,
      // two independent registered owners and exact expectedRequest matching.
      assert.match(child.stdout, /NORMAL_EPOCH_OFFLINE_PASS/);
      const lostProcess = path.join(directory, "synthetic-lost-process");
      fs.mkdirSync(lostProcess);
      const guarded = spawnSync(
        process.execPath,
        [__filename, "--lost-process-child", lostProcess],
        {
          cwd: directory,
          encoding: "utf8",
          env: { ...process.env, FMCAD_TEST_RUNTIME: installed },
        },
      );
      assert.equal(guarded.status, 0, guarded.stderr || String(guarded.error));
      assert.match(guarded.stdout, /PROCESS_FENCE_PRECEDENCE_SDK0_PASS/);
    },
  );
}
