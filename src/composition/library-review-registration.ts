import type { CommandDescriptor } from "./library-commands";
import type { CommandManual } from "./library-help-manual";
import {
  reviewCmd,
  parseReviewArgs,
  buildReviewScript,
  verifyReport,
  views,
  flags,
} from "./library-review-command";
const descriptor: CommandDescriptor = {
  usage:
    "review --doc <name> (--doc-id <creationId> | --doc-file-id <cloudId>) --out <new-local-directory> [--width N] [--height N] [--recipes <json-array>]",
  desc: "Capture default or selected orientation/ROI/detail/section views with identity and restoration evidence. Requires visual review; never CAD acceptance.",
  example:
    "fmcad review --doc Model --doc-id DISCOVER_CREATION_ID --out ./review-new",
};

const manual: CommandManual = {
  sections: [
    {
      title: "Input Contract",
      text: "No positionals. Required --doc is an exact unique open top-level name; --doc-id (creationId) or --doc-file-id (DataFile.id) pins it, both may be supplied and must match. Duplicate names fail even with an ID. Required --out is a new CLI-local directory with an existing parent; relative paths resolve against cwd before the existing WSL path mapper. Existing directories, files and symlinks are rejected. --width/--height are integer pixels, defaults 1600/1200, each 32..4096 and total <=16,000,000. Optional --recipes is a JSON array of 1..32 unique orientation/ROI/detail/section recipes using the ReviewCaptureRecipe contract. No overwrite flag.",
    },
    {
      title: "Return Contract",
      text: "One JSON result and manifest.json. Success means every requested recipe PNG was captured and state restoration verified. Without --recipes, the default set remains front, back, left, right, top, bottom, iso-top-left and iso-bottom-right. All use orthographic projection; framing and presentation depend on each recipe. documentIdentity includes creationId/fileId/version/isSaved/isModified; fusionBuild, selected recipes, per-view camera, filenames, bytes and SHA256 are recorded. requiresVisualReview=true always. Exit 1 for capture, restoration, transport, identity or readback failures. Partial images and backend-report.json are retained; missing terminal evidence is unknown, never success.",
    },
    {
      title: "Prerequisites And Safety",
      text: "Requires an owned, idle Fusion instance and a uniquely named already-open Design. One backend script invocation; no retry, cloud open, geometry edit or document save. This changes viewport/UI state and is not submitted as readOnly. try/finally restores target and original camera/projection/framing, visual style, component-colour display and original active document with independent error reporting. CLI and Fusion must share the mapped output directory; request.json verifies mapping. Transport timeout does not cancel the backend: inspect durable evidence and current state before further work. Current visibility, sections, selection and graphics determine the image; this does not inspect hidden interiors, generate critical-interface closeups, assess interference or confer CAD/physical acceptance.",
    },
  ],
  examples: [
    {
      label: "Pinned open document",
      argv: [
        "review",
        "--doc",
        "Model",
        "--doc-id",
        "DISCOVER_CREATION_ID",
        "--out",
        "./review-new",
      ],
      requires:
        "Replace Model and DISCOVER_CREATION_ID with the exact open name and discovered creationId. Own Fusion, finish interactive commands, and choose a fresh mapped destination. This example is not run by help.",
      output:
        "manifest.json and eight named PNGs; status captured with requiresVisualReview=true only after capture and restoration succeed.",
    },
  ],
  audit: {
    sources: [
      "src/review.js:parseReviewArgs,buildReviewScript,reviewCmd",
      "packages/core/src/application/review",
      "packages/node-adapters/src/review",
      "runtime/python/fmcad/adapters/fusion/legacy_review.py",
      "runtime/python/fmcad/domain/review.py",
      "assets/review.py (compatibility fixture)",
    ],
    verified: [
      "offline argument and destination validation",
      "single script dispatch and complete durable/terminal report comparison",
      "identity and active-command guards",
      "independent restoration and preserved partial failure outputs using SDK stubs",
      "primary-owned scratch qualification on Fusion2705.1.25: eight images personally inspected, orthogonal/isometric camera vectors verified, target/original viewport and active document restored",
    ],
    tests: [
      "tests/review-application.test.js",
      "tests/review.test.js",
      "tests/review_test.py",
      "tests/shot.test.js",
    ],
    gaps: [],
    bugs: [
      "Live qualification covers Fusion2705.1.25 and the tested mapped filesystem only, not every SDK/build. The viewOrientation getter can return arbitrary after a successful named view; actual camera-vector relationships are checked instead. Current visibility/sections determine the images; capture is not CAD or physical acceptance.",
    ],
  },
};

export {
  reviewCmd,
  parseReviewArgs,
  buildReviewScript,
  verifyReport,
  views,
  flags,
  descriptor,
  manual,
};
