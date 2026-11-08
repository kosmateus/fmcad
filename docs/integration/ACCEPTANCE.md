# Integration acceptance ledger

Agent G owns this ledger. Starting source is
`0b84454d8e5d22abb23bcf52999c506894ebf5bf` (8 November 2026).
**Offline refactor: incomplete. Native qualification: not run.**
A claim, static registration, compilation or model output is not acceptance.

## Reproducible inventory

After `npm ci && npm run build`, run:

```sh
python3 -B scripts/integration/coverage.py --check --output .test-artifacts/integration/ci-registration.json
python3 -B scripts/integration/inventory.py --output .test-artifacts/integration/inventory.json
python3 -B -m unittest discover -s tests -p integration_registration_test.py
```

The starting snapshot contains 650 runtime source files and 420 executable public
routes (the existing registry has 505 entries including family headings). The
public inventory includes existing source/test audit references and aliases.
Those references still need effect/readback and negative-case review by E and
the runtime owners. Literal CommonJS shims are candidates, not approved deletions.
Other source forms deliberately remain `requires-semantic-review`: neither line
count nor extension can establish whether a family is migrated.

The initial test audit finds 485 test sources, 222 with a recognized CI execution
path and 263 without one. The new guard adds one Python test source, giving 486
and 223 respectively. Source wrappers and their TS bodies are separate inventory
rows, not independent test counts. None of these numbers counts assertions or
proves a test passed. The audit traces workflow run commands through npm scripts,
Node test selections, Python package discovery and literal test-wrapper imports.
Build/typecheck commands alone do not count. Dynamic dispatch, conditional jobs,
per-case skips, matrix completeness and actual results still require log review.

[Registration debt](ci-registration-gaps.json) names every initial missing source,
its triage owner and next action. This is open debt, not a waiver. New unregistered
sources and unexplained removal of listed gaps fail the separate integration
workflow. Existing gaps can become registered without rewriting the baseline.
Do not add a blanket glob: `tests/integration` mixes native mutations and local
checks; `tests/native` also contains offline harness tests. Review each selection.

Initial gap routing: A 64, B 48, C 40, D 3, E 43, F 19, G 46. These are review
assignments under the seven plans, not final assertions of code ownership. G
resolves ambiguous ownership. In particular, A's six broker gates remain A's
bootstrap exception; G does not race edits to `package.json` or `ci.yml`.

## Delivery dependencies

Observed open heads below are proposals, **not merge evidence**. Refresh them
before any integration; record exact merged SHA and full matrix results here.

| Package | Observed delivery              | Required evidence / remaining disposition                                                                             |
| ------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| A       | PR #42 `270096c`               | Broker gates first; A2–A4 admission/recovery/concurrency still required.                                              |
| B       | PR #36 claim; PR #44 `fe1c66f` | Persistence increment; complete assertion mapping, shared profiles and lifecycle/cleanup proof remain B dependencies. |
| C       | PR #37 `a4943f3`               | Claim only at observation; canonical modeling services, Python boundaries and negative/readback evidence required.    |
| D       | PR #38 `ee0fd54`               | Claim only at observation; file/source/version/publication and recovery contracts required.                           |
| E       | PR #39 `a66ea3c`               | Public/host work in progress; installed routes, declarations and consumer parity required.                            |
| F       | PR #41 `a751396`               | Claim only at observation; production browser, retention and explicit UI retirement ledger required.                  |
| G       | PR #40                         | Registration guard and inventories are an initial delivery, not G1–G4 completion.                                     |

Base-main CI run `42523257166` subsequently completed with all 22 jobs successful
on `0b84454d8e5d22abb23bcf52999c506894ebf5bf`. G's own exact-head workflows still
need their independent complete results. Merge neither this delivery nor another
owner's work on stale or partial checks.

## Archive and Beads reconciliation

The separately downloaded archive has SHA-256
`fbed61c51441a3d6a1794790cca10c60e54719cf744ee0624581596574923654`,
size 196879449 bytes, Git HEAD `f474e943e05e6a78f763a290cd4ad92b3685e952`,
140 local branch refs and 168 worktree metadata directories. These directories
are historical references, not 168 active deliverables. No archive, Git store,
worktree or Beads database is included in the source changes.

