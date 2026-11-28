import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  bindBootstrapEntryEvidence,
  bindOwnedBootstrapEntryEvidence,
  bootstrapInstalledFilesDigest,
  type BootstrapEntryIntent,
  type BootstrapEntryIntentV2,
  type BootstrapOwnedEntryIntentV3,
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

function ownedFixture() {
  const f = fixture();
  const profile = JSON.parse(f.originals.profile.bytes.toString());
  profile.loadedScripts[0].runOnStartup = true;
  f.originals.profile.bytes = encode(profile);
  const generation = { instance: "owned-instance", epoch: "owned-epoch" };
  const provision = {
    nativePath: "C:\\private\\provision.json",
    bytes: encode({
      ...f.expected.process,
      ...generation,
      source: f.expected.installed.source,
    }),
  };
  const expected: BootstrapOwnedEntryIntentV3 = {
    ...f.expected,
    version: 3,
    mode: "owned-autoload-v1",
    generation,
    provision: { path: provision.nativePath, sha256: sha(provision.bytes) },
    profile: {
      path: f.originals.profile.nativePath,
      sha256: sha(f.originals.profile.bytes),
    },
  };
  f.originals.intent.bytes = encode(expected);
  const base = {
    ...JSON.parse(f.originals.returned.bytes.toString()),
    version: 3,
    mode: expected.mode,
    generation,
    provision: expected.provision,
    intent: {
      path: f.originals.intent.nativePath,
      sha256: sha(f.originals.intent.bytes),
    },
    profile: expected.profile,
  };
  const { phase: unusedPhase, entry: unusedEntry, ...common } = base;
  void unusedPhase;
  void unusedEntry;
  const startupAudit = controlledStartupAuditFixture();
  f.originals.entry.bytes = encode({
    ...common,
    phase: "entry-audited-before-addon-import",
    startupAudit,
  });
  f.originals.returned.bytes = encode({
    ...common,
    phase: "run-returned",
    entry: {
      path: f.originals.entry.nativePath,
      sha256: sha(f.originals.entry.bytes),
    },
  });
  return { expected, originals: { ...f.originals, provision }, fork: f.fork };
}

function ownedSemanticFixture() {
  const f = ownedFixture();
  const canonical = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      "import sys,json,hashlib; print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf-8')).hexdigest())",
    ],
    { input: f.originals.profile.bytes, encoding: "utf8" },
  );
  assert.equal(canonical.status, 0, canonical.stderr);
  Object.assign(f.expected.profile, {
    semanticSha256: canonical.stdout.trim(),
  });
  resignOwnedFixture(f);
  return f;
}

function resignOwnedFixture(f: ReturnType<typeof ownedFixture>) {
  f.originals.intent.bytes = encode(f.expected);
  const entry = JSON.parse(f.originals.entry.bytes.toString());
  Object.assign(entry, {
    profile: f.expected.profile,
    intent: {
      path: f.originals.intent.nativePath,
      sha256: sha(f.originals.intent.bytes),
    },
  });
  f.originals.entry.bytes = encode(entry);
  const returned = JSON.parse(f.originals.returned.bytes.toString());
  Object.assign(returned, {
    profile: f.expected.profile,
    intent: entry.intent,
    entry: {
      path: f.originals.entry.nativePath,
      sha256: sha(f.originals.entry.bytes),
    },
  });
  f.originals.returned.bytes = encode(returned);
}

test("owned receipts retain SDK slash spelling and trailing separators in observed audit paths", () => {
  const f = ownedFixture();
  const entry = JSON.parse(f.originals.entry.bytes.toString());
  const audit = entry.startupAudit;
  audit.preferences.defaultPathForScriptsAndAddIns =
    audit.preferences.defaultPathForScriptsAndAddIns.replaceAll("\\", "/") +
    "/";
  for (const item of audit.scripts.items)
    item.folder = item.folder.replaceAll("\\", "/") + "/";
  f.originals.entry.bytes = encode(entry);
  resignOwnedFixture(f);
  const originalEntry = Buffer.from(f.originals.entry.bytes);
  const bound = bindOwnedBootstrapEntryEvidence(
    f.expected,
    f.originals,
    f.fork,
  );
  assert(
    bound,
    "Real SDK observations must not require authority-path spelling",
  );
  assert.deepEqual(bound.startupAudit, audit);
  assert.deepEqual(f.originals.entry.bytes, originalEntry);
});

