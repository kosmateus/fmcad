# Python admission boundary

`core/application/python-admission.ts` refuses every checker report except a
complete `passed` result bound to the prepared artifact and exact wire hash.
Rejection is local `not_started` evidence, not a CAD execution result.

`node-adapters/python/admission.ts` closes RPC classification: known protocol,
discovery and native non-Python tools are explicit; unknown tools are refused.
`execute_python` and script `fusion_mcp_execute` are always Python. Literal
sources are inventoried recursively by the existing AST-only preparation port.
An injected checker is an internal application/test port, not a user bypass.

The certificate binds the complete RPC JSON, immutable source-unit inventory,
artifact context/request/maps and final UTF-8 bytes. The real checker report
also binds its strict config, helper, typing, SDK producer and engine. Admission
snapshots all installed typing/definition and engine resource content before
checking and after it. The synchronous final fence repeats content/inventory
verification; replacing a stub, context helper or checker during a pause cannot
reuse the report. Broker build/input/context/reset/ownership fences remain
separate and execute in the same grant/send turn. No checker cache, SDK retry,
second scheduler or late script rewriting is introduced.

The private transports expose `prepareCallTool`, `prepareUiGuardedScript` and
`prepareListTools`. These return one-shot operations with a synchronous `fence`;
preparation does not open an MCP session. The add-in's bridge/guard/entrypoint
transformation precedes the broker's `preparePost`, which binds receipt, RPC and
job identity and checks the resulting exact script. Opening a session is deferred
until execution, after a fresh certificate fence. The physical boundary fences
again in the synchronous grant/send turn and consumes the prepared record once.

`PhasedWorkers.checkSdkRequest` prepares the final transport operation and both
document probes before `readyTurn`. Raw RPC reserves its internal job ID and
checks its final receipt artifact and probes before `state.submit`; the reserved
ID is not a new client-controlled request field. Idempotent duplicate requests
retain the original accepted ID/artifact. Prepared operations are process-local:
an unavailable checked raw request is refused rather than reconstructed/replayed
after restart. Existing unknown execution ownership remains held.

Raw preparation is tracked separately from SDK ownership. Idle release refuses
while it is pending, graceful shutdown waits for it to settle, and acceptance
rechecks stop/reset/build/lock fences after the asynchronous work. A stopping
broker cannot publish a new queued request after releasing its lock. This local
counter does not occupy the SDK slot or prevent other clients from preparing.
Local worker liveness is rechecked between preparation phases so a dead worker
cannot publish a later prepared turn. Terminal jobs' unused local plans are retired
without releasing active or unknown physical ownership.

Administrative and startup calls use the same transport preparation seam. A
failed startup Python check now produces zero physical calls, including zero
`initialize`/`notifications/initialized` calls. The broker retains its existing
lifecycle ownership policy; local rejection evidence is available as
`probeNotSubmitted` for the lifecycle owner to handle.

The receipt writer uses typed JSON boundaries, checked string object keys, typed
native lifecycle callbacks and a narrow Win32 ABI protocol. The raw wrapper
executes in a closure, retaining the original writer/binding after a
nonpersistent host clears its globals. The existing canonical identity and queue
document helpers are typed in place; no second snapshot implementation is used.
SDK lookup nullability omitted by upstream declarations is widened explicitly at
the two guarded native lookup boundaries, not suppressed globally.

Official script entrypoints are checked as callable with the actual string
context. Receipt artifacts additionally identify their embedded entrypoint unit;
the checker verifies that signature rather than treating a dictionary lookup as
proof that any `run` signature is valid. Generated signature declarations are
bound into checker provenance. Checked reports and supplied artifact snapshots
are recursively frozen; source mutation during an asynchronous check cannot
change the artifact it analyzes.

## Original source and namespace binding

Prepared CAD/run/atomic/probe callers pass
`callTool(request, "fusion_mcp_execute", pythonArtifactManifest(artifact))`
through the private worker backend. This is not a public RPC argument or an
execution authorization. The manifest retains source units, their hashes,
context/request and source maps, without duplicating `script` or its byte array.
The transport reconstructs and verifies the original artifact against the actual
input script before adding its guard/entrypoint. The manifest never reaches the
Fusion tool arguments.

The broker binds the original artifact identity into the final receipt artifact,
retains declared embedded units even when no literal `compile` references them,
and remaps explicit contexts by matching filename and source hash. Concatenated
runtime units stay in their real shared namespace. Diagnostic mapping follows
verified original-source segments through transport prefixes and receipt
wrapping; identical text in a separate declared embedded file keeps its own
identity. A helper name alone does not inject globals.

The existing cad-v1 user context declares deferred `FMCAD` and
`entrypoint: "run-if-present"`, matching the runtime's conditional invocation.
An existing module binding must have the right signature. Local function names
and comprehension targets do not invent module entrypoints; unresolved dynamic
entrypoint construction remains incomplete.

Full reports are owner-only `result(jobId).pythonChecks`, ordered by physical RPC
with a local refusal appended when applicable. A refusal also lives in
`execution.pythonCheck`. Public queue status omits these private diagnostics, and
the queue snapshot retains the outcome flags rather than copies of large reports.
CLI emits the same report JSON as `FMCAD_PYTHON_CHECK`; MCP owned-result responses
preserve the list. Public `fmcad/api` result receipts expose that same optional
`pythonChecks` field without modifying application stdout/results or invoking
another checker. Static `passed` never upgrades execution or model validation.

