# Captured geometry preservation baseline

`baseline.json` was captured from `23cc436`, before extraction, using only offline
SDK doubles. It is data, not an alternative handler implementation.

- `statements`: SHA-256 of each original top-level executable AST statement
  (`ast.dump(..., include_attributes=False)`), excluding imports and module
  docstrings. Functions retain their decorators in the hashed AST. The extraction
  test excludes only the newly introduced ownership/initialization markers.
- `handlers` and `handlerOrder`: the original full bundle's public registry set
  and insertion order, from the same minimal SDK stub as `bundle_smoke_test.py`.
- `transcript`: `geometry_runtime_probe.py` run with the original geometry asset
  sources exported from that commit into a temporary directory. Its current mode
  runs the extracted layers against the same doubles. Tokens are omitted from
  normalized DTO comparisons, SDK objects preserve type/name and anonymous handles
  preserve their Python type; separate existing family tests check exact native
  reference/occurrence identity.

The original source may be exported with `git show
23cc436:assets/cad/<family>.py`. Passing the export directory to
`python3 -B tests/geometry_runtime_probe.py <directory>` reproduces the transcript.
The normal regression check needs neither Git nor the original source checkout.

The partial scenario deliberately injects a failure after one recorded effect;
drift injects `DOCUMENT_CHANGED` at identity assertion. Neither is a native Fusion
result or proof of native transaction semantics.

Integration keeps `thread` under the previously merged assembly family. The
historical thread AST hashes remain baseline metadata, but the geometry AST test
checks only its eight owned families. Assembly's own parity tests cover thread;
no second geometry thread implementation is loaded or retained.
