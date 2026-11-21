# GM01/GM02 offline extraction and local CLI parity

Five definition expand/inspect cases and six catalog/placement ledger cases are extracted into strict TypeScript suites. CI runs these eleven cases without Fusion or skips. The retained integration entrypoints import the same emitted suites, so the local steps and assertions have one implementation. Four GM01 and three GM02 document-bound cases remain pending real Fusion qualification; no native behavior is inferred from these checks.

## Historical comparison

The reference is pre-TypeScript commit `a26222ff617b0e9597b2a91b50474bdca8d0a0ce`. Running its original CLI, source/assets and the original two integration suites produced eleven offline passes and seven native skips. Running those unchanged suites against the candidate before this fix produced eight offline passes, three failures and seven native skips. All three failures were catalog ledger cases G02-03, G02-05 and G02-09: the CLI emitted a successful computation with unresolved evidence but returned exit 1 before the helper could evaluate the original assertions.

At the reference, `src/cli.js` returned failure for `success:false`, `status:failed`, or unknown outcomes of batch reconciliation/finalization. The refactored generic receipt exit policy additionally treated every `status:unknown` as failure. A later test expectation of exit 1 in `tests/data_import.test.ts` came from the clean-source import rather than historical behavior. It is restored to exit 0 for the completed local computation; `status:unknown`, `mutation:false`, missing evidence and `modelValidated:false` assertions remain unchanged.

The fix applies only to local `catalog.check` and `placement.check` results with matching operation, `success:true`, no document identity, no mutation and no model validation. Failed/blocked results, uncertain execution outcomes, document operations and broker execution do not use this exception. Regression checks explicitly reject those cases, while the existing unknown-receipt CLI tests retain their failure expectations. Exit 0 means that the requested ledger computation completed; it does not certify a Fusion model or fill missing mass/model evidence.

## Validation scope

The eleven extracted CLI cases pass with their original semantic/numeric assertions. Two additional outcome tests cover the narrow boundary and refusal cases. The historical/native suites remain available; their seven skipped native cases are not counted as acceptance. Final integrated CI and owned native qualification are still required.
