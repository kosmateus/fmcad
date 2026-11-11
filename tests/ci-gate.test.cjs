const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { evaluateJobs, checkRun } = require("../.github/scripts/ci-gate.cjs");

const job = (name, overrides = {}) => ({
  name,
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
  ...overrides,
});
const gate = (overrides = {}) =>
  job("CI gate", { status: "in_progress", conclusion: null, ...overrides });
const evaluate = (jobs, overrides = {}) =>
  evaluateJobs({
    jobs,
    pipelineResult: "success",
    runAttempt: 1,
    ...overrides,
  });

test("accepts flattened reusable matrices and automatically checks new jobs", () => {
  const jobs = [gate(), job("pipeline / contracts (22.13.0)")];
  assert.equal(evaluate(jobs), 1);
  jobs.push(job("pipeline / new-unlisted-job (24.x)"));
  assert.equal(evaluate(jobs), 2);
  jobs[2].conclusion = "failure";
  assert.throws(() => evaluate(jobs), /new-unlisted-job/);
});

for (const conclusion of [
  "failure",
  "cancelled",
  "skipped",
  "neutral",
  "timed_out",
  "action_required",
  null,
]) {
  test(`rejects job conclusion ${conclusion}`, () => {
    assert.throws(
      () => evaluate([gate(), job("pipeline / test", { conclusion })]),
      /Unsuccessful jobs/,
    );
  });
}
for (const status of ["queued", "in_progress", "waiting", "pending"]) {
  test(`rejects incomplete ${status} jobs`, () => {
    assert.throws(
      () => evaluate([gate(), job("pipeline / test", { status })]),
      /Unsuccessful jobs/,
    );
  });
}
test("fails closed on missing jobs, missing/duplicate gate and gate-only reruns", () => {
  for (const jobs of [
    undefined,
    [],
    [gate()],
    [job("test")],
    [gate(), gate(), job("test")],
  ])
    assert.throws(() => evaluate(jobs));
  assert.throws(() => evaluate([gate({ status: "completed" }), job("test")]));
});
for (const pipelineResult of ["failure", "cancelled", "skipped", undefined]) {
  test(`rejects aggregate pipeline result ${pipelineResult}`, () => {
    assert.throws(
      () => evaluate([gate(), job("test")], { pipelineResult }),
      /Pipeline result/,
    );
  });
}
test("accepts retry jobs only from the current attempt, never stale success", () => {
  const jobs = [
    gate({ run_attempt: 2 }),
    job("pipeline / retried", { run_attempt: 2 }),
  ];
  assert.equal(evaluate(jobs, { runAttempt: 2 }), 1);
  jobs.push(job("pipeline / stale-success"));
  assert.throws(() => evaluate(jobs, { runAttempt: 2 }), /current run attempt/);
  delete jobs[2].run_attempt;
  assert.throws(() => evaluate(jobs, { runAttempt: 2 }), /current run attempt/);
});
test("API adapter paginates only the current attempt and propagates errors", async () => {
  const previousAttempt = process.env.GITHUB_RUN_ATTEMPT;
  process.env.GITHUB_RUN_ATTEMPT = "2";
  try {
    const endpoint = Symbol("listJobsForWorkflowRunAttempt");
    const historyEndpoint = Symbol("listJobsForWorkflowRun");
    const github = {
      rest: {
        actions: {
          listJobsForWorkflowRunAttempt: endpoint,
          listJobsForWorkflowRun: historyEndpoint,
        },
      },
      paginate: async (method, params) => {
        if (method === historyEndpoint) {
          assert.deepEqual(params, {
            owner: "owner",
            repo: "repo",
            run_id: 123,
            filter: "all",
            per_page: 100,
          });
          return [gate(), job("pipeline / retried", { conclusion: "failure" })];
        }
        assert.equal(method, endpoint);
        assert.deepEqual(params, {
          owner: "owner",
          repo: "repo",
          run_id: 123,
          attempt_number: 2,
          per_page: 100,
        });
        return [
          gate({ run_attempt: 2 }),
          job("pipeline / retried", { run_attempt: 2 }),
        ];
      },
    };
    const args = {
      github,
      context: { repo: { owner: "owner", repo: "repo" }, runId: 123 },
      core: {
        info: (message) =>
          assert.match(message, /1 successful jobs in attempt 2/),
      },
      pipelineResult: "success",
    };
    await checkRun(args);
    github.paginate = async () => {
      throw new Error("API unavailable");
    };
    await assert.rejects(checkRun(args), /API unavailable/);
    process.env.GITHUB_RUN_ATTEMPT = "";
    await assert.rejects(checkRun(args), /Invalid GITHUB_RUN_ATTEMPT/);
  } finally {
    if (previousAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = previousAttempt;
  }
});
test("retry cannot hide historical skipped jobs or duplicate matrix names", () => {
  const jobs = [gate({ run_attempt: 2 }), job("test", { run_attempt: 2 })];
  const history = [
    gate(),
    job("test", { conclusion: "failure" }),
    job("skipped-test", { conclusion: "skipped" }),
  ];
  assert.throws(
    () => evaluate(jobs, { runAttempt: 2, history }),
    /missing.*skipped-test/,
  );
  jobs.push(job("skipped-test", { run_attempt: 2 }));
  assert.equal(evaluate(jobs, { runAttempt: 2, history }), 2);
  history.push(job("test"));
  assert.throws(
    () => evaluate(jobs, { runAttempt: 2, history }),
    /missing.*test/,
  );
  jobs.push(job("test", { run_attempt: 2 }));
  assert.equal(evaluate(jobs, { runAttempt: 2, history }), 3);
});
test("workflow puts all jobs behind the reusable boundary and tests the gate first", () => {
  const read = (file) =>
    fs
      .readFileSync(path.join(__dirname, "..", file), "utf8")
      .replace(/\r\n/g, "\n");
  const caller = read(".github/workflows/ci.yml");
  const reusable = read(".github/workflows/ci-tests.yml");
  // Structural check: top-level job keys have exactly two spaces indentation.
  const callerJobs = caller.split(/^jobs:\n/m)[1];
  assert.deepEqual(
    [...callerJobs.matchAll(/^  ([\w-]+):\n/gm)].map((m) => m[1]),
    ["pipeline", "ci-gate"],
  );
  assert.match(
    callerJobs,
    /  pipeline:\n    uses: \.\/\.github\/workflows\/ci-tests\.yml\n/,
  );
  assert.match(
    callerJobs,
    /name: CI gate\n    needs: pipeline\n    if: \$\{\{ always\(\) \}\}/,
  );
  assert.match(callerJobs, /actions: read/);
  assert.doesNotMatch(caller, /secrets:|pull_request_target|write/);
  assert.ok(
    caller.indexOf("node --test tests/ci-gate.test.cjs") <
      caller.indexOf("uses: actions/github-script@"),
  );
  assert.match(caller, /PIPELINE_RESULT: \$\{\{ needs.pipeline.result \}\}/);
  assert.match(reusable, /on:\n  workflow_call:/);
  assert.doesNotMatch(reusable, /\n  (pull_request|push|workflow_dispatch):/);
  assert.match(
    reusable,
    /npx prettier --check.*\.github\/workflows\/\*\.yml.*\.github\/scripts\/\*\.cjs.*ci-gate\.test\.cjs/,
  );
  // The caller never enumerates reusable jobs; a new job belongs to pipeline.
  const withNewJob = `${reusable}\n  future-job:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: exit 1\n`;
  assert.match(withNewJob.split(/^jobs:\n/m)[1], /^  future-job:/m);
  assert.doesNotMatch(caller, /future-job/);
});

test("prepare builds once per Node and all consumers restore matching complete outputs", () => {
  const root = path.join(__dirname, "..");
  const reusable = fs
    .readFileSync(path.join(root, ".github/workflows/ci-tests.yml"), "utf8")
    .replace(/\r\n/g, "\n");
  const scripts = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).scripts;
  const jobs = Object.fromEntries(
    [
      ...reusable
        .split(/^jobs:\n/m)[1]
        .matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm),
    ].map(([, name, body]) => [name, body]),
  );
  assert.deepEqual(Object.keys(jobs), [
    "prepare",
    "broker-regressions",
    "contracts",
    "scenario-model",
    "modeling-admission",
    "public-consumers",
    "python",
    "control-center-browser",
    "scenario-broker",
    "refactor-regressions",
  ]);
  assert.equal((reusable.match(/- run: npm run build\n/g) || []).length, 1);
  assert.equal(
    (jobs.prepare.match(/- run: npm run test:prepare-offline\n/g) || []).length,
    1,
  );
  assert.equal(
    (reusable.match(/run: npm run test:prepare-offline\n/g) || []).length,
    10,
  );
  assert.equal(
    (reusable.match(/- run: npm run typecheck:tests\n/g) || []).length,
    1,
  );
  assert.match(jobs.prepare, /node: \["22\.13\.0", "24\.x"\]/);
  assert.match(jobs.prepare, /actions\/cache\/restore@v4[\s\S]*npm ci/);
  assert.match(
    jobs.prepare,
    /npm_config_cache: \/tmp\/fmcad-npm-cache[\s\S]*npm run build[\s\S]*npm run typecheck:tests[\s\S]*npm run test:prepare-offline[\s\S]*actions\/cache\/save@v4/,
  );
  assert.doesNotMatch(reusable, /github\.run_id|github\.run_attempt/);
  assert.equal(
    (reusable.match(/uses: actions\/upload-artifact@v4/g) || []).length,
    4,
  );
  assert.equal((reusable.match(/overwrite: true/g) || []).length, 3);
  assert.match(jobs.prepare, /retention-days: 90/);
  assert.match(jobs["broker-regressions"], /- run: mkdir -p \/tmp\/opencode/);
  assert.match(
    jobs.prepare,
    /node \.github\/scripts\/ci-build-artifact\.cjs build-output\.tar\.gz/,
  );
  assert.match(jobs.prepare, /name: build-\$\{\{ matrix.node \}\}/);
  for (const [name, body] of Object.entries(jobs)) {
    assert.match(body, /timeout-minutes:/, name);
    assert.doesNotMatch(body, /continue-on-error:|\brun: timeout\b/, name);
    const envBlock = body.match(
      /^    env:\n([\s\S]*?)(?=^    (?:strategy|steps):)/m,
    )?.[1];
    if (envBlock) {
      assert.match(envBlock, /npm_config_cache: \/tmp\/fmcad-npm-cache/, name);
      assert.doesNotMatch(envBlock, /\$\{\{\s*runner\./, name);
    }
    if (name === "prepare") continue;
    assert.match(body, /^    needs: prepare$/m, name);
    assert.match(body, /npm_config_cache: \/tmp\/fmcad-npm-cache/, name);
    assert.match(
      body,
      /uses: actions\/cache\/restore@v4\n        id: npm-cache/,
      name,
    );
    assert.match(
      body,
      /if: steps\.npm-cache\.outputs\.cache-hit != 'true'\n        run: npm run test:prepare-offline/,
      name,
    );
    assert.match(
      body,
      /npm ci[\s\S]*actions\/download-artifact@v4[\s\S]*tar -xzf build-output\.tar\.gz/,
      name,
    );
    const node =
      body.includes("matrix:") && body.includes("node: [")
        ? "${{ matrix.node }}"
        : "24.x";
    assert.ok(body.includes(`name: build-${node}`), name);
    assert.ok(
      body.includes(`path: \${{ env.npm_config_cache }}`) &&
        body.includes(
          `key: ci-prepared-npm-\${{ runner.os }}-${node}-\${{ hashFiles('package-lock.json') }}`,
        ),
      name,
    );
    assert.doesNotMatch(
      body,
      /npm run (?:build|test:scenarios:unit|test:control-center:e2e)\b/,
      name,
    );
  }
  assert.match(jobs["scenario-model"], /timeout-minutes: 90/);
  assert.match(jobs["scenario-model"], /python-version: "3\.12"/);
  assert.match(jobs["modeling-admission"], /timeout-minutes: 90/);
  assert.match(
    jobs["modeling-admission"],
    /node: \["22\.13\.0", "24\.x"\][\s\S]*shard: \[0, 1, 2, 3, 4, 5, 6, 7\]/,
  );
  assert.match(
    jobs["modeling-admission"],
    /FMCAD_MODELING_ADMISSION_SHARD: \$\{\{ matrix\.shard \}\}\/8/,
  );
  assert.match(
    jobs["modeling-admission"],
    /npm run test:modeling:admission \| tee \.test-artifacts\/modeling\/admission\.log/,
  );
  for (const [script, body] of [
    ["test:scenarios:unit", jobs["scenario-model"]],
    ["test:control-center:e2e", jobs["control-center-browser"]],
  ]) {
    const parts = scripts[script].split(" && ");
    assert.ok(
      body.includes(`- run: ${parts.at(-1)}`),
      `Retain exact tests from ${script}`,
    );
    if (script === "test:scenarios:unit") {
      assert.equal(parts[0], "tsc -p tsconfig.runtime-tests.json");
      assert.ok(scripts["build:code"].includes(parts[0]));
    } else {
      assert.deepEqual(parts.slice(0, -1), [
        "npm run build:code",
        "npm run typecheck:tests",
      ]);
      assert.ok(scripts.build.startsWith("npm run build:code && "));
    }
  }
  assert.match(
    jobs["public-consumers"],
    /python -m pip install -r tests\/python-requirements\.txt/,
  );
  assert.match(
    jobs["public-consumers"],
    /- run: npm run test:public-consumers/,
  );
  assert.match(jobs["public-consumers"], /FMCAD_REFERENCE_PYTHON: python3/);
  assert.match(jobs["scenario-broker"], /protocol: \[mcp, addin\]/);
  assert.match(jobs["scenario-broker"], /concurrency: \[1, 2, 10\]/);
  assert.match(
    jobs["scenario-broker"],
    /timeout-minutes: \$\{\{ matrix\.suite\.jobMinutes \}\}/,
  );
  for (const suite of [
    "foundation",
    "saved",
    "parameters",
    "documents",
    "cloud",
    "boxes",
    "attributes",
    "sketches",
  ])
    assert.match(jobs["scenario-broker"], new RegExp(`\\b${suite}\\b`));
});

test("build tar preserves complete staging, executable modes and symlinks without workspace secrets", () => {
  const os = require("node:os");
  const { execFileSync } = require("node:child_process");
  const {
    buildOutputs,
    pack,
  } = require("../.github/scripts/ci-build-artifact.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-build-artifact-"));
  try {
    for (const file of [
      "dist/library-build/src/queue-broker.js",
      "src/queue-broker.ts",
      "src/queue-broker.js",
      "src/dist/runtime.js",
      "server.mjs",
      "docs/COMMAND_REFERENCE.md",
      "docs/COMMAND_COVERAGE.md",
      "packages/core/dist/index.d.ts",
      "tests/fixtures/closed-scratch-artifacts.cjs",
      "tests/fixtures/closed-epoch-successor.cjs",
      "tests/fixtures/historical-module.cjs",
      ".git/config",
      ".npmrc",
      "node_modules/private/index.js",
      "src/queue-handwritten.js",
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), file);
    }
    fs.chmodSync(
      path.join(root, "dist/library-build/src/queue-broker.js"),
      0o755,
    );
    for (const name of [
      "queue-broker",
      "queue-client",
      "queue-closed-epoch-proof",
      "queue-isolated-epoch",
      "queue-scratch-control",
      "queue-admission",
      "queue-fixed-fixture-admission",
      "queue-instance-liveness",
      "queue-epoch-lineage",
    ]) {
      fs.writeFileSync(path.join(root, `src/${name}.ts`), name);
      for (const extension of [".js", ".d.ts"])
        fs.writeFileSync(path.join(root, `src/${name}${extension}`), name);
    }
    fs.writeFileSync(path.join(root, "src/queue-broker-ports.ts"), "ports");
    fs.writeFileSync(path.join(root, "src/queue-broker-ports.d.ts"), "ports");
    fs.writeFileSync(
      path.join(root, "src/cad.js"),
      '"use strict";\n// Generated by stage-compatibility; edit the canonical TypeScript module.\n',
    );
    fs.symlinkSync(
      "library-build/src/queue-broker.js",
      path.join(root, "dist/linked.js"),
    );
    const outputs = buildOutputs(root);
    assert.ok(outputs.includes("src/queue-broker.js"));
    assert.ok(outputs.includes("src/cad.js"));
    assert.ok(!outputs.includes("src/queue-handwritten.js"));
    const archive = path.join(root, "artifact.tar.gz");
    pack(root, archive);
    const listing = execFileSync("tar", ["-tzf", archive], {
      encoding: "utf8",
    });
    assert.doesNotMatch(
      listing,
      /(?:\.git|\.npmrc|node_modules|queue-handwritten)/,
    );
    const restored = path.join(root, "restored");
    fs.mkdirSync(restored);
    execFileSync("tar", ["-xzf", archive, "-C", restored]);
    assert.equal(
      fs.statSync(path.join(restored, "dist/library-build/src/queue-broker.js"))
        .mode & 0o777,
      0o755,
    );
    assert.equal(
      fs.readlinkSync(path.join(restored, "dist/linked.js")),
      "library-build/src/queue-broker.js",
    );
    for (const output of outputs)
      assert.ok(fs.existsSync(path.join(restored, output)), output);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CI invokes only offline scripts; real Fusion live suites stay local", () => {
  const root = path.join(__dirname, "..");
  const scripts = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).scripts;
  const visited = new Set();
  function check(command) {
    assert.doesNotMatch(
      command,
      /--backend\s+fusion|test:(?:live|native)|run-live|(?:^|\s)--run(?:\s|$)/,
    );
    for (const [, name] of command.matchAll(/npm run ([\w:-]+)/g)) {
      if (visited.has(name)) continue;
      visited.add(name);
      assert.equal(
        typeof scripts[name],
        "string",
        `Missing npm script: ${name}`,
      );
      check(scripts[name]);
    }
  }
  check(
    fs.readFileSync(path.join(root, ".github/workflows/ci-tests.yml"), "utf8"),
  );
});
