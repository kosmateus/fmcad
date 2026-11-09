# Standalone local MCP server

Run the installed **`fmcad-mcp`** executable. It terminates newline-delimited
JSON-RPC locally; it is not a proxy to the OpenCode `fusion`/`fusion_addin` server
aliases. Both aliases, when retained by a host, refer to this same application
and one physical backend selected by standalone fmcad configuration.

`initialize`, `ping`, `tools/list`, `fmcad_help` and local/preview CAD calls work
without OpenCode, configuration discovery, a broker, Fusion or network access.
The server advertises only `tools`; upstream SDK schemas are not its native
capabilities. Unsupported prompts, resource reads and subscriptions return
method-not-found locally. Notifications produce no reply and cannot execute tools.
Request ID `0` is a normal request, not a notification.

## Structured execution and help

Use objects, not command strings:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "fmcad_execute",
    "arguments": {
      "operation": "entity.list",
      "data": {},
      "context": {
        "projectDirectory": "/absolute/path/to/project-a",
        "doc": "Model",
        "docId": "creation-id",
        "docFileId": "file-id",
        "purpose": "Inspect the target part"
      }
    },
    "_meta": { "fmcad": { "requestId": "stable-client-request-id" } }
  }
}
```

`context.projectDirectory` selects the local project directory used for owned
results; it is separate from the Fusion `projectId`. Alternatively, select it
once with `--project-directory PATH` or `FMCAD_PROJECT_DIRECTORY`. MCP roots may
be supplied as `params._meta.fmcad.roots: [{"uri":"file:///absolute/path"}]`;
roots are hints only. Each URI must resolve to an existing local directory, an
explicit project must be inside supplied roots, and multiple roots require an
explicit project. The server never substitutes its working or installation
directory.

`context` also accepts the catalog's document pins, component/project scope, purpose
and preview. `data` must match the selected installed operation's schema and
specialist validator. Unknown keys, operations, invalid pins and conflicting
purpose/description reject before submission. Optional `_meta.fmcad.description`
is the per-operation purpose; a process-level `--purpose` does not substitute for
the purposes of later calls.

Call `fmcad_help` with `{"operation":"entity.list"}` for the installed contract,
or `{}` for the installed public catalog. The `fmcad_cad_*` tools remain aliases
projected from that same catalog; their existing `data`/pin envelope is unchanged.
Internal primitives are not published. New capabilities are advertised only when
implemented and registered, not inferred from a Fusion SDK inventory.

The strict TypeScript protocol adapter is `src/entrypoints/mcp.ts`. The
stdio composition root is `src/entrypoints/mcp-stdio.ts`; framing and the
output boundary are `src/entrypoints/mcp-framing.ts` and
`src/entrypoints/mcp-stdio-transport.ts`. `src/mcp-stdio.js` is a compatibility
launcher to that emitted runtime, while the retained queue/transport adapters
are isolated in `src/mcp-stdio-compat.js`. `bin/fmcad-mcp.js` launches the same
emitted TypeScript runtime; neither launcher loads source TypeScript. Resource
budgets and artifact contracts are documented in
[MCP_STDIO_FRAMING.md](MCP_STDIO_FRAMING.md). The build stages the protocol
alongside the same public `fmcad/api` consumed by CLI and other adapters.
Execution never invokes a shell or CLI parser.

## Broker, receipts and compatibility

Native CAD execution uses `createFmcad` with a typed invocation. Local/preview
execution invokes the shared application service directly; SDK execution connects
to an **already running compatible broker**, then submits once. A missing broker
reports `FMCAD_BROKER_UNAVAILABLE`. There is no automatic direct fallback, implicit
broker start, backend switching, recovery or resubmission. CLI and MCP reach the
same validation, prepared Python/typechecker, document guards and phased worker.

The adapter observes for a bounded one-second completion window. A terminal result
is returned as MCP content and structured content. Otherwise it returns the owned
receipt, job ID and an instruction to poll `fmcad_queue_result`. An accepted,
running or uncertain receipt is **not** successful CAD execution. Observation
failure preserves the known request/job ID and never cancels or replays SDK work.
Disconnection drains local requests; it does not stop the shared broker or Fusion.

`--client` or `FMCAD_CLIENT` selects a stable owner identity; otherwise MCP uses a
stable per-user owner ID. The owner credentials are created and read from the same
private `client-credentials` store used by the broker. `clientInfo` is display
metadata only; process `instanceId` and presence are separate from owner
credentials. A stable owner-scoped session and request ID bind the project,
document pins, purpose and revision into the queued job. An owner-private,
mode-`0600` request-context record is stored beside credentials before submission;
it contains no broker token. Responses carry validated context and typed request
status.

`fmcad_queue_begin/end/status/result/request/reconcile` retain their queue service adapters.
`fmcad_queue_request` resolves an existing request ID to its owned job and result,
including after process restart. It is read-only; a missing job in a broker snapshot
is uncertain and never authorizes resubmission. `result` and `reconcile` enforce
broker ownership, so another client cannot read or reconcile a foreign job.
Lease calls and catalog calls with `_meta.fmcad.sequence` or `expectedRevision`
use the existing broker adapter, including typed worker payloads, exact policy
projection, revision validation and owned-artifact reads. Local operations cannot
take a queue lease. Large outputs are read only through hash/size/job/project-bound
owned artifact references, never caller-advertised paths.

The following **deprecated physical-backend compatibility adapters** are explicit,
separate from native catalog capabilities:

- `execute_python`: nonempty `code`, `persistent:false`, no shared session.
- `fusion_mcp_execute`: `featureType:script|document` and `object`; script source
  stays in `object.script`.
- `fusion_mcp_read`, `fetch_api_documentation`, `fetch_design_guide`,
  `capture_viewport`, `get_viewport`: JSON argument objects retain their physical
  backend meaning. Backend-specific argument validation remains with that backend.

These requests preserve their wire argument shapes and pass through the broker's
isolation, supported-completion, source preparation/checking and ownership policy.
Persistent API object references, unsupported background operations and arbitrary
unregistered raw tool names are rejected, never proxied to another server or
retried through a direct transport. A physical backend can still reject a supported
compatibility name; discovery is not proof that it is available or authorized.

## Optional resource catalogs

Explicit `resources/list` and `resources/templates/list` use one broker-admitted
raw RPC each, preserving the request/session and the backend's cursor, resource
records and error response. They require the same validated project context as
other broker work; the MCP process does not open a physical discovery session.

Only a matching JSON-RPC `-32601` response to `resources/templates/list` becomes
`{"resourceTemplates":[]}`. Authentication/authorization errors, transport errors,
malformed replies and mismatched IDs remain failures. `resources/list` errors are
not normalized. No resources/read capability is advertised; reads fail closed
locally and never fall through to direct SDK access.

## Offline verification

```sh
npm run build:code
npm run typecheck:tests
npm run lint
npx eslint src/entrypoints/mcp.ts
node --test tests/mcp-application.test.js dist/tests/mcp-client-context.test.js dist/tests/mcp-installed-package.test.js tests/mcp-catalog.test.js tests/mcp-stdio.test.js tests/mcp-stdio-queue-lifecycle.test.js tests/catalog-worker.test.js tests/library-api.test.js tests/library-api-broker.test.js
```

The process tests execute the entrypoint from an actual npm tarball outside the
repository without OpenCode, test poisoned configuration absence, notifications,
invalid input, ID `0`, local CLI/MCP parity and concrete missing-broker failure.
A production broker/worker with a fake physical backend verifies stable owner
recovery after lost acknowledgement and process restart, two-project isolation,
duplicate request IDs, foreign result/reconcile denial, pause during an active
turn, and one SDK dispatch per distinct request. Framing and optional-resource
regressions retain negative auth/ID/read checks. These are offline checks, not live
Fusion or physical model validation.
