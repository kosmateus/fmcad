"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCatalogServices } = require("../src/dist/api");
const { createV2 } = require("../packages/opencode-adapter/dist/v2");
const { createV1 } = require("../packages/opencode-adapter/dist/v1");

function dependencies(ensureWeb, diagnostic) {
  return {
    catalog: createCatalogServices(),
    create() {
      assert.fail("web setup must not create an fmcad CAD service");
    },
    instanceID: "fixture-instance",
    requestID: () => "fixture-request",
    clientID: () => "fixture-client",
    config: () => {
      assert.fail("web setup must not load fmcad user configuration");
    },
    presence: () => null,
    ensureWeb,
    diagnostic,
  };
}

test("optional web ensure is nonblocking and reports only diagnostics", async () => {
  let rejectEnsure;
  const diagnostics = [];
  let ensured = 0;
  const deps = dependencies(
    () => {
      ensured++;
      return new Promise((_resolve, reject) => {
        rejectEnsure = reject;
      });
    },
    (message) => {
      diagnostics.push(message);
    },
  );
  const context = {
    app: { version: "2.1.3" },
    options: {},
    location: { directory: "/tmp/fixture-project" },
    tool: {
      async transform(edit) {
        edit({ add() {} });
        return { async dispose() {} };
      },
    },
    session: {
      async get() {
        assert.fail("no tool invocation was made");
      },
    },
    permission: {
      async assert() {
        assert.fail("no permission flow was started");
      },
    },
    event: {
      subscribe({ signal }) {
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise((resolve) =>
              signal.addEventListener("abort", resolve, { once: true }),
            );
          },
        };
      },
    },
  };
  const dispose = await createV2(deps).setup(context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ensured, 1);
  assert.equal(typeof dispose, "function");
  rejectEnsure(new Error("do not log raw service details"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(diagnostics, [
    "Control Center could not be ensured; fmcad tools remain available.",
  ]);
  await dispose();
});

test("V1 schedules optional web ensure after plugin hooks are constructed", async () => {
  let hooksReady = false;
  let ensured = false;
  const deps = dependencies(
    () => {
      ensured = hooksReady;
      return Promise.resolve();
    },
    () => assert.fail("successful web ensure must not report diagnostics"),
  );
  const setup = createV1(deps);
  const hooks = await setup({
    directory: "/tmp/fixture-project",
    client: { session: { get() {} } },
  });
  hooksReady = Boolean(hooks.tool?.fmcad_help && hooks.tool?.fmcad_execute);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ensured, true);
  await hooks.dispose?.();
});
