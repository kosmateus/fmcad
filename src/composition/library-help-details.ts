import type { RegisteredCommand } from "./library-commands";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const batchExample = load("../../help-batch-example.json") as unknown;
const nativeDrive = load("../../catalog/native-drive") as {
  validates(operation: string): boolean;
};

// Contextual guidance supplements catalog fields without expanding the command listing.
export function contextualHelp(entry: RegisteredCommand): string {
  const sections: string[] = [];
  const operation = entry.target!;
  if (entry.kind === "cad" && entry.requiresDoc !== false) {
    sections.push(`CLI input and output:
  --data '<JSON object>' or --file <local JSON file> supplies the payload; neither is needed for empty inputs.
  Direct --kebab-case flags may add fields; a field supplied by both --data/--file and a direct flag is rejected.
  Repeated direct CAD input flags keep their last value. Duplicate members inside JSON text follow JSON.parse last-value semantics; they are not separately detected.
  Direct values are JSON-decoded when possible: --confirm true is boolean; --entities '[{"token":"..."}]' is an array.
  Quote dimensional strings, for example --distance '10 mm'. Payload booleans are true/false, not strings.
  --doc is required even for offline validation. Live CAD lookup uses an EXACT case-sensitive open-document name.
  --project-id <exact project ID> optionally disambiguates saved documents; --doc does NOT accept file IDs.
  --doc-id <creationId> and --doc-file-id <cloud fileId> optionally assert identity on that unique named target before live execution.
  IDs are exact opaque values, not selectors; duplicate/empty/whitespace-containing guards are rejected. A file pin rejects unsaved targets.
  Without pins, legacy name lookup cannot detect replacement by a same-name document. Names are not persistent identity.
  Do not use a save destination project as --project-id for an unsaved source. See docs/DOCUMENT_IDENTITY.md.
  --component <exact component name or occurrence name/full path> selects scope; default root.
  CLI --component is a string, NOT JSON-decoded. For object refs use supported payload fields or a batch step's component.
  --input-component supplies a payload component field, when listed above; it is distinct from CLI scope.
  Output is JSON by default; --json makes it compact, not more detailed. Executed non-batch CAD envelopes contain success, operation, document, result and created; offline previews have a different schema.
  ${(load("../../sketch") as { validates(operation: string): boolean }).validates(operation) ? "--preview checks GM06 nested input shapes, expression-string syntax and supported variants. It does NOT evaluate Fusion expressions, resolve selectors or establish solver feasibility." : nativeDrive.validates(operation) ? "--preview also checks the bounded driver/follower shape, finite math, increments and confirmation. It does NOT resolve native refs, read joints/transforms, move the driver or qualify solver/coupling behavior." : "--preview checks only the outer payload object, known keys and unconditional required-key presence. It does NOT validate nested schemas/types, conditional requirements, units or supported mode values."}
  It neither resolves entities nor runs handlers/the kernel. Batch preview adds step/ref/parameter checks, not nested operation validation. It is NOT a Fusion geometry preview.`);
    if (
      operation.startsWith("batch.") ||
      operation === "definition.instantiate"
    ) {
      sections.push(`Step schema:
  operations is a nonempty ordered array. Leaf steps accept id, operation, data, component, onExisting.
  formatVersion:1 additionally supports scoped use/repeat/forEach nodes, named inputs and exported outputs. See docs/DEFINITIONS.md and definition expand.
  id: unique letters/digits/underscore/hyphen; __proto__, prototype and constructor are reserved.
  operation: catalog operation ID, e.g. model.extrude, NOT its CLI alias extrude or a command string.
  data: JSON object using that operation's Inputs/Required fields; mode-dependent requirements still apply at runtime.
  Only outer data keys and unconditional required fields are checked offline; unknown nested geometry/constraint fields and invalid nested types can still receive success:true.
  component: optional name/ref or {"$ref":"part.result.component"}; overrides the outer scope for THIS step only.
  Explicit component:null resets that step to root. Offline validation does not otherwise type-check a resolved component; live scope resolution can still fail.
  Omitting component inherits the original CLI scope, NOT the preceding step's scope.
  onExisting: error (default) or reuse. This controls report replay, NOT reuse of similarly named Fusion entities.
  Definition use and bounded loop nodes compile to ordinary leaves. Nested batch operation calls, legacy commands, node-only leaf operations and batchAllowed:false operations are rejected.
  document.save_as must be invoked separately, never as a modeling step.

Result references:
  A sole-key object {"$ref":"stepId.result.field"} replaces a WHOLE value from an earlier successful step's output envelope.
  Examples: {"$ref":"section.result.sketch"}, {"$ref":"rim.result.refs.rim"}, {"$ref":"base.result.bodies.0"}.
  Array indices use dotted numeric segments, not [0]. {"$ref":"base.result.feature"} selects the feature, not its body.
  Paths start at the step output, not the report's steps array. Each segment uses letters/digits/_/-; reserved prototype keys are forbidden.
  Only earlier steps are allowed; no self/future refs or cycles. Offline checks do NOT verify output fields or array bounds.
  References resolve recursively in step data and component just before execution. Missing paths stop the run before that step starts.
  Strings such as "base.result.bodies.0" or "prefix $ref" remain literal strings; no interpolation or JSONPath.

Parameter substitution:
  parameters is an optional JSON object. {"$param":"diameter"} must be a sole-key object with a nonempty key name.
  Substitution clones the entire parameter value recursively within operations (including per-step component), before reference validation.
  It does not substitute runId/reportPath, object keys or substrings. Unknown parameters and remaining $param markers are errors.
  No JavaScript/Python evaluation or arbitrary planning. Version-1 repeat/forEach are bounded JSON expansion. A substituted "2 * wall" stays a string for the CAD handler to evaluate.
  These are definition literals, NOT Fusion user parameters. Use param.apply and driving dimensions to retain model equations.`);
      sections.push(`Atomic mode (batch validate/preview/run):
  The optional boolean atomic field defaults to true: omitted OR atomic:true selects atomic execution; ONLY explicit atomic:false selects non-atomic per-step execution.
  Invalid types (string "false", numbers, arrays, objects) are validation errors, never coerced. JSON: {"atomic": false} or {"atomic": true}; direct CLI flag --atomic true|false.
  batch validate and batch preview report the effective atomic mode plus the atomic capability (addin only) without mutating the model or contacting a backend.
  batch run atomic executes every step inside ONE native no-input Fusion command: all mutations share one timeline transaction (one Undo entry). On error the command sets executeFailed to request an abort.
  Atomic execution is supported only on the addin backend (atomicBatch capability). The official mcp backend and local/node-only or save/export/document-lifecycle steps are rejected before any mutation with a specific reason; no silent fallback to non-atomic.
  An atomic report distinguishes committed/aborted/rejected/unknown and carries terminationReason, rollbackVerified (distinct from the abort request: only true after a post-destroy model measurement) and errorStep/original error.
  Steps that executed before an abort are reported as rolled_back, not durably applied. An unknown outcome (e.g. timeout after send) is never auto-replayed; a client timeout does not cancel the Fusion command.
  Explicit atomic:false preserves the legacy per-step semantics and marks the report non-atomic with no transactional protection. Historical reports without atomic are read as non-atomic, never attributed atomicity.
  Full method documentation (outcomes, terminationReason, rollbackVerified, backend matrix, fault-injection gate): docs/BATCH_ATOMIC.md.

Modes and reports:
  batch validate and batch preview force their named mode, return expanded operations with $ref still symbolic, and never contact Fusion or write reports.
  batch run forces run unless --preview is supplied. definition instantiate accepts mode validate|preview|run (default run).
  batch run --summary prints concise TEXT status/runId/reportPath and step id/status/error. --json takes precedence and retains the full unchanged JSON report.
  --summary is a formatting-only boolean accepted only by batch run; it never enters execution context, requestHash, snapshots or reference outputs.
  batch summary --report-path DIR [--step N] [--json] reads historical outcomes locally without a document/config/backend. N is 1-based. It does not replay or validate the current model.
  After a timeout or unknown outcome, batch reconcile --report-path DIR [--data '{"operations":[...]}'] inspects the receipt and matching live holder read-only (never opens/activates a document); observed outputs are not acceptance. batch finalize --report-path DIR completes only the owned command's cleanup after observed destroy + idle + exact identity, and never steals another writer's lock. An unresolved outcome stays unknown.
  For definition instantiate, invalid explicit mode values (including null/false/0/empty string) are rejected before backend initialization.
  --preview overrides every execution mode. All modes require runId using letters/digits/_/- and operations.
  reportPath is a DIRECTORY on the CLI machine, relative to the working directory; default .fmcad-batch/<runId>.
  Run creates this directory, immutable 00000000.json etc. snapshots, and an exclusive run.lock. This is not a Fusion export path.
  Steps report pending/running/success/failed/unknown/skipped, resolved request and actual output when available.
  Failed output stops execution; exceptions/timeouts are unknown. Remaining steps are skipped. mutationStatus distinguishes none/not_started/completed/unknown/rolled_back.
  No rollback, resume or automatic retry in non-atomic mode. A failed call may have partially mutated the model, even without returned created refs.
  Inspect Fusion AND the last snapshot before deciding on a new run. Stale locks/unrecognized or incomplete reports require operator inspection; do not blindly delete them.
  Exact successful replay requires onExisting:reuse on EVERY step in the ORIGINAL request and the same request/context hash (non-atomic runs; the effective atomic mode is part of the identity).
  mode/reportPath are excluded from the request hash; full context including supplied docId/docFileId pins is included. Changing parameters, steps, onExisting or atomic is not exact replay.
  Replay returns saved outputs with replayed:true without executing CAD; it does not inspect current model state or match existing entities by name.
  Replay is offline historical evidence even with pins: it cannot detect replacement or validate current document identity. Use local filesystems, not network report stores.`);
      sections.push(`Worked JSON payload (use with --data or a local --file):
${JSON.stringify(batchExample, null, 2)}
  Offline: fmcad batch validate --doc Model --file batch.json
  Offline expansion: fmcad batch preview --doc Model --file batch.json
  Execute explicitly: fmcad batch run --doc Model --file batch.json
  Definition equivalent: fmcad definition instantiate --doc Model --file batch.json --preview
  Model must be open before execution, with no existing HelpBracket component. Reports must be new or an exact successful replay.
  The single circle gives one profile, so index is intentionally omitted. Diameter is driving; center position is still underconstrained.
  This example demonstrates wiring, not a fully constrained production part or verified live geometry.`);
    } else {
      if (
        /^(entity|selection|sketch|path|model|pattern|shape|datum|component|occurrence|joint|assembly|feature|visibility|appearance|material|measure|export)\./.test(
          operation,
        ) ||
        ["check", "change.preview", "parameter.test"].includes(operation)
      ) {
        sections.push(`Entity references and scope:
  Use an exact unique name/alias or an actual returned ref such as {"token":"TOKEN_FROM_RESULT","kind":"body","component":"Part"}.
  Tokens are opaque, authoritative over display names, and may go stale or split after topology edits; ambiguity is an error.
  Reference objects may carry component and occurrence refs; preserve returned context rather than stripping it.
  Native component definitions are shared by all instances. An occurrence context yields proxies, not an independent copy.
  Many modeling mutations require native geometry in the selected component and reject proxies; see this command's Limits.
  Discover refs with entity list/find/inspect; sketch inspect returns curves, points and profiles. No guessed tokens or implicit first-match selection.
  Full reference/alias help: fmcad help entity inspect; fmcad help entity alias.`);
      }
      if (
        /^(sketch|path|model|pattern|shape|datum|measure)\./.test(operation) ||
        ["check", "parameter.test"].includes(operation)
      ) {
        sections.push(`Units and coordinates:
  Dimensioned inputs require strings with explicit units or dimensional parameter references: "10 mm", "-5 mm", "wall", "30 deg".
  Bare numbers, "10" and dimensionless expressions cannot implicitly acquire length/angle units. Counts and direction vectors have their own numeric rules above.
  Points normally use three length expressions, including "0 mm" for zero. Sketch coordinates are sketch-local, not world coordinates.
  Raw core geometry reports use cm/rad (area cm^2, volume cm^3); read each result's units/space, not the document display units.
  Expression evaluation alone does not imply a persistent parameter relationship; each command specifies what remains driving.`);
      }
      if (
        /^(sketch\.(inspect|check)|model\.(extrude|revolve|sweep|loft|split)|shape\.(revolved_profile|slot|rib|web|route|helix))$/.test(
          operation,
        ) ||
        operation === "entity.inspect"
      ) {
        sections.push(`Profile selection:
  {"kind":"profile","sketch":"Section","index":0} selects an explicitly inspected zero-based profile.
  Omit index only when the sketch has exactly one profile. Alternatively loopCount selects a UNIQUE positive loop count, e.g. 2 for an annulus.
  index and loopCount are mutually exclusive. Neither index nor loop count is a topology-stability guarantee; re-inspect after edits.
  Example discovery: fmcad sketch inspect --doc Model --sketch Section. Use its profiles[].ref, not a sketch as an implicit profile.`);
      }
      if (operation.startsWith("sketch.")) {
        sections.push(`Sketch workflow:
  sketch create makes an empty sketch; sketch geometry initializes shapes. Coordinates, radius and sweep are evaluated once, not retained equations.
  Add sketch constrain relationships and sketch dimension driving expressions for persistent design intent; fixed geometry is not parameter-driven.
  sketch geometry returns result.entities and result.refs.<suppliedName>; rectangles return four refs under the label.
  Labels are response keys, NOT persistent aliases or later bare-name curve selectors. Retain returned refs or explicitly call entity alias.
  Endpoint syntax: {"entity":{"token":"CURVE_TOKEN_FROM_RESULT"},"point":"start"}; end/center require a curve exposing that point.
  "rim.center" is NOT a general sketch endpoint reference (local selector strings are supported within generated shape profileData and route recipes).
  Driving dimensions default to driving:true and require expression. For measurement only use driving:false and omit expression.
  Dimension output includes result.dimension, result.parameter and result.expression. Check actual completeness with sketch check, and profiles with sketch inspect.
  See fmcad help batch run for a complete create -> geometry -> driving dimension -> extrude example with returned references.`);
      }
      if (operation.startsWith("model.") || operation.startsWith("pattern.")) {
        sections.push(`Feature outputs:
  result.feature is the feature ref; result.bodies is the array of actual result body refs, with healthState and message alongside.
  Do not assume the feature name is a body name. For a later body operation use a returned body ref, not result.feature.
  In a batch, {"$ref":"base.result.bodies.0"} selects a body only if that output contains one; inspect outputs and native health.`);
      }
      if (
        /^(export|checkpoint|import)\./.test(operation) ||
        [
          "shot.pack",
          "view.compare",
          "motion.sample",
          "animation.joints",
        ].includes(operation)
      ) {
        sections.push(`Files and safety:
  --file reads input JSON on the CLI machine. Payload path/directory fields refer to files on the Fusion machine after CLI mapping.
  Relative payload paths resolve against CLI cwd; /mnt/c/... maps to C:\\..., Windows drive/UNC paths pass through.
  Other Linux paths map to \\\\wsl$\\<WSL_DISTRO_NAME or Ubuntu>\\...; ensure Fusion can access that location. macOS/Windows use native absolute paths.
  Parent directories must already exist for exports. Unlike batch reportPath, export paths are not local report directories.
  Where overwrite is supported, existing files require BOTH overwrite:true and confirm:true. Motion frame exports never overwrite.
  Earlier output files can remain after a later failure. Export/checkpoint is not a cloud save or proof of geometric equivalence.
  Legacy export step uses --out and defaults to whole-design export; CAD STEP is fmcad cad export step --doc Model --path 'C:/cad-output/part.step'.`);
      }
      if (operation.startsWith("document.")) {
        sections.push(`Save workflow:
  doc save targets the ACTIVE document; doc save-as/document save_as targets the explicit --doc and requires confirm:true.
  First save or a saved-document copy: fmcad doc save-as --doc Model --name Housing --project ProductProject --folder '' --confirm true
  Empty folder means the existing cloud project root, not a filesystem directory. No local-path mapping or automatic folder creation.
  A saved-document copy can change the open document's identity/name. Read the returned original/current/target identities before further scoped operations.
  After acceptance, query fmcad doc status --doc '<current open name>'; compare fileName/folderId/projectId to target.name/folderId/projectId.
  Verify fileId differs from original.fileId, saved:true, modified:false and isComplete:true. target has no fileId field.
  pending is not durable completion. A timeout or readback error can leave an uncertain save; inspect before retrying.
  Save separately outside command-event transactions; no batch save_as, automatic save, overwrite or automatic retry.`);
      }
      sections.push(`Validation and failure:
  Required lists cover unconditional fields; mode-dependent requirements and limits above are also mandatory.
  Offline validation does not check entity existence, solver compatibility or kernel feasibility.
  A mutation failure can leave partial changes. Inspect outputs, native health and the document before retrying; no automatic rollback/save is implied.`);
    }
  } else if (["doc save", "doc close", "undo", "redo"].includes(entry.key)) {
    sections.push(`Active-document safety:
  This legacy command targets the ACTIVE document and does not accept --doc. Check doc list and active before proceeding.
  No automatic retry or batch rollback is provided. doc close --discard explicitly loses unsaved changes.
  For an explicit first save or new copy/destination use fmcad help doc save-as; for read-only scoped save state use fmcad help doc status.`);
  } else if (entry.kind === "export") {
    sections.push(`Legacy export safety:
  This is the legacy --out interface, not the CAD --data/--path interface. Without --body, STEP/STL exports root geometry.
  --body selects the first exact-name root body and is forwarded for both formats; STEP support for that body is not guaranteed. Prefer CAD component STEP export.
  No overwrite/confirm guard is supplied by this legacy interface. Use a new output filename.
  For scoped component STEP, explicit STL units, guarded overwrite and verification see fmcad help cad export step, export mesh and export verify.
  Export does not save the cloud document or validate exported geometry.`);
  } else if (entry.key === "shot") {
    sections.push(`Output safety:
  PNG bytes are written locally on the CLI machine, unlike shot pack's Fusion-machine paths.
  The parent directory must exist. Existing --out files are overwritten without confirmation.
  Omitted screenshot options are delegated to the selected backend; this CLI does not enforce common image-size defaults.`);
  } else if (entry.key === "doc open") {
    sections.push(`Selection safety:
  Search results are not required to be unique: this legacy command opens the FIRST result.
  Inspect doc search results first. For explicit file-ID targeting use call fusion_mcp_execute with a document/open object containing fileId.
  Subsequent CAD --doc scoping uses the exact open display name, not this fuzzy search term or file ID.`);
  } else if (entry.key === "run") {
    sections.push(`Script safety:
  Without identity pins, --doc only injects DOC_NAME; it does not enforce document scope or activate a document for arbitrary scripts.
  Optional --doc-id <creationId> / --doc-file-id <cloudId> require --doc and assert the unique exact named target before any user code inside the actual invocation. Duplicate/invalid pins and --list combinations are refused before backend setup.
  Guarded mutation checks activation and active target, then rechecks pins; guarded --readonly never activates. Pins assert the named target, not an arbitrary active document.
  This is a trusted-code precondition, NOT a sandbox: scripts can deliberately access other documents or mutate under --readonly. No automatic save or acceptance of stale pins after first save.
  Guarded source compiles in a fresh namespace (future imports supported), executes top-level code once, then calls run(context) if defined. Unguarded entry-point behavior is unchanged.
  --readonly is a declaration, not source inspection. The addin backend has no enforced read-only sandbox.
  A failed script may have partially modified Fusion; no automatic rollback or retry. Prefer catalog commands for documented input contracts.`);
    sections.push(`Helper facade (--helpers cad-v1):
  Opt-in; requires --doc plus --doc-id or --doc-file-id. Unknown helper versions are rejected before any RPC.
  The bundled facade is FMCAD: FMCAD.call(operation, data, component=None) dispatches an existing catalog handler and returns its raw result (mutating/read-only per the catalog readOnly flag); a failed call records unknown effects.
  FMCAD.resolve(ref, expected_kind=None) resolves one SDK reference. Unit helpers convert: FMCAD.length -> cm, FMCAD.angle -> rad, FMCAD.point -> Point3D, FMCAD.value -> ValueInput, FMCAD.collection -> ObjectCollection.
  Read-only getters FMCAD.doc, FMCAD.design and FMCAD.root expose the raw SDK document/design/root; the returned objects are mutable and trusted (this is not a sandbox).
  FMCAD.require_pass(result) requires at least one of accepted/checkPassed/passed present and true, and every present acceptance flag true; it rejects success:false or failed:true and statuses unknown/missing/stale/blocked/error/fail/failed, never success alone.
  FMCAD.require_history_end() read-checks markerPosition == count without mutation. FMCAD.emit(payload) buffers exactly one JSON payload; a second emit is an error. If run() returns a value and nothing was emitted, it is emitted once automatically.
  The wrapper prints exactly one terminal FMCAD_RESULT {success, helperCallsOnly:[...], result?, error?}. helperCallsOnly records only FMCAD.call dispatches (completed/observed or failed/unknown); there is no automatic replay or rollback.
  Under --readonly, the facade rejects only mutating helper dispatch (operations outside the catalog readOnly set); it is not a Python sandbox and the trusted script still runs unsandboxed.`);
    sections.push(`Local validation helpers:
  FMCAD.parameter_test(spec, check_case, check_restored) runs synchronous local parameter cases with per-case restoration; it does not save, upload or publish. Required skipped cases are not accepted, and timeout/unknown results require reconciliation before another call.
  FMCAD.temporary_body(ref, frame) and FMCAD.compare_bodies(a, b, frame, volume_tolerance, linear_tolerance, angular_tolerance) provide temporary-B-Rep two-way CSG and pose comparison in the declared frame. These helpers and callbacks are trusted Python, not a sandbox; asynchronous/publishing callbacks are unsupported.`);
  }
  return sections.length ? "\n" + sections.join("\n\n") + "\n" : "";
}