`.beads/metadata.json` identifies an embedded Dolt database named `fmcad`;
`.beads/.local_version` is `1.3.1`. No JSON/JSONL issue export was present.
The initial environment lacked a reader. G subsequently downloaded the official
Dolt 2.7.2 Linux binary, verified its release SHA-256
`72825a65d96bf0a0967ec408ad43bc21afc9b1c899b84cb84344a35f567fb11f`,
and queried a disposable copy of the embedded database using a writable TMPDIR.
No issue or archived database was mutated.

The independent query confirms **150 tasks: 104 closed, 22 open, 11 in progress,
9 deferred and 4 blocked**, with **307 dependency edges**. The earlier 104/46
split is now verified. Detailed task text and relationships remain outside the
public repository; the table below retains only the scope already published in
the completion plan. Historical closed state is not current acceptance evidence.
No new task closure is inferred or written.

Automatic approval review rejected publication of the detailed archive-derived
ledger to this public repository. This delivery publishes aggregate verification
only. A public per-task dependency ledger remains withheld; do not reconstruct
it from this summary or claim that its publication succeeded.

All identifiers below have the `fmcad-` prefix. This preserves the earlier scope
without pretending that historical statuses or later fixes complete an epic.

| Archived scope                                                                                                                                                                                                                                                                                                      | Owner      | Evidence and disposition                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `69j`, `69j.2`                                                                                                                                                                                                                                                                                                      | A/E/G      | Completion plan links `8b2c237` for doc-id handling. Verify installed route and original task conditions; no duplicate implementation or closure yet.                                                  |
| `cb4`, `cb4.2`, `cb4.4`–`cb4.8`                                                                                                                                                                                                                                                                                     | B/G        | Existing shared scenario families are partial. Await assertion-level inventory and required-profile results.                                                                                           |
| `e4m`, `e4m.2`, `hex-integration`                                                                                                                                                                                                                                                                                   | G with A–F | Reconcile current runtime boundaries and public consumers; archived states verified; current completion remains open.                                                                                  |
| `control-center`, `control-center.1`, `locale-catalogs`, `locale-selection`, `web-system-controls`, `web-agents-projects`, `web-bundle`, `web-operational-views`, `web-telemetry`, `browser-console`, `log-retention`                                                                                               | F/G        | Existing browser/locales/history are foundations. F must supply parity, retention/disposal, real browser and retirement evidence.                                                                      |
| `isc`, `dru`, `dru.2`, `dru.2.5`, `dru.2.6`, `native-drive-test`, `live-acceptance`, `hex-integration.2`                                                                                                                                                                                                            | A/B/G      | Preserve current recovery/native prerequisites; native acceptance deferred until offline completion and actual Fusion access.                                                                          |
| `brep-baselines`, `capture-integrity`, `selection-rules`, `semantic-model-state`, `attachment-check`, `channel-check`, `geometry-evidence`, `regional-contacts`, `adaptive-clearance`, `invariants-parameters`, `native-interfaces`, `native-route-check`, `qualified-recipes`, `rework-plan`, `verify-saved-model` | C/D/E/G    | Separate feature backlog. Protect existing behavior; do not claim new feature completion through the refactor. Retain the existing separate-feature scope; detailed archive records are not published. |
| Keychain                                                                                                                                                                                                                                                                                                            | excluded   | Deliberately removed before the historical baseline; do not restore.                                                                                                                                   |

## Qualification preparation

Generate commands with real dedicated fixture identifiers after the pinned build:

```sh
python3 -B scripts/integration/native-plan.py --project-id PROJECT_ID --folder-id FOLDER_ID --output .test-artifacts/integration/native-plan.json
```

This command only constructs existing scenario objects and validates CLI arguments;
it does not connect to Fusion, start a broker or execute a scenario. It produces
48 command arrays: eight current shared families, MCP/addin, and concurrency
1/2/10 with ten owners. It records their actual scenario IDs/capabilities, source
SHA, dirty state, current live inventory, required receipts and cleanup command.
It is a runnable **partial** handoff, not the final assertion-complete manifest.
B's later required-profile/assertion manifest must replace this bounded family
selection before final acceptance. Global UI restoration and fixed owned fixture
copies remain explicit B/F dependencies; native export geometry is not model JSON.

