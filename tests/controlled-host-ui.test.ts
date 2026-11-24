import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  controlledHostUiAuditPaths,
  createControlledHostUi,
  readControlledHostUiCapture,
} from "../packages/node-adapters/src/execution/controlled-host-ui";
import { createControlledFusionLaunchAdapter } from "../packages/node-adapters/src/execution/controlled-fusion-launch";
import { bootstrapInstalledFilesDigest } from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
import { setImmediate } from "node:timers/promises";

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
test("a rejected asynchronous lease fence fails closed without an unhandled rejection or native action", async () => {
  const hash = "a".repeat(64);
  const installedDirectory = "C:\\owned-source";
  const files = Object.fromEntries(
    ["AutodeskFusionMCP.py", "addon_runtime.py", "lib/bootstrap_entry.py"].map(
      (name) => [name, hash],
    ),
  );
  const paths = {
    profile: "C:\\private\\profile.json",
    profileBackup: "C:\\private\\profile-before.json",
    intent: "C:\\private\\intent.json",
    receiptDirectory: "C:\\private\\receipts",
    entry: "C:\\private\\receipts\\entry.json",
    returned: "C:\\private\\receipts\\returned.json",
    launchJournal: "C:\\private\\launch.json",
    launchAttempt: "C:\\private\\launch-attempt.json",
    sourceClosure: "C:\\private\\closure.json",
    transcript: "C:\\private\\transcript.json",
    provision: "C:\\private\\provision.json",
  };
  // The real adapter constructor performs no native action. Deliberately absent
  // mapped files prove the rejected lease is refused before any executable read.
  const native = createControlledFusionLaunchAdapter({
    nativePython: "C:\\tools\\python.exe",
    mappedNativePython: "/never-launched/python.exe",
    nativePythonSha256: hash,
    sourceDirectory: installedDirectory,
    mappedSourceDirectory: "/never-launched/source",
    installedDirectory,
    mappedInstalledDirectory: "/never-launched/source",
    installedSource: "a".repeat(40),
    installedBuild: bootstrapInstalledFilesDigest(files),
    installedFiles: files,
    executable: "C:\\tools\\vendor.exe",
    mappedExecutable: "/never-launched/vendor.exe",
    executableSha256: hash,
    arguments: [],
    workingDirectory: "C:\\private",
    paths,
    originalPaths: [],
    mappedOriginalPaths: Object.fromEntries(
      Object.values(paths).map((name, index) => [
        name,
        `/never-launched/${index}`,
      ]),
    ),
    receiptTimeoutMs: 1,
    normalCloseTimeoutMs: 1,
    mainWindowClass: "Owned",
  });
  const selector = {
    id: "open",
    name: "Open manager",
    class: "Button",
    type: "ControlType.Button",
  };
  const ui = createControlledHostUi(
    {
      powershell: "C:\\tools\\powershell.exe",
      mappedPowershell: "/never-launched/powershell.exe",
      powershellSha256: hash,
      powershellConfigSha256: hash,
      executable: "C:\\tools\\vendor.exe",
      executableSha256: hash,
      mainClass: "Owned",
      openManager: selector,
      installedEntry: {
        ...selector,
        id: "entry",
        name: `${installedDirectory}\\AutodeskFusionMCP.py`,
      },
      start: { ...selector, id: "start", name: "Start" },
      auditDirectory: "C:\\private\\ui",
      mappedAuditDirectory: "/never-launched/ui",
    },
    native,
    {
      fence: () =>
        Promise.reject(new Error("Rejected async lease must be consumed")),
      assertCurrent: async () => {
        throw new Error("Async lease must not be queried");
      },
    },
  );
  const input = {
    process: processIdentity,
    entry: `${installedDirectory}\\AutodeskFusionMCP.py`,
  };
  await assert.rejects(
    ui.prepareExactHost(input),
    /Synchronous held lease fence/,
  );
  await setImmediate();
  await assert.rejects(ui.prepareExactHost(input), /retry|replay/);
});
test("normal staged UI adapters import and decode without workspace packages", () => {
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
      const legacy=require(${JSON.stringify(path.join(temp, "execution", "controlled-legacy-ui.js"))});
      if(typeof legacy.createControlledLegacyHostUi!=="function") process.exit(4);
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
