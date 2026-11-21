import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
import fs from "node:fs";
import { createHash } from "node:crypto";
import type { AsyncLocalStorage } from "node:async_hooks";
type RunApi = typeof import("../src/composition/run.js");
type RunArguments = Parameters<RunApi["prepareRunScript"]>;
type SourceUnit = ReturnType<RunApi["prepareRunScript"]>["units"][number];
// Reviewed source pairs for these two fixed helper fixtures only. Both variants
// select identical runtime units; user source and wrappers stay byte-exact.
const selectedPairs: Record<string, readonly [string, string]> = {
  values: [
    "b8af1e0f987a3e0bec9c8cbefbc5a21249d04f0ea287f974fd6a41cc56201f7e",
    "65e8a7bcefcdfa2430d23e31ac1516bd6699701853736cc31eb297e48f2ddfff",
  ],
  core: [
    "3ee5c107b94c3e1746b573d0c379721b6ee9df7e3227b324fc453f3e60d9eb43",
    "3559c16984edf97acc7121a6c46d4092627afce9184255b4881648202ca17789",
  ],
  "docio-animation2-rules": [
    "234b631d17f50cddc5ffa85033512d2994254ee296657da2aa19636adac85c8f",
    "898ced6f15d1761d41a2085f77af9f225203a2a752868372bf06eb283aa66821",
  ],
  "assembly-domain": [
    "eb8520886cea23d756c9993aa8cc4ce14ffed1aabb796cfd6545335a6a6103ec",
    "d3558ee068a09094bf9abc01362d411d3c6d9b67bbcffc0af944efa47d395320",
  ],
  "geometry-datum-fusion": [
    "f3842af32f1dc49559190a2fb918749c2136f860b02ef3f2f666fb27d594f495",
    "495abe551e6d2c95d433721363c55009ba65da0e77e679d27d4bbeb9af8c27a4",
  ],
  entity: [
    "75287b46431c82087166c6124d51174cf5371050c8bb834608f981477fb7c409",
    "43daed2a98ac49891e320583b82daf5a4f716a574cf7277e9658cce501d04f78",
  ],
  helpers: [
    "e7aeb35837f88ecea965a00c9d82125943d31247d76d12f0156a7c265b8786a7",
    "2448e562551e48d96a82eff9817b302e23072d14612547149ffe6823a049c03f",
  ],
  "capture-integrity": [
    "70483acd925b65e9b7dcf667ab320be2129ea2ed13d46e96f82f75e0d1ea4685",
    "3416dfcef09695506640f10e2039e22f6ec779b6af950092a963adb6a7ef3ad5",
  ],
  "docio-io-rules": [
    "ec42eea8a100ff86791ee60ec6e0bb8243d7e8dbef79a3be9aa1bf8c816b135e",
    "be54d3c6b103a38d84ba6b1638e5d9c172e6f1c53b8d22e09968441619a39d4c",
  ],
  io: [
    "2ce4bf447517276b2f1663a72d9e31461cc1c29eeb66bc4ca8efd689d74c308b",
    "38c9d08b81942f1a0f544fd77417df22a10e9eb0fe14e17833ece6b3655e9921",
  ],
};
const helperUnitOrder = [
  "values",
  "fusion-values",
  "fusion-typing",
  "core",
  "inspection-domain",
  "inspection",
  "docio-animation2-rules",
  "assembly-domain",
  "geometry-datum-domain",
  "geometry-datum-fusion",
  "entity",
  "helpers",
  "identity",
  "capture-integrity",
  "docio-io-rules",
  "io",
  "user-script",
  "wrapper",
];
function assertSelectedProvenance(unit: SourceUnit, original: SourceUnit) {
  assert.equal(unit.id, original.id);
  assert.equal(unit.filename, original.filename);
  assert.equal(unit.role, original.role);
  assert.equal(
    unit.sha256,
    createHash("sha256").update(unit.source).digest("hex"),
  );
  const pair = selectedPairs[unit.id];
  if (!pair || unit.role !== "runtime") {
    assert.deepEqual(unit, original);
    return;
  }
  const originalHash = createHash("sha256")
    .update(original.source)
    .digest("hex");
  assert.equal(original.sha256, originalHash);
  assert.deepEqual(
    [originalHash, unit.sha256],
    pair,
    `${unit.id}: unreviewed source pair`,
  );
  const marker = `\n# Automatic source selection; original-sha256=${originalHash}\n`;
  assert.ok(
    unit.source.endsWith(marker),
    `${unit.id}: original source binding`,
  );
}
const current = load("./src/run.js") as RunApi;
test("selected provenance rejects removed function guards and partial registry keys", () => {
  const values = fs.readFileSync(
    path.join(root, "runtime/python/fmcad/domain/values.py"),
    "utf8",
  );
  const withoutGuard = values.replace(
    "        if not _value_math.isfinite(value):\n            raise ValueError('Non-finite value cannot be serialized')\n",
    "",
  );
  assert.notEqual(withoutGuard, values);
  for (const [source, changed] of [
    [values, withoutGuard],
    [
      "CAD_HANDLERS.update({'body.list': _body_list})\n",
      "CAD_HANDLERS.update({' ody.list': _body_list})\n",
    ],
    ["CAD_HANDLERS.owner = 'owner'\n", "pass\n"],
    ["removed = CAD_HANDLERS.pop('body.list')\n", "pass\n"],
    ["class SideEffect:\n    CAD_HANDLERS.owner = 'ops'\n", "pass\n"],
  ]) {
    const original: SourceUnit = {
      id: "values",
      filename: "review.py",
      role: "runtime",
      source: source!,
      sha256: createHash("sha256").update(source!).digest("hex"),
    };
    const selected =
      changed +
      `\n# Automatic source selection; original-sha256=${original.sha256}\n`;
    assert.throws(
      () =>
        assertSelectedProvenance(
          {
            ...original,
            source: selected,
            sha256: createHash("sha256").update(selected).digest("hex"),
          },
          original,
        ),
      /unreviewed source pair/,
    );
  }
});
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
) => unknown;
const previous = historical(
  "d496c734d63661f2f131b6797ce171e9373a58f4",
  "src/run.js",
) as RunApi;
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "run migration żółć "),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source.py");
  const source =
    'ARGS = []\nDOC_NAME = ""\ndef run(context):\n    return ARGS\n';
  fs.writeFileSync(file, source);
  return { directory, file, source };
}

