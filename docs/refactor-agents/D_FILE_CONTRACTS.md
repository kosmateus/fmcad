# File workflow contract and qualification map

This map completes the D-owned source/behavior handoff. Historical live assertion
coverage remains tracked in [B's audit](B_ASSERTION_AUDIT.md) and the
[live inventory](../REFACTOR_LIVE_INVENTORY.md). It is not a claim that every live
assertion has an executable simulator scenario or that Fusion qualification ran.
Keychain is intentionally excluded.

| Workflow | Preserved contract and failure boundary | Executable evidence | Remaining native evidence |
| --- | --- | --- | --- |
| Import plans and catalog/placement/replacement | Read/hash one source snapshot; explicit owner/revision/content identity; refuse foreign or edited geometry; never silently replace dependent occurrences; retain original occurrences when replacement import fails | `data_import.test.ts`, `data_import_test.py` through the migrated composition suite; archived baseline/predecessor sources under `fixtures/file-workflows` | Real import geometry, native entity lifetime and physical-child world poses |
| Save/copy/publication | One save request; acceptance is not publication; exact project/folder/new file identity; incomplete or unavailable readback remains pending; receipt-only follow-up and no mutation replay | `document_save_test.py`, `document_save_publication_test.py`, `python_document_io_test.py`, document publication service tests | Cloud completion, actual version advancement, exact cold reopen after native save |
| Reference refresh | Immutable graph/version plan; preserve/latest policy; exact source pins; unknown update never permits a second update/save/close; saved receipt survives reopen | `references-refresh.test.ts`, `references_native_test.py`, `python_references_test.py` | Actual derived/external reference updates, event completion and exposed parameter linkage |
| Externalization | Explicit destination/ownership; bounded exact source pins; extraction-group endpoint context; original evidence retained on response loss; independent cleanup; no automatic replay | `externalization.test.ts`, `externalization_native_test.py`, `externalization_planning_test.py` | Native copies, replacement dependencies, derived assembly history and actual driver propagation |
| Export/import/roundtrip | Supported extension/options; false SDK return and missing output fail; partial import cleanup closes only operation-owned document; independent restoration attempts preserve primary failure | `io_test.py`, `manual_io_test.py`, `python_document_io_test.py` | Genuine F3D/STEP/STL/IGES/SAT/SMT/PNG contents and roundtrip geometry, not mere file existence |
| Drawing/package publication | Exact scene/report bytes and hashes; staged publication; missing/malformed/foreign artifacts distinguished; no cleanup of a replacement inode; preserve primary plus cleanup error | `drawing.test.ts`, `drawing-migration.test.ts`, `drawing_test.py` | Native drawing/rendering and image correctness |

## Python boundaries

Pure import plans, ownership and metadata rules; camera/visibility DTO validation;
externalization source/endpoint/budget decisions; reference graph projection; and
document-copy result decisions now reside in domain/application modules. The
composition test imports those modules without SDK/filesystem/process access and
compares retained function bodies where semantics are unchanged. SDK adapters
retain native reads/mutations, document lifecycle and cleanup because those steps
need the actual Fusion state. Moving those effectful steps into another file
without a new behavioral boundary is not additional qualification.

The final audit found a migration-specific gap: the aggregate suite selected a
nonexistent import test name, so it never executed the actual import SDK-double
suite against canonical runtime code. Restoring that coverage exposed strict
metadata validation rejecting the writer's own fields and caller request
pollution by execution deadlines. The original 18 import tests pass against
retained compatibility code; their original expectations are also required of
the migrated implementation. No expected result is relaxed.

## Shared-backend handoff

A backend-neutral save/copy scenario should use `document.save_as` with explicit
project/folder pins and then inspect the same owned document. The exact result
rule is `document_copy_result`: a new file identity matching project, folder and
name is observed; completion additionally requires acceptance, a clean document
and `isComplete is True`. Accepted-but-processing, unchanged identity and missing
readback remain pending. Cleanup must use the owned exact identity, never title.

Import/reference/export scenarios must preserve the contracts in the table.
A model backend may store marked model JSON to test identity/version and failure
paths, but that data cannot satisfy assertions about native format, geometry,
physical properties or rendering. The shared scenario registry must retain those
assertions as native obligations rather than silently dropping them.

## Canonical host composition

Import and drawing declarations, local/native routing decisions, workflow wiring,
and reference catalog configuration now reside in strict `library-*` composition
modules. The existing public JavaScript paths delegate to these implementations.
They remain compatibility entrypoints while installed consumers use them; there
is no duplicate behavioral implementation to retire. Paired descriptor/manual
and routing tests compare the retained pre-refactor and immediate-predecessor
fixtures in addition to the existing full result, source-pin and failure tests.

`python-document-io.test.ts` executes the assembled canonical Python in a separate
process, forbids filesystem fallback, verifies handler ownership/order and source
maps, and checks failed document readback. `data_import-fixtures.ts` owns the
synthetic native fixture generator; its small JavaScript launcher preserves the
historical command and module paths. The existing import suite verifies emitted
files and refuses overwriting a prior fixture directory. None of these tests
connects to Fusion or claims native-format qualification.

## Remaining release gates

- Exact-head strict generated Python admission for affected families and all
  262 C modeling programs; complete combined CI on supported Node versions.
- Broker receipt recognition and shared-scenario coverage reconciliation,
  including primitive validation rejection before native mutation.
- Real Fusion execution for the native obligations above. Offline green checks
  cannot close these obligations or demonstrate kernel equivalence.
