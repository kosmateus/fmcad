# Retained style/save qualification

`tests/scenarios/native-style-save-cases.ts` ports the six native groups from
`tests/live-style-save.js` into the existing `ScenarioSession` lifecycle. The
frozen source and its assertion inventory remain the historical reference.
The factory is `nativeStyleSaveScenarios`; owners default to 10, SDK requests use
the existing single queue, and each owner runs exclusively. Its capability is
`native-style-save-addin`; the retained suite requires the addin protocol and
`original-user-view` capture before creating an unsaved fixture.

The port preserves density unit conversions, mass/volume checks, material and
appearance readback, face/body/instance cascade and clear behavior, prevalidation
failures, unchanged physical properties, and F3D export/import readback. Object
component references retain the production `buildCadScript` path. Every such
request includes the original full foreign-document inventory guard, strengthened
with file identity and unsaved state checks.

F3D files live in the owner's mapped private directory. Import and closure remain
in one original SDK request, with a durable receipt bound to the request, client,
parent and input file. Fusion may copy the source creation ID during F3D import:
the explicit copied-ID policy therefore requires a newly returned native object,
an owned child name and closure of that exact object in the original request.
Missing or uncertain closure defers cleanup; neither import nor mutation is
replayed. The shared runner closes the primary fixture and restores the original
document, camera and workspace only after settled evidence permits it.

Native prerequisites are an active Design document, an idle UI, at least two
loaded materials whose positive densities differ by more than ten percent, and
distinct loaded appearances suitable for the retained color checks. The runner
does not download material libraries or choose a cloud save destination.

Validation at this checkpoint:

- Strict TypeScript and ESLint passed for the port and its three safety/preview
  tests. AST comparison preserved the assertion/readback calls in all six native
  groups; an additional assertion binds the child receipt to the current request.
- The local `document.save_as` preview remains an actual offline call with a
  backend that throws if contacted. Its test checks `mutation: false` and
  `state: input-validated-only`.
- Runtime execution of those three tests is pending the coordinated central
  build. The retained `tests/document_save_test.py` module also needs a current
  full run; no prior package-D run is claimed as its evidence.
- Native geometry, materials, rendering and F3D qualification are **not run**.
  Static checks and unsupported-capability tests do not qualify native behavior.
