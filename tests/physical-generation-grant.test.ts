import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { createPhysicalTurnStatusRequest } from "../packages/node-adapters/src/execution/admission-http";
import {
  createPhysicalGenerationAuthorization,
  type PhysicalGenerationDescriptor,
} from "../packages/node-adapters/src/execution/physical-generation";

function pythonEvidence(
  binding: unknown,
  releasedBy = "dispatch-finally",
): string {
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import hashlib,json,sys; print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf-8')).hexdigest())",
    ],
    {
      input: JSON.stringify({ binding, state: "released", releasedBy }),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t: { after(action: () => void): void }) {
  const root = fs.mkdtempSync("/tmp/opencode/private-physical-grant-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expected: PhysicalGenerationDescriptor = {
    kind: "fmcad-physical-grant",
    version: 1,
    handoffId: "handoff-one",
    generation: { instance: "runtime-one", epoch: "epoch-one" },
    brokerOwner: {
      pid: process.pid,
      birth: "broker-birth",
      nonce: "owner-one",
      clientId: "broker-owner",
      queueDirectory: root,
    },
    endpointURL: "http://127.0.0.1:8765/mcp",
    physicalRuntime: {
      pid: 42,
      birth: "sdk-birth",
      version: "test",
      source: "verified-source",
      build: "verified-build",
    },
  };
  const secret = "private-grant-token-".repeat(4);
  const bytes = Buffer.from(JSON.stringify({ ...expected, token: secret }));
  const grantFile = path.join(root, "grant.json");
  fs.writeFileSync(grantFile, bytes, { mode: 0o600, flag: "wx" });
  const options = {
    grantFile,
    expected,
    grantDigest: createHash("sha256").update(bytes).digest("hex"),
    assertBrokerOwner() {
      assert.equal(process.pid, expected.brokerOwner.pid);
    },
  };
  return { root, expected, secret, grantFile, options };
}

test("physical capability pins exact grant bytes and preserves exact target string", (t) => {
  const f = fixture(t);
  const authorization = createPhysicalGenerationAuthorization(f.options);
  const target = '{"creationId":"doc-one","fileId":"file","version":3}';
  const binding = authorization.turnBinding("turn-one", target);
  assert.equal(binding.target, target);
  assert.equal(binding.grantDigest, f.options.grantDigest);
  assert.deepEqual(binding.generation, f.expected.generation);
  assert.equal(
    authorization.headers("http://127.0.0.1:8765/admission/v1", {
      turnId: binding.turnId,
      target: binding.target,
    })["X-Fmcad-Physical-Target"],
    Buffer.from(target).toString("base64url"),
  );
  assert.equal(
    authorization.headers(f.expected.endpointURL)["X-Fmcad-Physical-Grant"],
    f.secret,
  );
  assert.equal(JSON.stringify(binding).includes(f.secret), false);
});

test("concurrent physical turns keep the same pinned binding through asynchronous send", async (t) => {
  const f = fixture(t);
  const authorization = createPhysicalGenerationAuthorization(f.options);
  const turns = ["A", "B"].map((id) =>
    authorization.turnBinding(
      `turn-${id}`,
      JSON.stringify({ creationId: `document-${id}` }),
    ),
  );
  await Promise.all(
    turns.map((binding) =>
      authorization.withPhysicalTurn(binding, async () => {
        await Promise.resolve();
        const headers = authorization.headers(f.expected.endpointURL);
        assert.equal(headers["X-Fmcad-Physical-Turn"], binding.turnId);
        assert.equal(
          Buffer.from(
            headers["X-Fmcad-Physical-Target"]!,
            "base64url",
          ).toString(),
          binding.target,
        );
        assert.throws(
          () =>
            authorization.headers(f.expected.endpointURL, {
              turnId: "foreign-turn",
              target: binding.target,
            }),
          { code: "PHYSICAL_GENERATION_REJECTED" },
        );
      }),
    ),
  );
  assert.equal(
    authorization.headers(f.expected.endpointURL)["X-Fmcad-Physical-Turn"],
    undefined,
  );
  assert.throws(
    () =>
      authorization.withPhysicalTurn(
        {
          ...turns[0]!,
          grantDigest: "f".repeat(64),
        },
        () => undefined,
      ),
    { code: "PHYSICAL_GENERATION_REJECTED" },
  );
});

test("broker binding factory pins the physical child ID and exact canonical selector", (t) => {
  const f = fixture(t);
  const authorization = createPhysicalGenerationAuthorization(f.options);
  const bound = authorization.bindPhysicalTurn({
    physicalRequestId: "physical-child-not-jsonrpc-id-three",
    documentSelector: {
      version: 3,
      fileId: "saved-file",
      creationId: "saved-doc",
    },
  });
  assert.equal(bound.turnId, "physical-child-not-jsonrpc-id-three");
  assert.equal(
    bound.target,
    '{"creationId":"saved-doc","fileId":"saved-file","version":3}',
  );
  assert.equal(
    authorization.bindPhysicalTurn({
      physicalRequestId: "no-document-child",
    }).target,
    "null",
  );
  assert.throws(
    () =>
      authorization.bindPhysicalTurn({
        kind: "system-read",
        brokerNonce: "foreign-broker",
        physicalRequestId: "probe",
      }),
    { code: "PHYSICAL_GENERATION_REJECTED" },
  );
  assert.equal(
    authorization.bindPhysicalTurn({
      kind: "system-read",
      brokerNonce: f.expected.brokerOwner.nonce,
      physicalRequestId: "probe",
      documentSelector: { metadataOnly: true },
    }).target,
    '{"metadataOnly":true}',
  );
});