Do not dispatch until offline acceptance is complete and the installed broker
matches the integrated source/build. Use the dedicated project/folder, verify the
configured transport, preserve original reports under `.test-artifacts/scenarios`,
and record Fusion/API versions, owners, request/creation/file/version IDs, physical
call counts, source hashes and before/after inventories. Execute command arrays
without shell interpolation. A blocked, unsupported, skipped or unexecuted
required assertion cannot pass qualification.

After uncertainty, inspect the original request's receipts. Use the existing
`--cleanup ORIGINAL_MANIFEST --backend fusion --profile broker --protocol ORIGINAL_PROTOCOL --run`
path only against the original backend/owner. Never replay the mutation, delete
by name, substitute another version or clear an unrelated document. Keep primary
and cleanup errors separately. Cleanup completion cannot pass assertions that
never ran. The older `tests/native/integrated-qualification/manifest.json` is
historical feature evidence with its own pinned runtime/hold; it is not the final
refactor manifest and its safety holds must not be removed by this inventory.

## Remaining integration work

- G1: resolve semantic family ownership, per-method effects/negative coverage,
  actual job results and assertion mapping from B. Beads export is verified;
  semantic reconciliation and current closure evidence remain open.
- G2: register reviewed offline selections, migrate handwritten tests in bounded
  groups, and integrate delivered A–F contracts on current main with full CI.
- G3: complete installed CLI/MCP/SDK/OpenCode/declarations/assets checks, clean and
  incremental builds, owner-approved facade retirement and retained cold/warm,
  startup/checker/preparation/RSS/package-size comparisons. No concurrency increase
  is justified yet; retain model default `min(2, CPU)` and one physical SDK lane.
- G4: publish one accepted integrated SHA only after every A–F checklist and G1–G3
  closes. Finalize all native assertions, then qualify separately with real Fusion.

## Initial local verification and unresolved findings

- `npm run build` and `npm run typecheck:tests`: passed.
- Registration units: 8 passed, including rejection of compile-only/name-filtered
  selections and commented or quoted wrapper imports. Inventory check passed.
- Shared scenario units: 123 passed, zero failed/skipped. Simulator typecheck:
  zero errors/warnings. API verifier: 57 methods and 21 property accessor shapes.
- Native plan: 48 command arrays validated by the existing CLI parser, not run.
- Installed MCP test: initial attempt failed on missing offline npm metadata.
  Preparing cache and executing in the same host invocation resolves that setup
  problem, then the unchanged test fails its empty-stderr assertion with
  `fmcad: Control Center unavailable; MCP remains available.` E/F must diagnose
  the lifecycle/platform prerequisite before registration; expectations retained.
- Installed OpenCode tests initially failed dependency-cache setup; checker and
  admission packaging tests also encounter npm-pack JSON parsing. These attempts
  are failures, not installed acceptance; rerun with isolated prerequisites and
  retain complete stdout/stderr before attributing product versus fixture drift.
- Retained final-benchmark harness: three tests pass; its multi-client worker
  fails because `process.memoryUsage()` returns `ENOENT: uv_resident_set_memory`
  in this host, after setting a writable TMPDIR. RSS measurement is unavailable
  here; do not invent values, relax thresholds, or change concurrency defaults.
  Repeat on Linux CI with process/RSS evidence. No comparative timing claim made.

The dependency table is a timestamped observation, not a moving branch status.
Later A–F proposals must be fetched and verified before their status changes here.

Package inspection at `f1bed91f1e2c51ec33123f7b7d1fdfc758fbd64c`:
`npm pack --dry-run --ignore-scripts --json` reports 1,567 files,
3,374,032 compressed bytes and 16,624,667 unpacked bytes. No tests, Beads, Git,
node_modules, archive ZIPs or investigation artifacts occur in the package list.
This checks the allowlist only; it does not replace installed behavior tests or
establish a before/after performance comparison.
