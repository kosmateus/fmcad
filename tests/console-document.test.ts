import { createRequire } from "node:module";
import type { ConsoleRow } from "@fmcad/core";

import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
const load = createRequire(
  path.join(process.cwd(), "tests", "console-document.test.js"),
);
const { documentLabel, sourceName, documentFields } = load(
  "../src/console-document",
) as typeof import("@fmcad/core");
const { textContext } = load("./fixtures/console-text-context.cjs") as {
  textContext(language?: string): Parameters<typeof describe>[1];
};
const { describe } = load(
  "../src/console-details",
) as typeof import("../src/composition/library-console-details");
const { ConsoleModel } = load(
  "../src/console-controller",
) as typeof import("../src/composition/library-console-controller");
test("document display prioritizes recorded Fusion names and marks source fallbacks explicitly", () => {
  const source = { sourcePath: "/project/fixture.py", label: "run fixture.py" };
  assert.equal(
    documentLabel({ ...source, document: "Known Fusion v2" }),
    "Known Fusion v2",
  );
  assert.equal(documentLabel(source), "py · fixture.py");
  assert.equal(
    sourceName({ sourcePath: "C:\\project\\fixture.py" }),
    "fixture.py",
  );
  assert.equal(documentLabel({ script: "retained.py" }), "py · retained.py");
  assert.equal(documentLabel({ label: "run retained.py" }), "py · retained.py");
  assert.equal(documentLabel({ label: "doctor" }), null);
  assert.equal(documentLabel(null), null);
  assert.equal((source as ConsoleRow).document, undefined);
});
test("details use the same display value and disclose the fallback provenance", () => {
  const ui = textContext("en");
  const row = {
    id: "op",
    state: "succeeded",
    sourcePath: "/project/fixture.py",
  };
  assert.equal(documentFields(row, ui)[0]!.value, documentLabel(row));
  assert.match(
    documentFields(row, ui)[1]!.value as string,
    /Fusion target not recorded/,
  );
  const fields = describe(row, ui).fields;
  assert.equal(
    fields.find((field) => field.label === "Document / script")!.value,
    "py · fixture.py",
  );
});

test("document filters accept recorded target, source filename and displayed fallback", () => {
  const model = new ConsoleModel();
  model.tab = 2;
  model.update({
    operations: [
      { id: "source", state: "succeeded", sourcePath: "/project/fixture.py" },
      { id: "doc", state: "succeeded", document: "Known Fusion" },
    ],
  });
  for (const document of ["fixture.py", "py · fixture.py"]) {
    model.state.filters = { scope: "all", document };
    assert.deepEqual(
      model.rows()!.map((row) => row.id),
      ["source"],
    );
  }
  model.state.filters.document = "Known Fusion";
  assert.deepEqual(
    model.rows()!.map((row) => row.id),
    ["doc"],
  );
});
