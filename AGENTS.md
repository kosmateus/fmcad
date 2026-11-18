# Project-specific staffing and continuous delivery

These explicit user requirements replace the generic `team-coordinator` staffing defaults for this project.

- Use `openai/gpt-6.1-sol` for work previously assigned to Luna and for new standard assignments. Use `openai/gpt-6-astra` for work previously assigned to Sol and for escalations beyond Sol. Existing Astra assignments stay with Astra. Use the default variants unless the user requests otherwise; do not assign new work to Luna.
- Preserve the session, worktree, branch, evidence, and running operations when changing models. Confirm the configured model and the model of actual execution separately. Update open Beads assignees to `sol-<scope>` or `astra-<scope>` and record the model, variant, and session ID; preserve historical owners of closed tasks.
- The coordinator owns delivery through completion, not just reporting. Independently inspect ready tasks and concrete blockers, launch as many useful independent executors as capacity permits, and immediately refill capacity when work finishes or dependencies unblock. Keep this discipline throughout the assignment; do not manufacture audits or duplicate work just to increase the agent count.
- The coordinator also diagnoses, implements, and verifies explicitly owned, non-overlapping tasks while coordinating the team. Record those assignments in Beads and preserve other executors' file ownership.
- Executors collaborate on contracts, failures, fixes, and evidence through the permitted mailbox. Route messages through the coordinator when direct routing is unavailable. Only the coordinator starts or resumes subagents, in the background, and prevents overlapping edits and duplicate runs.
- Continue from results directly to the next required action. Progress updates, one completed batch, and routine implementation decisions are not stopping points. Ask the user only about a genuine unresolved scope, authority, or resource blocker after safe available remedies have been exhausted.

## Responsibility for Fusion and the refactor

- The team owns Fusion operation and recovery for this project. The goal is to finish the refactor against the agreed requirements, pass the required offline and actual live tests, and complete integration; starting commands, receiving receipts, or publishing commits alone is not delivery.
- Decide and perform necessary Fusion/broker restarts, resets, recovery, runtime deployment, and routine test actions autonomously within the authorized scope. Do not ask the user for routine permission to restart Fusion or proceed with these operations.
- Before lifecycle changes, establish the actual state of active producers and accepted requests, coordinate a safe boundary with their owners, and use the supported lifecycle and shared SDK queue. Preserve user and peer documents, saved files and versions, receipt identity, and historical UNKNOWN evidence. A model change never justifies replaying an uncertain mutation, bypassing a guard, or replacing a runtime beneath active clients.
- Use the currently authorized transport and pinned runtime. For the current live scope, physical execution is ADDIN `8765` only; public fmcad MCP stdio may route through ADDIN. Physical MCP `27182` probes, initialization, and requests remain excluded. A simulator result is not live Fusion evidence.
- When a new live test fails, compare the corresponding historical JS implementation and tests before inventing a replacement mechanism. Fix the technical cause, verify it, and use fresh request/document IDs for a fresh test; preserve the original uncertain outcome without replay or fabricated settlement.
- PR #104 has the user's explicit shared-integration exception: each executor may integrate and push their own verified changes fast-forward to `refactor/offline-completion`, from a separate worktree after incorporating the current remote. Preserve peers' changes; no force-push or direct push to `main`. After PR #104 is actually merged, return to separate branches and pull requests as specified below.

# Commit and pull request style

- Write commit subjects in English.
- Keep commit subjects short and factual.
- Use the imperative mood for commit subjects.
- Write pull request titles and descriptions in English.
- Keep pull request titles and descriptions short and natural.
- Describe only behavior added or changed by the pull request.
- Do not use the pull request description as a process report.
- Do not include a Validation or Testing section in the pull request description.
- Do not include test results, logs, plans, or a narrative of agent activity in the pull request description.
- A pull request description may be empty when the title is sufficient.
- Do not require a pull request template.
- Keep test evidence and verification details in Beads and GitHub Actions, not the pull request description.
- Prefer clear wording over prescribed formats.
- Conventional Commits prefixes are optional, not required.

## Agent collaboration, testing, and change integration

### Autonomy and ownership of outcomes

- Agents are autonomous within their assigned scope. Ordinary implementation, testing, creating or updating a pull request, and merging after requirements are met do not require user or coordinator permission.
- The executor owns the work end to end: understand the code and task; implement and test; create their own pull request; monitor CI, diagnose failures, and fix them; update the branch from `main`; run required checks, including appropriate local Fusion checks; merge the pull request; and confirm the merge and update Beads.
- Creating a pull request, pushing, or running tests alone does not complete a task.