test("observed audit paths still reject traversal, relative paths, aliases and NUL", () => {
  for (const invalid of [
    "C:/Api/../foreign",
    "C:/Api/./owned",
    "relative/Api",
    "C:relative",
    "//server/share/Api",
    "\\\\server\\share\\Api",
    "C:/Api/\0owned",
  ]) {
    for (const field of ["default", "folder"]) {
      const f = ownedFixture();
      const entry = JSON.parse(f.originals.entry.bytes.toString());
      if (field === "default")
        entry.startupAudit.preferences.defaultPathForScriptsAndAddIns = invalid;
      else entry.startupAudit.scripts.items[0].folder = invalid;
      f.originals.entry.bytes = encode(entry);
      resignOwnedFixture(f);
      assert.equal(
        bindOwnedBootstrapEntryEvidence(f.expected, f.originals, f.fork),
        null,
      );
    }
  }
});

test("SDK observation normalization does not relax executable authority paths", () => {
  const f = ownedFixture();
  f.expected.executable.path = f.expected.executable.path.replaceAll("\\", "/");
  for (const name of ["entry", "returned"] as const) {
    const value = JSON.parse(f.originals[name].bytes.toString());
    value.executable = f.expected.executable;
    f.originals[name].bytes = encode(value);
  }
  resignOwnedFixture(f);
  assert.equal(
    bindOwnedBootstrapEntryEvidence(f.expected, f.originals, f.fork),
    null,
  );
});

test("owned v3 explicit semantic profile survives vendor whitespace but keeps original raw SHA", () => {
  const f = ownedSemanticFixture(),
    rawHash = f.expected.profile.sha256;
  f.originals.profile.bytes = Buffer.from(
    JSON.stringify(
      JSON.parse(f.originals.profile.bytes.toString()),
      null,
      "\t",
    ).replaceAll("\n", "\r\n"),
  );
  assert.notEqual(sha(f.originals.profile.bytes), rawHash);
  const bound = bindOwnedBootstrapEntryEvidence(
    f.expected,
    f.originals,
    f.fork,
  );
  assert(bound);
  assert(
    !bound.references.some(
      (reference) => reference.path === f.expected.profile.path,
    ),
  );
  assert.equal(f.expected.profile.sha256, rawHash);
});

test("owned semantic profile denies all content changes and bad digest even when raw is unchanged", () => {
  for (const mutate of [
    (p: MutableRecord) =>
      (object((p["loadedScripts"] as unknown[])[0])["runOnStartup"] = false),
    (p: MutableRecord) =>
      (object((p["loadedScripts"] as unknown[])[0])["isFavorite"] = true),
    (p: MutableRecord) =>
      (object((p["loadedScripts"] as unknown[])[0])["isRemoved"] = true),
    (p: MutableRecord) =>
      (object((p["loadedScripts"] as unknown[])[0])["name"] = "changed"),
    (p: MutableRecord) =>
      (object((p["loadedScripts"] as unknown[])[0])["location"] = 2),
    (p: MutableRecord) =>
      (object((p["loadedScripts"] as unknown[])[0])["path"] = "C:\\foreign.py"),
    (p: MutableRecord) => (p["loadedScripts"] as unknown[]).pop(),
    (p: MutableRecord) =>
      (p["loadedScripts"] as unknown[]).push({
        ...object((p["loadedScripts"] as unknown[])[0]),
        name: "foreign",
        path: "C:\\foreign.py",
        runOnStartup: false,
      }),
  ]) {
    const f = ownedSemanticFixture(),
      profile = JSON.parse(f.originals.profile.bytes.toString());
    mutate(profile);
    f.originals.profile.bytes = encode(profile);
    assert.equal(
      bindOwnedBootstrapEntryEvidence(f.expected, f.originals, f.fork),
      null,
    );
  }
  const f = ownedSemanticFixture();
  object(f.expected.profile)["semanticSha256"] = "0".repeat(64);
  resignOwnedFixture(f);
  assert.equal(
    bindOwnedBootstrapEntryEvidence(f.expected, f.originals, f.fork),
    null,
  );
});

test("legacy owned v3 stays raw-bound; malformed or unknown profile descriptors deny", () => {
  const legacy = ownedFixture();
  legacy.originals.profile.bytes = Buffer.from(
    JSON.stringify(
      JSON.parse(legacy.originals.profile.bytes.toString()),
      null,
      2,
    ),
  );
  assert.equal(
    bindOwnedBootstrapEntryEvidence(
      legacy.expected,
      legacy.originals,
      legacy.fork,
    ),
    null,
  );
  for (const extra of [
    { semanticSha256: "bad" },
    { semanticSha256: null },
    { semanticSha256: 1 },
    { ignored: true },
  ]) {
    const f = ownedFixture();
    Object.assign(f.expected.profile, extra);
    resignOwnedFixture(f);
    assert.equal(
      bindOwnedBootstrapEntryEvidence(f.expected, f.originals, f.fork),
      null,
    );
  }
  const manual = fixture();
  Object.assign(manual.expected.profile, { semanticSha256: "a".repeat(64) });
  assert.equal(
    bindBootstrapEntryEvidence(manual.expected, manual.originals, manual.fork),
    null,
  );
});

