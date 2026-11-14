import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(path.resolve(__dirname, "../../package.json"));
const { createDiagnosticLog } = load(
  "./packages/node-adapters/dist/telemetry/diagnostic-log",
) as typeof import("../packages/node-adapters/src/telemetry/diagnostic-log");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-retention-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory: path.join(root, "diagnostics") };
}

test("diagnostics bound queued input, rotate by bytes, redact and close", async (t) => {
  const { directory } = fixture(t);
  const log = createDiagnosticLog("test", {
    directory,
    maxBytes: 256,
    maxFiles: 2,
    maxPending: 2,
  });
  assert.equal(log.write("Authorization: Bearer private-secret"), true);
  assert.equal(log.write("second"), true);
  assert.equal(log.write("overflow"), false);
  await log.flush();
  assert.doesNotMatch(
    fs
      .readdirSync(directory)
      .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
      .join(""),
    /private-secret/,
  );
  for (let index = 0; index < 10; index++) {
    log.write("x".repeat(512));
    await log.flush();
  }
  assert.equal(fs.readdirSync(directory).length, 2);
  for (const name of fs.readdirSync(directory))
    assert.ok(fs.statSync(path.join(directory, name)).size <= 256);
  await log.close();
  assert.equal(log.write("after close"), false);
  assert.deepEqual(log.stats(), { pending: 0, dropped: 2, errors: 0 });
});

test("cleanup removes only inactive owned diagnostics and preserves recovery evidence", async (t) => {
  const { root, directory } = fixture(t);
  fs.mkdirSync(directory);
  const uuid = "11111111-1111-4111-8111-111111111111";
  const file = (at: number, pid: number) =>
    path.join(directory, `test-${at}-${pid}-${uuid}.log`);
  fs.writeFileSync(file(1, 101), "expired");
  fs.writeFileSync(file(2, 102), "live");
  const receipt = path.join(root, "unresolved-receipt.json");
  fs.writeFileSync(receipt, "original unresolved evidence");
  fs.linkSync(receipt, file(3, 103));
  fs.symlinkSync(receipt, file(4, 104));
  fs.writeFileSync(path.join(directory, "foreign.log"), "foreign");
  const log = createDiagnosticLog("test", {
    directory,
    now: () => 1000,
    maxAgeMs: 100,
    isAlive: (pid) => pid === 102,
  });
  log.write("new");
  await log.close();
  assert.equal(fs.existsSync(file(1, 101)), false);
  assert.equal(fs.readFileSync(file(2, 102), "utf8"), "live");
  assert.equal(
    fs.readFileSync(receipt, "utf8"),
    "original unresolved evidence",
  );
  assert.equal(fs.lstatSync(file(3, 103)).nlink, 2);
  assert.equal(fs.lstatSync(file(4, 104)).isSymbolicLink(), true);
  assert.equal(
    fs.readFileSync(path.join(directory, "foreign.log"), "utf8"),
    "foreign",
  );
});

test("diagnostic disk full is reported separately and writing recovers", async (t) => {
  const { root, directory } = fixture(t);
  const durable = path.join(root, "history.sqlite");
  fs.writeFileSync(durable, "durable");
  let full = true;
  const io = {
    ...fs,
    writeFileSync(...args: Parameters<typeof fs.writeFileSync>) {
      if (full) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return fs.writeFileSync(...args);
    },
  };
  const log = createDiagnosticLog("test", { directory, io });
  log.write("lost auxiliary record");
  await log.flush();
  assert.equal(log.stats().errors, 1);
  full = false;
  log.write("recovered");
  await log.close();
  assert.match(
    fs
      .readdirSync(directory)
      .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
      .join(""),
    /recovered/,
  );
  assert.equal(fs.readFileSync(durable, "utf8"), "durable");
});

test("deleting temporary diagnostics does not prevent subsequent writes", async (t) => {
  const { directory } = fixture(t);
  const log = createDiagnosticLog("test", {
    directory,
    maxBytes: 128,
    maxFiles: 1,
  });
  log.write("first");
  await log.flush();
  fs.rmSync(directory, { recursive: true });
  log.write("after cleanup");
  await log.close();
  assert.equal(log.stats().errors, 0);
  assert.equal(fs.readdirSync(directory).length, 1);
});

test("unsafe diagnostic directory cannot redirect writes", async (t) => {
  const { root, directory } = fixture(t);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, directory);
  const log = createDiagnosticLog("test", { directory });
  log.write("must not appear");
  await log.close();
  assert.equal(log.stats().errors, 1);
  assert.deepEqual(fs.readdirSync(outside), []);
});
