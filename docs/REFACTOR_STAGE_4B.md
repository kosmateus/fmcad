# Stage 4b: private native action adapters

Reference refresh and externalization SDK calls now live in the typed Node
adapter. Their successful request bytes, read-only classification, bounded RPC
timeouts and restoration behavior match the frozen pre-migration implementation
at `5292078`. Existing public CAD dispatch still composes these adapters.

The original `a26222f` and pre-migration implementations accepted the first
`FMCAD_RESULT` marker even when another result followed, and accepted null/array/
scalar values where the internal protocol requires an object. Malformed JSON
raised an unclassified parsing error after the SDK call. Paired tests reproduce
these inherited gaps in both retained versions.

The adapter now requires exactly one JSON object result. A malformed, ambiguous
or non-object response remains an unknown outcome; it must not certify completion
or permit another mutation. Errors preserve their original evidence where
possible; primitive/frozen exceptions gain an error wrapper with the cause and
unknown flag. No call is retried, and temporary timeout changes are restored on
success, failure and a proven pre-submit UI block. Budget-exhausted requests remain
unsent. None of these checks establish native geometry or cloud completion.

The nested externalization test had a separate migration defect in its test wire
parser: it recognized only untyped assignments with JSON-load expressions.
The unchanged test also failed against `5292078`. It now uses the existing safe
Python AST config reader and recognizes typed assignment headers. Its expected
UI block, pinned saved version, request-bound lease and zero native command/finalize
assertions are unchanged.

Validation: 95 action, reference and externalization tests passed, including
historical response comparisons, exact current script parity, physical call counts
and timeout restoration. These suites are included in the regression CI gate.
Native qualification remains deferred; the CAD coordinator, reference workflows
and other JavaScript services still require migration.