test("owned v3 binds original provision and cannot qualify as manual v2", () => {
  const f = ownedFixture();
  const result = bindOwnedBootstrapEntryEvidence(
    f.expected,
    f.originals,
    f.fork,
  );
  assert.equal(result?.authority, "NONE");
  assert.equal(result?.references.length, 5);
  // Exercise runtime refusal without weakening the public v2 type.
  assert.equal(
    Reflect.apply(bindBootstrapEntryEvidence, undefined, [
      f.expected,
      f.originals,
      f.fork,
    ]),
    null,
  );
  const old = fixture();
  assert.equal(
    Reflect.apply(bindOwnedBootstrapEntryEvidence, undefined, [
      old.expected,
      old.originals,
      old.fork,
    ]),
    null,
  );
});

for (const fault of [
  "provision-hash",
  "provision-generation",
  "receipt-generation",
  "manual-profile",
] as const)
  test(`owned v3 refuses ${fault}`, () => {
    const f = ownedFixture();
    if (fault === "provision-hash") f.originals.provision.bytes = encode({});
    if (fault === "provision-generation") {
      const value = JSON.parse(f.originals.provision.bytes.toString());
      value.epoch = "foreign";
      f.originals.provision.bytes = encode(value);
      f.expected.provision.sha256 = sha(f.originals.provision.bytes);
      f.originals.intent.bytes = encode(f.expected);
    }
    if (fault === "receipt-generation") {
      const value = JSON.parse(f.originals.returned.bytes.toString());
      value.generation.epoch = "foreign";
      f.originals.returned.bytes = encode(value);
    }
    if (fault === "manual-profile") {
      const value = JSON.parse(f.originals.profile.bytes.toString());
      value.loadedScripts[0].runOnStartup = false;
      f.originals.profile.bytes = encode(value);
    }
    assert.equal(
      bindOwnedBootstrapEntryEvidence(f.expected, f.originals, f.fork),
      null,
    );
  });

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

