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
    fs.readFileSync(path.join(__dirname, "..", file), "utf8");
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
    /npx prettier --check.*\.github\/workflows\/\*\.yml.*ci-gate\.cjs.*ci-gate\.test\.cjs/,
  );
  // The caller never enumerates reusable jobs; a new job belongs to pipeline.
  const withNewJob = `${reusable}\n  future-job:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: exit 1\n`;
  assert.match(withNewJob.split(/^jobs:\n/m)[1], /^  future-job:/m);
  assert.doesNotMatch(caller, /future-job/);
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
