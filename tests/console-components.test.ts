import { createRequire } from "node:module";

const load = createRequire(
  path.join(process.cwd(), "tests", "console-components.test.js"),
);
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
const { ConsoleModel } = load(
  "../src/console-controller",
) as typeof import("../src/composition/library-console-controller");

test("agent correlations never join missing IDs and task log drilldown does not require an agent field", () => {
  const model = new ConsoleModel();
  assert.equal(
    model.related("logs", { state: "running" }),
    false,
    "missing task and request IDs must not select every log",
  );
  model.update({
    agents: [{ id: "A" }, { id: "B" }],
    operations: [{ id: "op", clientId: "A", state: "running" }],
    logs: [{ id: "log", taskId: "op", message: "event" }],
  });
  assert.equal(model.source("agents")![1]!.operations!.length, 0);
  model.related("logs", model.snapshot.operations![0]!);
  assert.equal(model.rows()!.length, 1);
});
