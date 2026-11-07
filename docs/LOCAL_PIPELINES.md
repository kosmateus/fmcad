# Local calculation and worker boundaries

`packages/core/src/application/engineering.ts` dispatches the retained local
engineering operations. Fit/interface, hydraulic, fluid, mass/load/stability and
thermal algorithms live in strict TypeScript under `domain/engineering`.
They import neither Node nor a Fusion host, configuration, transport or broker.
The source-tree `src/engineering-*.js` modules are transitional CommonJS facades.
Existing operation names, SI quantities, missing-data statuses, errors, source
uncertainty and canonical SHA-256 provenance are retained. No keychain workflow
or replacement tolerance engine is introduced.

## Fit-stack sensitivity and evidence

`fit.stack` returns a separate `sensitivity` result using
`one-at-a-time-worst-case-range-v1`. It ranks each term by the span between that
term's projected minimum and maximum contribution, with signed lower/upper shifts
and deterministic ID-ascending tie breaks. Equal ranges share a competition rank.
`rangeShare` is the term range divided by the sum of all term ranges (unit `1`);
when every range is zero it is `null` rather than a fabricated fraction.
If any input needed to form a term's projected interval is missing/open, the
sensitivity status is `unknown` and its ranking is `null`. Incompatible units
remain validation errors.

Each ranked term carries provenance for the source/status/uncertainty metadata of
the parsed inputs. This records caller-provided measurement or declared-value
evidence; it does not certify the source or propagate that metadata's uncertainty
into the tolerance range. The ranking is a worst-case bounded comparison, not a
statistical contribution. The separate `linear-normal` statistical result uses
the supplied correlation matrix and reports a covariance-derived interval; that
interval is not a worst-case guarantee. Both calculations are deterministic and
charge their work to the existing engineering evaluation budget.

## Deterministic calculations and bounded execution

`runEngineering(operation, data, runtime?)` accepts unknown input and performs
the existing strict runtime field/unit/schema checks. Omitting `runtime` uses a
logical constant clock: the same input and evaluation budget produce the same
result independently of host load. `budget.maxEvaluations` remains the hard
deterministic work bound. A caller may supply `{clock:{now(): number}}` for
elapsed-time protection; the CLI explicitly supplies its monotonic host clock.
The clock must return finite monotonic milliseconds. Time/evaluation exhaustion
keeps the existing `Engineering evaluation budget exceeded` error and publishes
no result. Nested interface checks propagate the supplied runtime and charge
their completed evaluations to the enclosing budget.

Null measurements remain unknown, not zero. In particular, explicit missing
load efficiency yields null required torque; a missing tensor in any contributing
item cannot be restored by adding a later complete item. These partial-data
cases have dedicated regression tests.

## Image/reference plans and replaceable effects

`domain/local-pipeline-plan.ts` owns pure image argv/request planning and reference
worker plans. It preserves camelCase fields, duplicate/unknown flag rejection,
required local paths, boundaries' duplicate JSON-key detection and the original
division of validation: detailed numeric/raster/schema checks belong to Python.

`application/local-pipeline.ts` orchestrates `LocalPipelineFiles` and
`LocalWorkerPort`. Invalid outer requests never start a worker. Request-file
paths and request contents resolve against invocation cwd, not the request-file
directory. Worker plans identify a logical worker, local interpreter, argv and
JSON request; they contain no host SDK handles. Reference results preserve the
worker JSON envelope and error guidance. Image results preserve stdout/stderr
and process termination without interpreting `ready` as CAD acceptance.
On successful exit the Node adapter now requires exactly one finite JSON value
through EOF before publishing stdout. Empty, malformed, concatenated JSON,
NaN/Infinity and exponent overflow fail locally. The original valid stdout bytes
are retained; this is not NDJSON and does not reinterpret the image envelope.

The Node process adapter is `node-adapters/src/python/local-pipeline.ts`. The
composition root supplies asset resolution and interpreter preflight. It starts
one process with `shell:false`, sends JSON stdin, forwards optional output sinks
and retains exit code/signal. Diagnostic copies are redacted by the composition
root. Output is buffered within a shared stdout/stderr limit of 32 MiB, then
published after process settlement/JSON validation; it is not a progress stream.
JSON input is limited to 32 MiB. The default process deadline is 30 minutes;
`FMCAD_LOCAL_WORKER_TIMEOUT_MS` selects a positive integer up to 86400000 ms.
Invalid limits fail before spawning. On Linux/WSL each child owns a new process
group; timeout, output overflow and leader exit stop that group, not any unrelated
process or Fusion. This adapter does not supervise descendants that deliberately
escape its process group. The private Python supervisor below retains its stronger
ancestry tracking for its own existing internal callers/tests.
It does not install dependencies, retry a worker,
clean partial outputs, enter an SDK slot or read Fusion configuration.

