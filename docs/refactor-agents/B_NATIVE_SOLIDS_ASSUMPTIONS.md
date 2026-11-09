# Native profile, sector and torus obligations

The shared `native-solids-*` sequence retains the rib, web, annular-sector,
arc-strip and O-ring requests, body counts, measurements and tolerances from
`tests/live-shape-native-solids.js`. It uses an owned saved fixture and the same
runner/receipts/cleanup as other shared families. The historical source stays
intact. Its old unsaved-fixture assertions remain separate unmigrated lifecycle
obligations; moving normal geometry onto a saved file does not satisfy them.

The model deliberately lacks `native-profile-sector-torus`. Selecting this suite
on either model transport produces required `unsupported` failures before any
SDK work or fixture creation. These negative tests establish capability refusal,
not geometry correctness. The native backend advertises the API capability as a
qualification prerequisite, not proof that the native run will pass. The family
is selected explicitly and is not silently added to the supported model `all`.

## Historical annular-sector expectation conflict

The retained request is inner radius 10 mm, outer radius 20 mm, start 0 degrees,
sweep 120 degrees and height 5 mm. The historical bounds expectation is
`[30, 20 * sin(120 degrees), 5]`, with 0.001 mm tolerance. The production recipe
in `runtime/python/fmcad/adapters/fusion/geometry_shapes.py`, function
`_shapes_annular_segment`, constructs concentric arcs and radial caps in XY.
The declared outer arc includes 90 degrees, where Y is 20 mm; minimum Y is zero.
For that declared sector the analytical Y span is therefore 20 mm, whereas the
historical expectation is approximately 17.320508 mm (the endpoint Y value).

This is an analytical inconsistency, not an observed native Fusion result. The
migration preserves the historical assertion and marks qualification blocked;
it does not change it to fit a simulator, manufacture passing output, or silently
lower tolerance. C/G must review the recipe/reference behavior and authorize a
separately evidenced expectation correction before this family can qualify.
No native execution is requested while the offline refactor remains incomplete.

Other native obligations include closed profile selection, successful native
BRep construction, actual solidness, bounds and physical volume, plus retained
receipt/cleanup behavior after a native error. Model JSON archives cannot prove
these kernel behaviors or genuine F3D format validity. The explicit saved folder,
matching offline-qualified build, both transports and required concurrency matrix
remain prerequisites for the later native qualification run.
