import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  bindBootstrapEntryEvidence,
  bootstrapInstalledFilesDigest,
  type BootstrapEntryIntent,
  type BootstrapEntryIntentV2,
  type BootstrapStartupAudit,
} from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
import { controlledStartupAuditFixture } from "./controlled-fusion-bootstrap-fixture";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

type MutableRecord = Record<string, unknown>;

function object(value: unknown): MutableRecord {
  return value as MutableRecord;
}
function getPath(value: unknown, keys: readonly string[]): unknown {
  return keys.reduce<unknown>((current, key) => object(current)[key], value);
}
function setPath(
  value: unknown,
  keys: readonly string[],
  replacement: unknown,
): void {
  const parent = getPath(value, keys.slice(0, -1));
  object(parent)[keys.at(-1)!] = replacement;
}

function fixture() {
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
          runOnStartup: false,
        },
      ],
    }),
  };
  const expected: BootstrapEntryIntentV2 = {
    kind: "fmcad-bootstrap-entry-intent",
    version: 2,
    nonce: "a".repeat(32),
    process: { pid: 42, birth: "fresh-os-birth" },
    executable: {
      path: "C:\\Program Files\\Autodesk\\Fusion\\Fusion.exe",
      sha256: "f".repeat(64),
    },
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
    version: 2,
    nonce: expected.nonce,
    process: expected.process,
    purpose: expected.purpose,
    engineVersion: 2,
    executable: expected.executable,
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
    bytes: encode({
      ...base,
      phase: "entry-audited-before-addon-import",
      startupAudit: controlledStartupAuditFixture(),
    }),
  };
  const returned = {
    nativePath: "C:\\private\\receipts\\returned.json",
    bytes: encode({
      ...base,
      phase: "run-returned",
      entry: ref(entry),
    }),
  };
  const originals = { intent, profile, entry, returned };
  return { expected, originals, fork };
}

function rewriteEntry(
  f: ReturnType<typeof fixture>,
  change: (entry: MutableRecord) => void,
) {
  const entry = JSON.parse(f.originals.entry.bytes.toString()) as MutableRecord;
  change(entry);
  f.originals.entry.bytes = encode(entry);
  const returned = JSON.parse(
    f.originals.returned.bytes.toString(),
  ) as MutableRecord;
  returned["entry"] = {
    path: f.originals.entry.nativePath,
    sha256: sha(f.originals.entry.bytes),
  };
  f.originals.returned.bytes = encode(returned);
}

function audit(f: ReturnType<typeof fixture>): BootstrapStartupAudit {
  return getPath(JSON.parse(f.originals.entry.bytes.toString()), [
    "startupAudit",
  ]) as BootstrapStartupAudit;
}

test("closed v2 original bytes bind exact executable, full startup audit and returned entry hash as data only", () => {
  const f = fixture();
  const result = bindBootstrapEntryEvidence(f.expected, f.originals, f.fork);
  assert.ok(result);
  assert.equal(result.kind, "bound-bootstrap-entry-data");
  assert.equal(result.authority, "NONE");
  assert.deepEqual(result.executable, f.expected.executable);
  assert.deepEqual(result.entry, {
    path: f.originals.entry.nativePath,
    sha256: sha(f.originals.entry.bytes),
  });
  assert.deepEqual(result.startupAudit, audit(f));
  assert.equal(result.startupAudit.scripts.countBefore, 2);
  assert.equal(result.startupAudit.scripts.items[1]?.isVisible, false);
  assert.equal(result.startupAudit.scripts.items[1]?.isRunOnStartup, null);
  assert.equal(
    result.startupAudit.scripts.items[1]?.manifest.content,
    '{ "id": "hidden-peer", "version": 1 }',
    "the raw manifest text is retained without canonicalization",
  );
  assert.equal(result.references.length, 4);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.startupAudit), true);
  assert.equal(Object.isFrozen(result.startupAudit.scripts.items[1]), true);
  f.originals.entry.bytes.fill(0);
  assert.equal(result.entry.sha256.length, 64);
  assert.equal(
    result.startupAudit.scripts.items[0]?.manifest.content,
    '{"id":"controlled-fork"}',
  );
});

test("genuinely empty bounded collection remains valid data", () => {
  const f = fixture();
  rewriteEntry(f, (entry) => {
    setPath(entry, ["startupAudit", "scripts"], {
      countBefore: 0,
      countAfter: 0,
      items: [],
    });
  });
  const result = bindBootstrapEntryEvidence(f.expected, f.originals, f.fork);
  assert.deepEqual(result?.startupAudit.scripts, {
    countBefore: 0,
    countAfter: 0,
    items: [],
  });
});

test("v1 data or isolated-stdout intents are never fallback evidence for v2", () => {
  const f = fixture();
  const legacy = {
    ...f.expected,
    version: 1,
    purpose: "isolated-stdout-v1",
  } as unknown as BootstrapEntryIntent;
  delete (legacy as unknown as MutableRecord)["executable"];
  assert.equal(bindBootstrapEntryEvidence(legacy, f.originals, f.fork), null);
  assert.equal(
    bindBootstrapEntryEvidence(
      {
        ...legacy,
        purpose: "bootstrap-entry-data-v1",
      } as BootstrapEntryIntent,
      f.originals,
      f.fork,
    ),
    null,
  );
});

