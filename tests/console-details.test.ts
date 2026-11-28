import { createRequire } from "node:module";

import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
const load = createRequire(
  path.join(process.cwd(), "tests", "console-details.test.js"),
);
const { textContext } = load("./fixtures/console-text-context.cjs") as {
  textContext(language?: string): Parameters<typeof describe>[1];
};
const { describe, correlate, refresh } = load(
  "../src/console-details",
) as typeof import("../src/composition/library-console-details");
const { ConsoleModel } = load(
  "../src/console-controller",
) as typeof import("../src/composition/library-console-controller");
const makeUI = () => textContext("en");
test("details distinguish absent, false and zero and scope direct results to transport", () => {
  const ui = makeUI();
  assert.doesNotThrow(() => describe(null, ui));
  assert.doesNotThrow(
    () => describe({ state: "running" }, ui),
    "missing archive and task identity must remain unavailable, not crash",
  );
  const detail = describe(
    { id: "op", state: "completed", exitCode: 0, mayHaveMutated: false },
    ui,
    { mode: "direct" },
  );
  assert.equal(
    detail.fields.find((field) => field.label === "Process exit code")!.value,
    0,
  );
  assert.equal(
    detail.fields.find((field) => field.label === "May have mutated")!.value,
    "No",
  );
  assert.match(
    detail.fields.find((field) => field.label === "Result scope")!
      .value as string,
    /Transport only/,
  );
  assert.ok(
    !detail.fields.some((field) =>
      field.group?.startsWith("Related operations"),
    ),
  );
});

test("correlation excludes absent IDs and modal drilldowns select only matching retained IDs", () => {
  const model = new ConsoleModel();
  model.update({
    agents: [{ id: "a" }, { id: "b" }],
    operations: [
      { id: "op", clientId: "a", requestId: "req" },
      { id: "other" },
    ],
    logs: [{ id: "event", requestId: "req" }, { id: "unrelated" }],
  });
  assert.deepEqual(
    correlate({ id: "b", operations: [] }, model.snapshot).events,
    [],
  );
  assert.equal(
    model.related("tasks", { id: "unrelated", level: "INFO" }, model.snapshot),
    false,
  );
  assert.equal(
    model.related("logs", model.snapshot.operations![0]!, model.snapshot),
    true,
  );
  assert.deepEqual(
    model.rows()!.map((row) => row.id),
    ["event"],
  );
  assert.equal(
    model.related("agents", model.snapshot.operations![0]!, model.snapshot),
    true,
  );
  assert.deepEqual(
    model.rows()!.map((row) => row.id),
    ["a"],
  );
});
test("refresh pins the inspected ID through filtering, retention loss and frozen snapshots", () => {
  const model = new ConsoleModel();
  model.tab = 2;
  const initial = { id: "op", state: "running", description: "original" };
  model.update({ operations: [initial], logs: [] });
  const modal: Parameters<typeof refresh>[0] = {
    id: "op",
    rowType: "tasks" as const,
    row: structuredClone(initial),
  };
  model.state.filters = { scope: "open" };
  model.update({ operations: [{ ...initial, state: "completed" }], logs: [] });
  refresh(modal, model);
  assert.equal(modal.row.state, "completed");
  assert.equal(modal.outsideFilter, true);
  model.update({ operations: [], logs: [] });
  refresh(modal, model);
  assert.equal(modal.missing, true);
  assert.equal(modal.row.description, "original");
  model.update({ operations: null, available: false });
  refresh(modal, model);
  assert.equal(modal.missing, false);
  assert.equal(modal.contextSnapshot!.available, false);
  modal.frozen = true;
  const before = structuredClone(modal);
  model.update({ operations: [{ id: "op", description: "new" }] });
  refresh(modal, model);
  assert.deepEqual(modal, before);
});
