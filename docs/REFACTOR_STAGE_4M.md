# Stage 4m: execution time budgets

The Node clock/timer adapters for pause budgets and per-RPC admission are now
strict TypeScript. Pause transitions stay in the existing core policy. The
production deadlines and the distinction between refusing the next RPC and
cancelling a running RPC are unchanged.

Frozen complete sources from the pre-refactor baseline `a26222f` and the previous
head `abbce68` run against the same clock and scheduler fixtures as the typed
adapters. The comparisons cover two pauses, stale callbacks, close while paused,
independent owners, exact-fit RPC admission and refusal of a later call before
transport. They retain the original timeout values, error code and one-send
assertion. Missing timeout configuration without an outer deadline retains its
old return value; configuration validation/defaulting remains the caller's job.
The existing execution-budget test is now compiled TypeScript.

Fourteen budget tests pass, including a real Node timer. These checks do not
explain the previously intermittent native-action observation timeout or claim
that the entire historical broker has been replayed.

The declaration check also found private `@fmcad/core` imports in already migrated
worker declarations. Staging now closes those references for the execution
adapter directory, as it already does for journal adapters. The new external
consumer check fails before the fix and passes with strict declaration checking
afterwards. Both persistence and execution declaration groups are required in CI.

Final native Fusion qualification remains deferred. The real broker/model matrix
and installed runtime tests must pass before merge.
