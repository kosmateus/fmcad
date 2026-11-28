# References Python runtime

The canonical references family is implemented by the existing
`runtime/python/fmcad/domain/references.py`,
`runtime/python/fmcad/adapters/fusion/references.py`, and
`runtime/python/fmcad/adapters/fusion/reference.py` source units. This work adds
strict annotations and narrow static SDK/JSON boundaries; it does not add a
handler, workflow, capability, or runtime namespace.

## Typing boundaries

- The domain helpers use the shared `JsonObject`/`JsonValue` aliases for public
  edge data. `_sourceDataFile` stays an internal opaque SDK reference and is
  removed by the existing public-edge projection.
- SDK operations use the shared `CadContext` and `_CadItemCollection[T]`
  contracts. Small references-local Protocols describe only the Fusion fields
  this adapter actually reads, including nullable document and reference
  observations; they do not replace the shared context or callback contracts.
- The image handler delegates to the existing `CadHandler` contract. Its
  source-provenance validation and existing image calibration implementation
  remain in their original owners.

## Verification

Offline family tests:

```sh
npm run build:code
python3 -B -m unittest tests.python_document_io_test.RuntimeInventoryTests.test_every_retained_definition_has_exactly_its_previous_count tests.python_document_io_test.RuntimeInventoryTests.test_clean_rules_import_without_sdk_filesystem_or_processes
python3 -B tests/python_references_test.py
python3 -B -m unittest tests.references_native_test tests.reference_native_test tests.reference_images_test
node --test dist/tests/reference.test.js tests/references-refresh.test.js tests/integration/gm05-reference.test.js
node --test tests/typesgeometry/geometry_shapes_inventory_test.cjs
```

The canonical prepared-bundle replay used the real basedpyright 1.40.2 engine,
Python 3.11/Linux strict configuration and verified Autodesk definitions
snapshot `83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179`.
At final family checkpoint `b972eba` (including approved target `0bcbfbc`),
the strict replay artifact contains 121 source units plus one wrapper (122
total) and is 1,764,901 bytes. Its artifact hash is
`47b38f2313b4793ae27f8d199bf1313a9bf36337e82ab7630cea7bfdeb989741`; its wire
hash is `4b7b54462c79f862c08c4c9962c13709c2f2ec7bc82067baa953ebba435e91f5`.

Source-mapped strict diagnostics are zero in the three canonical references
files. The full diagnostic-only replay reports 14,671 errors across the global
bundle. Two `reportAny` diagnostics fall on generated
`CAD_HANDLERS.owner = __import__('json').loads(...)` prefixes for the
`reference` and `references` adapters; these prefixes are emitted by the shared
bundle builder, not by this family's Python source.

The production checker returned `tool_error: Checker process: output limit
exceeded` at its existing 2 MiB output cap. The cap was not raised, and neither
the production checker nor the full bundle is reported as `passed` or accepted
for admission. The complete direct diagnostic report and source map are kept
outside the repository under `/tmp/opencode/types-references-replay/final-20261026/`.

On the final checkpoint, `npm run build:code` passed; the targeted Python
retention, clean-domain-import and references/fake-SDK suites passed (30 tests,
14 skipped); the focused Node references suite passed (38 tests, 7 skipped);
and the full geometry bundle-inventory test passed. Its fixture records the
three changed references source units while retaining all 121 source IDs, the
wrapper, source-map entries, unit order and generated offsets. The shape
inventory artifact is 1,766,883 bytes with hash
`001a23bee23e3a49ab247395e3e8a694110203f9a6765e3b0e008089bf0e7ff5`.

The full `npm run test:python` suite was not rerun for this final target; the
approved assembly target's completed test report is retained separately.

No live Fusion/SDK operation was used; existing fake-SDK suites remain the
runtime behavior checks.