The retained `src/image-*.js` and `src/reference.js` consumers now compose these
services. The shared adapter is staged under `src/dist/python` and installed
under `dist/src/dist/python` before the runtime identity is generated. Asset
locations still come from `resolveRuntimePaths`; interpreter selection and
dependency checks still use `resolvePython` (explicit path → `FMCAD_PYTHON` →
`python3`). An absent interpreter remains absent in the pure plan so it cannot
silently override the environment. Trace detail selects `image-detail`
preflight; ordinary tracing, optimize, boundaries and reference retain their
respective features. Reference runs with `-I -B`, images with `-B`, without a
shell. Invalid outer image input is rejected before interpreter preflight.

Data-import preparation accepts a third `DataImportFiles` argument. Its default
Node adapter owns cwd/path/filesystem reads; tests can supply snapshots with no
real filesystem. Each snapshot binds decoded text and SHA-256 to the same bytes.
The existing 32 MiB source gate, source paths/revisions, inline fingerprints and
missing-model evidence remain unchanged. Data-import native mutation is not
executed by these local planners.

## Verification

```sh
npm run build:code
npm run typecheck:tests
node --test tests/engineering-*.test.js tests/batch-local.test.js tests/data_import.test.js
FMCAD_LOCAL_TEST_PYTHON=/path/to/existing/venv/bin/python node --test tests/local-pipelines.test.js
FMCAD_LOCAL_TEST_PYTHON=/path/to/existing/venv/bin/python node --test tests/local-pipeline-installed.test.js
```

The dedicated suite separately verifies deterministic budgets, injected time
exhaustion, unknown/nonfinite/unit errors, hash compatibility, source snapshots,
zero process starts on invalid planning and actual process-start counts. Its
real-worker test generates a raster and executes trace, bounded optimize,
boundaries inspection and the full reference layout → calibrate → compare
source chain. It also checks actual Python rejection before output creation.
Dependencies must already exist in the selected user-owned Python environment;
the test reports an explicit skip when they are unavailable. Typechecking and
fake process tests are not substitutes for this test.

The installed test packs and installs the actual npm artifact, makes the
installation readonly, then executes all three image consumers and the full
reference chain through the installed CLI from a foreign cwd and clean Unicode
HOME. It selects Python through `FMCAD_PYTHON`, supplies deliberately malformed
Fusion configuration, checks analytic engineering output and confirms that the
runtime fingerprint and installed tree remain unchanged. It additionally executes
the installed Black/Pygments formatter without executing or rewriting the source,
the internal offline callable worker and malformed-input rejection at each image/
reference entrypoint. Its selected Python needs the formatter requirements too.
These are real local
Python processes, not a simulated interpreter or a mocked worker implementation.
Build once before stable runtime/worker tests; do not restage executable bytes
while a test has pinned its runtime identity.

All verification is offline. Image metrics and reference checks do not certify
Fusion geometry, physical fit, metrology or manufacturing quality.

## Private offline supervision and UIAutomation

`assets/offline_execution.py`, `offline_worker.py` and `generated_cleanup.py`
remain internal modules. There is no public arbitrary module/function command,
keychain replacement or recovery workflow. `call_offline` sends one JSON request
to EOF, uses its actual `sys.executable`, rejects nonfinite result JSON and honors
exit status. The old cleanup-byte stdout side channel is not accepted as JSON.
Cleanup metadata remains supervisor-local transport metadata.

Supervision explicitly requires Linux/WSL with `/proc`, not generic POSIX/macOS.
It preserves inherited monotonic deadlines, process-group and start-tick ancestry
ownership, bounded termination, redacted diagnostic files, retained checkpoints
when cleanup is unconfirmed and no replay. Input and combined output are limited
to 128 MiB; the internal `max_output_bytes` argument may lower the output limit.
Output overflow returns status 125, timeout 124 and interruption 130. A zero
offline timeout still means unlimited duration (unlike the image adapter).
Successful diagnostic collection is allowlisted and bound to the original
producer inode; replacing a log/checkpoint cannot transfer ownership. Unknown,
changed, linked and foreign files remain. It is not a filesystem sandbox.

`ui_dialog.ps1` is an installed resource resolved through runtime paths; the Node
caller uses argv with `shell:false` and a base64 JSON request, with a 16 KiB input
gate below Windows' command-line limit. The helper deadline is a positive integer
up to 120000 ms and output remains capped at 256 KiB. UIAutomation is a Windows
host capability, not portable local Python. Stopping a request-owned watcher does
not cancel Fusion or prove the native operation finished; timed-out action outcomes
remain unknown and are never replayed. A read-only status-query timeout continues
to detach rather than stopping the queried process. Host execution still requires
the separately qualified WSL/Windows/Fusion integration; offline tests make no live
UIAutomation or native acceptance claim.

Focused additional verification:

```sh
node --test tests/host-workers.test.js tests/ui.test.js
python3 -B -m unittest discover -s tests -p 'offline*_test.py'
python3 -B -m unittest discover -s tests -p 'host_worker*_test.py'
```
