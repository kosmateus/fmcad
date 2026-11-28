import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { cameraReceiptSource } from "../packages/node-adapters/src/execution/camera-receipt.js";
import { receiptIdentitySource } from "../packages/node-adapters/src/execution/receipt-identity.js";

const binding = {
  jobId: "job",
  rpcId: "rpc",
  requestHash: "request",
  buildHash: "build",
  sourceHash: "source",
};

test("ordinary camera receipt is deterministic and excludes unrelated workflows", () => {
  const source = cameraReceiptSource(
    "print('camera')",
    "C:\\receipt.json",
    binding,
  );
  assert.equal(
    source,
    cameraReceiptSource("print('camera')", "C:\\receipt.json", binding),
  );
  assert.doesNotMatch(
    source,
    /audit|atomic-batch|__fmcad_native_lifecycle__|\/proc\/|_qr_object|_qr_cast|_qr_execute/,
  );
  assert.match(source, /GetProcessTimes/);
  assert.match(source, /_qi_os\.fsync/);
  assert.match(source, /_qi_os\.replace/);
  assert.doesNotMatch(
    receiptIdentitySource("windows"),
    /\/proc\/|platform\.startswith/,
  );
  assert.match(receiptIdentitySource(), /\/proc\/self\/stat/);
  for (const invalid of [
    { ...binding, auditExpectedProcess: {} },
    { ...binding, purpose: "atomic-batch" },
    { ...binding, sourceHash: "" },
  ])
    assert.throws(() =>
      cameraReceiptSource("pass", "C:\\receipt.json", invalid),
    );
  assert.throws(() =>
    cameraReceiptSource("pass", "/tmp/not-windows.json", binding),
  );
});

test("Windows receipt preserves ABI, terminal errors, atomic writes and host refusal", () => {
  const sources = {
    success: cameraReceiptSource(
      "assert '__fmcad_native_lifecycle__' not in globals()\nprint('camera')",
      "C:\\success.json",
      binding,
    ),
    failure: cameraReceiptSource(
      "raise ValueError('camera error')",
      "C:\\failed.json",
      binding,
    ),
    host: cameraReceiptSource(
      "raise AssertionError('must not run')",
      "C:\\host.json",
      binding,
    ),
  };
  const directory = mkdtempSync("/tmp/opencode/camera-receipt-");
  const program = `
import json, uuid, traceback, ctypes, os, sys, types, unittest
real_os = os
calls = []
class FileTime:
    dwHighDateTime = 1
    dwLowDateTime = 2
class ProcessHandle:
    restype = None
    def __call__(self): return "handle"
class ProcessTimes:
    argtypes = None
    def __call__(self, handle, *times):
        assert handle == "handle" and len(times) == 4
        assert self.argtypes == ["HANDLE"] + ["FILETIME*"] * 4
        calls.append("times")
        return 1
kernel = types.SimpleNamespace(GetCurrentProcess=ProcessHandle(), GetProcessTimes=ProcessTimes())
fake_ct = types.ModuleType("ctypes")
fake_ct.WinDLL = lambda name, use_last_error: kernel
fake_ct.POINTER = lambda value: "FILETIME*"
fake_ct.byref = lambda value: value
fake_wt = types.ModuleType("ctypes.wintypes")
fake_wt.HANDLE, fake_wt.FILETIME = "HANDLE", FileTime
fake_ct.wintypes = fake_wt
fake_os = types.SimpleNamespace(
    name="nt", getpid=lambda: 123,
    fsync=lambda fd: (calls.append("fsync"), real_os.fsync(fd))[-1],
    replace=lambda src, dst: (calls.append("replace"), real_os.replace(src, dst))[-1])
adsk = types.ModuleType("adsk")
adsk.core = types.ModuleType("adsk.core")
adsk.core.Application = types.SimpleNamespace(get=lambda: types.SimpleNamespace(
    version="version", userInterface=types.SimpleNamespace(activeCommand="SelectCommand")))
sys.modules.update({"os": fake_os, "ctypes": fake_ct, "ctypes.wintypes": fake_wt,
                    "adsk": adsk, "adsk.core": adsk.core})
sources = json.loads(${JSON.stringify(JSON.stringify(sources))})
class ReceiptBehavior(unittest.TestCase):
    def setUp(self):
        calls.clear()
    def test_success(self):
        exec(sources["success"], {})
        with open("C:\\\\success.json") as stream: receipt = json.load(stream)
        self.assertTrue(receipt["terminal"])
        self.assertEqual(receipt["outcome"], "succeeded")
        self.assertEqual(receipt["sourceHash"], "source")
        self.assertEqual(receipt["instance"], {
            "pid":123, "birth":str((1 << 32) | 2), "version":"version", "activeCommand":"SelectCommand"})
        self.assertEqual(kernel.GetCurrentProcess.restype, "HANDLE")
        self.assertIn("fsync", calls)
        self.assertLess(calls.index("fsync"), calls.index("replace"))
    def test_failure(self):
        with self.assertRaisesRegex(ValueError, "camera error"):
            exec(sources["failure"], {})
        with open("C:\\\\failed.json") as stream: receipt = json.load(stream)
        self.assertEqual(receipt["outcome"], "failed")
        self.assertEqual(receipt["error"]["type"], "ValueError")
        self.assertIn("camera error", receipt["error"]["traceback"])
    def test_host_refusal(self):
        fake_os.name = "posix"
        try:
            with self.assertRaisesRegex(RuntimeError, "qualified Windows"):
                exec(sources["host"], {})
            self.assertFalse(real_os.path.exists("C:\\\\host.json"))
        finally: fake_os.name = "nt"
    def test_failed_birth_has_no_pid_fallback(self):
        previous = kernel.GetProcessTimes
        kernel.GetProcessTimes = lambda *args: 0
        fake_ct.get_last_error = lambda: 5
        try:
            with self.assertRaises(OSError):
                exec(sources["host"].replace("raise AssertionError('must not run')", "pass"), {})
            self.assertFalse(real_os.path.exists("C:\\\\host.json"))
            self.assertNotIn("replace", calls)
        finally: kernel.GetProcessTimes = previous
    def test_failed_atomic_write_is_not_success(self):
        previous = fake_os.replace
        def deny(*args): raise OSError("replace denied")
        fake_os.replace = deny
        try:
            with self.assertRaisesRegex(OSError, "replace denied"):
                exec(sources["host"].replace("raise AssertionError('must not run')", "pass"), {})
            self.assertFalse(real_os.path.exists("C:\\\\host.json"))
        finally: fake_os.replace = previous
unittest.main()
`;
  try {
    const result = spawnSync("python3", ["-I", "-S", "-B", "-c", program], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Ran 5 tests/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
