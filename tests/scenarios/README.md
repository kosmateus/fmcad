# Shared Fusion scenarios

`cases.ts` supplies the same steps and assertions to real Fusion and the partial
Python model. The initial scope is document lifecycle and literal length user
parameters, including ownership under interleaving. It does not replace the
existing CAD/live suites or qualify geometry, cloud storage or rendering.

## Build and checks

```sh
npm ci
npm run build
npm run test:scenarios:unit
npm run typecheck:simulator
node dist/tests/scenarios/verify-api.js
npm run test:scenarios:component -- --protocol mcp --owners 10
npm run test:scenarios:component -- --protocol addin --owners 10
```

The build verifies the Autodesk commit and content snapshot recorded in
`scripts/adsk-refresh/api-lock.json`. Updating that lock is a reviewed source
change; the normal build does not follow a moving upstream branch.

The component profile uses the production Python checker and prepared artifact,
but bypasses the broker. Its result explicitly says `qualification: component`.
Unit tests also exercise both actual HTTP transports and a lost reply after
execution. These checks do not establish broker correctness.

## Real broker with the model

```sh
npm run test:scenarios:broker -- --protocol mcp --concurrency 10 --owners 10
npm run test:scenarios:broker -- --protocol addin --concurrency 10 --owners 10
```

This path uses QueueClient, the actual broker, production checker and physical
transport. It needs ordinary Linux process identity and Unix socket facilities.
It fails explicitly when those prerequisites are unavailable. No process guard
or IPC check is disabled to make the profile pass. CI runs each protocol in a
separate job with isolated broker state.

## Real Fusion

After installing the matching build, start the configured broker and Fusion
backend. The protocol must match that configuration:

```sh
npm run test:scenarios:live -- --run --protocol mcp
npm run test:scenarios:live -- --run --protocol addin
```

The runner does not start or upgrade a live broker. Fusion defaults to 10
concurrent scenarios; `--concurrency N` overrides this. The model defaults to
at most two scenarios based on CPU availability. Each slot covers setup, steps
and cleanup. `--owners N` sets the number of parameter scenarios, in addition
to one lifecycle scenario. Run one coordinator per Fusion instance.

Each scenario receives its own document, creation ID, request IDs and export
file. Guarded operations activate the exact owned document in the same SDK
call. Cleanup closes only that document without saving, then removes its export.
Reports and source hashes are retained under `.test-artifacts/scenarios/`.
The model's `.f3d` is marked JSON test state, not a native archive.

Scenario steps may address only the session's immutable owned document. The
runner reserves create/export/cleanup phases, validates the document identity in
successful results, and binds creation receipts to the client and original
request. Returned and durable creation identities must agree before any step.
These checks complement the in-SDK and broker guards; arbitrary scenario Python
is trusted code, not a sandbox.

## Failure and recovery

An operation or assertion failure still runs cleanup after known settlement.
Unknown outcomes defer cleanup: an absent reply is not evidence that execution
did not happen. SIGINT/SIGTERM stop new scenario steps and wait for the current
operation to settle before cleanup. Forced termination cannot guarantee cleanup.

For a deferred live report, with the original backend and matching build:

```sh
npm run test:scenarios:live -- --run --protocol mcp --cleanup /absolute/path/report.json
```

Recovery looks up original results, verifies ownership and settlement, and only
then closes the owned document. It never replays the original mutation and does
not change a failed scenario into a pass. A new model process is a different
backend instance and cannot recover the old process's documents.

Unsupported capabilities are reported before setup and fail the required
profile. Backend-specific changes to expected results or tolerances are not
allowed. Live validation remains necessary for unsaved-document export, the
global active-document behavior and the model's supported API semantics.
