# Capture integrity and selectable review recipes

Visual capture has three separate outcomes: execution/restoration, PNG bytes and
decoded-pixel diagnostics, and CAD acceptance. A successful script, PNG header,
byte count, or SHA-256 alone is not a pixel-quality result or CAD acceptance.
Review continues to require visual inspection and keeps document identity,
Fusion build, requested recipes, camera-vector readback, restoration steps, and
the prepared artifact source map.

## Pixel policy `capture-pixels-v1`

Review reads each owned PNG back from the output store, verifies its PNG
structure, dimensions, byte count, and SHA-256, then decodes its pixels in the
Node adapter. The pure review policy computes an RGBA digest, edge density,
luminance standard deviation, 12-bit color-bin count, and a deterministic 32 ×
32 RGB thumbnail. The canonical Fusion runtime uses the same thresholds for
`review` and PNG `shot.pack` output.

Custom `ReviewRunPorts` must provide `decodePixels` (or their artifact store may
provide the equivalent method). If neither exists, image quality is unknown and
the application fails closed; it never falls back to a PNG header or hash-only
success.

| Threshold                               |            Value | Meaning                                                |
| --------------------------------------- | ---------------: | ------------------------------------------------------ |
| Maximum decoded pixels                  |     `16,000,000` | Larger PNGs are reported as unsupported.               |
| Thumbnail sample size                   |        `32 × 32` | Fixed grid for pairwise similarity diagnostics.        |
| Strong adjacent-pixel edge delta        |       `12 / 255` | Used to count high-contrast horizontal/vertical edges. |
| Color quantization                      | `4 bits/channel` | Distinct bins in the blank-frame check.                |
| Minimum edge-pixel ratio                |        `0.00002` | Lower frames are considered blank.                     |
| Minimum luminance standard deviation    |      `1.5 / 255` | Lower frames are considered blank.                     |
| Minimum distinct 12-bit color bins      |              `3` | Fewer bins are considered blank.                       |
| Near-duplicate mean channel delta       |      `0.5 / 255` | Used only for same-direction frames.                   |
| Near-duplicate samples within delta `4` |          `0.995` | Used only for same-direction frames.                   |
| Similar-view mean channel delta         |        `3 / 255` | Produces a non-failing visual-review diagnostic.       |
| Similar-view samples within delta `8`   |           `0.98` | Produces a non-failing visual-review diagnostic.       |

A blank frame or exact/near-identical frame from the same camera direction fails
pixel integrity, even when its PNG and hash are valid. Very similar projections
from distinct readback directions are reported as `review-required`, not
rejected: symmetric or low-detail geometry can legitimately render similarly.
That warning is not a geometry equivalence proof. PNG encodings may have
different hashes while decoding to identical pixels; the pixel digest detects
that case.

## Optional recipe API

The existing CLI keeps its compatible eight-view recipe. Embedders using
`createReviewServices` can supply `ReviewRequest.recipes` to replace it. Recipes
must have unique safe names; coordinates and orthographic extents are Fusion
centimetres.

```ts
const request = {
  doc: "Synthetic fixture",
  docId: "discovered-creation-id",
  docFileId: null,
  out: "/owned/review-output",
  fusionOut: "C:\\mapped\\review-output",
  width: 1200,
  height: 900,
  requestId: "stable-request-id",
  recipes: [
    { name: "front", kind: "orientation", orientation: "front" },
    {
      name: "interface-roi",
      kind: "roi",
      orientation: "front",
      target: [2, 4, 1],
      extents: [1.5, 1.2],
    },
    {
      name: "interface-detail",
      kind: "detail",
      orientation: "front",
      target: [2, 4, 1],
      scale: 0.2,
    },
    {
      name: "section-left",
      kind: "section",
      orientation: "left",
      sectionName: "Existing section",
      visible: true,
    },
  ],
};
```

ROI/detail target, extents, and actual camera vectors are read back and recorded.
Section recipes only use an already-existing section; unsupported application or
restoration is explicit and prevents a successful review. Custom recipe sets
retain per-view camera readback but are labelled `readback-only` rather than
being asserted against the default orthogonal/isometric basis. Request pins,
document identity, build identity, artifact source mapping, and independent
camera/style/color restoration remain required.

