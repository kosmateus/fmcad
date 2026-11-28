# E: retained native transport diagnostics

The three retained diagnostic runners now have typed factories on the existing
`ScenarioSession` and `QueueScenarioBackend`: backend adapter soak, OpenCode MCP
stdio, and physical RPC recovery. They are exclusive, read-only scenarios with
no owned model creation. Default owner count remains 10. The coordinator retains
complete before/after inventory checks; all real SDK calls still use the one
broker queue. Native qualification is **NOT RUN**.

`assertion-dispositions-native-transports.json` accounts individually for the 70
frozen sites (40/12/18). It preserves their exact observations and tolerances.
The adapter factory keeps all 450 markers, one actual session, Unicode/stderr,
expected Python exception followed by success, bridge cardinality, and four
unsupported operations without fallback. Stdio uses the actual installed entry,
initialization/tool discovery, original queue receipt and native marker.

The existing `live-broker.createBackend` gains a bounded registered-request hook
for these read-only diagnostics. It persists each original intent before queue
admission and converts only the actual original result through `queueExecution`.
The existing owned-child bypass refusal remains. Registered command mode is
rejected; owned commands continue through the existing CLI journal. Read-only
intent never fabricates `mayHaveMutated:false`.

RPC recovery is a separate **absent global broker lock** profile. Preparation
refuses an existing lock and creates exactly one private broker using the real
add-in transport. It discards one physical reply only after real completion,
requires `RESULT_UNAVAILABLE`, exactly one physical call and peer continuation
within the retained 10000 ms bound. Admission acknowledgement loss uses only the
original request lookup, never a submit retry. The second real client is an
existing session peer, durably linked before registration; unknown peer work
holds the parent. `closeOwned` invokes only the created broker handle, whose
existing close refusal retains uncertain work and ownership.

Source-only checks: all four factory/support modules passed narrow strict
TypeScript and ESLint. Offline safety tests cover pure/unsupported planning,
original-intent-before-admission through the real private adapter, foreign
owner/request rejection, missing settlement, lost reply/no replay, conservative
mutation evidence, and refusing an existing user broker. Their actual execution
and final CI are pending; source registration is not execution evidence.

Native evidence still required for the exact final installed candidate: build
and protocol fingerprints; private raw stdin/stdout/RPC evidence; child identity
for stdio; original owner/request/job and SDK settlement for every operation;
450 exact adapter markers; both fault receipts and bounded peer continuation;
complete unchanged document/active inventory; final broker state or explicit
retained deferred recovery. Shared simulations do not qualify these transports.
