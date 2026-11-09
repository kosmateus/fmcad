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