const cases: [string, RunArguments[4], RunArguments[5], RunArguments[6]][] = [
  ["plain", {}, undefined, []],
  ["creation ID", { docId: "creation-A" }, undefined, []],
  ["file ID", { docFileId: "urn:file:A" }, undefined, []],
  [
    "read-only",
    { docId: "creation-A", docFileId: "urn:file:A", readOnly: true },
    undefined,
    [],
  ],
  ["helpers", { docId: "creation-A" }, "cad-v1", []],
  [
    "read-only helpers",
    { docFileId: "urn:file:A", readOnly: true },
    "cad-v1",
    ["body.list"],
  ],
];
for (const [label, identity, helper, operations] of cases) {
  test(`run migration preserves ${label} source, guards and raw provenance`, (t) => {
    const f = fixture(t);
    const args: RunArguments = [
      f.file,
      { text: "Zażółć 🧪 $&", yes: true, value: null },
      true,
      "Model A",
      identity,
      helper,
      operations,
      { trustedStageContext: { runId: "stage-A" } },
    ];
    const before = {},
      after = {};
    const { context } = load("./src/invocation.js") as {
      context: AsyncLocalStorage<Record<string, unknown>>;
    };
    const historical = context.run(before, () =>
      previous.prepareRunScript(...args),
    );
    const migrated = context.run(after, () =>
      current.prepareRunScript(...args),
    );
    if (helper) {
      assert.ok(migrated.units.length < historical.units.length);
      assert.deepEqual(
        migrated.units.map((unit) => unit.id),
        helperUnitOrder,
      );
      assert.deepEqual(migrated.context, historical.context);
      assert.deepEqual(migrated.request, historical.request);
      for (const unit of migrated.units) {
        const original = historical.units.find((entry) => entry.id === unit.id);
        assert.ok(original, `Unknown source unit ${unit.id}`);
        assertSelectedProvenance(unit, original);
        if (unit.source !== original.source) {
          const source = "raise RuntimeError('tampered')\n" + unit.source;
          assert.notEqual(source, unit.source);
          assert.throws(
            () =>
              assertSelectedProvenance(
                {
                  ...unit,
                  source,
                  sha256: createHash("sha256").update(source).digest("hex"),
                },
                original,
              ),
            /unreviewed source pair/,
          );
          assert.throws(() =>
            assertSelectedProvenance(
              {
                ...unit,
                sha256: original.sha256,
              },
              original,
            ),
          );
        }
      }
    } else {
      assert.deepEqual(migrated, historical);
    }
    assert.deepEqual(after, before);
    assert.deepEqual(after, {
      sourcePath: f.file,
      sourceHash: createHash("sha256").update(f.source).digest("hex"),
    });
    assert.equal(current.buildRunScript(...args), migrated.script);
    assert.equal(fs.readFileSync(f.file, "utf8"), f.source);
  });
}

