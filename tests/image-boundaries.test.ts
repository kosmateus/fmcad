import { createRequire } from "node:module";
import os from "node:os";
import type {
  SpawnOptions,
  ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { CliDependencies } from "../src/entrypoints/cli";
import type { ImageCommandDependencies } from "../packages/node-adapters/src/python/image-command";
import { at, record, text } from "./integration/offline-cli";
const root = process.cwd(),
  load = createRequire(__filename);
interface ImageCall {
  python: string;
  args: string[];
  options: SpawnOptions;
  request?: unknown;
}
interface Harness {
  stdout: string;
  stderr: string;
  calls: ImageCall[];
  deps: CliDependencies & ImageCommandDependencies;
  exitCode?: number;
}
function first(h: Harness) {
  const value = h.calls[0];
  assert(value, "Expected exactly recorded worker invocation");
  return value;
}
function spawnWorker(
  python: string,
  args: string[],
  options: SpawnOptions,
): ChildProcessWithoutNullStreams {
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  return spawn(python, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
}
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const { main } = load(
  path.join(root, "src/cli"),
) as typeof import("../src/entrypoints/cli");
const { globalHelp } = load(
  path.join(root, "src/help"),
) as typeof import("../src/composition/library-help");
const { findCommand } = load(
  path.join(root, "src/commands"),
) as typeof import("../src/composition/library-commands");

const required = [
  "--svg",
  "traced.svg",
  "--reference",
  "ref.png",
  "--palette",
  "palette.json",
  "--out",
  "new audit",
];
const data = {
  svg: "traced.svg",
  reference: "ref.png",
  palette: "palette.json",
  out: "new audit",
  referenceMode: "labels",
  mode: "repair",
  scale: 4,
  maxGapWidthPx: 1.5,
  maxOverlapWidthPx: 2,
  maxChangedAreaPx: 500,
  fitErrorPx: 0.35,
  cornerAngle: 55,
  widthMm: 50,
  mirrorX: false,
};
const flagFor = (field: string) =>
  "--" + field.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
const encoded = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);
function harness(code = 0, status = "inspected") {
  const h: Harness = {
    stdout: "",
    stderr: "",
    calls: [],
    deps: { stdout: { write() {} }, stderr: { write() {} } },
  };
  h.deps = {
    resolvePython: ({ pythonPath }) => pythonPath || "python3",
    loadConfig: () => assert.fail("Must not load configuration"),
    initConfig: () => assert.fail("Must not write configuration"),
    createFmcad: () => assert.fail("Must not connect"),
    stdout: {
      write: (text) => {
        h.stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        h.stderr += text;
      },
    },
    setExitCode: (value) => {
      h.exitCode = value;
    },
    spawnImageBoundaries: (python, args, options) => {
      h.calls.push({ python, args, options });
      return spawnWorker(
        process.execPath,
        [
          "-e",
          String.raw`let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({success:true,operation:'image.boundaries',result:{status:${JSON.stringify(status)},geometryValidated:false,request:JSON.parse(s)}})+'\n');process.stderr.write('worker diagnostic\n');process.exitCode=${code};});`,
        ],
        options,
      );
    },
  };
  return h;
}
function fixture(value: unknown, raw = false) {
  const parent = os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "image-boundaries-cli-"));
  test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "request.json");
  fs.writeFileSync(file, raw ? text(value) : JSON.stringify(value), {
    flag: "wx",
  });
  return file;
}
function resolved(value: Record<string, unknown>) {
  const result = { ...value };
  for (const key of ["svg", "reference", "palette", "out"])
    result[key] = path.resolve(text(value[key]));
  return result;
}

test("all boundary flags map to exact worker JSON stdin locally, including .35 and false", async () => {
  const h = harness();
  const args = Object.entries(data).flatMap(([key, value]) => [
    flagFor(key),
    key === "fitErrorPx" ? ".35" : encoded(value),
  ]);
  assert.equal(
    await main(
      [
        "image",
        "boundaries",
        ...args,
        "--python",
        "/local python/bin/python",
        "--json",
      ],
      h.deps,
    ),
    0,
  );
  assert.deepEqual(h.calls, [
    {
      python: "/local python/bin/python",
      args: ["-B", path.resolve(root, "assets/image_boundaries.py")],
      options: {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform === "linux",
      },
    },
  ]);
  assert.equal(
    h.stdout,
    JSON.stringify({
      success: true,
      operation: "image.boundaries",
      result: {
        status: "inspected",
        geometryValidated: false,
        request: resolved(data),
      },
    }) + "\n",
  );
  assert.equal(h.stderr, "worker diagnostic\n");
});

