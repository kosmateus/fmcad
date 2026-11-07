# Standalone CLI adapter

`src/entrypoints/cli.ts` owns argv orchestration, streams and exit status.
`src/entrypoints/cli/parser.ts` owns global and legacy-command parsing; CAD input
continues to use the shared plan/decoder. `src/cli.js` is only the temporary
CommonJS import facade. `bin/fmcad.js` starts the compiled TypeScript entrypoint.

CAD aliases, document pins, purpose, JSON/summary preferences and run argument
files map to the existing versioned application DTOs. Catalog metadata and
validation come from `createCatalogServices()`, execution from `createFmcad()`.
No physical transport is constructed by the CLI. Historical non-CAD families
keep their existing broker/application compatibility route until their DTOs are
migrated; this is not a direct execution fallback or another scheduler.

Help, local engineering/image processing and CAD previews precede configuration
discovery and session start. Local results do not prove physical CAD acceptance.
Invalid arguments reject before configuration/admission. `routing=direct` fails;
the old `routing=queue` spelling selects no alternative implementation.

The CLI owns and disposes its library session, not the shared broker or accepted
SDK work. It never resubmits after a lost acknowledgement, cancels on detach or
upgrades unknown/unresolved receipts to success. Application JSON field names,
paths, identities and SDK diagnostics remain opaque. Adapter prose uses stable
localization IDs and argument maps, with English fallback and Polish rendering.

The existing `createFmcad` API is extended additively at its typed execution
boundary for original CLI file hashes, queue controls and broker-owned exact
stdout/stderr. The implementation remains the same public service and private
queue composition; no new route or catalog copy is introduced. Large streams are
read only through validated broker-owned artifact references. This preserves raw
SDK diagnostics without translating or trusting arbitrary broker filesystem
paths.

## Offline checks

```sh
npm run build:code
node --test tests/cli-adapter.test.js tests/cad-worker-service.test.js
```

The dedicated suite covers parser constraints, every help route, public catalog
validation and aliases, explicit identity/purpose, direct rejection, legacy
broker delegation, real offline preview and built CLI from a foreign cwd, and
session cleanup/no replay with fake services. These checks do not contact Fusion.
Legacy tests injecting physical clients into `cli.main` need migration to the
new service seam; worker/application tests remain the execution baselines.