test("intent, executable, native references and closed receipt phases must match exactly", () => {
  for (const change of [
    { version: 1 },
    { version: 3 },
    { purpose: "bootstrap-entry-data-v1" },
    { extra: true },
    { nonce: "f".repeat(32) },
    { executable: { path: "C:\\other\\Fusion.exe", sha256: "f".repeat(64) } },
    { executable: { path: "C:\\other\\Fusion.exe", sha256: "0".repeat(64) } },
  ]) {
    const f = fixture();
    const expected = { ...f.expected, ...change } as BootstrapEntryIntent;
    assert.equal(
      bindBootstrapEntryEvidence(expected, f.originals, f.fork),
      null,
    );
  }
  for (const change of [
    { phase: "entry-before-addon-import" },
    { phase: "unexpected-phase" },
    { nonce: "f".repeat(32) },
    { process: { pid: 43, birth: "other" } },
    { purpose: "bootstrap-entry-data-v1" },
    { engineVersion: 3 },
    { executable: { path: "C:\\other\\Fusion.exe", sha256: "f".repeat(64) } },
    { extra: true },
    {
      installed: {
        directory: "C:\\other",
        source: "b".repeat(40),
        filesDigest: "a".repeat(64),
      },
    },
    { entry: { path: "C:\\other\\entry.json", sha256: "0".repeat(64) } },
  ]) {
    const f = fixture();
    const returned = JSON.parse(
      f.originals.returned.bytes.toString(),
    ) as MutableRecord;
    f.originals.returned.bytes = encode({ ...returned, ...change });
    assert.equal(
      bindBootstrapEntryEvidence(f.expected, f.originals, f.fork),
      null,
      JSON.stringify(change),
    );
  }
  const aliasedExecutable = fixture();
  aliasedExecutable.expected.executable.path =
    aliasedExecutable.originals.profile.nativePath;
  aliasedExecutable.originals.intent.bytes = encode(aliasedExecutable.expected);
  assert.equal(
    bindBootstrapEntryEvidence(
      aliasedExecutable.expected,
      aliasedExecutable.originals,
      aliasedExecutable.fork,
    ),
    null,
  );
  const noncanonicalExecutable = fixture();
  noncanonicalExecutable.expected.executable.path =
    "C:\\private\\..\\Program Files\\Fusion.exe";
  noncanonicalExecutable.originals.intent.bytes = encode(
    noncanonicalExecutable.expected,
  );
  assert.equal(
    bindBootstrapEntryEvidence(
      noncanonicalExecutable.expected,
      noncanonicalExecutable.originals,
      noncanonicalExecutable.fork,
    ),
    null,
  );
});

test("audit schema requires complete contiguous counts, exact fields and SDK enum name/value pins", () => {
  const malformed: Array<(audit: MutableRecord) => void> = [
    (value) => setPath(value, ["extra"], true),
    (value) => setPath(value, ["scripts", "countAfter"], 1),
    (value) => setPath(value, ["scripts", "countBefore"], 3),
    (value) => setPath(value, ["scripts", "items", "1", "index"], 0),
    (value) => setPath(value, ["scripts", "items", "1", "isVisible"], 0),
    (value) =>
      setPath(value, ["scripts", "items", "0", "isRunOnStartup"], null),
    (value) =>
      setPath(value, ["scripts", "items", "1", "isRunOnStartup"], false),
    (value) =>
      setPath(value, ["scripts", "items", "0", "location", "value"], 30),
    (value) =>
      setPath(
        value,
        ["scripts", "items", "0", "location", "name"],
        "UndocumentedScriptSourceLocation",
      ),
    (value) =>
      setPath(
        value,
        ["scripts", "items", "0", "manifest", "parseStatus"],
        "json",
      ),
    (value) =>
      setPath(value, ["scripts", "items", "0", "manifest", "extra"], true),
    (value) =>
      setPath(value, ["scripts", "items", "0", "folder"], "relative\\path"),
    (value) =>
      setPath(value, ["preferences", "defaultPathForScriptsAndAddIns"], ""),
  ];
  for (const mutate of malformed) {
    const f = fixture();
    rewriteEntry(f, (entry) => mutate(object(entry["startupAudit"])));
    assert.equal(
      bindBootstrapEntryEvidence(f.expected, f.originals, f.fork),
      null,
    );
  }
  const tooMany = fixture();
  rewriteEntry(tooMany, (entry) => {
    setPath(entry, ["startupAudit", "scripts", "countBefore"], 1025);
    setPath(entry, ["startupAudit", "scripts", "countAfter"], 1025);
    setPath(entry, ["startupAudit", "scripts", "items"], []);
  });
  assert.equal(
    bindBootstrapEntryEvidence(
      tooMany.expected,
      tooMany.originals,
      tooMany.fork,
    ),
    null,
  );
});