for (const state of [
  "released",
  "released-before-sdk",
  "released-unicode",
  "arbitrary-digest",
  "unrecognized-reason",
  "active",
  "unknown",
  "foreign-target",
  "foreign-grant",
  "foreign-runtime",
  "foreign-generation",
  "duplicate-state",
  "bad-evidence",
  "disconnected",
]) {
  test(`quiescence query accepts only bound durable evidence: ${state}`, async (t) => {
    const f = fixture(t);
    const before = fs.readFileSync(f.grantFile);
    let queries = 0;
    const authorization = createPhysicalGenerationAuthorization(f.options, {
      async request(request) {
        const body: Record<string, unknown> = JSON.parse(
          Buffer.from(request.body).toString("utf8"),
        );
        queries++;
        assert.equal(
          request.endpoint,
          "http://127.0.0.1:8765/physical/v1/turn-status",
        );
        assert.equal(request.headers["X-Fmcad-Physical-Grant"], f.secret);
        if (state === "disconnected") throw new Error("Connection lost");
        const release =
          state === "released" ||
          state === "released-before-sdk" ||
          state === "released-unicode" ||
          state === "arbitrary-digest" ||
          state === "unrecognized-reason" ||
          state === "bad-evidence" ||
          state === "foreign-target" ||
          state === "foreign-grant" ||
          state === "foreign-runtime" ||
          state === "foreign-generation" ||
          state === "duplicate-state";
        const responseBinding =
          state === "foreign-target"
            ? { ...body, target: '{"creationId":"foreign"}' }
            : state === "foreign-grant"
              ? { ...body, grantDigest: "b".repeat(64) }
              : state === "foreign-runtime"
                ? {
                    ...body,
                    physicalRuntime: {
                      ...f.expected.physicalRuntime,
                      birth: "foreign-sdk-birth",
                    },
                  }
                : state === "foreign-generation"
                  ? {
                      ...body,
                      generation: {
                        ...f.expected.generation,
                        epoch: "foreign-epoch",
                      },
                    }
                  : body;
        const digest =
          state === "arbitrary-digest"
            ? "a".repeat(64)
            : pythonEvidence(
                responseBinding,
                state === "released-before-sdk"
                  ? "cancelled-before-sdk"
                  : state === "unrecognized-reason"
                    ? "operator-assumption"
                    : "dispatch-finally",
              );
        const raw = JSON.stringify({
          state: release ? "released" : state,
          binding: responseBinding,
          ...(release
            ? {
                evidenceDigest: digest,
                physicalEvidenceReference: `fmcad-physical-turn:sha256:${state === "bad-evidence" ? "b".repeat(64) : digest}`,
              }
            : {}),
        });
        return {
          status: 200,
          body: Buffer.from(
            state === "duplicate-state"
              ? raw.replace(
                  '"state":"released"',
                  '"state":"active","state":"released"',
                )
              : raw,
            "utf8",
          ),
        };
      },
    });
    const binding = authorization.turnBinding(
      "original-turn",
      state === "released-unicode"
        ? '{"creationId":"zażółć 📐 \ufffd"}'
        : '{"creationId":"original"}',
    );
    const proof = await authorization.physicalTurnQuiescence(binding);
    assert.equal(
      proof.state,
      state.startsWith("released")
        ? "released"
        : ["active", "unknown"].includes(state)
          ? state
          : "unknown",
    );
    assert.deepEqual(proof.binding, binding);
    assert.equal(queries, 1);
    assert.deepEqual(fs.readFileSync(f.grantFile), before);
  });
}

