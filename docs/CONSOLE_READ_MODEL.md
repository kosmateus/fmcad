# Console read model (transitional terminal facade)

`packages/core/src/application/console-*` implements the shared, strict TypeScript
read model. It imports no terminal, Node APIs, processes, filesystem or Fusion SDK.
The existing terminal renderer and its navigation are intentionally retained, not
redesigned or rewritten. This is not the web panel or a new admission service.

## Application policies

- `ConsoleReadStore` pins mode/project, copies snapshots, retains active/unknown
  operations and bounds completed history/logs. Direct completion remains transport
  history, not CAD validation. Explicit `null`, `false` and `0` survive projection.
- `consoleSource` and `selectConsoleRows` project agents, select scope, search,
  filter and sort; terminal navigation owns focus, freeze and stable selection.
  History never invents live process presence. Direct heartbeat freshness uses the
  existing observation policy (future timestamps are unknown).
- `correlate`, `matchesTask` and `eventsFor` require nonempty identities. A conflicting
  task ID cannot join through a shared request ID. Archive/tail copies are deduped
  by source/offset/content even when the tail cursor's epoch changes.
- `projectContains` requires canonical paths supplied by an adapter and enforces
  a path-component boundary. Response selection independently checks the retained
  job and canonical project before opening old stdout/RPC/stderr files.
- `sourceHashMismatch` distinguishes unknown, match and mismatch; comparing the
  current source never establishes what executed. `console-source.js` delegates
  hash comparison and bounded reads to the shared modules while retaining the
  runtime path resolver and common Python formatter preflight. Its terminal
  display is not imported by the model or response reader.
- `controlIntent` accepts only an explicit available authoritative observation,
  carrying instance/generation/request fences. The terminal control adapter reads
  `control-status` immediately before mutation even if the displayed view is frozen.
  A failed/unknown mutation reads status, never replays the intent.

## Node adapters and ports

`packages/node-adapters/src/console` contains passive persisted snapshot readers,
bounded tail/archive/response readers and the host/broker metrics collector. Pure
policies, redaction, legacy command metadata and presence readers are supplied by
the root compatibility composition. There is no global registry, broker startup,
SDK probe or admission mutation in these readers.

`ConsoleReadPort` exposes `ReadObservation<T>`: `available`, `stale` (retaining
the last observations), `missing` or `error`. `createAdapter().read()` preserves the
legacy snapshot shape for TUI; `createAdapter().observation.read()` exposes the
explicit status contract. Freshness is bounded and future/undated observations are
stale. This never turns missing measurements into zero or authorizes control.

`ConsoleMetricsPort<T>` is an explicit passive port. Host/panel/broker measurements
are independent of Fusion connectivity. First CPU/network samples are null, rates
require matching counter identities and monotonic elapsed time, and broker metrics
check PID/birth before and after ancillary reads. Unsupported measurements and lock
ownership remain unknown, not measured zero or proof of no lock.

Existing read budgets remain: 256 direct sessions, 128 MiB broker snapshot,
256 KiB/2000 rows for the usual log tail with seven hourly archives, and 4 MiB/24
hourly files/200 matches for task archives. Tail API callers are capped at 4 MiB and
20000 rows. Response state is bounded to 64 MiB and each output to 1 MiB.
`readBounded` refuses symlinks/nonregular files and reports a source changed during
read as stale. Retention gaps/errors remain visible; old logs/results do not depend
on an online broker. Source formatting and its subprocess remain at the Node edge.

## Verification

`npm run build:code`, `npm run lint`, `npm run typecheck:tests`, and
`node --test tests/console-*.test.js` run offline. Dedicated `console-read-model`
tests import only pure modules and exercise data without files/terminal/SDK;
`console-read-port` and `console-metrics-port` use injected in-memory observations.
Bounded reader tests use temporary local fixtures. Existing terminal tests preserve
presentation, navigation, archives, response and pause behavior. None is Fusion
execution or physical CAD validation. Web integration is deferred to
`fmcad-hex-integration` and its dependent tasks.
