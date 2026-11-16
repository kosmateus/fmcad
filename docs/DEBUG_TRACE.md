# Queued request debug trace

Set `FMCAD_DEBUG_TRACE=1` on a queued CLI or MCP caller to emit a correlated,
redacted JSONL trace through the caller, broker, worker, and observable Fusion
response boundary. The caller prints the trace ID to stderr. Read the combined
events from all retained local process logs with one command:

```sh
FMCAD_DEBUG_TRACE=1 fmcad run <command> ...
fmcad debug trace <trace-id>
```

The trace records stage, timestamps, correlation IDs, safe response keys,
lengths and hashes, and references to retained response artifacts. It never
copies response text or Python source into the debug log. `stdoutObservation`
is `observed_empty`, `observed_nonempty`, or `not_observed`; absence of evidence
does not imply empty output. A native dispatch/response event identifies only
the boundary observed by this process, not activity hidden inside the Fusion
host.

Tracing uses the existing bounded, redacted diagnostic retention. It is off by
default. Trace context is internal queue metadata and is not serialized into
the MCP or Fusion/Python payload. It does not change receipt semantics or queue
outcomes when diagnostic writes fail. Traces are local and expire with
diagnostic retention; the trace reader does not inspect Fusion documents or
queue payloads.
