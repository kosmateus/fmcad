# OpenCode plugin

`fmcad` is the optional dual OpenCode plugin. Use `fmcad/api` for the standalone
library; neither CLI nor MCP needs an OpenCode installation.

## Hosts and configuration

**V2 is recommended:** stable `>=2.1.3 <3`. V1 `>=1.18.29 <2` is deprecated,
but remains supported and tested, with **no sunset date**. The manifest's
`engines.opencode` lets V1 reject older hosts before calling the plugin. V1 has
no reliable plugin-context version field: the adapter neither invents one nor
executes an `opencode` binary from `PATH`. V2 checks `ctx.app.version` and the
required context capabilities before registration.

The V2 floor is the tested host contract, not a guess from a newer SDK pin.
The active server reported `2.1.3` via `/api/info`; its actual resolver loads the
generated package entrypoint in the external built-plugin fixture. The adapter
is also strict-typechecked against `@opencode/plugin@2.1.3`. Comparing published
2.1.3/2.1.4 plugin declarations shows the used host surface (`Context`, session
lookup, events, permissions, tool registration and loader) is unchanged. The
client declarations add MCP client-token and debug heap-dump methods in 2.1.4;
neither is used here, so those additions do not make 2.1.4 a minimum host.

For a single configuration shared with V1, retain the supported migration spelling:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["fmcad"],
}
```

V2 normalizes this without rewriting the file. For **new V2-only configurations**,
use the recommended native form instead:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["fmcad"],
}
```

These are alternatives, not simultaneous registrations. There is no manual
adapter-selection option. The root export, `./server` export and `main` identify
the same built ESM object. The actual loaders select `server()` (V1) or `setup()`
(V2); no probing/fallback is involved. Failed V2 setup never invokes V1.
For local configuration, name the **built package directory**, not a `.ts` file.
Do not load both the old personal wrapper and the packaged plugin. Switching a
live installation requires separate authorization; tests never edit user config,
replace the active wrapper or restart OpenCode.

Declarations are pinned to `@opencode-ai/plugin@1.18.29` and
`@opencode/plugin@2.1.3`. Both are optional peers, not unconditional runtime
dependencies. The public root declaration is host-neutral, so importing its
types does not require either inactive SDK. V1 dynamically imports its actual `tool()` helper and needs that
peer. V2 uses the host's context and JSON Schema, with type-only SDK imports:
**V2 needs no runtime V1 SDK**. Only the selected adapter/composition loads.
Standalone consumers need neither peer. TypeScript consumers directly using
host-specific plugin declarations should supply the corresponding SDK types.

## Tools

The packaged tools intentionally use typed API DTOs, **not the personal wrapper's
old `argv` subprocess interface**. `fmcad_help` returns the installed public
catalog locally, optionally filtered by exact `operation`; it never probes Fusion
or starts a broker. Both tools use the calling session's directory and signal,
not the plugin-instance location. V2 reads `session.location.directory`; V1 uses
the declared tool-context `directory`/`worktree`. There is no `process.cwd()` fallback.

Example `fmcad_execute` input:

```json
{
  "action": "execute",
  "requestId": "stable-request-id",
  "invocation": {
    "version": 1,
    "kind": "cad",
    "operation": "document.status",
    "data": {},
    "doc": "Model",
    "docId": "creation-id",
    "docFileId": "file-id",
    "purpose": "Inspect the pinned model before editing"
  },
  "sequence": { "action": "begin", "mode": "automatic" },
  "queueTimeoutMs": 180000
}
```

`invocation` is the public version-1 `CadWorkerInvocation`: `cad`, `cad-command`
or typed `run`, including existing output preferences. Run source paths must be
absolute. Core decoding/catalog validation remain authoritative. Sequence controls
use `begin` without `id`, or `continue`/`end` with `id`; mode is `automatic` or
`exclusive`. `expectedRevision` and `queueTimeoutMs` use public `ExecuteOptions`,
not a private queue-client call. Local/preview operations reject queue controls.

