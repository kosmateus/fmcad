import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  controlledHostUiAuditPaths,
  readControlledHostUiCapture,
} from "../packages/node-adapters/src/execution/controlled-host-ui";

const processIdentity = { pid: 321, birth: "123456789" };
// Complete 1x1 RGBA PNG; decoding tests are NOT Windows UI execution.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";
function fixture() {
  const main = {
    index: -1,
    id: "",
    name: "Owned fixture",
    class: "Window",
    type: "ControlType.Window",
    enabled: true,
    offscreen: false,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    selected: null,
  };
  return {
    inputDelivered: false,
    png,
    view: {
      process: processIdentity,
      hwnd: "555",
      main,
      tree: [
        {
          ...main,
          index: 0,
          name: "C:\\owned\\AutodeskFusionMCP.py",
          selected: true,
        },
      ],
      selectedEntry: "C:\\owned\\AutodeskFusionMCP.py",
    },
  };
}
test("full original capture is data only and preserves exact process/selection", () => {
  const value = fixture();
  assert.deepEqual(
    readControlledHostUiCapture(JSON.stringify(value), processIdentity, false),
    value,
  );
});
test("partial pixels/tree, wrong HWND/PID/birth/selection and unknown fields are refused", () => {
  const checks: Array<(value: ReturnType<typeof fixture>) => void> = [
    (v) => {
      v.png = Buffer.from(v.png, "base64").subarray(0, 24).toString("base64");
    },
    (v) => {
      v.png = Buffer.from(v.png, "base64").subarray(0, -4).toString("base64");
    },
    (v) => {
      v.view.main.width = 2;
    },
    (v) => {
      v.view.tree[0]!.index = 9;
    },
    (v) => {
      v.view.selectedEntry = "C:\\another\\AutodeskFusionMCP.py";
    },
    (v) => {
      v.view.process = { ...processIdentity, pid: 111 };
    },
    (v) => {
      v.view.process = { ...processIdentity, birth: "999" };
    },
    (v) => {
      v.inputDelivered = true;
    },
    (v) => {
      Object.assign(v.view.tree[0]!, { authority: true });
    },
  ];
  for (const change of checks) {
    const value = structuredClone(fixture());
    change(value);
    assert.throws(() =>
      readControlledHostUiCapture(
        JSON.stringify(value),
        processIdentity,
        false,
      ),
    );
  }
  assert.throws(() =>
    readControlledHostUiCapture(
      JSON.stringify(fixture()),
      processIdentity,
      false,
      "556",
    ),
  );
  assert.throws(() =>
    readControlledHostUiCapture(
      '{"view":{},"view":{}}',
      processIdentity,
      false,
    ),
  );
});
test("durable start action paths are bound to original intent, not a new audit directory", () => {
  const intent = "C:\\owned\\original-intent.json";
  const a = controlledHostUiAuditPaths("C:\\owned\\first", intent);
  const b = controlledHostUiAuditPaths("C:\\owned\\second", intent);
  assert.deepEqual(a.slice(-2), b.slice(-2));
  assert.equal(a.at(-1), `${intent}.ui-start-attempt.json.dispatch`);
  assert.equal(a.length, new Set(a).size);
});
test("normal staged adapter imports and decodes without workspace packages", () => {
  const root = path.resolve(__dirname, "../..");
  const staged = path.join(root, "dist/src/dist/node-adapters/execution");
  assert.ok(
    fs.existsSync(path.join(staged, "controlled-host-ui.js")),
    "Run normal stage-core before this test",
  );
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "controlled-ui-staged-"));
  try {
    fs.cpSync(staged, path.join(temp, "execution"), { recursive: true });
    const loaded = createRequire(path.join(temp, "fixture.cjs")).resolve(
      "./execution/controlled-host-ui.js",
    );
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const {readControlledHostUiCapture}=require(${JSON.stringify(loaded)});
      const v=${JSON.stringify(fixture())};
      if(readControlledHostUiCapture(JSON.stringify(v),v.view.process,false).view.hwnd!=="555") process.exit(3);
    `,
      ],
      { cwd: temp, encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