function rewriteFirstManifest(f: ReturnType<typeof fixture>, content: string) {
  rewriteEntry(f, (entry) => {
    setPath(
      entry,
      ["startupAudit", "scripts", "items", "0", "manifest", "content"],
      content,
    );
    setPath(
      entry,
      ["startupAudit", "scripts", "items", "0", "manifest", "sha256"],
      sha(Buffer.from(content, "utf8")),
    );
  });
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

test("startup SDK paths require valid UTF-8 and match native 65,536-byte bounds", () => {
  const pathAtLimit = `C:\\${"é".repeat(32766)}a`;
  const pathOverLimit = `C:\\${"é".repeat(32767)}`;
  assert.equal(Buffer.byteLength(pathAtLimit, "utf8"), 65536);
  assert.equal(Buffer.byteLength(pathOverLimit, "utf8"), 65537);

  const valid = fixture();
  rewriteEntry(valid, (entry) => {
    setPath(
      entry,
      ["startupAudit", "preferences", "defaultPathForScriptsAndAddIns"],
      pathAtLimit,
    );
    setPath(
      entry,
      ["startupAudit", "scripts", "items", "0", "folder"],
      pathAtLimit,
    );
  });
  const bound = bindBootstrapEntryEvidence(
    valid.expected,
    valid.originals,
    valid.fork,
  );
  assert.ok(bound, "exact UTF-8 byte limit with legal Unicode remains valid");
  assert.equal(
    bound.startupAudit.preferences.defaultPathForScriptsAndAddIns,
    pathAtLimit,
  );
  assert.equal(bound.startupAudit.scripts.items[0]?.folder, pathAtLimit);

  for (const field of [
    ["preferences", "defaultPathForScriptsAndAddIns"],
    ["scripts", "items", "0", "folder"],
  ]) {
    const tooLong = fixture();
    rewriteEntry(tooLong, (entry) => {
      setPath(entry, ["startupAudit", ...field], pathOverLimit);
    });
    assert.equal(
      bindBootstrapEntryEvidence(
        tooLong.expected,
        tooLong.originals,
        tooLong.fork,
      ),
      null,
      `${field.join(".")} over the native UTF-8 byte limit`,
    );

    for (const surrogate of [0xd800, 0xdc00]) {
      const loneSurrogate = fixture();
      rewriteEntry(loneSurrogate, (entry) => {
        setPath(
          entry,
          ["startupAudit", ...field],
          `C:\\fixture\\${String.fromCharCode(surrogate)}`,
        );
      });
      assert.equal(
        bindBootstrapEntryEvidence(
          loneSurrogate.expected,
          loneSurrogate.originals,
          loneSurrogate.fork,
        ),
        null,
        `${field.join(".")} with an unpaired surrogate`,
      );
    }
  }
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

test("manifest strict JSON follows native arbitrary-integer and finite-float semantics without rewriting raw bytes", () => {
  const hugeInteger = "9".repeat(400);
  const validContent =
    `{"name":"café","id":9007199254740993,"huge":${hugeInteger},` +
    '"finite":1e308,"underflow":1e-400,"enabled":true,"empty":null}';
  const invalidContents = [
    '{"n":1e999}',
    '{"id":1,"id":2}',
    '{"text":"\\x"}',
    '{"text":"\\uZZZZ"}',
    '{"n":NaN}',
    '{"n":Infinity}',
    '{"n":-Infinity}',
  ];
  const nativeCheck = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      [
        "import json, math, sys",
        "def reject(value): raise ValueError('non-finite constant')",
        "def finite_float(value):",
        "    number = float(value)",
        "    if not math.isfinite(number): raise ValueError('non-finite float')",
        "    return number",
        "def unique_object(pairs):",
        "    result = {}",
        "    for key, value in pairs:",
        "        if key in result: raise ValueError('duplicate key')",
        "        result[key] = value",
        "    return result",
        "def valid(text):",
        "    try:",
        "        value = json.loads(text, parse_constant=reject, parse_float=finite_float, object_pairs_hook=unique_object)",
        "        return type(value) is dict",
        "    except (ValueError, RecursionError):",
        "        return False",
        "print(json.dumps([valid(text) for text in json.load(sys.stdin)]))",
      ].join("\n"),
    ],
    {
      input: JSON.stringify([validContent, ...invalidContents]),
      encoding: "utf8",
    },
  );
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
  assert.deepEqual(JSON.parse(nativeCheck.stdout), [
    true,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
  ]);

  const valid = fixture();
  rewriteFirstManifest(valid, validContent);
  const bound = bindBootstrapEntryEvidence(
    valid.expected,
    valid.originals,
    valid.fork,
  );
  assert.ok(
    bound,
    "native-valid large integers and finite floats are accepted",
  );
  assert.equal(
    bound.startupAudit.scripts.items[0]?.manifest.content,
    validContent,
    "the exact manifest text and its original hash input remain unchanged",
  );
  assert.equal(
    bound.startupAudit.scripts.items[0]?.manifest.sha256,
    sha(Buffer.from(validContent, "utf8")),
  );

  const depthAtLimit = fixture();
  const nestedAtLimit = `{"value":${"[".repeat(127)}0${"]".repeat(127)}}`;
  rewriteFirstManifest(depthAtLimit, nestedAtLimit);
  assert.ok(
    bindBootstrapEntryEvidence(
      depthAtLimit.expected,
      depthAtLimit.originals,
      depthAtLimit.fork,
    ),
    "the existing 128-level JSON nesting budget remains accepted",
  );
  const tooDeep = fixture();
  rewriteFirstManifest(
    tooDeep,
    `{"value":${"[".repeat(128)}0${"]".repeat(128)}}`,
  );
  assert.equal(
    bindBootstrapEntryEvidence(
      tooDeep.expected,
      tooDeep.originals,
      tooDeep.fork,
    ),
    null,
    "opaque validation retains the existing nesting limit",
  );

  for (const content of invalidContents) {
    const invalid = fixture();
    rewriteFirstManifest(invalid, content);
    assert.equal(
      bindBootstrapEntryEvidence(
        invalid.expected,
        invalid.originals,
        invalid.fork,
      ),
      null,
      content,
    );
  }

  const unsafeOuterInteger = fixture();
  const entryText = unsafeOuterInteger.originals.entry.bytes
    .toString()
    .replace('"version":2', '"version":2,"outer":9007199254740993');
  unsafeOuterInteger.originals.entry.bytes = Buffer.from(entryText, "utf8");
  const returned = JSON.parse(
    unsafeOuterInteger.originals.returned.bytes.toString(),
  ) as MutableRecord;
  setPath(
    returned,
    ["entry", "sha256"],
    sha(unsafeOuterInteger.originals.entry.bytes),
  );
  unsafeOuterInteger.originals.returned.bytes = encode(returned);
  assert.equal(
    bindBootstrapEntryEvidence(
      unsafeOuterInteger.expected,
      unsafeOuterInteger.originals,
      unsafeOuterInteger.fork,
    ),
    null,
    "the outer receipt stays protocol-safe-integer strict",
  );
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