| Other action | Required field | Public API                                        |
| ------------ | -------------- | ------------------------------------------------- |
| `status`     | none           | `query.status()`                                  |
| `result`     | `jobId`        | `query.result()`                                  |
| `request`    | `requestId`    | `query.request()`                                 |
| `cancel`     | `jobId`        | `control({version:1, action:"cancel", jobId})`    |
| `reconcile`  | `jobId`        | `control({version:1, action:"reconcile", jobId})` |

Recover lost acknowledgements with `request` and the same explicit `requestId`;
never resubmit automatically. Accepted receipts and `unknown` states are not
physical success. Explicit cancellation is subject to broker policy, not a promise
of remote cancellation.

Execution requires `fmcad_execute` plus **`shell` on V2** or `bash` on V1.
Permission metadata includes typed input, calling directory and request ID;
resources start with `fmcad execute`, `fmcad result`, etc. Review old argv-specific
permission patterns when adopting this tool contract. Host deny/rejection and
cancellation errors propagate unchanged. `plan`/`explore` can use offline help,
but cannot execute/control jobs.

## Budgets and lifecycle

The root composition resolves standalone fmcad configuration. Plugin options may
supply a `config` override in that same typed shape; core normalization and the
accepted-service compatibility fence still apply. Local service handles are
scoped by session/agent/directory; client identity derives from session+agent.

Execution requires an explicit project directory, not the user's home or filesystem
root. The plugin calls `createFmcad().execute/query/control`, never a CLI subprocess or
shell. SDK/control work explicitly connects through `start()` to an already
compatible broker; the plugin does not autostart/restart/recover shared services.
Local/preview work needs no broker. Configuration `timeoutMs` retains the shared
execution budget; `queueTimeoutMs` separately budgets waiting. A calling-session
abort stops only the local wait, not accepted/unknown physical work. There is no
second scheduler, automatic replay or implicit cancellation.

V2 transforms register captured definitions only: replay never starts services.
Presence, the V2 event subscription and the tool registration are plugin-owned.
Idempotent cleanup aborts/disposes those resources and closes local handles,
without stopping the shared broker, cancelling jobs or waiting for unknown SDK
completion. Presence failures are passive diagnostics, never execution success.

## Optional Control Center

After tool registration, both adapters schedule the root `ensureWeb` hook in a
background microtask. It does not delay setup or tool calls; an ensure failure is
reported as a passive diagnostic and leaves fmcad tools available. The installed
root loads the staged server and browser assets from its resolved installation
root. It does not start or recover the shared Fusion broker.

The current root composition has no approved project read port, registry-backed
principal, or revision feed. Control Center data endpoints therefore remain
explicitly unavailable; there is no demo snapshot or path-backed fallback. The
installed-process contract test verifies service startup and static assets only;
it is not production telemetry, CAD, or physical-model validation.

## Offline verification and upstream evidence

```sh
npm run build:code
npm run typecheck:tests
npm run lint
node --test tests/opencode-adapters.test.js tests/library-api.test.js tests/library-api-broker.test.js
```

Adapter tests install the actual `npm pack` tarball into temporary consumers
outside the repository. V1 runs with its pinned `@opencode-ai/plugin@1.18.29`
runtime peer supplied by the host. V2 runs the tarball's exported plugin entry
with a fake host context and no runtime OpenCode SDK; its adapter uses type-only
SDK imports. Tests cover permissions/deny, caller cwd, unknown receipts, abort
without replay/cancel, transform replay, idempotent cleanup and effect-free root
import. Public API tests type-check declarations without host SDKs and cover
typed broker submission including sequence controls and purpose. No test
contacts Fusion or validates CAD physics.

Inspected contracts (including installed pinned `.d.ts` declarations):

- [V2 plugins](https://opencode.ai/v2/docs/build/plugins)
- [Plugin migration / dual object](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
- [General migration / retained config](https://opencode.ai/v2/docs/migrate-v1)
- [V1 1.18.29 loader / cleanup](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/plugin/index.ts)
- [V1 entrypoint / engine checks](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/plugin/shared.ts)
- [V2 2.1.3 resolver](https://github.com/anomalyco/opencode/blob/v2.1.3/packages/plugin/src/host.ts)
- [V2 2.1.3 module shape / setup selection](https://github.com/anomalyco/opencode/blob/v2.1.3/packages/core/src/plugin/module.ts)
