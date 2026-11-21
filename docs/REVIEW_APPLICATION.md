# Visual review application workflow

`packages/core/src/application/review` owns the host-independent view plan,
report validation, and review orchestration. It receives a prepared immutable
Python artifact, a broker execution port, an artifact-store port, and a hash
function. The application does not parse CLI arguments, read stdout, access the
filesystem, or import `terminal-kit`.

`packages/node-adapters/src/review` prepares the retained canonical runtime
family (`identity` plus `legacy-review`), maps the existing backend response to
a structured report, and implements exclusive local artifact writes and
readback. Capture still executes once through the injected gateway with
`readOnly: false`; unknown outcomes are not retried. The Fusion camera
readback/refresh/restoration policy and report construction remain in the
canonical Python review adapter. No other Python family is changed.

## Evidence and outcome semantics

The application separately reports transport state, artifact state, and
`cadAcceptance: "not-evaluated"`. A captured result requires the pinned document
identity, all eight expected views in order, verified orientation, restored
camera/display/active-document state, valid PNG headers and dimensions, matching
byte counts and SHA-256 hashes, and successful manifest publication. The report
always retains `requiresVisualReview: true`; neither a successful script nor
complete images establish CAD or physical correctness.

Partial captures and backend reports are retained for inspection. Transport or
readback uncertainty is recorded as unknown; no application branch deletes
evidence or replays capture. Manifest publication failure changes the returned
report to failure even when transport and image verification succeeded.

`src/review.js` remains the CLI adapter: it parses existing flags, maps the
Fusion output path, injects the execution/artifact ports, and formats the final
JSON result. The public API factory/root exports are owned by `sol-api`; this
workflow is available as a typed application module for composition without
depending on the CLI. The legacy `shot` implementation is isolated in
`src/shot.js`. `src/docops.js` owns its dispatch and was intentionally not edited;
the owner must wire that dispatcher to the new module in its final integration.

## Offline verification

```sh
npm run build:code
npm run typecheck:tests
npm run lint
node --test tests/review-application.test.js tests/review.test.js dist/tests/shot.test.js
python3 -B -m unittest discover -s tests -p review_test.py
```

The tests compare the existing report contract fixture and use fake ports/SDK
stubs for capture, restoration, image corruption, identity, and publication
failures. They do not contact Fusion or validate CAD/physical quality.
