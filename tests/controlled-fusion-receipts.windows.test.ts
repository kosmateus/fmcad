import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { controlledFusionLaunchNative } from "../packages/node-adapters/src/execution/controlled-fusion-launch-native";

interface FixturePins {
  nativePython: string;
  mappedNativePython: string;
  nativePythonSha256: string;
  sourceDirectory: string;
  installedFiles: Record<string, string>;
}
interface Result {
  case: string;
  status: "ERROR" | "RECEIPT_PAIR_READ";
  error: null | { type: string; errno: number | null; message: string };
  observed: {
    sharingErrors: number;
    receiptOpenHandleGrowthAtTimeout?: number;
  };
  SDK: number;
  processControl: number;
  admissionWrites: number;
  originalReceiptWrites: number;
  nativeProgramUnmodified: boolean;
}
const fixturePins = process.env["FMCAD_RECEIPT_SHARING_WINDOWS_PINS"];
function run(mode: string): Result {
  assert(fixturePins);
  const pins = JSON.parse(fs.readFileSync(fixturePins, "utf8")) as FixturePins;
  assert.equal(
    createHash("sha256")
      .update(fs.readFileSync(pins.mappedNativePython))
      .digest("hex"),
    pins.nativePythonSha256,
  );
  const fixture = fs.readFileSync(
    path.resolve("tests/fixtures/controlled-receipt-sharing-windows.py"),
    "utf8",
  );
  const call = spawnSync(
    pins.mappedNativePython,
    ["-I", "-S", "-B", "-c", fixture],
    {
      input: JSON.stringify({
        ...pins,
        case: mode,
        program: controlledFusionLaunchNative,
        receiptTimeoutMs: 400,
      }),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        SystemRoot: "C:\\Windows",
        WSLENV: [process.env["WSLENV"], "SystemRoot"].filter(Boolean).join(":"),
      },
    },
  );
  assert.ifError(call.error);
  assert.equal(call.status, 0, call.stderr);
  const result = JSON.parse(call.stdout) as Result;
  assert.equal(result.case, mode);
  assert.equal(result.SDK, 0);
  assert.equal(result.processControl, 0);
  assert.equal(result.admissionWrites, 0);
  assert.equal(result.originalReceiptWrites, 0);
  assert.equal(result.nativeProgramUnmodified, true);
  return result;
}
for (const mode of ["entry", "returned"]) {
  test(
    `native receipts wait for the ${mode} writer to close without relaxing stable-file guards`,
    {
      skip: !fixturePins,
    },
    () => {
      const result = run(mode);
      assert.equal(result.status, "RECEIPT_PAIR_READ", JSON.stringify(result));
      assert.equal(result.error, null);
      assert(result.observed.sharingErrors >= 1);
    },
  );
}
for (const mode of ["entry-timeout", "returned-timeout", "missing-returned"]) {
  test(
    `native receipts keep their deadline and bounded file handles for ${mode}`,
    {
      skip: !fixturePins,
    },
    () => {
      const result = run(mode);
      assert.equal(result.status, "ERROR");
      assert(result.error);
      assert.equal(result.error?.type, "TimeoutError", JSON.stringify(result));
      assert.match(
        result.error.message,
        /Original receipt pair incomplete; no replay/,
      );
      assert(
        result.observed.receiptOpenHandleGrowthAtTimeout !== undefined &&
          result.observed.receiptOpenHandleGrowthAtTimeout <= 3,
        JSON.stringify(result),
      );
    },
  );
}
test(
  "native receipts do not treat an alias guard failure as a transient writer",
  {
    skip: !fixturePins,
  },
  () => {
    const result = run("hardlink");
    assert.equal(result.status, "ERROR");
    assert(result.error);
    assert.equal(result.error?.type, "ValueError");
    assert.match(
      result.error.message,
      /Regular non-aliased native file required/,
    );
    assert.equal(result.observed.sharingErrors, 0);
  },
);
test(
  "native receipts do not retry a receipt ACL refusal as a sharing window",
  {
    skip: !fixturePins,
  },
  () => {
    const result = run("public-acl");
    assert.equal(result.status, "ERROR");
    assert(result.error);
    assert.notEqual(result.error.type, "TimeoutError");
    assert.match(
      result.error.message,
      /ACL|DACL|private|owner|permissions|allow|SID/i,
    );
    assert.equal(result.observed.sharingErrors, 0);
  },
);
test(
  "native receipts do not retry a non-sharing CreateFileW refusal",
  {
    skip: !fixturePins,
  },
  () => {
    const result = run("directory-entry");
    assert.equal(result.status, "ERROR");
    assert.equal(result.error?.errno, 5, JSON.stringify(result));
    assert.equal(result.observed.sharingErrors, 0);
  },
);