test("script search, listing, validation and missing-slot failures retain their contract", (t) => {
  const f = fixture(t);
  const config = path.join(f.directory, "config.json");
  const scripts = path.join(f.directory, "scripts");
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, "box.py"), f.source);
  fs.writeFileSync(path.join(scripts, "z.py"), "# user script\n");
  fs.writeFileSync(path.join(scripts, "ignored.txt"), "not Python");
  for (const api of [previous, current]) {
    assert.equal(
      api.resolveScript("box", { config }),
      path.join(scripts, "box.py"),
    );
    assert.equal(api.resolveScript(f.file), f.file);
    assert.equal(
      api.listScripts({ config }).filter((item) => item.name === "box").length,
      2,
    );
  }
  assert.deepEqual(
    current.listScripts({ config }),
    previous.listScripts({ config }),
  );
  for (const name of [
    "nonexistent-script-93848",
    path.join(f.directory, "missing.py"),
  ]) {
    let expected: string | undefined;
    try {
      previous.resolveScript(name, { config });
    } catch (error) {
      assert.ok(error instanceof Error);
      expected = error.message;
    }
    assert.throws(() => current.resolveScript(name, { config }), {
      message: expected,
    });
  }
  for (const args of [
    [f.file, [], false, undefined, { docId: "id" }],
    [f.file, [], false, "Model", {}, "unknown"],
    [f.file, [], false, "Model", {}, "cad-v1"],
  ] as RunArguments[]) {
    let expected: string | undefined;
    try {
      previous.prepareRunScript(...args);
    } catch (error) {
      assert.ok(error instanceof Error);
      expected = error.message;
    }
    assert.equal(typeof expected, "string");
    assert.throws(() => current.prepareRunScript(...args), {
      message: expected,
    });
  }
  fs.writeFileSync(f.file, 'print("no injection slots")\n');
  for (const args of [
    [f.file, [], true],
    [f.file, [], false, "Model"],
  ] as RunArguments[]) {
    let expected: string | undefined;
    try {
      previous.prepareRunScript(...args);
    } catch (error) {
      assert.ok(error instanceof Error);
      expected = error.message;
    }
    assert.throws(() => current.prepareRunScript(...args), {
      message: expected,
    });
  }
});

test("both versions reject changed or unpinned queued source before preparing an artifact", (t) => {
  const f = fixture(t);
  const keys = ["FMCAD_QUEUE_WORKER_JOB", "FMCAD_QUEUE_INPUT_FILES"];
  const original = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, index) => {
      if (original[index] === undefined) delete process.env[key];
      else process.env[key] = original[index];
    }),
  );
  process.env["FMCAD_QUEUE_WORKER_JOB"] = "run-migration";
  const pin = [
    {
      path: f.file,
      sha256: createHash("sha256").update(f.source).digest("hex"),
    },
  ];
  for (const api of [previous, current]) {
    process.env["FMCAD_QUEUE_INPUT_FILES"] = JSON.stringify(pin);
    fs.writeFileSync(f.file, f.source);
    assert.equal(api.prepareRunScript(f.file, [], false).script, f.source);
    fs.writeFileSync(f.file, f.source + "# changed after queue acceptance\n");
    assert.throws(() => api.prepareRunScript(f.file, [], false), {
      code: "INPUT_CHANGED",
    });
    fs.writeFileSync(f.file, f.source);
    process.env["FMCAD_QUEUE_INPUT_FILES"] = "[]";
    assert.throws(() => api.prepareRunScript(f.file, [], false), {
      code: "INPUT_CHANGED",
    });
  }
});

test("source verification and preparation use the same read even if the file changes", (t) => {
  const f = fixture(t);
  let observed: Buffer | undefined;
  let verified: string | undefined;
  const { createRunScriptAdapter } = load(
    "./src/dist/python/run-script.js",
  ) as typeof import("../packages/node-adapters/src/python/run-script.js");
  const api = createRunScriptAdapter({
    observeSource(filename, bytes) {
      assert.equal(filename, f.file);
      observed = bytes;
      fs.writeFileSync(filename, 'raise RuntimeError("replacement")\n');
    },
    verifySource(filename, bytes) {
      assert.equal(filename, f.file);
      assert.equal(bytes, observed);
      verified = bytes.toString("utf8");
    },
  });
  const artifact = api.prepareRunScript(f.file, [], false);
  assert.equal(verified, f.source);
  assert.equal(artifact.script, f.source);
  assert.match(fs.readFileSync(f.file, "utf8"), /replacement/);
});
