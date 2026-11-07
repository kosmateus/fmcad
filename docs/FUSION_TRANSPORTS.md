# Broker-private Fusion transports

The physical implementations live in strict TypeScript under
`packages/node-adapters/src/fusion-transport`. They are not exported by the
node-adapters workspace barrel. `broker.ts` is an internal composition entry,
not a public library API. Only the broker composition root selects `mcp` or
`addin`; transport selection is explicit (`node`/`http` or `windows-curl`). There
is no fallback, reconnect replay, mutation retry, redirect following, remote
cancellation, or rollback.

The transitional `src/client.js` and `src/addin-client.js` constructors expose
configuration and invocation metadata only. They have no physical transport;
all network calls reject with `QUEUE_REQUIRED`, including discovery methods.
`initialize`, `ping` and `tools/list` are served locally by the MCP application.
Optional `resources/list` and `resources/templates/list` requests are admitted
through the shared broker. SDK reads, probes, UI operations and raw calls cannot
be sent by the public compatibility facades.

Historical direct observations remain readable by the console, but the public
compatibility facade no longer creates new direct observations. Neither a
telemetry sink nor a worker environment variable grants execution. There is no
public socket agent or `_transportPost` monkeypatch seam.

## Request and response lifecycle

- Construction snapshots configuration and headers. Request options carry the
  session and protocol version without changing the caller's configuration.
  Broker-only `withRequest` uses async-local scope for timeout/header overrides;
  nested scopes inherit unspecified values, cannot widen an outer timeout, and
  concurrent scopes are isolated. Raw callers carry their own protocol version
  rather than inheriting the broker's discovery-session negotiation.
- HTTP and curl use an absolute positive deadline, not an inactivity timeout.
  The default is 180 seconds and the maximum timer value is 2,147,483,647 ms.
  Responses are bounded to 32 MiB by default; a lower positive `maxBuffer` is
  supported. Requests are bounded by the same limit. Curl counts both stdout
  and stderr toward its output limit. An unbounded zero timeout is rejected.
- Deadline, byte overflow, broken socket, abort, or malformed response ends
  local observation. It does not establish that remote execution stopped or
  that a mutation did not happen. Inspect the existing execution receipt rather
  than replaying an uncertain operation. Timers and abort listeners are removed
  on settlement; HTTP sockets are not pooled, and a failed curl child is killed.
- Curl is loopback-only, disables proxy/config-file discovery and passes the
  generated request configuration on stdin, not the command line. Credentials,
  scripts, session identifiers, and endpoint queries are not printed by the
  transport. Native error messages are not copied into transport diagnostics;
  the private `nativeError` value preserves JSON-RPC error details for broker
  processing. Invalid JSON/SSE diagnostics never include response snippets.
- JSON and SSE preserve native result data. SSE supports multiline data and
  ignores comment/notification frames around the response. Session mismatch,
  malformed JSON-RPC correlation, and unsupported protocol negotiation fail
  closed without retry. Initialized-notification failures are not swallowed.
- `isError`, structured content, textual ERROR markers and native receipt data
  retain their result semantics. Add-in execution preserves stdout/stderr,
  bridge result data and the request-bound interactive-command guard. A
  read-only request is **not SDK-enforced read-only** on the add-in backend.

The add-in's unsupported list remains licensing, recent documents, undo, redo
and electronics. Unsupported operations reject before network submission with
an explicit-backend message. The external add-in/main-thread dispatcher is not
included in this npm source migration.

## Offline verification

After `npm run build:code`, run:

```sh
node --test tests/fusion-transport.test.js tests/fusion-transport-broker.test.js tests/addin-client.test.js tests/backend-response.test.js tests/curl-transport.test.js
npm run typecheck:tests
npm run lint
```

Tests use controlled loopback HTTP endpoints on ephemeral ports, synthetic
authentication, fake curl children and an optional installed local curl against
a fake endpoint. They check bounded streaming, aborts, broken connections,
session/protocol mismatches, JSON/SSE mapping, native errors, add-in capability
mapping and absence of retry/fallback. They do not contact Fusion, prove SDK
execution, or validate a physical CAD model.

`fusion-transport-broker.test.js` additionally starts the production broker
factory with each selected backend, isolated state directories, synthetic
authentication and a fake HTTP server. No factory is injected in those tests.
The fake decodes only broker-generated JSON receipt literals; it never executes
the submitted Python. The disconnect cases verify that the existing job stays
unknown and that shutdown refuses to release unresolved ownership. Those cases
run in disposable child processes because retaining the live broker is the
correct behavior, not something the test should bypass.

Legacy CLI formatting/payload tests inject the private adapter explicitly with
the test-only `tests/helpers/legacy-transport.cjs` preload. A worker environment
variable is not physical transport authorization. The legacy fixture is not
distributed in npm and does not replace broker admission tests.
