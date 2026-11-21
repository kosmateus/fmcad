# Pull request reconciliation

## Modeling and file workflows

The first combined candidate starts from main `330849f` and retains the complete
commit ancestry of C (#37, #47, #57, #61, #65, #82, #66) and D (#38, #49, #53,
#54, #55, #59). These are 13 existing PRs, not independent new implementations.
No PR is closed until its commits are included in verified main.

The merged package scripts retain A's admission/epoch/publication tests and add
C's full modeling admission matrix. Drawing and drawing-migration are now also
explicit regression gates, as requested by D.

The failed C/D CI logs identify three integration corrections:

- The BRep fake-backend tests used Windows path conversion without the retained
  fake-WSL fixture. Install and restore that existing fixture in the two affected
  tests; production platform detection, SDK counts and result assertions stay
  unchanged. The first test still needs Linux process evidence unavailable here.
- C moved 19 more Python compatibility assets to canonical source entries. The
  loader test now accounts for all 38 assets, retaining every old prepared-loader
  provenance check and checking complete canonical source bytes and declared
  dependencies for the new entries. Canonical entries no longer pretend their
  source filename is the compatibility asset.
- The exact generated status program changed after modeling/file-policy and
  provenance integration. Update only its SHA allowance, after the historical
  modeling/file tests; request/document/project pins, outcomes, effects and SDK
  call counts have no new allowance.

Local evidence: pinned build, lint, formatting and strict test types pass. The
initial focused run passed 319/320; its sole remaining loader representation
failure is corrected and all 12 loader/artifact tests now pass. The fake BRep
unknown-outcome/no-replay test passes; the production broker test stops at absent
`/proc/<pid>/stat`, so Linux CI remains required without weakening its guards.
Full matrix and installed/admission qualification are required before acceptance.

Other stacks B, E, F and G remain open and retain their previously documented
blockers. Native Fusion qualification is not claimed.
