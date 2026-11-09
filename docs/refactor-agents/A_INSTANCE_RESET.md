# Physical instance and reset migration

## Instance ownership and receipt preparation

`src/queue-instance.js` is now a compatibility facade over a strict typed Node
adapter. The facade retains its original installation anchor and injects the
canonical platform resolver. The adapter reuses the existing durable-record and
Python-artifact implementations; no persistence or preparation path is duplicated.
Linux PID/birth checks, Windows FILETIME observation, recovery ownership claims,
probe timeout restoration, single-use dispatch and receipt bytes are unchanged.

A hash-checked predecessor fixture (`6db319b`) is compared against the migrated
adapter in `queue-native-receipt.test.js`. It verifies complete prepared artifacts
for official and non-official receipt wrappers; native workflow classification,
including nested textual envelopes and cloud save processing; and probe deferred
execution, one-shot consumption and timeout restoration. This test needs no real
`/proc` identity or Fusion process. Physical process and native receipt execution
remain covered by existing Linux/Windows qualification gates.

## Forced Fusion reset and interrupted recovery

`src/fusion-reset.js` now wires the public API to a strict typed adapter. Typed
ports describe queue submission/control, exact process observations, durable
reset markers and persisted queue state. Lazy broker/autostart loading is retained
to avoid changing the existing initialization graph. Document classification,
PowerShell bytes, generation-bound pause ownership, stale recovery, read-only
queue smoke verification and primary/restoration error retention are unchanged.

The hash-checked `bab4c10` predecessor fixture is compared in
`fusion-reset.test.js`: force parsing; saved/foreign/owned document decisions;
complete fixture-closure Python bytes; process-inspection command/options and
malformed observations; unowned-pause observation without resume authority; and
an injected pause CAS loss that preserves the original exception and grants no
pause receipt. Strict TypeScript, ESLint, formatting and paired tests pass.
The existing suite has ten passing tests locally; two physical broker tests need
Linux `/proc`, absent in this execution environment, and remain required in CI.
