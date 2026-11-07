# Stage 3f: unambiguous component selection

The archived `a26222f` component command returns the first component matching a
name, with the root component taking precedence. Current migrated code retained
that behavior. Paired model tests show it creates a child under an arbitrary
parent when names collide. This is an inherited defect, not a migration regression.

Lookup now rejects more than one distinct matching component before creation.
Root-name collisions follow the same rule. A unique existing name still reports
`EXISTS`; an ambiguous existing name cannot certify which component was found and
now raises an error without `DONE`. These changed expectations follow the command's
named-target contract, not the observed implementation's collection order.

The saved component-tree scenario creates duplicate names through the SDK, then
checks the same rejection, unchanged tree and unchanged timeline in both backend
modes. Setup also asserts that the SDK retained the duplicate names. A native
build that enforces unique names will fail that precondition explicitly; it will
not silently skip or weaken the assertion. Final native qualification must confirm
component naming and handle equality. No modeled capability is expanded here.
