# Shared Fusion scenarios

The scenario case modules supply the same steps and assertions to real Fusion and the partial
Python model. The scope includes document and saved-file lifecycle, numeric
parameters, simple construction planes, component trees, display units, cloud inventory and rectangular extrusions,
including ownership under interleaving. It does not replace the
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
npm run test:scenarios:live -- --run --protocol mcp --project-id PROJECT --folder-id FOLDER
npm run test:scenarios:live -- --run --protocol addin --project-id PROJECT --folder-id FOLDER
```

The runner does not start or upgrade a live broker. Fusion defaults to 10
concurrent scenarios; `--concurrency N` overrides this. The model defaults to
at most two scenarios based on CPU availability. Each slot covers setup, steps
and cleanup. `--owners N` sets the number of parameter scenarios, in addition
to one lifecycle scenario. Run one coordinator per Fusion instance.

`--suite all` is the default and runs foundation, saved, parameter, document, cloud,
box, body-attribute and rectangle-sketch scenarios. Use
`--suite foundation` for historical unsaved/export behavior or `--suite saved`
for the save/close/delete lifecycle, `--suite parameters` for parameter contracts
or `--suite documents` for planes, components and units, or `--suite cloud` for inventory. `--suite boxes` covers historical box dimensions,
volume and rollback. `--suite attributes` covers body attributes and token
isolation; `--suite sketches` covers owned rectangles and root-XY coordinate
checks. The model supplies a dedicated fixture
folder. Native saved scenarios require exact project/folder IDs; the runner never
chooses a live folder by name or creates one implicitly. Native runs are deferred
until the refactor is complete.

Each scenario receives its own document, creation ID, request IDs and export
file. Guarded operations activate the exact owned document in the same SDK
call. Foundation cleanup closes that document without saving and removes its export.
Saved fixtures bind the accepted save to its original client/request, observe
the exact completed file/version, close the document, request deletion and verify
absence from the configured folder before removing the export. Cleanup refuses
changed versions and read-only files. A successful delete call alone is not proof
of absence. File inventories protect pre-existing folder contents.
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
then continues cleanup. It never replays an accepted save, close or delete and does
not change a failed scenario into a pass. A new model process is a different
backend instance and cannot recover the old process's documents.
When all created scenarios have cleaned up, recovery audits the original document
and file inventories and restores the original active document. These extra
read-only observations do not repeat the original mutation.

Unsupported capabilities are reported before setup and fail the required
profile. Backend-specific changes to expected results or tolerances are not
allowed. Live validation remains necessary for unsaved-document export, the
global active-document behavior and the model's supported API semantics.

## Saved revisions and reopen

`--suite reopen` tests discarding unsaved parameter/geometry edits when reopening
an exact saved fixture. `--suite revisions` first saves modeled geometry and a
parameter, observes the next completed version, then verifies that reopening
retains that snapshot and discards subsequent unsaved edits. Both families are in
`--suite all` and use identical steps and tolerances on both backends.

Each scenario may save one revision and reopen once. Durable intents and original
backend receipts bind client/request, prior creation ID and exact file/version.
A lost reply defers cleanup; recovery reads the original evidence and never repeats
save/open/close. A failed receipt handoff cannot authorize deleting a different
file. A revision has no native-format implication: model exports remain marked JSON.

## Exclusive scenario barriers

A shared scenario with `scope: "exclusive-instance"` runs only after every
earlier scenario has completed its cleanup. Later fixtures are created only
after it passes and completes cleanup. A failed or unsupported exclusive case
blocks all later cases with durable `not-run` reports; those fail required
profiles. An unsettled earlier cleanup also blocks the next group. Ordinary
settled failures retain bounded concurrency and do not masquerade as success.

Cleanup recovery resolves original requests only. It does not launch blocked
scenarios or certify restoration of camera, workspace, material or motion state.
The exclusive scenario must assert its own restoration before returning. This
is a coordinator barrier, not an interprocess lock: use one coordinator per
Fusion instance. Native global-state qualification remains deferred.

`--suite camera` is an exclusive shared saved-fixture family for explicit camera
pose/lens, independent readback, invalid/foreign-state rejection and verified
restoration. It is also part of `all`. Its model does not render images or simulate
ViewCube/fit behavior. A failed assertion still attempts restoration after known
settlement; an unknown write stops further mutations, retains both primary and
restoration errors, and blocks subsequent scenarios. Recovery does not upgrade
that result to a passed camera qualification.