### Separate worktrees, branches, and pull requests

- By default, each executor uses their own worktree, branch, pull request, and merge. Create the branch from the current `origin/main`.
- Do not share an active worktree or staging area, commit or push to another person's branch, overwrite another person's changes, push directly to `main`, or collect changes from multiple agents on a shared branch or aggregate pull request.
- Record ownership of shared files, configuration, manifests, and dependencies in Beads.
- Exception: agents may jointly complete an existing integration when the user has explicitly allowed multiple agents to work on that pull request. Use separate worktrees; the designated owner assembles the changes and completes the merge. Afterward, return to separate pull requests.

### Merge without manual slots or additional review

- Merge a ready pull request without waiting for a merge slot, coordinator approval, additional review, or unrelated pull requests.
- Preconditions: the scope is complete; required tests and checks have passed; appropriate local live evidence is available when working with Fusion; the branch is up to date; and effective GitHub branch protection is satisfied.
- Before merging, fetch refs and check the pull request head and `origin/main`. If the branch is stale, merge or rebase according to repository practice, resolve conflicts, push, and rerun the checks for the new candidate. If `main` changes again, repeat this process yourself rather than joining a queue.
- Use `gh pr merge --match-head-commit` with exactly the verified head SHA and an allowed merge method. The head-SHA guard does not replace checking that the branch is current with `main`.
- If GitHub merge queue is in use, enqueue the pull request yourself and monitor it until it is actually merged. Do not add a separate agent queue, global lock, or schedule.
- Do not use `--admin`, bypass protections, or disable branch protection.
- The coordinator manages scope, dependencies, and completeness, but does not grant merge permission for independent, ready pull requests.

### Actively manage pull requests with `gh`

- Use local `gh pr view`, `gh pr checks --watch`, `gh run list --commit`, `gh run watch --exit-status`, `gh run view --log-failed`, `gh pr update-branch`, and `gh pr merge` as appropriate.
- Analyze actual executions, the full test matrix, and skipped jobs. A green status, compilation, or registration does not substitute for evidence that the code ran.
- Attribute results to the correct candidate and distinguish the pull request head SHA, base SHA, and synthetic merge SHA.

### Offline CI and parallel local Fusion testing

- CI runs offline checks and tests only. Real Fusion and live tests run locally only, even when CI uses self-hosted runners.
- Run only the relevant local test subset covering changed code or behavior and directly affected areas or dependencies; do not run all tests by default or wait locally for unrelated long suites.
- CI runs the full required offline suite. Monitor CI, diagnose failures, and fix regressions; a local targeted subset is not evidence that the full CI suite passed.
- When the scope involves Fusion, run appropriate targeted local live checks. CI must not run live Fusion tests.
- The broker backend simulator is allowed in CI. Classify execution by backend and dependencies, not by filename.
- Multiple agents may run local live tests concurrently. Each uses their own documents and files; no permission, Fusion reservation, or time slot is needed.
- Preserve the existing broker's support for parallel clients, owner isolation, document routing, the SDK operation queue, and recovery. Preserve configurable scenario concurrency with a default of 10, parallel offline preparation, and a single queue for SDK operations.
- Let the broker wait automatically when normal operation requires it; this needs no approval. Use your own client, request, document, and artifact IDs.
- Clean up only resources you own, using fixtures or cleanup mechanisms. Preserve file, version, and receipt identity.
- When an outcome is unknown, recover using the original evidence and defer cleanup; do not blindly retry mutations or delete resources by name alone.
- Verify concurrency across independent runner processes, not only among scenarios in one runner.
- If broker isolation or global Fusion state is inadequate, fix the existing architecture. Do not impose manual reservations or serialize entire suites.
- Link results to the source SHA, artifacts, and actual runtime.
- Do not replace the shared add-in or broker while other agents have active runs using it. Switch runtimes through a safe lifecycle; routine tasks do not require manual permission.

### Beads as the current work record

- Use local Beads to track tasks, owners, dependencies, blockers, and status.
- Do not create or update shared Markdown solely to report claims or progress, and do not create claim commits or a claim board for pull requests.
- Record the task scope, pull request, verified SHA, test results, and evidence links.
- Close a task only after its actual scope is complete and integration is confirmed.
- For a real blocker, record concrete evidence and the dependency, and continue independent work. Manual test permission and merge-slot approval are not blockers because those stages do not exist.
