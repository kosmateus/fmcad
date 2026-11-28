import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";

const load = createRequire(__filename);
const { inspectMetadataWorkerProcess } = load(
  "../src/dist/composition/queue-epoch-successor-retirement",
) as typeof import("../src/composition/queue-epoch-successor-retirement");
const { processBirth } = load("../../src/queue-instance") as {
  processBirth(pid: number): string;
};

test("normal serve retirement previews the exact CLI producer without weakening worker selection", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "normal-serve-retirement-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "bin"));
  const file = path.join(root, "bin/fmcad.js");
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, "{}");
  fs.writeFileSync(file, "process.stdin.resume();");
  const child = spawn(
    process.execPath,
    [
      file,
      "queue",
      "serve",
      "--backend",
      "mcp",
      "--config",
      config,
      "--confirm-ownership",
      "true",
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  t.after(() => {
    child.kill();
  });
  await once(child, "spawn");
  assert.ok(child.pid);
  const owner = {
    pid: child.pid,
    birth: processBirth(child.pid),
    nonce: "test",
    protocol: 2,
  };
  assert.throws(() =>
    inspectMetadataWorkerProcess(owner, root, [], false, root),
  );
  const preview = inspectMetadataWorkerProcess(
    owner,
    root,
    [],
    false,
    root,
    [],
    "inspect",
    "normal-serve",
  );
  assert.equal(preview.retired, false);
  assert.equal(preview.process.pid, child.pid);
  assert.equal(child.exitCode, null);
  assert.throws(() =>
    inspectMetadataWorkerProcess(
      { ...owner, birth: "foreign:1" },
      root,
      [],
      false,
      root,
      [],
      "inspect",
      "normal-serve",
    ),
  );
  assert.throws(() =>
    inspectMetadataWorkerProcess(
      owner,
      path.join(root, "foreign"),
      [],
      false,
      root,
      [],
      "inspect",
      "normal-serve",
    ),
  );
  assert.throws(() =>
    inspectMetadataWorkerProcess(
      owner,
      root,
      [{ path: config, sha256: "0".repeat(64) }],
      false,
      root,
      [],
      "inspect",
      "normal-serve",
    ),
  );
  assert.ok(preview.interpreter);
  const retired = inspectMetadataWorkerProcess(
    {
      ...owner,
      processProof: preview.process,
      interpreterProof: preview.interpreter,
    },
    root,
    [],
    true,
    root,
    [],
    "inspect",
    "normal-serve",
  );
  assert.equal(retired.retired, true);
  await once(child, "exit");
  for (const argv of [
    [
      file,
      "queue",
      "serve",
      "--backend",
      "addin",
      "--config",
      config,
      "--confirm-ownership",
      "true",
    ],
    [
      file,
      "queue",
      "serve",
      "--backend",
      "mcp",
      "--config",
      config,
      "--confirm-ownership",
      "true",
      "--idle-ms",
      "1",
    ],
  ]) {
    const other = spawn(process.execPath, argv, {
      stdio: ["pipe", "ignore", "ignore"],
    });
    t.after(() => {
      other.kill();
    });
    await once(other, "spawn");
    assert.ok(other.pid);
    const foreign = {
      ...owner,
      pid: other.pid,
      birth: processBirth(other.pid),
    };
    assert.throws(() =>
      inspectMetadataWorkerProcess(
        foreign,
        root,
        [],
        false,
        root,
        [],
        "inspect",
        "normal-serve",
      ),
    );
  }
});
