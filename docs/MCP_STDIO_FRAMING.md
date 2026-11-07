# MCP stdio framing and resource limits

`src/entrypoints/mcp-framing.ts` owns strict JSON-RPC and JSON/SSE parsing;
`src/entrypoints/mcp-stdio-transport.ts` owns bounded byte-stream decoding,
stdout writes and the adapter to the existing owned-result store. `npm run
build:code` stages both modules with the other compiled MCP entrypoints.

## Limits and framing

- An input JSONL frame is limited to **1 MiB of UTF-8 payload bytes** (the LF
  delimiter is not counted). UTF-8 decoding is fatal rather than replacement-
  based. An over-limit frame is discarded through its next LF and rejected
  before it reaches the application.
- The default in-flight/pending request limit is **4**. The stdio pump pauses
  input while waiting for a slot and resumes as completed requests release one.
  Queue helper concurrency is selected by the caller; `fmcad_queue_begin` is
  deliberately ordered with other protocol requests.
- Every stdout frame, including its terminating LF and any duplicated MCP
  `content`/`structuredContent`, must be **strictly smaller than 8 MiB**. The
  2 MiB margin remains below the host's 10 MiB frame ceiling. Oversized results
  are never truncated. The writer serializes one frame at a time and waits for
  `drain` whenever `stdout.write()` returns `false`.

For an oversized `tools/call`, the small response reports
`structuredContent.status: "EXTERNALIZED"`, `complete: true`, the original HTTP
status, and the complete `OwnedResultReference`; the original `isError` value is
retained. An oversized `tools/list` reports the same descriptor in
`result._meta.fmcad` with `listComplete: false`, so its empty inline list cannot
be mistaken for the complete catalog. The artifact is the
existing owned `rpc-result.json` format (`{ "status", "raw" }`), written using
the existing `responsePath`, atomic `durable`, and verified `describeOwnedResult`
descriptor. A local response receives a generated owner ID in the selected
project store, or the existing runtime-owned result area when no project was
selected. Queue results reuse their existing artifact when available; an
application-generated wrapper can be written exclusively under its accepted
job ID. Existing artifacts are never overwritten. No filesystem path is
returned to the MCP peer.

## Lifecycle and diagnostics

EOF stops new input and waits for already accepted work. EPIPE closes input,
does not cancel accepted work and does not retry an upstream request. One
stateful forwarder retains the negotiated protocol/session; it never performs a
second `initialize`. Invalid upstream IDs fail closed without forwarding their
payloads.

Diagnostics are allowlisted metadata only: a salted request-ID hash, validated
method/tool labels, byte counts and a bounded error code. Each line is capped at
2 KiB; both the protocol forwarder and the transport cap their own records at
20 (at most 40 combined per process). Request arguments, Python, credentials
and full responses are not diagnostic fields; stdout remains MCP JSONL only.

The stdio launcher uses these modules for each process. The queue adapter passes
through existing job-bound `rpc-result.json` references when present; generated
MCP wrappers are written exclusively using the same owner and existing result
store. EOF/EPIPE lifecycle waits for accepted requests before disposing local
resources.

`tests/mcp-framing.test.js` exercises the byte decoder, JSON/SSE parsing,
slow-reader/drain behavior, pending limits, EOF/EPIPE, reconnection/no-retry,
large tool lists/results/queue helpers/images, structured-content duplication,
bad upstream IDs and owned-artifact retrieval with fake streams and payloads.
Process and installed-package tests cover the actual stdio launcher and a fake
broker/worker. These tests do not bypass SDK admission or contact Fusion.
