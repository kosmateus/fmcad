# Missing queue execution evidence

CI run 42675903303 (thread scenarios, owner 5) exposed a terminal queue result
without `execution`. The scenario adapter dereferenced `sdkSettled`, replacing
that original evidence with a TypeError. Both submission and recovery now use
one decoder: exact client/request identities remain mandatory, and absent or
malformed SDK evidence produces an unknown outcome, never a settled success.
The original result is retained in the diagnostic field. A terminal job state
alone does not authorize document cleanup.

The regression covers missing/null/malformed execution records and exact
identity fencing. For both MCP and add-in, a real model command first executes;
its reply is then stripped of execution evidence. Cleanup remains deferred,
recovery with the same incomplete evidence fails without modifying the retained
document, and only lookup of the original settled result permits cleanup. The
command executes once. No timeout retry, assertion waiver, or native geometry
claim is introduced. The separate workflow timeout needs its own budget change.
