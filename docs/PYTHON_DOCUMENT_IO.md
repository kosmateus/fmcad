# Document, evidence and I/O runtime

The family-owned canonical inventory is
`packages/node-adapters/src/python/document-io-manifest.ts`. Its 33
families cover the retained document/identity/snapshot/reference/externalization,
data import, I/O, measurement/checking/interference/containment/DFM,
appearance/attributes/presentation/animation/explode, atomic/entity and industrial
families, plus the legacy review/export/inspect/upload/queue-document scripts.
It does not add operations or capabilities.

## Boundaries

- `runtime/python/fmcad/domain/` contains DTO validation, comparisons, predicates,
  vector/matrix calculations, analytic geometry and PNG-byte construction. These
  modules import without `adsk`, filesystem or subprocess access. Native style
  properties, collections, UnitsManager, health enums and entity resolution stay
  in the Fusion adapters, not behind a misleading "pure" facade.
- `application/document.py` performs one explicit copy request over
  `ports/document.py`. Its adapter owns the destination folder and native
  document; only request/identity/result DTOs cross the application boundary.
  Request validation and target-observation/completion policy are domain rules.
- `application/checking.py` owns predicate evaluation, checklist dependencies,
  evidence completeness and delivery orchestration. Measurement/operation
  dispatch and document-identity reporting are injected callbacks. Declared
  evidence paths are not treated as verified files or CAD acceptance.
- `adapters/fusion/` owns all SDK handles and effects. Existing filesystem and
  encoder calls remain in effect adapters, including temporary concat files and
  encoder failures. No native or FS operation moved into the clean layers.

The prepared Fusion artifact retains the existing shared cad-v1 namespace; the
manifest supplies pure rule/use-case dependencies before a family's adapter.
These modules are source units, not a new in-Fusion package loader or executor.
Source maps retain their actual runtime filenames. Handler ownership remains the
family ID; rule/use-case units do not register duplicate handlers.

## Canonical bundle integration

`documentIoCadManifest(base)` in the Python Node adapter replaces
each owned compatibility source with its canonical runtime units. Dependencies
from the base manifest are preserved. `cadBundleManifest` composes this catalog
after the existing assembly and geometry units. The real default bundler counts
`compatibilityPath` when validating the retained `assets/cad` inventory, while
reading/executing only replacement units. A runtime adapter's `owner` property
prefixes its prepared source with the original family ID, not a rule-unit ID.
Assembly/geometry initialization and their checked handler transfers are not
rewritten. The narrow document-status profile retains just core/value units,
identity and snapshot; it does not load modeling, checking or document writes.

The former runtime JSON manifest is now a frozen parity fixture at
`tests/fixtures/python-document-io-manifest.json`. Preparation needs no JSON
catalog lookup or repository preload; one root-independent TypeScript catalog
supplies all paths/dependencies. Tests compare the complete inventory against
the frozen fixture and exercise the actual default prepared bundle.

The retained `assets/cad` and legacy scripts are standalone compatibility
fixtures during this transition, like the retained `core.py` value helpers.
They must not be concatenated alongside the replacements. The complete-registry
test checks both handler keys and ownership against these retained sources, not
just representative operations.

Legacy inspect/upload/export builders in `src/ops.js` and the pinned review
builder in `src/review.js` already read canonical runtime units through the
family manifest and the existing installation runtime-path resolver. Literal
argument injection and artifact hashing remain unchanged. No worker, `core.py`,
`helpers.py`, `src/python.js`, CAD/run
entrypoint or another agent's geometry/assembly sources are edited here.

### Broker probe consumer contract

`packages/node-adapters/src/python/document-probe.ts` exports:

```ts
queueDocumentSnapshotUnits(runtimeRoot: string): readonly SourceInput[];
queueDocumentSnapshotSource(runtimeRoot: string): string;
```

Both exports are available from the Node-adapter package barrel and the staged
`src/dist/python/document-probe` module. The input is the existing runtime-path
resolver's `runtime` directory, **not** its assets directory. The units contain
canonical identity helpers followed by the canonical queue-document adapter,
with actual runtime filenames; they are self-contained and must be prepended
once. The string function joins exactly those source units for the existing
string-based probe builder.

The existing wrapper still owns process/instance probing, selector JSON
injection, the `_qd_capture(app, selector)` invocation and insertion of its
unchanged result under `documentState`. Receipt binding and final artifact
preparation/hash verification must happen **after** composition. This adapter
only reads local source; it never calls Fusion or admits/saves/retries anything.

The active execution owner must replace its two asset reads
(`assets/cad/identity.py` and `assets/queue_document.py`) with these units/source,
removing the old identity prefix rather than concatenating both copies. This
task deliberately does not edit `queue-instance`, queue workers or execution
composition. Their existing standalone assets remain usable until that wiring;
the real CAD bundle already reads only canonical runtime units. Fake probe tests
verify unscoped, metadata-only and unavailable outcomes, and the retained
queue-document suite verifies full identity/fingerprint behavior on runtime.

## Preserved safety and limits

Identity/file/version guards, provenance, ownership and partial result fields
remain intact. A false SDK return is not promoted to success. An accepted copy
with stale/wrong identity or incomplete publication remains pending; post-save
readback errors retain acceptance separately. A pre-save failure or an exception
after entry is not silently retried. Explicit existing lifecycle operations
remain explicit; there is no new automatic save/close/reopen/rollback/retry.

`simulation.capabilities` remains metadata-only: discovering the preview module
does not grant entitlement or add a solver. Cloud reference operations still
need Fusion, network and account permissions; extracting rules does not make
them offline. Sampled motion/clearance and analytic DFM evidence do not become
continuous collision proof, simulation or physical CAD validation.

## Offline verification

```sh
npm run build:code
node --test tests/python-document-io.test.js tests/python-artifact.test.js tests/review.test.js
python3 -B -m unittest discover -s tests -p python_document_io_test.py
python3 -B -m unittest discover -s tests -p '*_test.py'
```

The family Python test checks every retained top-level definition, unchanged
ASTs except explicitly extracted document/checking orchestration, complete
registry/ownership, clean imports, and save effect/failure ordering. It also
reruns 478 existing fake tests while substituting canonical family runtime
sources for compatibility files. The JS test executes the **default** full strict
bundle from outside the checkout with `open`, `Path.read_text` and `Path.is_file`
denied, without preloading any family. It checks exact registry order, ownership,
source maps, stale delivery rejection, simulation capability limits and legacy
builders. Assembly and geometry parity/no-filesystem suites also use this same
canonical bundle.
These tests do not run live Fusion or certify model/physical correctness.
