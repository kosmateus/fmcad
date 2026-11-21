# Typed atomic owner migration runtime

The root compatibility path now loads the compiled TypeScript composition. The
orchestrator retains the existing approval, exact-byte checker qualification,
receipt binding, immutable backup, owner/PID, closed-gate, stop, install, restart
and release checks. JSON/file boundaries have concrete evidence types; core
migration stages and filesystem inventory types are reused. The core owns stage
ordering, while the host narrows its extensible records to qualified runtime
approvals. No missing-process guard is bypassed.

A hash-bound snapshot of the original 330849f runtime supports paired checks of
closed admission, foreign claims, transport receipt ordering/binding, live or
missing worker evidence, qualification rejection before preparation/deployment,
and competing lifecycle preflight fences. These use real isolated filesystem
receipts and controlled process observations, not a claim of native PID handoff.

Validation: strict package/API/runtime-test compilation, normal queue/core staging,
facade export identity and ESLint pass. Four paired runtime tests and thirteen
existing pure migration/crash-resumption tests pass. The first pure-suite run
missed the generated historical loader; the normal stage-queue-runtime --tests
step fixed staging, after which all thirteen passed. Real PID handoff and complete
integrated CI remain separate gates on a host with the required process APIs.

Register dist/tests/queue-atomic-migration-runtime.test.js with the existing atomic
migration offline gate. The native evidence assembler and observation extraction
remain owned by G and F respectively; their public facade paths stay unchanged.
