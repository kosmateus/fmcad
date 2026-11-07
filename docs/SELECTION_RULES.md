# Persistent entity selection rules

The isolated `selection_rules` runtime family adds versioned `define`, `inspect`,
`resolve` and `check` handlers over the existing `entity._entity_query` resolver.
Predicates use the existing entity query filter schema. Rules also store explicit
exclusion filters, expected cardinality, occurrence/component scope, and the exact
project, document and saved source version that owned the definition.

## Handler contract

`selection.rule.define` accepts a `ruleId`, an entity `query` with an explicit
`kind` and `expect`, and optional `exclude` filters:

```json
{
  "ruleId": "outer-cylinder-faces",
  "query": {
    "kind": "face",
    "scope": { "body": { "name": "Housing" } },
    "filters": { "geometry": "cylinder", "radius": "12 mm" },
    "expect": 1
  },
  "exclude": [{ "name": "InspectionOnly" }]
}
```

The resolver enumerates and describes all predicate matches, applies exclusions in
the same entity/scope/frame context, then checks the final count. Definition fails
instead of storing an initially unsatisfied rule. The resulting manifest includes a
rule schema version and revision, owner identity, source version, instance scope,
normalized predicates, expected cardinality, previous references as provenance,
and the resolver identity.

`selection.rule.inspect`, `selection.rule.resolve` and `selection.rule.check` accept
`{"artifact": ...}` using the exact reference returned by `define`. `inspect`
validates the artifact hash, owner and active document identity without enumerating
topology. `resolve` and `check` always rerun the semantic query on
the active native topology; they do not resolve previous references to choose a
target. Previous tokens are inspected only to report a native split or merge and
are never repaired or substituted. Statuses are `resolved`, `split`, `merge`,
`missing`, `stale` and `ambiguous`. A changed saved source version is stale, and any
non-resolved status fails `check` without advancing the manifest baseline.

## Artifact ownership and persistence

The Python handlers return a manifest and do not perform filesystem I/O. The Node
coordinator stores immutable manifest envelopes through the shared core
`ArtifactStore` port, implemented by `createArtifactStore` in the Node adapters.
`createSelectionRuleArtifactClient` validates the rule schema and binds the
reference to its manifest. Artifact references bind
the project, Fusion document file/creation IDs and SHA-256; reads check the request
context, envelope, owner and hash before returning a manifest. Store the returned
artifact reference between calls and pass the loaded manifest to the next handler
invocation. Persist an updated manifest only after a resolved result; failed or
changed-topology results intentionally return the prior baseline unchanged.

The `withSelectionRules` hook is applied by the canonical default Python bundle
after geometry, BRep baseline, regional geometry and section-witness modules. The
shared catalog projects the four public operations into CLI routes and MCP tools;
both use the ordinary typed catalog invocation and CAD worker/fake-broker path.
The `FMCAD.selection_rule_*` Python helpers operate on inline manifests inside an
already running helper script. They do not have an `ArtifactStore` port and do not
persist artifacts; use CLI/MCP operations for durable ownership and provenance.
Private Fusion handler turns are coordinator-authorized and excluded from public
CLI/MCP discovery.

## Verification boundary

`tests/selection_rules_test.py` exercises the actual retained entity query against
offline SDK doubles for enumeration reorder, repeated identical occurrences,
explicit instance scope, exclusions, split, merge, deletion, ambiguity, source
version drift and project/document ownership. `tests/selection-rules-store.test.js`
checks manifest persistence across client instances, request/document ownership,
hash validation and prepared bundle registration. `tests/selection-rules-e2e.test.js`
checks typed CLI/MCP execution through a fake broker and project `.cad/artifacts`
store, including owner/hash rejection. These are mock-backed contract checks, not
proof of Fusion-native token lineage or geometry behavior.

`tests/fixtures/selection-rules-native.json` is a prepared native acceptance plan,
not an executed or batch-runnable fixture. It requires explicit authorization and
a disposable synthetic document. No live Fusion run or restore was performed for
this change; native qualification and restore remain the only blocked acceptance
criteria.
