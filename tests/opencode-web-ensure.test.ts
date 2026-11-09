import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { Dependencies } from "../packages/opencode-adapter/src/shared/contracts";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import type { PluginInput } from "@opencode-ai/plugin";
const load = createRequire(__filename),
  root = process.cwd();
const { createCatalogServices } = load(
  path.join(root, "src/dist/api"),
) as typeof import("../src/api");
const { createV2 } = load(
  path.join(root, "packages/opencode-adapter/dist/v2"),
) as typeof import("../packages/opencode-adapter/src/v2");
const { createV1 } = load(
  path.join(root, "packages/opencode-adapter/dist/v1"),
) as typeof import("../packages/opencode-adapter/src/v1");
// The host exposes many unrelated APIs. A missing fixture member must fail
// immediately if setup starts depending on it, rather than silently returning undefined.
function fixture<T extends object>(members: Partial<T>): T {
  return new Proxy(members, {
    get(target, key, receiver) {
      assert(Reflect.has(target, key), `Unexpected host member ${String(key)}`);
      return Reflect.get(target, key, receiver) as unknown;
    },
  }) as T;
}
function dependencies(
  ensureWeb: () => Promise<void>,
  diagnostic: (message: string) => void,
): Dependencies {
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

test(
  "optional web ensure is nonblocking and reports only diagnostics",
  { timeout: 1000 },
  async () => {
    let rejectEnsure: (error: Error) => void = () =>
      assert.fail("ensure was not started");
    const diagnostics: string[] = [];
    let ensured = 0;
    const deps = dependencies(
      () => {
        ensured++;
        return new Promise<void>((_resolve, reject) => {
          rejectEnsure = reject;
        });
      },
      (message) => {
        diagnostics.push(message);
      },
    );
    const context = fixture<Context>({
      app: fixture<Context["app"]>({ version: "2.1.3" }),
      options: {},
      location: fixture<Context["location"]>({
        directory: "/tmp/fixture-project" as Context["location"]["directory"],
      }),
      tool: fixture<Context["tool"]>({
        async transform(edit) {
          edit(fixture<ToolEditor>({ add() {} }));
          return { async dispose() {} };
        },
      }),
      session: fixture<Context["session"]>({
        async get() {
          assert.fail("no tool invocation was made");
        },
      }),
      permission: fixture<Context["permission"]>({
        async assert() {
          assert.fail("no permission flow was started");
        },
      }),
      event: fixture<Context["event"]>({
        subscribe({ signal } = {}) {
          assert(signal);
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise((resolve) =>
                signal.addEventListener("abort", resolve, { once: true }),
              );
            },
          };
        },
      }),
    });
    const dispose = await createV2(deps).setup(context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ensured, 1);
    assert.equal(typeof dispose, "function");
    rejectEnsure(new Error("do not log raw service details"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(diagnostics, [
      "Control Center could not be ensured; fmcad tools remain available.",
    ]);
    assert(dispose);
    await dispose();
  },
);

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
  const hooks = await setup(
    fixture<PluginInput>({
      directory: "/tmp/fixture-project",
      client: fixture<PluginInput["client"]>({
        session: fixture<PluginInput["client"]["session"]>({
          async get() {
            assert.fail("no tool invocation was made");
          },
        }),
      }),
    }),
  );
  hooksReady = Boolean(
    hooks.tool?.["fmcad_help"] && hooks.tool?.["fmcad_execute"],
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ensured, true);
  await hooks.dispose?.();
});
