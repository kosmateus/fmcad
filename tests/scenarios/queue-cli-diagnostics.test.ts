import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  queueExecReceipt,
  queueExecReceiptWithDiagnostics,
} from "./queue-backend";

const owner = { clientId: "scenario:owned-client" };

test("missing public job receipt retains exact CLI output in a private request artifact", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-cli-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = {
    status: 1,
    stdout: "original stdout\n",
    stderr:
      'FMCAD_QUEUE_REQUEST {"requestId":"request:original","clientId":"scenario:owned-client"}\noriginal stderr\n',
  };

  assert.throws(
    () =>
      queueExecReceiptWithDiagnostics({
        result,
        directory: root,
        cliPath: "/qualified/bin/fmcad.js",
        argv: ["run", "owned-script.py"],
        owner,
        requestId: "request:original",
      }),
    (error: Error & { diagnosticPath?: string }) => {
      assert.match(error.message, /job receipt is missing or mismatched/);
      assert.ok(error.diagnosticPath);
      const artifact = JSON.parse(
        fs.readFileSync(error.diagnosticPath, "utf8"),
      ) as Record<string, unknown>;
      assert.equal(artifact["requestId"], "request:original");
      assert.equal(artifact["clientId"], owner.clientId);
      assert.equal(artifact["stdout"], result.stdout);
      assert.equal(artifact["stderr"], result.stderr);
      assert.equal(typeof artifact["scriptIdentity"], "string");
      assert.equal(fs.statSync(error.diagnosticPath).mode & 0o777, 0o600);
      assert.equal(
        fs.statSync(path.dirname(error.diagnosticPath)).mode & 0o777,
        0o700,
      );
      return true;
    },
  );
});

test("receipt success and identity failures keep their existing validation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-cli-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = {
    status: 0,
    stdout: "ok\n",
    stderr: [
      `FMCAD_QUEUE_REQUEST ${JSON.stringify({ requestId: "request:ok", clientId: owner.clientId })}`,
      `FMCAD_QUEUE_JOB ${JSON.stringify({ jobId: "job-1", requestId: "request:ok" })}`,
    ].join("\n"),
  };
  assert.deepEqual(
    queueExecReceiptWithDiagnostics({
      result,
      directory: root,
      cliPath: "/qualified/bin/fmcad.js",
      argv: ["run", "owned-script.py"],
      owner,
      requestId: "request:ok",
    }),
    { jobId: "job-1" },
  );
  assert.throws(
    () =>
      queueExecReceiptWithDiagnostics({
        result: {
          ...result,
          stderr: result.stderr.replace("request:ok", "foreign"),
        },
        directory: root,
        cliPath: "/qualified/bin/fmcad.js",
        argv: ["run", "owned-script.py"],
        owner,
        requestId: "request:ok",
      }),
    /request receipt has a foreign identity/,
  );
  assert.throws(
    () => queueExecReceipt(result.stderr, owner, "request:other"),
    /request receipt has a foreign identity/,
  );
});

test("an existing final artifact is never overwritten by a later failed receipt", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-cli-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requestId = "request:preserve-existing",
    valid = {
      status: 0,
      stdout: "first result",
      stderr: [
        `FMCAD_QUEUE_REQUEST ${JSON.stringify({ requestId, clientId: owner.clientId })}`,
        `FMCAD_QUEUE_JOB ${JSON.stringify({ jobId: "job-1", requestId })}`,
      ].join("\n"),
    },
    input = {
      directory: root,
      cliPath: "/qualified/bin/fmcad.js",
      argv: ["run", "owned-script.py"],
      owner,
      requestId,
    };
  queueExecReceiptWithDiagnostics({ result: valid, ...input });
  const finalDirectory = path.join(root, "queue-exec-diagnostics");
  const finalPath = path.join(
    finalDirectory,
    `queue-exec-${createHash("sha256")
      .update(JSON.stringify([requestId, owner.clientId]))
      .digest("hex")}.json`,
  );
  const original = fs.readFileSync(finalPath);
  assert.throws(
    () =>
      queueExecReceiptWithDiagnostics({
        ...input,
        result: {
          status: 1,
          stdout: "second result",
          stderr: `FMCAD_QUEUE_REQUEST ${JSON.stringify({ requestId, clientId: owner.clientId })}`,
        },
      }),
    (
      error: Error & {
        diagnosticWriteFailed?: boolean;
        diagnosticWriteError?: { code?: string };
      },
    ) => {
      assert.match(error.message, /job receipt is missing or mismatched/);
      assert.equal(error.diagnosticWriteFailed, true);
      assert.equal(error.diagnosticWriteError?.code, "EEXIST");
      return true;
    },
  );
  assert.deepEqual(fs.readFileSync(finalPath), original);
  assert.deepEqual(fs.readdirSync(finalDirectory), [path.basename(finalPath)]);
});