test("file paths use invocation cwd, fields can supplement files, defaults stay worker-owned", async () => {
  const h = harness();
  assert.equal(
    await main(["image", "boundaries", "--file", fixture(data)], h.deps),
    0,
  );
  assert.deepEqual(
    at(JSON.parse(h.stdout), "result", "request"),
    resolved(data),
  );
  assert.equal(first(h).python, "python3");
  const minimal = harness();
  assert.equal(
    await main(
      [
        "image",
        "boundaries",
        "--file",
        fixture({ svg: "s", reference: "r", palette: "p" }),
        "--out",
        "o",
      ],
      minimal.deps,
    ),
    0,
  );
  assert.deepEqual(
    at(JSON.parse(minimal.stdout), "result", "request"),
    resolved({ svg: "s", reference: "r", palette: "p", out: "o" }),
  );
  const example = harness();
  assert.equal(
    await main(
      [
        "image",
        "boundaries",
        "--file",
        path.resolve(root, "examples/image-boundaries-request.json"),
        "--out",
        "example-audit",
      ],
      example.deps,
    ),
    0,
  );
  assert.equal(
    at(JSON.parse(example.stdout), "result", "request", "mode"),
    "inspect",
  );
});

test("every duplicate flag/file field and duplicate literal JSON key fails before spawning", async () => {
  const file = fixture(data);
  for (const [key, value] of Object.entries(data)) {
    for (const args of [
      ["--file", file, flagFor(key), encoded(value)],
      [flagFor(key), encoded(value), flagFor(key), encoded(value)],
    ]) {
      const h = harness();
      assert.equal(await main(["image", "boundaries", ...args], h.deps), 1);
      assert.match(h.stderr, /Duplicate/);
      assert.equal(h.calls.length, 0);
    }
  }
  for (const args of [
    ["--json", "--json"],
    ["--python", "p", "--python", "p"],
    ["--file", file, "--file", file],
    ["--file", fixture('{"svg":"a","svg":"b"}', true)],
    ["--file", fixture('{"svg":"a","s\\u0076g":"b"}', true)],
  ]) {
    const h = harness();
    assert.equal(await main(["image", "boundaries", ...args], h.deps), 1);
    assert.match(h.stderr, /Duplicate/);
    assert.equal(h.calls.length, 0);
  }
});

test("required paths, unknown fields, malformed values and global/backend routes never spawn", async () => {
  const invalid = [
    null,
    [],
    5,
    ...["python", "file", "json", "doc", "reference-mode", "unknown"].map(
      (key) => ({ ...data, [key]: 1 }),
    ),
  ];
  for (const key of ["svg", "reference", "palette", "out"]) {
    const missing = { ...data };
    delete record(missing)[key];
    invalid.push(
      missing,
      ...["", " ", null, 1, []].map((value) => ({ ...data, [key]: value })),
    );
  }
  for (const value of invalid) {
    const h = harness();
    assert.equal(
      await main(["image", "boundaries", "--file", fixture(value)], h.deps),
      1,
    );
    assert.equal(h.calls.length, 0);
  }
  const globalFlags = [
    "--doc",
    "--backend",
    "--config",
    "--url",
    "--header",
    "--timeout",
    "--transport",
    "--curl-path",
  ];
  const invalidArgs = [
    [],
    ["--file", fixture("{", true)],
    ["positional"],
    ["--unknown", "x"],
    ...Object.keys(data).map((key) => [flagFor(key)]),
    ["--python"],
    ["--file"],
    ["--scale", "NaN"],
    ["--scale", "1e999"],
    ["--fit-error-px", "null"],
    ["--mirror-x", "False"],
    ...globalFlags.map((flag) => [...required, flag, "x"]),
  ];
  for (const argv of [
    ...invalidArgs.map((args) => ["image", "boundaries", ...args]),
    ...globalFlags.map((flag) => [
      flag,
      "x",
      "image",
      "boundaries",
      ...required,
    ]),
  ]) {
    const h = harness();
    assert.equal(await main(argv, h.deps), 1, argv.join(" "));
    assert.equal(h.calls.length, 0);
    assert.equal(h.exitCode, 1);
  }
});

