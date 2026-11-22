# Offline native successor query fixture

`native-pr4.zip` is an unmodified, narrow `git archive` from
`kosmateus/autodesk-fusion-mcp` commit
`4d99a7f9ce5f54008ea43670d9d6dceb257e4c97`:

```text
git archive --format=zip --prefix=native-pr4/ 4d99a7f9ce5f54008ea43670d9d6dceb257e4c97 \
  lib/admission_json.py lib/request_admission.py lib/physical_authority.py \
  lib/rebaseline_fence.py lib/rebaseline_fence_store.py LICENSE
```

Archive SHA-256:
`b69446aee1152f50ed05b69dc946abb0b45b83e21a101975eb2b3d6a947ca8c8`.
The original license is inside the archive. No SDK module or installed Fusion
package is loaded. `check_query.py` executes the production fragment with real
`AdmissionStore`, current-process guards, native BEGIN/CONSUME and ordinary
handoffs on owned temporary SQLite databases. Mutations are confined to these
fixtures, including explicit corruption tests.

These are offline native-contract tests, not live Fusion evidence.