test("diagnostic write failure does not replace the primary receipt failure", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-cli-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(os.tmpdir(), path.join(root, "queue-exec-diagnostics"));
  assert.throws(
    () =>
      queueExecReceiptWithDiagnostics({
        result: { status: 1, stdout: "", stderr: "" },
        directory: root,
        cliPath: "/qualified/bin/fmcad.js",
        argv: ["run", "owned-script.py"],
        owner,
        requestId: "request:missing",
      }),
    (
      error: Error & {
        diagnosticPath?: string;
        diagnosticWriteFailed?: boolean;
        diagnosticWriteError?: { message?: string };
      },
    ) => {
      assert.match(error.message, /request receipt has a foreign identity/);
      assert.equal(error.diagnosticPath, undefined);
      assert.equal(error.diagnosticWriteFailed, true);
      assert.match(
        String(error.diagnosticWriteError?.message),
        /Queue diagnostic directory is not private/,
      );
      return true;
    },
  );
});

test("partial filesystem writes never publish a final artifact or replace receipt error", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "queue-cli-partial-write-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requestId = "request:partial-write",
    script = `
      process.on("SIGXFSZ", () => {});
      const { queueExecReceiptWithDiagnostics } = require(${JSON.stringify(path.join(__dirname, "queue-backend.js"))});
      const root = ${JSON.stringify(root)};
      const requestId = ${JSON.stringify(requestId)};
      const clientId = ${JSON.stringify(owner.clientId)};
      try {
        queueExecReceiptWithDiagnostics({
          result: {
            status: 1,
            stdout: "x".repeat(4096),
            stderr: "FMCAD_QUEUE_REQUEST " + JSON.stringify({ requestId, clientId }) + "\\n" + "y".repeat(4096),
          },
          directory: root,
          cliPath: "/qualified/bin/fmcad.js",
          argv: ["run", "owned-script.py"],
          owner: { clientId },
          requestId,
        });
        process.stdout.write(JSON.stringify({ unexpectedSuccess: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({
          message: error.message,
          diagnosticPath: error.diagnosticPath,
          diagnosticWriteError: error.diagnosticWriteError && error.diagnosticWriteError.code,
        }));
      }
    `;
  const child = spawnSync(
    "/bin/bash",
    ["-c", 'ulimit -f 2; exec "$@"', "bash", process.execPath, "-e", script],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  const outcome = JSON.parse(child.stdout) as Record<string, unknown>;
  assert.match(
    String(outcome["message"]),
    /job receipt is missing or mismatched/,
  );
  const identity = createHash("sha256")
    .update(JSON.stringify([requestId, owner.clientId]))
    .digest("hex");
  const directory = path.join(root, "queue-exec-diagnostics");
  const finalPath = path.join(directory, `queue-exec-${identity}.json`);
  assert.equal(
    fs.existsSync(finalPath),
    false,
    "partial final artifact published",
  );
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(outcome["diagnosticPath"], undefined);
  assert.equal(typeof outcome["diagnosticWriteError"], "string");
  assert.equal(outcome["diagnosticWriteError"], "EFBIG");
});
