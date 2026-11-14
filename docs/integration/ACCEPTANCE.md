# Native qualification preparation

`tests/live-required-profiles.json` and the scenario case manifests define the
required model profiles and retained native obligations. They are machine-readable
test inputs, not a record of current execution status. Keep their runtime pins,
case identities and unsupported/native-only classifications unchanged unless a
separate code or test change requires it.

After building the matching candidate, generate a plan with explicit, owned
fixture identifiers:

```sh
python3 -B scripts/integration/native-plan.py --project-id PROJECT_ID --folder-id FOLDER_ID --output .test-artifacts/integration/native-plan.json
```

Plan generation validates inputs and constructs command arrays; it does not
connect to Fusion, start a broker or execute a scenario. Targeted local live tests
may be run during development against the matching installed build and the
already-running configured broker. The final qualification matrix remains a
separate acceptance gate after required offline checks have completed.

## Execution and evidence

Use the dedicated project/folder and configured transport. Each runner must own
unique run, request, document, file/version and report identities. Independent
runners may share the broker: the broker serializes physical Fusion SDK turns,
while scenario concurrency includes offline preparation and cleanup. Do not
start a competing broker or impose a manual Fusion reservation. Global-state
scenarios use their in-run exclusive barrier; that is not an interprocess lock.

Record the exact installed commit/build, Fusion/API versions, source/profile
hashes, receipts, physical call counts and before/after inventories. A model or
simulator result is not native evidence. A blocked, unsupported, skipped or
unexecuted required assertion is not a pass; keep native results `NOTRUN` unless
they were actually executed and all required checks passed.

After an uncertain result, inspect the original request receipts. Use the existing
`--cleanup ORIGINAL_MANIFEST --backend fusion --profile broker --protocol ORIGINAL_PROTOCOL --run`
path only against the original backend and owner. Never replay a mutation, delete
by name, substitute another version or clear an unrelated document. Preserve
primary and cleanup errors separately. Cleanup cannot pass assertions that never
ran. The older `tests/native/integrated-qualification/manifest.json` is historical
feature evidence with its own pinned runtime and hold; it is not the final refactor
manifest, and its safety holds must not be removed by this inventory.
