const GATE_NAME = "CI gate";

// The attempt endpoint includes flattened jobs from called reusable workflows.
// Only the running gate itself may be incomplete; everything else must succeed.
function evaluateJobs({ jobs, pipelineResult, runAttempt, history = [] }) {
  if (pipelineResult !== "success") {
    throw new Error(`Pipeline result: ${pipelineResult}`);
  }
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error("No jobs returned for the current run attempt");
  }
  const gates = jobs.filter((job) => job.name === GATE_NAME);
  if (gates.length !== 1 || gates[0].status !== "in_progress") {
    throw new Error("Expected exactly one running CI gate");
  }
  if (jobs.some((job) => job.run_attempt !== runAttempt)) {
    throw new Error("Job does not belong to the current run attempt");
  }
  const pipelineJobs = jobs.filter((job) => job.name !== GATE_NAME);
  if (pipelineJobs.length === 0) {
    throw new Error("No pipeline jobs returned for the current run attempt");
  }
  // A partial retry must not silently drop an earlier skipped/failed job.
  // Compare multiplicities too: custom matrix names need not be unique.
  const currentCounts = new Map();
  for (const job of pipelineJobs) {
    currentCounts.set(job.name, (currentCounts.get(job.name) || 0) + 1);
  }
  const previousCounts = new Map();
  for (const job of history) {
    if (
      !Number.isInteger(job.run_attempt) ||
      job.run_attempt < 1 ||
      job.run_attempt > runAttempt
    ) {
      throw new Error("Invalid historical job run attempt");
    }
    if (job.name === GATE_NAME || job.run_attempt >= runAttempt) continue;
    const key = JSON.stringify([job.run_attempt, job.name]);
    const count = (previousCounts.get(key) || 0) + 1;
    previousCounts.set(key, count);
    if ((currentCounts.get(job.name) || 0) < count) {
      throw new Error(`Job missing from current run attempt: ${job.name}`);
    }
  }
  const unsuccessful = pipelineJobs.filter(
    (job) => job.status !== "completed" || job.conclusion !== "success",
  );
  if (unsuccessful.length) {
    throw new Error(
      `Unsuccessful jobs: ${unsuccessful.map((job) => `${job.name} (${job.status}/${job.conclusion})`).join(", ")}`,
    );
  }
  return pipelineJobs.length;
}

async function checkRun({ github, context, core, pipelineResult }) {
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (!Number.isInteger(runAttempt) || runAttempt < 1) {
    throw new Error("Invalid GITHUB_RUN_ATTEMPT");
  }
  // needs: pipeline is complete, so there is no polling or race with its jobs.
  // Do not use listJobsForWorkflowRun: its filters can mix retry attempts.
  const jobs = await github.paginate(
    github.rest.actions.listJobsForWorkflowRunAttempt,
    {
      ...context.repo,
      run_id: context.runId,
      attempt_number: runAttempt,
      per_page: 100,
    },
  );
  const history =
    runAttempt > 1
      ? await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
          ...context.repo,
          run_id: context.runId,
          filter: "all",
          per_page: 100,
        })
      : [];
  if (
    runAttempt > 1 &&
    !history.some(
      (job) => job.run_attempt < runAttempt && job.name !== GATE_NAME,
    )
  ) {
    throw new Error("No historical pipeline jobs returned for retry");
  }
  const count = evaluateJobs({ jobs, pipelineResult, runAttempt, history });
  core.info(
    `CI gate passed: ${count} successful jobs in attempt ${runAttempt}`,
  );
}

module.exports = { evaluateJobs, checkRun };