## `shot.pack` presentation results

Each `shot.pack` result includes `pixelIntegrity`, `presentationCapture`,
`presentationRestoration`, and `requiresVisualReview: true`. The legacy
`presentationRestored` field is `true` only after getter readback confirms the
captured state, `false` for an observed restore mismatch, and `null` when the
result is unsupported or unknown. SectionAnalysis no-op setters are checked
after both application and restore; a no-op does not imply the requested
presentation was applied. Non-PNG formats remain capturable, but pixel analysis
is reported as `unsupported`, not silently skipped or passed.

## Offline and native qualification

Offline fixtures cover blank PNGs, exact/near duplicate pixels, distinct but
similar views, malformed chunks, partial captures, readback failures, and
unsupported presentation state. These prove the policy and adapter contracts;
they do not establish Fusion rendering or geometry correctness.

The prepared native orchestrator is
`tests/native/capture-integrity-qualification.js`; its Python fixture,
capture, and exact-ID cleanup helpers are under
`tests/native/capture-integrity-*.py`. Ordinary test discovery never invokes
them. **Do not run without separate explicit authorization to operate Fusion.**
The orchestrator requires the resolved shared configuration to select
`backend=addin` and `routing=queue`, plus the exact authorization string in its
CLI arguments. It writes a private mode-`0600` temporary configuration with
autostart disabled; it never edits shared configuration or asks the CLI to
autostart/reclaim a broker. It first checks broker status, add-in doctor, a fresh
document inventory, and the actual Fusion `app.version` through read-only broker
turns. It records only the inventory count/digest, not names of other documents,
and stops before fixture creation if any preflight is unavailable or the build is
not `2706.1.14`. It then creates new unsaved blank, asymmetric, and symmetric
designs, checking names against the fresh inventory, and pins each target action
to its new creation ID.

Review calls use the installed public pinned `review --doc ... --doc-id ...` CLI
for the deployed default recipe set. The selectable `--recipes` JSON CLI
contract added by this branch is covered offline and is usable after that commit
is integrated and deployed; the native runner does not assume it is present in
an older installed CLI. Native ROI/detail/section recipes use pinned `shot.pack`
calls. Each public Review command and single-turn `shot.pack` capture has its own
short exclusive queue sequence covering target activation, camera/presentation
changes, capture and restoration; the lease is released after that command's
terminal report and never spans the full qualification. The runner's independent
local PNG byte/hash verification and visual inspection happen outside the lease.
This prevents another operator's viewport turn from interleaving with a
capture/restore pair without reserving Fusion for unrelated work.
Cases include blank and same-direction duplicate negatives, a symmetric
front/back legal-similarity positive, partial output files, and
camera/presentation restore.
The runner never restores a pre-test global active document. It only cleans up
exact fresh scratch IDs after settled outcomes, under a short pinned cleanup
sequence. Unsupported section readback remains explicit and is not qualification
success. If an operation or restoration is unknown, it does not replay, release
the lease, or clean up; preserve the fixtures for reconciliation. The report
keeps image paths, hashes, dimensions/pixel diagnostics, source-artifact and
document/build identity for visual inspection. Mock results are not a substitute
for native evidence.

For the single terminal fixture-creation case with a successful creation receipt,
no capture cases, and a failed local pin-report step, `--resume-report PATH`
allows only read-only inventory and exact-pin/geometry inspection of those
already-open owned scratches. It never creates replacement documents. Any other
failure/unknown report is not resumable and retains its current recovery path.

Example invocation (only after separate authorization):

```sh
node tests/native/capture-integrity-qualification.js --run --authorize 'I authorize native capture-integrity qualification'
```

Offline verification:

```sh
npm run build:code
npm run typecheck:tests
node --test tests/review-pixels.test.js tests/review-application.test.js tests/review.test.js
python3 -B -m unittest discover -s tests -p 'capture_integrity_test.py'
python3 -B -m unittest discover -s tests -p 'python_document_io_test.py'
python3 -B -m unittest discover -s tests -p 'review_test.py'
python3 -B -m unittest discover -s tests -p 'presentation_test.py'
```
