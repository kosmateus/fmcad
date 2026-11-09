# Agent G integration: saved revision and reopen profiles

The scenario-unit command already discovers `reopen.test.ts` and `revision.test.ts`.
The CLI and required-profile manifest register `reopen` and `revisions` for both
backends. Existing shared build/workflow files remain owned by G.

Add required Linux broker jobs for these dimensions:

- suite: `reopen`, `revisions`
- protocol: `mcp`, `addin`
- concurrency: `1`, `2`, `10`
- owners: `10`

After the pinned build, execute:

```sh
npm run test:scenarios:broker -- --suite SUITE --protocol PROTOCOL --concurrency CONCURRENCY --owners 10
```

Each job needs isolated broker state, retained `.test-artifacts/scenarios` reports,
and the existing timeout/cleanup handling. A failed, blocked, unsupported or not-run
required case must fail qualification. Do not replace existing gates. Keep physical
SDK concurrency at one; scenario concurrency includes offline preparation and
cleanup. This registration is a cross-owner dependency, not evidence of execution.

For component admission, the same commands use `test:scenarios:component`.
For final native qualification use `test:scenarios:live`, `--run`, an explicit
`--project-id` and `--folder-id`, and the matching installed build. Do not run native
qualification until the offline refactor is complete.

Add `rectangles` to the same required MCP/addin, concurrency 1/2/10 matrix.
The scenario always uses ten owners in the unit matrix and validates analytical
regeneration before and after owned saved-file reopening. Native execution stays
deferred; model geometry is not native kernel qualification.

Add `transactions` to required profiles for both protocols at concurrency 1/2/10.
It invokes the production definition/batch coordinator, not a Python-only facade.
Native command-event atomic rollback is not implied by this legacy definition
family. The ten-owner case is more expensive because each definition retains its
full original reference/measurement/replay/rejection sequence; measure job time
before assigning the final CI timeout instead of dropping assertions.

Add `camera` for both protocols and concurrency 1/2/10. It intentionally uses
exclusive-instance barriers even when the configured owner limit is ten. Keep
native rendering, ViewCube, fit and shot-pack obligations separate; this family
qualifies explicit state and lifecycle only. Never run two coordinators against
one Fusion instance.

Add `poses` to both protocols at concurrency 1/2/10. This exclusive saved-fixture
family tests production manifest revisions, body visibility, temporary evaluation
and restoration. It does not qualify joint solving or native rendering. Retain the
foreign-token and lost-reply unit gates in the aggregate scenario command.

Add `animation` for both protocols at concurrency 1/2/10. This owned-document
family runs the production deterministic camera-track planner and verifies its
read-only contract. Native storyboard actions, joint sampling and frame/video
export remain separate obligations; a generated manifest is not rendered output.

The native `shape-native-solids` obligation now points to shared `--suite
native-solids` with explicit project/folder and protocol/concurrency placeholders.
Keep this outside the required supported-model matrix: model execution must fail
as unsupported without SDK work. Its historical annular bound conflict is a
qualification blocker, not an optional skip; see B_NATIVE_SOLIDS_ASSUMPTIONS.md.

Add `materials` to required supported-model profiles for MCP/addin and concurrency
1/2/10. It covers local material metadata copy/rename/collision/readback and saved
revision/reopen, not physical properties or appearance/assignment inheritance.

Add `appearances` as the seventeenth supported model family, with the same MCP/addin
and concurrency 1/2/10 broker matrix. Unit tests also cover lost-copy recovery without
replay, foreign-document IDs, closed/library writes and assertion-failure cleanup.
Native visual/texture/assignment qualification is not covered by this registration.

Add `style-assignments` as the eighteenth required supported model family on the
same MCP/addin broker matrix at concurrency 1/2/10. Native inherited materials,
physical mass and face/occurrence overrides remain outside this bounded capability.

Add `thread-recipes` as the nineteenth supported model family for MCP/addin at
concurrency 1/2/10 with ten owners. It retains analytic custom-profile/pair-fit
assertions and independent unchanged geometry after curated-query rejection.
It does not replace the pending native ThreadInfo/cosmetic-feature obligations.
The new shared scenario uses nominal catalog key M10 and separately verifies
historically rejected M10x1.5; see B_ASSERTION_AUDIT.md for the preserved mismatch.

The follow-up `gear-pair` family retains nine declared involute external/internal
pair calculations on saved owned fixtures. Register it for MCP/addin, concurrency
1/2/10 and ten owners as the twentieth bounded family. It does not implement native
gear teeth, gear contact or the missing composite-shape suite. Unit and registration
checks pass; production checker, broker and native qualification remain required.
