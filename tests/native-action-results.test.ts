import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  NativeActionClient,
  NativeActionReply,
} from "../packages/node-adapters/src/python/native-actions.js";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
type CadApi = typeof import("../src/composition/cad-execution.js");
const current = load("./src/cad.js") as CadApi;
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
) => unknown;
const original = historical(
  "a26222ff617b0e9597b2a91b50474bdca8d0a0ce",
  "src/cad.js",
) as CadApi;
function isUnknown(error: unknown): error is Error & { unknown: true } {
  return error instanceof Error && "unknown" in error && error.unknown === true;
}
const previous = historical(
  "5292078741b417d6e921d3252a8bf19b3f0cc15b",
  "src/cad.js",
) as CadApi;

function port(
  reply?: NativeActionReply,
  thrown?: unknown,
  server: NonNullable<NativeActionClient["server"]> = { timeoutMs: 120000 },
) {
  const calls: {
    request: Parameters<NativeActionClient["callTool"]>[0];
    timeout: number | undefined;
  }[] = [];
  return {
    calls,
    server,
    async callTool(request: Parameters<NativeActionClient["callTool"]>[0]) {
      calls.push({ request, timeout: server.timeoutMs });
      if (thrown !== undefined) throw thrown;
      assert.ok(reply, "Reply fixture is required unless the port throws");
      return reply;
    },
  };
}
const operations: [
  string,
  (
    api: CadApi,
    client: ReturnType<typeof port>,
  ) => Promise<Record<string, unknown>>,
][] = [
  [
    "references",
    (api, client) =>
      api.executeReferencesAction(
        client,
        "nativeUpdate",
        { nativeRpcTimeoutMs: 5000, value: "Zażółć" },
        {},
      ),
  ],
  [
    "externalization",
    (api, client) =>
      api.executeExternalizationAction(
        client,
        "perform",
        { remainingMs: 5000, value: "Zażółć" },
        false,
      ),
  ],
];

for (const [name, execute] of operations) {
  test(`${name} keeps the exact pre-migration script, timeout and result on success`, async () => {
    const reply = {
      text: 'progress\nFMCAD_RESULT {"status":"complete","value":42}\n',
    };
    const before = port(reply),
      after = port(reply),
      baseline = port(reply);
    const expected = await execute(previous, before);
    assert.deepEqual(await execute(current, after), expected);
    assert.deepEqual(await execute(original, baseline), expected);
    assert.deepEqual(after.calls, before.calls);
    for (const client of [before, after, baseline]) {
      assert.equal(client.calls.length, 1);
      assert.equal(client.calls[0]!.timeout, 5000);
      assert.equal(client.server.timeoutMs, 120000);
    }
  });
  for (const text of [
    'FMCAD_RESULT {"status":"complete"}\nFMCAD_RESULT {"status":"failed"}',
    "FMCAD_RESULT null",
    "FMCAD_RESULT []",
    "FMCAD_RESULT 0",
  ]) {
    test(`${name} rejects inherited ambiguous/non-object response: ${text}`, async () => {
      for (const api of [original, previous]) {
        const client = port({ text });
        await execute(api, client); // Historical gap: accepted as a settled result.
        assert.equal(client.calls.length, 1);
      }
      const client = port({ text });
      await assert.rejects(execute(current, client), (error) =>
        isUnknown(error),
      );
      assert.equal(client.calls.length, 1);
      assert.equal(client.server.timeoutMs, 120000);
    });
  }
  test(`${name} reports malformed JSON as unknown and never retries`, async () => {
    for (const api of [original, previous]) {
      await assert.rejects(
        execute(api, port({ text: "FMCAD_RESULT {" })),
        (error) =>
          error instanceof SyntaxError &&
          (!("unknown" in error) || error.unknown === undefined),
      );
    }
    const client = port({ text: "FMCAD_RESULT {" });
    await assert.rejects(execute(current, client), (error) => isUnknown(error));
    assert.equal(client.calls.length, 1);
    assert.equal(client.server.timeoutMs, 120000);
  });
  test(`${name} marks thrown primitive or frozen errors unknown without losing the cause`, async () => {
    for (const thrown of [
      "lost reply",
      Object.freeze(new Error("frozen reply loss")),
    ]) {
      const client = port(undefined, thrown);
      await assert.rejects(
        execute(current, client),
        (error) =>
          isUnknown(error) &&
          error.cause === thrown &&
          error.message ===
            (typeof thrown === "string" ? thrown : thrown.message),
      );
      assert.equal(client.calls.length, 1);
      assert.equal(client.server.timeoutMs, 120000);
    }
  });
  test(`${name} preserves ordinary error evidence and restores absent timeouts`, async () => {
    const error = Object.assign(new Error("transport lost"), {
      code: "LOST_REPLY",
    });
    const client = port(undefined, error, {});
    await assert.rejects(
      execute(current, client),
      (caught) => caught === error && isUnknown(caught),
    );
    assert.equal(error.code, "LOST_REPLY");
    assert.equal(client.calls.length, 1);
    assert.equal(Object.hasOwn(client.server, "timeoutMs"), false);
  });
  test(`${name} preserves pre-submit UI guards without interpreting result markers`, async () => {
    const reply = {
      uiGuard: { notStarted: true, activeCommand: "Move" },
      text: "blocked",
    };
    const before = port(reply),
      after = port(reply);
    assert.deepEqual(
      await execute(current, after),
      await execute(previous, before),
    );
    assert.equal(after.calls.length, 1);
    assert.equal(after.server.timeoutMs, 120000);
  });
}

test("reference read classification and native timeout stripping retain the original contract", async () => {
  for (const action of [
    "graph",
    "preflight",
    "sdkUpdate",
    "nativeUpdate",
    "save",
    "coldVerify",
  ]) {
    for (const lifecycle of ["existingOnly", "openOwned"]) {
      const before = port({ text: "FMCAD_RESULT {}" }),
        after = port({ text: "FMCAD_RESULT {}" });
      await previous.executeReferencesAction(
        before,
        action,
        { nativeRpcTimeoutMs: 9000 },
        { lifecycle },
      );
      await current.executeReferencesAction(
        after,
        action,
        { nativeRpcTimeoutMs: 9000 },
        { lifecycle },
      );
      assert.deepEqual(after.calls, before.calls);
      assert.equal(
        after.calls[0]!.request.object.readOnly,
        ["graph", "preflight"].includes(action) && lifecycle === "existingOnly",
      );
    }
  }
});

test("externalization keeps subsecond budgets unsent and inspect read-only flags intact", async () => {
  for (const api of [original, previous, current]) {
    const client = port({ text: "FMCAD_RESULT {}" });
    const result = await api.executeExternalizationAction(
      client,
      "perform",
      { remainingMs: 999 },
      false,
    );
    assert.equal(result["notStarted"], true);
    assert.equal(client.calls.length, 0);
    assert.equal(client.server.timeoutMs, 120000);
  }
  for (const readOnly of [false, true]) {
    const before = port({ text: "FMCAD_RESULT {}" }),
      after = port({ text: "FMCAD_RESULT {}" });
    await previous.executeExternalizationAction(
      before,
      "inspect",
      {},
      readOnly,
    );
    await current.executeExternalizationAction(after, "inspect", {}, readOnly);
    assert.deepEqual(after.calls, before.calls);
    assert.equal(after.calls[0]!.request.object.readOnly, readOnly);
  }
});
