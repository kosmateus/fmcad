import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  bindBootstrapEntryEvidence,
  bootstrapInstalledFilesDigest,
  type BootstrapEntryIntent,
} from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function fixture(runOnStartup = false) {
  const fork = "C:\\private\\addin\\AutodeskFusionMCP.py";
  const profile = {
    nativePath: "C:\\private\\JSLoadedScriptsinfo",
    bytes: encode({
      loadedScripts: [
        {
          name: "AutodeskFusionMCP",
          path: fork,
          location: 3,
          isRemoved: false,
          isFavorite: false,
          runOnStartup,
        },
      ],
    }),
  };
  const expected: BootstrapEntryIntent = {
    kind: "fmcad-bootstrap-entry-intent",
    version: 1,
    nonce: "a".repeat(32),
    process: { pid: 42, birth: "fresh-os-birth" },
    purpose: "isolated-stdout-v1",
    engineVersion: 2,
    installed: {
      directory: "C:\\private\\addin",
      source: "b".repeat(40),
      files: {
        "AutodeskFusionMCP.py": "c".repeat(64),
        "addon_runtime.py": "d".repeat(64),
        "lib/bootstrap_entry.py": "e".repeat(64),
      },
    },
    profile: { path: profile.nativePath, sha256: sha(profile.bytes) },
    receipts: {
      directory: "C:\\private\\receipts",
      entry: "entry.json",
      returned: "returned.json",
    },
  };
  const intent = {
    nativePath: "C:\\private\\intent.json",
    bytes: encode(expected),
  };
  const ref = (file: { nativePath: string; bytes: Uint8Array }) => ({
    path: file.nativePath,
    sha256: sha(file.bytes),
  });
  const base = {
    kind: "fmcad-bootstrap-entry-receipt",
    version: 1,
    nonce: expected.nonce,
    process: expected.process,
    purpose: expected.purpose,
    engineVersion: 2,
    intent: ref(intent),
    profile: expected.profile,
    installed: {
      directory: expected.installed.directory,
      source: expected.installed.source,
      filesDigest: bootstrapInstalledFilesDigest(expected.installed.files),
    },
  };
  const entry = {
    nativePath: "C:\\private\\receipts\\entry.json",
    bytes: encode({ ...base, phase: "entry-before-addon-import" }),
  };
  const returned = {
    nativePath: "C:\\private\\receipts\\returned.json",
    bytes: encode({ ...base, phase: "run-returned", entry: ref(entry) }),
  };
  return { expected, originals: { intent, profile, entry, returned }, fork };
}
test("entry and normal-return bytes bind exact intent, process, source and controlled profile without granting authority", () => {
  const f = fixture();
  const result = bindBootstrapEntryEvidence(f.expected, f.originals, f.fork);
  assert.ok(result);
  assert.equal(result.authority, "NONE");
  assert.equal(result.references.length, 4);
  f.originals.entry.bytes.fill(0);
  assert.equal(result.references[2]?.sha256.length, 64);
});
test("incomplete, altered and foreign original phases cannot be bound", () => {
  for (const change of [
    { phase: "ready" },
    { nonce: "f".repeat(32) },
    { process: { pid: 43, birth: "other" } },
    { extra: true },
    { installed: { directory: "C:\\other" } },
    { entry: { path: "C:\\other\\entry.json", sha256: "0".repeat(64) } },
  ]) {
    const f = fixture();
    f.originals.returned.bytes = encode({
      ...JSON.parse(f.originals.returned.bytes.toString()),
      ...change,
    });
    assert.equal(
      bindBootstrapEntryEvidence(f.expected, f.originals, f.fork),
      null,
    );
  }
  const f = fixture();
  f.originals.profile.bytes = encode({ loadedScripts: [] });
  assert.equal(
    bindBootstrapEntryEvidence(f.expected, f.originals, f.fork),
    null,
  );
  const enabled = fixture(true);
  assert.equal(
    bindBootstrapEntryEvidence(
      enabled.expected,
      enabled.originals,
      enabled.fork,
    ),
    null,
    "even consistent receipts do not qualify an autoload-enabled profile",
  );
});
test("installed-file digest matches the native Python encoder including Unicode and numeric filenames", () => {
  const files = {
    "2": "a".repeat(64),
    "10": "b".repeat(64),
    "żółć.py": "c".repeat(64),
    "𐀀.py": "d".repeat(64),
    "\ue000.py": "e".repeat(64),
  };
  const reference = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      "import json,hashlib,sys; v=json.load(sys.stdin); print(hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf-8')).hexdigest())",
    ],
    { input: JSON.stringify(files), encoding: "utf8" },
  );
  assert.equal(reference.status, 0, reference.stderr);
  assert.equal(bootstrapInstalledFilesDigest(files), reference.stdout.trim());
});
