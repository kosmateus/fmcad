# Live integration tests

These tests replace manual live validation: each invokes the real `fmcad` CLI
against a **provided cloud document**, asserts observable results, and leaves
the document empty after every test.

They are **never** part of the offline suites. They require the coordinator to
have opened a dedicated cloud test document in Fusion and to point
`FMCAD_TEST_DOC` at it.

## Environment

- `FMCAD_TEST_DOC` — identity of the open cloud test document. Accepts any of:
  - the exact open name shown by `fmcad doc list` (e.g. `C_... v21`),
  - the base name without the ` vN` version suffix (e.g. `C_...`), or
  - the document `id` shown by `fmcad doc list`.

  Fusion appends a version suffix to the open name (`Name vN`), while CAD
  commands require the **exact** open name in `--doc`. `docName()` resolves
  this automatically; do not hand-write ` vN` into `FMCAD_TEST_DOC`.

If `FMCAD_TEST_DOC` is unset, every test and hook skips (`# skipped`) and no
command reaches Fusion.

## Conventions

1. **Skip if no doc** — every test starts with:

   ```js
   test('...', (t) => {
     if (skipLive(t)) return;
     // ...
   });
   ```

2. **Clean before and after** — `clear()` empties the document (timeline,
   sketches, bodies, parameters, attributes, canvases). Register it as hooks and
   guard them so an offline run skips instead of throwing:

   ```js
   beforeEach(function () { if (!hasDoc()) return; clear(); });
   afterEach(function () { if (!hasDoc()) return; clear(); });
   ```

3. **Assert the envelope** — `fmcad(args)` returns the full JSON result
   envelope `{ success, operation, document, result, created, ... }` (envelope
   fields like `status`/`units`/`frame` are lifted for `schemaVersion:1`
   commands). Assert `success === true` and inspect `result`/lifted fields.

## Running

```sh
FMCAD_TEST_DOC=<cloud-id> node --test tests/integration/<file>.test.js
# ...or all live tests in the directory:
FMCAD_TEST_DOC=<cloud-id> node --test tests/integration/*.test.js
```

The validator runs these exactly this way with the coordinator-provided value.

## Helper API (`tests/integration/helper.js`)

| Export | Signature | Behavior |
| --- | --- | --- |
| `getDoc` | `() -> string` | `process.env.FMCAD_TEST_DOC`; throws a clear error if unset. |
| `hasDoc` | `() -> boolean` | True when `FMCAD_TEST_DOC` is set and nonempty (use in hooks). |
| `docName` | `() -> string` | Resolved exact open name (with ` vN`); cached, throws if ambiguous. |
| `fmcad` | `(args: string[]) -> object` | Runs `node bin/fmcad.js <args> --json --timeout 60000`, parses the JSON envelope; throws on non-zero exit or unparseable output with the raw output included. |
| `clear` | `() -> object` | Resolves name + cloud DataFile.id, runs `document clear`, asserts `status: 'cleared'` with all-zero `after`; returns the envelope. |
| `skipLive` | `(t) -> boolean` | `t.skip('FMCAD_TEST_DOC not set')` when no doc; returns true when skipped. Use `if (skipLive(t)) return;`. |

## CLI invocation shape

CAD commands are invoked as (command words use spaces, not dots):

```sh
node bin/fmcad.js <command words> --doc <exact-open-name> --data '<json>' --json
```

- `--doc` — the exact open name (resolved by `docName()`).
- `--data` — JSON object of operation inputs (serialize with `JSON.stringify`).
- `--json` — compact envelope output (appended by `fmcad()`).
- The envelope is `JSON.stringify` of `executeCad`'s result; exit code is
  nonzero when `success === false` or `status === 'failed'`.

`document clear` additionally requires the cloud DataFile.id, so `clear()` first
resolves it via `document status` and then runs:

```sh
node bin/fmcad.js document clear --doc <name> --doc-file-id <fileId> --file-id <fileId> --confirm true --json
```

## Default-atomic transaction scenarios (contract §5, §7 pkt 1–10)

These files cover the ten live scenarios and run the ATOMIC `batch run` path
(the default) — they never drive the legacy per-step client. Each asserts the
batch report envelope (`committed`/`aborted`/`rejected`/`unknown`, `rollback`
+ `rollbackVerified`, `documentIdentity`, `steps[].status`/`mutationStatus`) and
re-reads the model independently via `audit`/`diff`/`measure`/`history check`.

| File | Scenarios |
| --- | --- |
| `atomic-transaction.test.js` | S1 success (default atomic) · S2 error after mutation (default + `atomic:true`) · S3 partial handler (before-ref-publish, no orphan) · S4 edit existing model (param/name) + unsupported edit preflight reject · S5 final-validation abort |
| `atomic-isolation.test.js` | S6 document isolation (wrong/absent doc) · S7 transport timeout (unknown, no replay) · S8 queue/conflict (run.lock + same-runId refuse) · S9 external-effect rejection before mutation |
| `atomic-cwg-regression.test.js` | S10 CWG skeleton default-atomic · explicit `atomic:false` legacy stop-after-error + old report readable |

Rollback is proven by comparing the full `audit` snapshot before/after (counts,
parameters, occurrence transforms, body volume/bounds, timeline health) with
`diff`, allowing only `document/isModified` to differ (Fusion does not guarantee
that flag; spec §7). No test fakes Undo: the CLI/add-in does not expose
undo/redo, so the single-Undo guarantee is evidenced by the committed report +
model re-read, and the validator records the single-Undo UI check separately.

## Deterministic test-only fault injection (§8.4)

A test-only environment variable forces a deterministic failure inside the
atomic command at a specific step, without any public "break the model" command:

```sh
FMCAD_TEST_ATOMIC_FAULT=<phase> node --test tests/integration/atomic-transaction.test.js
```

`<phase>` is one of:

- `after_mutation` — raise after prior real steps mutated the model (abort must
  revert everything);
- `before_ref_publish` — create a real object via the shared handlers, then
  raise before its reference is published (abort must leave no orphan);
- `final_validation` — return an explicit unsuccessful result so the required
  result check aborts the whole batch.

An optional `:<afterIndex>` places the fault after a specific step (default:
last). The gate lives in `src/batch-atomic.js` (`injectTestFault`); the injected
operation `__test.fault` is handled by `_atomic_test_fault` in
`assets/cad/atomic.py`. The operation name is absent from every catalog, so
normal batch validation can never produce it — only the explicit env flag can,
and only inside the CLI process where the flag is set. It cannot be triggered
accidentally in production.
