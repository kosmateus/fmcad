# Integrated offline acceptance checkpoint

The integrated source checkpoint `68e59c3f21fa473b954240db965252b0a377be20`
contains the A–F candidates and G integration controls. It is not an accepted
release: registration, compilation and successful execution are distinct evidence.

## Previously unregistered tests

The static audit found 529 test sources: 331 registered and 198 without a complete
recognized CI execution path. Of those gaps, 153 are offline root/contract suites.
Their fixtures use local processes, fake transports, temporary files, the real
Python checker, or installed tarballs. The `live-broker` and
`live-sketch-operations` names describe contracts under test, not native execution.

`offline-regressions.yml` assigns these 153 sources to 16 explicit, disjoint
selections of at most ten files. Each runs serially under Node 22.13.0 and 24.x,
after a pinned build, Python prerequisites and offline npm cache preparation.
No existing assertion, internal timeout, checker or process-identity guard changes.
The initial 35-minute job budget is a bounded provisioning budget, not a measured
performance claim; retained logs must establish actual duration before tightening
or repartitioning. A failure requires diagnosis, not removal from a shard.

This makes 484 sources statically reachable and leaves 45 native/mixed sources.
Those remaining sources need assertion-level reconciliation with B's scenario
inventory. Their offline assertions must eventually execute independently; running
a file whose native cases skip does not establish complete coverage. The remaining
ledger is explicit debt, not an acceptance waiver.

## Expanded broker scenario failure evidence

Run `42658579977`, MCP rectangles at concurrency 10, retained ten owner reports.
Every owner failed request 5, the first `cad-v1` helper `shape.box` operation, with
`LOCAL_PHASE_TIMEOUT`. Each failed execution reports `sdkSettled: true`,
`mayHaveMutated: false`, and no completed Python checks; all cleanup completed.
The request timeout was 180 seconds. Submitted-to-finished elapsed time includes
queue waiting and must not be presented as active checker time. This evidence
locates the failure before physical mutation; it does not establish a geometry
regression or justify changing the expected solid. Measure helper preparation and
checker stages before choosing a timeout or resource-policy change.

## Remaining acceptance gates

- Execute every offline selection on both supported Node versions; retain failures,
  timing, and installed-package evidence for the exact integrated commit.
- Complete the remaining native/mixed assertion dispositions and ensure shared
  scenarios use identical steps and assertions in modeled and native modes.
- Reconcile the archived task ledger individually in private. Published aggregate
  counts alone do not establish current task completion.
- Finish owner-approved boundary migration and facade retirement. A loader still
  used by installed consumers cannot be deleted merely to reduce file counts.
- Run clean and incremental builds, external tarball consumer contracts, public
  declarations, browser evidence and final comparative performance measurements.
- Prepare final native MCP/addin runs at concurrency 1/2/10 with owned documents,
  file cleanup and recovery records. Native Fusion results remain **NOT RUN**.

The registration checker unit tests pass (9 tests). This checkpoint does not claim
that the newly registered test executions, native qualification, archived-task
reconciliation or entire refactor have passed.

## Further retained evidence

The MCP revisions concurrency-1 artifact from the same run records six completely
passed owners (19 requests and complete cleanup each), then the seventh owner
interrupted during request 12 and cleanup observation when the external 24-minute
command deadline terminated the process. Three owners had not started. This is
insufficient suite time, not six failed native assertions. The command budget is
now 40 minutes with a 46-minute job budget, based on the retained sequential
throughput and cleanup margin. All ten owners and both protocols remain required.

The thread recipe family is registered for both protocols at concurrency 1/2/10
and ten owners. Its implementation is supplied by B's `ad7c51a`; it validates
analytic thread recipes and unchanged owned-solid state, not a simulated thread
geometry kernel.

Private archive reconciliation has an individual disposition for all 150 records:
104 retain their historical closure without claiming current revalidation; every
one of the remaining 46 has an owner, current candidate evidence or precise gap,
and a distinction between refactor acceptance, native qualification, host-specific
follow-up, duplicate scope and additional product capability. No private records,
identifiers, relationships or archived history are included in this repository.
The inventory still requires completing owned TypeScript source migration,
installed-consumer facade retirement, and current measurements.

The two public launchers now have strict TypeScript sources and compiler-produced
compatibility paths. Existing launcher parity and incremental staging tests pass
on Node 22.13.0 and Node 24 (three tests on each); the pinned build and lint pass.
This bounded migration does not claim retirement of the other source facades.
