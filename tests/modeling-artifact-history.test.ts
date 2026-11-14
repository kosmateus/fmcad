import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const root = process.cwd();
const fixtures = path.join(root, "tests/fixtures/modeling-history");
const fixtureRequire = createRequire(
  path.join(root, "tests/modeling-artifact-history.test.ts"),
);
const manifest = fixtureRequire(
  "./fixtures/modeling-history/services-manifest.json",
) as Record<string, { fixture: string; sha256: string }>;
type Payload = Record<string, unknown>;
type Execute = (
  client: unknown,
  operation: string,
  data: Payload,
  context: Payload,
  ports: Payload,
) => Promise<unknown>;
interface Api {
  execute: Execute;
  createSelectionExecutor(
    authorize: (operation: string, payload: Payload) => void,
  ): Execute;
  createBrepExecutor(authorize: (payload: Payload) => void): Execute;
}
interface SelectionScenario {
  operation?: string;
  missing?: boolean;
  changed?: boolean;
  throwNative?: boolean;
  unwrapped?: boolean;
  unavailable?: boolean;
  status?: string;
  context?: Record<string, string | null>;
}
interface BrepPorts {
  newSession(): string;
  stage(count: number): unknown;
  executeNative(
    action: string,
    payload: Payload,
    context: Payload,
  ): Promise<unknown>;
}