for (const kind of [
  "changed-bytes",
  "public-file",
  "public-directory",
  "symlink",
  "foreign-owner",
  "foreign-queue",
  "foreign-runtime",
  "foreign-generation",
  "unknown-field",
  "duplicate-field",
  "foreign-endpoint",
  "retired-owner",
  "malformed-utf8",
]) {
  test(`physical capability refuses ${kind} without exposing the secret`, (t) => {
    const f = fixture(t);
    if (kind === "malformed-utf8") {
      f.expected.physicalRuntime.source = "source-\ufffd";
      const encoded = Buffer.from(
        JSON.stringify({ ...f.expected, token: f.secret }),
      );
      const position = encoded.indexOf(Buffer.from("\ufffd"));
      assert.ok(position >= 0);
      const corrupt = Buffer.concat([
        encoded.subarray(0, position),
        Buffer.from([0xff]),
        encoded.subarray(position + 3),
      ]);
      fs.writeFileSync(f.grantFile, corrupt);
      f.options.grantDigest = createHash("sha256")
        .update(corrupt)
        .digest("hex");
    }
    if (kind === "retired-owner")
      f.options.assertBrokerOwner = () => {
        throw new Error("Broker lifetime was retired");
      };
    if (kind === "changed-bytes") fs.appendFileSync(f.grantFile, " ");
    if (kind === "public-file") fs.chmodSync(f.grantFile, 0o644);
    if (kind === "public-directory") fs.chmodSync(f.root, 0o755);
    if (kind === "symlink") {
      fs.renameSync(f.grantFile, f.grantFile + ".source");
      fs.symlinkSync(f.grantFile + ".source", f.grantFile);
    }
    if (kind === "foreign-owner")
      f.expected.brokerOwner.nonce = "another-owner";
    if (kind === "foreign-queue")
      f.expected.brokerOwner.queueDirectory = "/tmp/opencode/another-queue";
    if (kind === "foreign-runtime")
      f.expected.physicalRuntime.birth = "another-sdk-birth";
    if (kind === "foreign-generation")
      f.expected.generation.epoch = "another-generation";
    if (kind === "unknown-field") {
      const value: unknown = JSON.parse(fs.readFileSync(f.grantFile, "utf8"));
      assert.ok(value && typeof value === "object");
      fs.writeFileSync(
        f.grantFile,
        JSON.stringify({ ...value, unbound: true }),
      );
      f.options.grantDigest = createHash("sha256")
        .update(fs.readFileSync(f.grantFile))
        .digest("hex");
    }
    if (kind === "duplicate-field") {
      const original = fs.readFileSync(f.grantFile, "utf8");
      fs.writeFileSync(
        f.grantFile,
        '{"kind":"foreign-kind",' + original.slice(1),
      );
      f.options.grantDigest = createHash("sha256")
        .update(fs.readFileSync(f.grantFile))
        .digest("hex");
    }
    const authorization = createPhysicalGenerationAuthorization(f.options);
    assert.throws(
      () =>
        authorization.headers(
          kind === "foreign-endpoint"
            ? "http://127.0.0.1:27182/mcp"
            : f.expected.endpointURL,
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error);
        assert.equal(error.code, "PHYSICAL_GENERATION_REJECTED");
        assert.equal(error.message.includes(f.secret), false);
        return true;
      },
    );
  });
}

for (const transport of ["node", "windows-curl"] as const) {
  test(`quiescence ${transport} refuses malformed UTF-8 before JSON can replace bytes`, async (t) => {
    const f = fixture(t);
    const original = createPhysicalGenerationAuthorization(f.options);
    const binding = original.turnBinding(
      "invalid-utf8-turn",
      '{"creationId":"document-\ufffd"}',
    );
    const digest = pythonEvidence(binding);
    const encoded = Buffer.from(
      JSON.stringify({
        state: "released",
        binding,
        evidenceDigest: digest,
        physicalEvidenceReference: `fmcad-physical-turn:sha256:${digest}`,
      }),
    );
    const position = encoded.indexOf(Buffer.from("\ufffd"));
    assert.ok(position >= 0);
    const corrupt = Buffer.concat([
      encoded.subarray(0, position),
      Buffer.from([0xff]),
      encoded.subarray(position + 3),
    ]);
    let sends = 0;
    const port = createPhysicalTurnStatusRequest(
      { transport },
      {
        fetch: async () => {
          assert.equal(transport, "node");
          sends++;
          return new Response(corrupt, { status: 200 });
        },
        spawn: (executable, _args, options) => {
          assert.equal(transport, "windows-curl");
          assert.equal(executable, "/mnt/c/Windows/System32/curl.exe");
          sends++;
          const response = Buffer.concat([
            Buffer.from(
              `HTTP/1.1 200 OK\r\nContent-Length: ${corrupt.length}\r\n\r\n`,
            ),
            corrupt,
          ]);
          return spawn(
            process.execPath,
            [
              "-e",
              `process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(Buffer.from("${response.toString("base64")}","base64")));`,
            ],
            options,
          );
        },
      },
    );
    const authorization = createPhysicalGenerationAuthorization(
      { ...f.options, transport },
      { request: port },
    );
    assert.equal(
      (await authorization.physicalTurnQuiescence(binding)).state,
      "unknown",
    );
    assert.equal(sends, 1);
  });
}

test("physical control byte port cannot dispatch to an SDK endpoint", () => {
  const port = createPhysicalTurnStatusRequest(
    {},
    {
      fetch: async () => assert.fail("No physical SDK dispatch"),
    },
  );
  for (const endpoint of [
    "http://127.0.0.1:8765/mcp",
    "http://127.0.0.1:8765/admission/v1",
  ])
    assert.throws(
      () =>
        port({
          endpoint,
          headers: {},
          body: new Uint8Array(),
          timeoutMs: 1000,
        }),
      /exact private control endpoint/,
    );
});