test("manifest raw bytes require exact UTF-8 hash, strict JSON object and per-manifest budget", () => {
  const invalid: Array<(entry: MutableRecord) => void> = [
    (entry) => {
      const content = '{"id":1,"id":2}';
      setPath(
        entry,
        ["startupAudit", "scripts", "items", "0", "manifest", "content"],
        content,
      );
      setPath(
        entry,
        ["startupAudit", "scripts", "items", "0", "manifest", "sha256"],
        sha(Buffer.from(content)),
      );
    },
    (entry) => {
      const content = '{"n":NaN}';
      setPath(
        entry,
        ["startupAudit", "scripts", "items", "0", "manifest", "content"],
        content,
      );
      setPath(
        entry,
        ["startupAudit", "scripts", "items", "0", "manifest", "sha256"],
        sha(Buffer.from(content)),
      );
    },
    (entry) => {
      const content = "[]";
      setPath(
        entry,
        ["startupAudit", "scripts", "items", "0", "manifest", "content"],
        content,
      );
      setPath(
        entry,
        ["startupAudit", "scripts", "items", "0", "manifest", "sha256"],
        sha(Buffer.from(content)),
      );
    },
    (entry) => {
      setPath(
        entry,
        ["startupAudit", "scripts", "items", "0", "manifest", "content"],
        '{"id":"changed"}',
      );
    },
    (entry) => {
      const content = `{"id":"${String.fromCharCode(0xd800)}"}`;
      setPath(
        entry,
        ["startupAudit", "scripts", "items", "0", "manifest", "content"],
        content,
      );
      setPath(
        entry,
        ["startupAudit", "scripts", "items", "0", "manifest", "sha256"],
        sha(Buffer.from(content)),
      );
    },
    (entry) => {
      const content = `{"data":"${"x".repeat(256 * 1024)}"}`;
      setPath(
        entry,
        ["startupAudit", "scripts", "items", "0", "manifest", "content"],
        content,
      );
      setPath(
        entry,
        ["startupAudit", "scripts", "items", "0", "manifest", "sha256"],
        sha(Buffer.from(content)),
      );
    },
  ];
  for (const mutate of invalid) {
    const f = fixture();
    rewriteEntry(f, mutate);
    assert.equal(
      bindBootstrapEntryEvidence(f.expected, f.originals, f.fork),
      null,
    );
  }
});

test("audit budget rejects oversized complete audit and does not truncate rows", () => {
  const f = fixture();
  const content = `{"data":"${"x".repeat(256 * 1024 - 12)}"}`;
  const manifest = {
    content,
    sha256: sha(Buffer.from(content)),
    parseStatus: "json-object",
  };
  rewriteEntry(f, (entry) => {
    const items = Array.from({ length: 16 }, (_, index) => ({
      index,
      folder: `C:\\fixture\\item-${index}`,
      location: {
        name: "UserDefinedScriptSourceLocation",
        value: 2,
      },
      isAddIn: true,
      isRunOnStartup: false,
      isRunning: false,
      isVisible: false,
      manifest,
    }));
    setPath(entry, ["startupAudit", "scripts"], {
      countBefore: items.length,
      countAfter: items.length,
      items,
    });
  });
  assert.equal(
    bindBootstrapEntryEvidence(f.expected, f.originals, f.fork),
    null,
  );
});

test("duplicate outer keys and invalid original UTF-8 are refused", () => {
  const duplicate = fixture();
  const entryText = duplicate.originals.entry.bytes.toString();
  duplicate.originals.entry.bytes = Buffer.from(
    entryText.replace('"version":2', '"version":2,"version":2'),
    "utf8",
  );
  const returned = JSON.parse(
    duplicate.originals.returned.bytes.toString(),
  ) as MutableRecord;
  setPath(returned, ["entry", "sha256"], sha(duplicate.originals.entry.bytes));
  duplicate.originals.returned.bytes = encode(returned);
  assert.equal(
    bindBootstrapEntryEvidence(
      duplicate.expected,
      duplicate.originals,
      duplicate.fork,
    ),
    null,
  );
  const nonfinite = fixture();
  const nonfiniteEntryText = nonfinite.originals.entry.bytes
    .toString()
    .replace('"version":2', '"version":NaN');
  nonfinite.originals.entry.bytes = Buffer.from(nonfiniteEntryText, "utf8");
  const nonfiniteReturned = JSON.parse(
    nonfinite.originals.returned.bytes.toString(),
  ) as MutableRecord;
  setPath(
    nonfiniteReturned,
    ["entry", "sha256"],
    sha(nonfinite.originals.entry.bytes),
  );
  nonfinite.originals.returned.bytes = encode(nonfiniteReturned);
  assert.equal(
    bindBootstrapEntryEvidence(
      nonfinite.expected,
      nonfinite.originals,
      nonfinite.fork,
    ),
    null,
  );
  const invalidUtf8 = fixture();
  invalidUtf8.originals.entry.bytes = Buffer.from([0xff, 0xfe]);
  assert.equal(
    bindBootstrapEntryEvidence(
      invalidUtf8.expected,
      invalidUtf8.originals,
      invalidUtf8.fork,
    ),
    null,
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
