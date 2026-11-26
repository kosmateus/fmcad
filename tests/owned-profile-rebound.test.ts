import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { ownedNativeReboundProgram } from "../packages/node-adapters/src/execution/controlled-native-handoff-program";
import { bootstrapProfileSemanticDigest } from "../packages/node-adapters/src/execution/bootstrap-profile-digest";

test("actual late owned rebound preserves original raw provenance and freshly checks semantic current profile", () => {
  const r = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      path.join(process.cwd(), "tests/fixtures/owned-profile-rebound.py"),
    ],
    { input: ownedNativeReboundProgram(), encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).cases, 6);
});

test("profile canonical digest agrees with native Python for Unicode/nested order and numeric token types", () => {
  for (const text of [
    '{"😀":{"z":3,"ą":true},"\\ue000":[null,"ą",{"b":2,"a":1}]}',
    '{"z":1.0,"a":-0.0,"b":1e-5,"c":1e-4,"d":0.125,"e":1e15}',
    '{"nested":{"second":[3,2,1],"first":"\\u007f\\n😀"}}',
  ]) {
    const r = spawnSync(
      "python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        "import sys,json,hashlib; print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf-8')).hexdigest())",
      ],
      { input: text, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      bootstrapProfileSemanticDigest(Buffer.from(text)),
      r.stdout.trim(),
    );
  }
  for (const text of ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}']) {
    assert.throws(() => bootstrapProfileSemanticDigest(Buffer.from(text)));
  }
});

test("actual mapped owned lifetime fence accepts only explicit same-content profile rewrites and rereads every time", () => {
  const moduleFile = path.join(
    __dirname,
    "../packages/node-adapters/src/execution/controlled-native-handoff.js",
  );
  const source = fs.readFileSync(moduleFile, "utf8"),
    load = createRequire(moduleFile);
  const capture = source.slice(
    source.indexOf("    function capture("),
    source.indexOf("    async function assertOriginalRebindWitness("),
  );
  const ownedCapture = source.slice(
    source.indexOf("    const ownedFiles ="),
    source.indexOf("    const ownedLaunchRefs ="),
  );
  const record = source.slice(
    source.indexOf("function record("),
    source.indexOf("function nativePath("),
  );
  const hash = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  for (const semantic of [false, true]) {
    const root = fs.mkdtempSync("/tmp/opencode/producer57-mapped-");
    try {
      const mappedPaths: Record<string, string> = {};
      const file = (name: string, value: unknown) => {
        const bytes = Buffer.from(JSON.stringify(value)),
          nativePath = "C:\\fixture\\" + name;
        const mapped = path.join(root, name);
        fs.writeFileSync(mapped, bytes);
        mappedPaths[nativePath] = mapped;
        return {
          nativePath,
          bytes,
          sha256: hash(bytes),
          identity: "original:" + name,
        };
      };
      const profile = file("profile.json", {
        loadedScripts: [{ name: "ą", location: 3, runOnStartup: true }],
      });
      const descriptor = {
        path: profile.nativePath,
        sha256: profile.sha256,
        ...(semantic
          ? { semanticSha256: bootstrapProfileSemanticDigest(profile.bytes) }
          : {}),
      };
      const launch = {
        profile,
        intent: file("intent.json", {
          version: 3,
          mode: "owned-autoload-v1",
          profile: descriptor,
        }),
        ...Object.fromEntries(
          [
            "journal",
            "attempt",
            "coldProcess",
            "sourceClosure",
            "profileBackup",
            "provision",
            "provisionBackup",
            "provisionReceipt",
          ].map((name) => [name, file(name + ".json", { name })]),
        ),
      };
      const owned = Object.fromEntries(
        [
          "installReceipt",
          "installClosure",
          "entry",
          "returned",
          "handoffRequest",
          "handoffReceipt",
        ].map((name) => [name, file(name + ".json", { name })]),
      );
      const code = Buffer.from("code"),
        codeHash = hash(code);
      for (const dir of ["helper", "installed"]) {
        fs.mkdirSync(path.join(root, dir));
        fs.writeFileSync(path.join(root, dir, "code.py"), code);
      }
      const python = file("python.exe", {}),
        exe = file("Fusion.exe", {}),
        manifest = file("manifest.json", {});
      const pins = {
        mappedPaths,
        mappedHelperDirectory: path.join(root, "helper"),
        mappedInstalledDirectory: path.join(root, "installed"),
        mappedNativePython: mappedPaths[python.nativePath],
        nativePythonSha256: python.sha256,
        executable: exe.nativePath,
        executableSha256: exe.sha256,
        manifest: {
          mappedPath: mappedPaths[manifest.nativePath],
          sha256: manifest.sha256,
        },
        qualified: { files: { "code.py": codeHash } },
      };
      const context = vm.createContext({
        Buffer,
        hash,
        pins,
        owned,
        names: new Set(["code.py"]),
        node_fs_1: { default: fs },
        node_path_1: { default: path },
        node_util_1: load("node:util"),
        bootstrap_profile_digest_1: load("./bootstrap-profile-digest"),
        admission_json_1: load("./admission-json"),
      });
      vm.runInContext(
        record +
          capture +
          ownedCapture +
          "\nglobalThis.makeFence=ownedCapture;",
        context,
      );
      const make = context["makeFence"] as (launch: unknown) => () => void;
      const rewrite = () =>
        fs.writeFileSync(
          mappedPaths[profile.nativePath]!,
          JSON.stringify(
            JSON.parse(profile.bytes.toString()),
            null,
            "\t",
          ).replaceAll("\n", "\r\n"),
        );
      if (!semantic) {
        const fence = make(launch);
        rewrite();
        assert.throws(fence);
      } else {
        rewrite();
        const fence = make(launch);
        fence();
        rewrite();
        fence();
        fs.writeFileSync(
          mappedPaths[profile.nativePath]!,
          '{"loadedScripts":[]}',
        );
        assert.throws(fence, /differs/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