const clone = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));
function errorMessage(error: unknown): string {
  assert.ok(error !== null && typeof error === "object");
  const message: unknown = Reflect.get(error, "message");
  assert.equal(typeof message, "string");
  return message as string;
}
function load(
  file: string,
  overrides: (name: string) => unknown,
  expectedHash?: string,
) {
  const source = fs.readFileSync(file, "utf8");
  if (expectedHash)
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      expectedHash,
    );
  const realRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      process,
      require(name: string) {
        return overrides(name) ?? realRequire(name);
      },
    },
    { filename: file },
  );
  return module.exports as Api;
}
const owner = {
  projectId: "project-A",
  documentFileId: "file-A",
  documentCreationId: "creation-A",
};
const context = {
  projectId: "project-A",
  docFileId: "file-A",
  docId: "creation-A",
  purpose: "parity",
};
const reference = { ...owner, artifactId: "rule-A", hash: "hash-A" };
const saved = { owner, revision: 1, rule: { id: "outer-face" }, count: 1 };
async function selection(historical: boolean, scenario: SelectionScenario) {
  const events: unknown[][] = [];
  let uuid = 0;
  const authorize = (op: string, payload: Payload) =>
    events.push(["authorize", op, clone(payload)]);
  const artifact = {
    async read(ctx: unknown, ref: unknown) {
      events.push(["read", clone(ctx), clone(ref)]);
      return scenario.missing ? null : clone(saved);
    },
    async write(ctx: unknown, value: unknown) {
      events.push(["write", clone(ctx), clone(value)]);
      return { ...reference, hash: "hash-B" };
    },
  };
  const overrides = (name: string) => {
    if (name === "node:crypto") return { randomUUID: () => "uuid-" + ++uuid };
    if (name === "node:fs")
      return {
        realpathSync: (p: string) => {
          events.push(["realpath", p]);
          return p;
        },
      };
    if (name.endsWith("/domain/contracts"))
      return { id: (_kind: string, value: string) => value };
    if (name.endsWith("/artifact-store"))
      return {
        createArtifactStore: (p: string) => {
          events.push(["store", p]);
          return {};
        },
      };
    if (name.endsWith("/selection-rules"))
      return {
        createSelectionRuleArtifactClient: () => artifact,
        validateReference: (value: unknown) => value,
      };
    if (name.endsWith("/owned-results") || name === "./queue-response-files")
      return { projectDirectory: (p: string) => p };
    if (name === "./catalog") return { selectionRulesInternal: { authorize } };
    return undefined;
  };
  const entry = manifest["selection-rules"]!;
  const api = historical
    ? load(path.join(fixtures, entry.fixture), overrides, entry.sha256)
    : load(
        path.join(
          root,
          "src/dist/node-adapters/persistence/selection-service.js",
        ),
        overrides,
      );
  const execute = historical
    ? api.execute
    : api.createSelectionExecutor(authorize);
  const operation = scenario.operation || "selection.rule.resolve";
  const input =
    operation === "selection.rule.define"
      ? { ruleId: "outer-face" }
      : { artifact: clone(reference) };
  const target = { ...context, ...scenario.context };
  const native = async (op: string, payload: Payload, ctx: Payload) => {
    events.push(["native", op, clone(payload), clone(ctx)]);
    if (scenario.throwNative) throw new Error("uncertain native outcome");
    const next = { ...saved, revision: scenario.changed ? 2 : 1 };
    const result = {
      success: true,
      operation,
      status: scenario.status || "resolved",
      manifest: next,
      count: 1,
      refs: ["face-A"],
    };
    return scenario.unwrapped ? result : { result };
  };
  let output;
  try {
    output = {
      value: clone(
        await execute(
          scenario.unavailable ? null : {},
          operation,
          input,
          target,
          { projectDirectory: "/owned", executeNative: native },
        ),
      ),
    };
  } catch (error) {
    output = { error: errorMessage(error) };
  }
  return { output, events, input, target };
}
for (const scenario of [
  { operation: "selection.rule.define" },
  { operation: "selection.rule.inspect", changed: true },
  { operation: "selection.rule.resolve" },
  { operation: "selection.rule.resolve", changed: true },
  { operation: "selection.rule.check", changed: true },
  { changed: true, status: "ambiguous" },
  { missing: true },
  { throwNative: true },
  { unwrapped: true },
  { unavailable: true },
  { operation: "unknown" },
  { context: { projectId: "foreign" } },
  { context: { docId: "foreign" } },
  { context: { docFileId: "foreign" } },
  { context: { docFileId: null } },
  { context: { docFileId: null, docId: null } },
] as SelectionScenario[]) {
  test(
    "selection service matches historical effects: " + JSON.stringify(scenario),
    async () => {
      const before = await selection(true, scenario);
      const after = await selection(false, scenario);
      assert.deepEqual(after, before);
      assert.ok(
        after.events.filter((event) => event[0] === "native").length <= 1,
      );
      if (
        scenario.missing ||
        scenario.context ||
        scenario.unavailable ||
        scenario.operation === "unknown"
      )
        assert.equal(
          after.events.filter((event) => event[0] === "native").length,
          0,
        );
      if (
        scenario.operation === "selection.rule.inspect" ||
        scenario.throwNative
      )
        assert.equal(
          after.events.filter((event) => event[0] === "write").length,
          0,
        );
    },
  );
}
async function brep(
  historical: boolean,
  operation: string,
  target: Payload,
  client: unknown,
) {
  const events: unknown[][] = [];
  const authorize = (payload: Payload) =>
    events.push(["authorize", clone(payload)]);
  const overrides = (name: string) => {
    if (name === "node:crypto") return { randomUUID: () => "session-A" };
    if (name === "node:fs")
      return {
        realpathSync: (p: string) => {
          events.push(["realpath", p]);
          return p;
        },
      };
    if (name.includes("/application/cad/brep-baseline"))
      return {
        createBrepBaselineService: (ports: BrepPorts) => ({
          async execute(op: string, data: Payload, context: Payload) {
            events.push(["execute", op, data, context, ports.newSession()]);
            ports.stage(2);
            return ports.executeNative("capture", { owned: true }, context);
          },
        }),
      };
    if (
      name.endsWith("/persistence/brep-baseline") ||
      name === "./brep-baseline"
    )
      return {
        brepBaselineArtifacts: (p: string) => {
          events.push(["artifacts", p]);
          return {};
        },
        createBrepBaselineStage: (
          p: string,
          count: number,
          convert: (path: string) => string,
        ) => {
          events.push(["stage", p, count, convert("part")]);
          return {};
        },
      };
    if (name === "./queue-response-files" || name === "./owned-results")
      return { projectDirectory: (p: string) => p };
    if (name === "./catalog/brep-baseline-internal") return { authorize };
    return undefined;
  };
  const entry = manifest["brep-baseline"]!;
  const api = historical
    ? load(path.join(fixtures, entry.fixture), overrides, entry.sha256)
    : load(
        path.join(
          root,
          "src/dist/node-adapters/persistence/brep-baseline-service.js",
        ),
        overrides,
      );
  const execute = historical ? api.execute : api.createBrepExecutor(authorize);
  let output;
  try {
    output = await execute(client, operation, { bodies: ["body-A"] }, target, {
      projectDirectory: "/owned",
      toFusionPath: (p: string) => "fusion:" + p,
      executeNative: async (...args: unknown[]) => {
        events.push(["native", ...args]);
        return { success: true };
      },
    });
  } catch (error) {
    output = { error: errorMessage(error) };
  }
  return clone({ output, events });
}
for (const op of [
  "measure.baseline.capture",
  "measure.baseline.inspect",
  "measure.baseline.compare",
  "unknown",
]) {
  for (const pinned of [true, false]) {
    test(`BRep composition matches historical effects: ${op}, pinned=${pinned}`, async () => {
      const target = pinned ? context : {};
      assert.deepEqual(
        await brep(false, op, target, pinned ? {} : null),
        await brep(true, op, target, pinned ? {} : null),
      );
    });
  }
}
