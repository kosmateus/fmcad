# Parameter commands and shared contracts

This delivery migrates the five legacy parameter commands out of
`assets/fusion_data_manager.py` into a typed Fusion adapter. Their source builder
now lives in TypeScript. The existing CommonJS entrypoint forwards to the compiled
adapter; removing the remaining compatibility entrypoints is still stage 4.

## Historical behavior

The portable fixture is the exact data-manager source from
`a26222ff617b0e9597b2a91b50474bdca8d0a0ce`, with a recorded SHA-256. Paired tests
execute it and the new adapter against independent model instances. The original
`live-legacy.js` sequence adds `migration_width = 10 mm`, lists it, sets it to
`20 mm` (2 cm internally), renames it and deletes it. Outputs, state, inferred
units, duplicate-add behavior and missing-name errors remain equal.

Two inherited defects change intentionally:

- Duplicate document names, failed activation and an active-document mismatch
  previously allowed a parameter mutation. The adapter now requires one matching
  name, successful activation and the same active creationId. Paired negative
  cases require zero mutations in the new code.
- A true `UserParameter.deleteMe()` result previously produced `DELETED_PARAM`
  even if the parameter remained. The pinned Autodesk reference explicitly
  documents this possible behavior for referenced parameters. The command now
  checks the user-parameter collection before claiming deletion. It never retries
  deletion. Both historical and current tests observe the retained dependency;
  only the false success message changes.

These are reproduced source-level defects predating the migration, not newly
established native failures. No successful historical assertion is weakened.

## Shared scenarios

`--suite parameters` runs four saved-file scenarios: CRUD, unit conversion,
dependent expressions, and rejected changes. They execute the shipped dispatcher
and inspect the resulting parameter collection independently. The model and
Fusion use the same steps and assertions, including the 1e-9 numeric tolerance.
`--suite all` includes them. Native runs require an explicit project/folder.

Each scenario owns its saved fixture and exact document/file identity. Existing
cleanup closes the document, deletes its file, observes absence, and preserves
foreign inventory. Both protocols run with concurrency limits 1, 2 and 10 in the
unit suite; dedicated CI jobs run each protocol through the real broker.

## Model scope

The model supports numeric user-parameter add/read/update/rename/delete, explicit
length and angle units, scalar values, and arithmetic with parameter references.
Dependent values update on read; rejected expressions and name collisions leave
the collection unchanged. Renaming updates references. A retained dependency
deliberately exercises Autodesk's documented true-without-deletion case.

The expression evaluator accepts only bounded arithmetic syntax. It does not
implement text parameters, arbitrary Fusion functions, implicit display units,
model dimensions, feature regeneration or a constraint solver. Unsupported input
raises an explicit error. Exports still contain marked test state, not F3D bytes.

Final native qualification must check expression normalization, rename propagation,
rejected-setter atomicity, unit spelling/tolerances and dependency deletion on the
installed Fusion version. Native tests remain deferred until the refactor ends.

## Verification

The checks include the retained CLI optional-slot tests, paired historical tests,
the production Python checker for all five generated commands, the shared model
scenarios, strict model typing, the pinned API call-shape check and full CI.
The larger refactor remains open; this completes one parameter contract family.