test("semantic range/type validation stays in worker, with unchanged request forwarding", async () => {
  const h = harness(1);
  const bad = {
    ...data,
    scale: 5,
    mode: "other",
    referenceMode: "other",
    maxGapWidthPx: -1,
    maxOverlapWidthPx: 0,
    maxChangedAreaPx: 0,
    fitErrorPx: 3,
    cornerAngle: 181,
    widthMm: -50,
    mirrorX: "false",
  };
  assert.equal(
    await main(["image", "boundaries", "--file", fixture(bad)], h.deps),
    1,
  );
  assert.deepEqual(
    at(JSON.parse(h.stdout), "result", "request"),
    resolved(bad),
  );
  assert.equal(h.calls.length, 1);
});

test("inspected, blocked and ready are unchanged successful envelopes, not CAD certification", async () => {
  for (const status of ["inspected", "blocked", "ready"]) {
    const h = harness(0, status);
    assert.equal(await main(["image", "boundaries", ...required], h.deps), 0);
    assert.equal(at(JSON.parse(h.stdout), "result", "status"), status);
    assert.equal(
      at(JSON.parse(h.stdout), "result", "geometryValidated"),
      false,
    );
    assert.equal(h.exitCode, undefined);
  }
});

test("actual boundary main summarizes unresolved reasons and omits full-report component/fit records", async () => {
  for (const status of ["inspected", "blocked", "ready"]) {
    const report = {
      status,
      out: "/local/audit",
      gapAreaPx: 4,
      overlapAreaPx: 0,
      files: { "report.json": "/local/audit/report.json" },
      warnings: [],
      geometryValidated: false,
      components:
        status === "ready"
          ? []
          : [
              { status: "unresolved", reason: "width_limit" },
              { status: "unresolved", reason: "width_limit" },
              { status: "unresolved", reason: null },
              {
                status: "protected_unchanged",
                reason: "preexisting_silhouette_deviation",
              },
              { status: "repairable", reason: null },
            ],
      parameters: { scale: 2 },
      ...(status === "ready"
        ? { sampledMaskValidated: true, fitValidation: { tolerancePx: 0.35 } }
        : {}),
    };
    const script = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('boundaries_contract', sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
report = json.loads(sys.argv[2])
worker.execute = lambda request: dict(success=True, operation='image.boundaries', result=report)
sys.exit(worker.main())
`;
    const h = harness();
    h.deps.spawnImageBoundaries = (python, args, options) =>
      spawnWorker(
        python,
        ["-B", "-c", script, text(args[1]), JSON.stringify(report)],
        options,
      );
    assert.equal(
      await main(["image", "boundaries", ...required], h.deps),
      0,
      h.stderr,
    );
    const summary = {
      status,
      out: report.out,
      gapAreaPx: 4,
      overlapAreaPx: 0,
      ...(status === "ready" ? { sampledMaskValidated: true } : {}),
      geometryValidated: false,
      files: report.files,
      warnings: [],
      unresolvedReasonCounts:
        status === "ready" ? {} : { width_limit: 2, unspecified: 1 },
    };
    assert.equal(
      h.stdout,
      JSON.stringify({
        success: true,
        operation: "image.boundaries",
        result: summary,
      }) + "\n",
    );
    assert.equal(h.stderr, "");
  }
});

test("real worker rejects invalid semantic fields before creating output, without image dependencies", async () => {
  const cases: (readonly [string, unknown, RegExp])[] = [
    ...[0, 5, 1.5, true].map(
      (value) => ["scale", value, /scale must be an integer/] as const,
    ),
    ...[
      "maxGapWidthPx",
      "maxOverlapWidthPx",
      "maxChangedAreaPx",
      "fitErrorPx",
      "widthMm",
    ].flatMap((key) =>
      [0, -1, true, "2"].map(
        (value) =>
          [
            key,
            value,
            new RegExp(key + " must be finite and positive"),
          ] as const,
      ),
    ),
    ["fitErrorPx", 2.01, /fitErrorPx must not exceed 2/],
    ...[-1, 181, true].map(
      (value) => ["cornerAngle", value, /cornerAngle must be in/] as const,
    ),
    ["mirrorX", "false", /mirrorX must be boolean/],
    ["mode", "other", /Invalid mode or referenceMode/],
    ["referenceMode", "other", /Invalid mode or referenceMode/],
  ];
  for (const [key, value, error] of cases) {
    const file = fixture({ ...data, [key]: value });
    const out = path.join(path.dirname(file), "must-not-exist");
    const h = harness();
    h.deps.spawnImageBoundaries = (python, args, options) =>
      spawnWorker(python, ["-B", ...args], options);
    const request = { ...data, out, [key]: value };
    assert.equal(
      await main(["image", "boundaries", "--file", fixture(request)], h.deps),
      1,
    );
    assert.match(h.stderr, error);
    assert.equal(h.stdout, "");
    assert.equal(fs.existsSync(out), false);
  }
});

test("worker and missing interpreter failures retain output and show local requirements guidance", async () => {
  const h = harness(7, "blocked");
  assert.equal(
    await main(
      ["image", "boundaries", ...required, "--python", "/venv/bin/python"],
      h.deps,
    ),
    1,
  );
  assert.equal(at(JSON.parse(h.stdout), "result", "status"), "blocked");
  assert.match(h.stderr, /worker failed \(7\)/);
  assert.match(
    h.stderr,
    /"\/venv\/bin\/python" -m pip install -r .*image_boundaries_requirements.txt/,
  );
  assert.match(h.stderr, /Nothing was installed automatically/);
  const missing = harness();
  missing.deps.spawnImageBoundaries = (_python, args, options) =>
    spawnWorker(
      path.join(path.dirname(fixture({})), "missing-python"),
      args,
      options,
    );
  assert.equal(
    await main(["image", "boundaries", ...required], missing.deps),
    1,
  );
  assert.match(
    missing.stderr,
    /Select an installed interpreter with --python EXE/,
  );
  assert.match(missing.stderr, /image_boundaries_requirements.txt/);
});

test("help aliases and root registry expose exact defaults, statuses and geometry limitations locally", async () => {
  const outputs: string[] = [];
  for (const argv of [
    ["image", "boundaries", "--help"],
    ["image", "boundaries", "-h"],
    ["help", "image", "boundaries"],
  ]) {
    const h = harness();
    assert.equal(await main(argv, h.deps), 0);
    assert.equal(h.calls.length, 0);
    assert.doesNotMatch(h.stdout, /Backend:|requires --doc/);
    const help = h.stdout.replace(/\s+/g, " ");
    for (const pattern of [
      /LOCAL/,
      /source\|labels; default source/,
      /inspect\|repair; default inspect/,
      /integer \[1, 4\]; default 2/,
      /--max-gap-width-px:.*default 2/,
      /--max-overlap-width-px:.*default 2/,
      /--max-changed-area-px:.*default 500/,
      /--fit-error-px:.*default 0.35/,
      /--corner-angle:.*default 55/,
      /--width-mm:.*default 50/,
      /--mirror-x:.*default false/,
      /NOT the request file directory/,
      /protected_unchanged/,
      /exactly in reverse/,
      /inspected.*blocked.*ready/,
      /geometryValidated remains false/,
      /sampled curve checks/,
      /contours can change globally/,
      /not original SVG curves/,
      /Only when published/,
      /compact summary/,
      /unresolvedReasonCounts/,
      /Full component records, parameters and fitValidation/,
      /result.files\["report.json"\]/,
    ])
      assert.match(help, pattern);
    outputs.push(h.stdout);
  }
  assert.equal(outputs[0], outputs[1]);
  assert.equal(outputs[1], outputs[2]);
  assert.equal(at(findCommand(["image", "boundaries"]), "kind"), "local");
  assert.match(
    globalHelp(),
    /image boundaries --svg PATH --reference PATH --palette JSON --out NEWDIR/,
  );
});

test("boundary guide distinguishes compact stdout from full report records", () => {
  const guide = fs.readFileSync(
    path.resolve(root, "docs/IMAGE_BOUNDARIES.md"),
    "utf8",
  );
  for (const pattern of [
    /compact summary/,
    /unresolvedReasonCounts/,
    /unresolved components by reason/,
    /Full `components` records/,
    /`fitValidation` remain in `report.json`, not stdout/,
    /result.files\["report.json"\]/,
  ])
    assert.match(guide, pattern);
});