## Bounded inventory transport

The AST helper writes hash-verified source files to its private scratch area and
returns a compact inventory. The source area and helper are outside the analyzed
import root. This avoids echoing multiple JSON-escaped copies of a large wire
script and every embedded source through the diagnostic channel. The original
8 MiB wire / 16 MiB source / 256 unit limits remain, and expanded source files
also have a cumulative 16 MiB bound. Engine output, time and memory limits are
unchanged. Mapped diagnostic output is bounded too; oversized original filenames
cannot inflate a small engine response into an unbounded public report.

Known standalone assembly/geometry compatibility loaders remain inventory units.
For Fusion preparation only, their reviewed source digest and canonical runtime
dependency must match before their filesystem/exec fallback is replaced by an
explicit initialization assertion. All handler implementations remain in the
canonical units and are still analyzed. Unknown/different facade contents reject
preparation; added Python is never silently stripped. Standalone offline assets
remain intact. Registry owner assignments use actual string literals rather than
introducing `Any` through a generated JSON loader.

## Candidate verification and remaining non-claims

On the `impl/python-admission` candidate at `92bfc24` (production runtime
`371f5393`, checker `6bb4518`; local `master@c00b96c` is an ancestor), the
complete 152-unit helper passed the real basedpyright aggregate with 151
origin-map entries, zero diagnostics, and both `raw/run` and
`cad-v1/deferredFacade/run-if-present` contexts. The installed-consumer profile
separately checked an exact packaged `cad-v1` helper with the same 152-unit
origin inventory offline outside the checkout. These checks preserve original
bytes, source hashes/maps, unit order and context; no partial/projected pass,
`Any`, ignore, timeout increase, heap increase or cache was used.

Public queue acceptance and physical transport fences were verified separately:
the exact candidate `document.status` artifact reaches the mocked public broker
once, a controlled type error reaches it zero times, and raw receipt transport
tests cover MCP/add-in positive-once and negative-zero behavior. `document.status`
is the six-unit light profile; it is not misreported as the full helper test.

The first exploratory public `document.save_as` attempt remained `preparing`
without `pythonChecks`; instrumented follow-up showed why: for each of five
bounded checker groups the origin function-body plan was redundantly rescanned
in a Python subprocess (~19 s each). The checker now derives the plan once and
revalidates it against each fresh, hash-bound group inventory. No unit/body
coverage is skipped and no resource limit or timeout was increased.

After that change, one isolated public-library request exercised the full
`document.save_as` operation with the real checker and a local fake transport
(no Fusion/cloud save). The operation's actual source inventory was 151 units /
151 maps and 2,310,193 bytes; it is a generated CAD operation with no additional
user-script unit, distinct from the separate 152-unit installed `cad-v1`
helper profile. The public worker returned terminal `succeeded` with
`executionOutcome=succeeded`; the real certificate was `passed` with zero
diagnostics and its artifact/wire hashes matched the durable main-RPC record.
Exactly one `document.save_as` main send occurred; the other three physical
calls were startup/preflight/postflight read-only probes. Both probe receipts and
the main receipt were terminal, the worker exited `0`, and the local worker
completed in `77.4 s` of the unchanged `180 s` budget. The reported save result
remains `accepted/pending`: this verifies native acceptance handling, **not**
cloud completion or live Fusion behavior.

The candidate remains a source-branch result, not a deployment claim. No live
Fusion/SDK or geometry correctness was tested; no full `npm test`, master merge,
shared staging, push or migration-candidate replacement is implied. Checker
limits, strict rules, resource fingerprints and cache-disabled behavior remain
unchanged.

## Offline verification

```sh
npm run build:code
node --test tests/python-admission.test.js tests/python-admission-transport.test.js
node --test tests/library-api-broker.test.js
node --test tests/python-admission-packaging.test.js
node --test tests/python-checker.test.js tests/python-checker-completeness.test.js
node --test tests/run-identity.test.js tests/queue-cloud-save.test.js
```

Tests exercise real checker errors, generated run/document/legacy/review/probe
sources, immutable artifact/resource fences, explicit non-Python classification,
grant/send adjacency and local-worker scheduling. The installed tarball consumer
runs offline outside checkout with lifecycle scripts disabled and includes one
real complete-helper check. Transport/SDK activity is synthetic. No submitted
source is executed by the checker, and no live Fusion, geometry or physical
correctness is claimed.

The retained `document-status-admission-6bb.json` evidence records a Windows CRLF
working tree. Its four extracted runtime sources (`values`, `fusion-values`,
`identity`, `document_snapshot`) are text-identical to the LF Git checkout; the
injected owner lines, prepared core, and wrapper are unchanged. The typed
`document-status-admission` test helper reconstructs only those historical source
line endings and verifies the original wire hash, artifact hash, byte length,
and all six unit hashes. It does not refresh or weaken the historical fixture.
Admission tests separately check the actual checkout artifact with the real
checker and require its current certificate and single physical send. Mutating a
snapshot expression or target identity fails the historical comparison. This
allows platform checkout spelling without accepting behavioral/source drift.
