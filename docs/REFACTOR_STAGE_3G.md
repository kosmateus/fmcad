# Stage 3g: body attributes and token isolation

The shared attribute scenarios exercise the production cad-v1 facade and its exact
creation/file identity guards. They create a rectangular body in an owned saved
fixture, write a namespaced string, update it, repeat the same write and read back
both an exact key and a group. These assertions come from the later
`live-entity-attributes.js` suite (`ab2b355`); the retained `a26222f` attribute
handler is the pre-refactor behavior reference.

Each owner uses the same body/group/key names and distinct values. Namespace
separation, a missing key and rejected non-string/blank-key writes add explicit
no-change checks. The original live suite's unsaved `shape.box` setup is replaced
here with the already-qualified public box script inside the shared saved-file
lifecycle. This does not qualify `shape.box` or attribute persistence. Native and
model execution use the same scenario code, operations and expected values.

Model version 7 adds body attributes and document-local body/component token
lookup. API call shapes are checked against the pinned Autodesk definitions.
The model stores strings on the actual owning body and includes attributes in its
revision hash. It does not return canned operation results. Geometry persistence,
proxy entities, split/merged topology and token lifetime across reopen remain
unsupported. Saves containing geometry continue to fail explicitly.

The 2 MiB value limit uses UTF-8 byte counting in the model. Native encoding,
error-versus-null behavior at that boundary, attribute iteration order, handle
lifetime, persistence and no-op write dirty flags still need final Fusion checks.
The shared assertions do not rely on those unverified boundary details.

Nine model tests pass, including both protocols at limits 1/2/10, foreign body
tokens, cleanup after an assertion failure and paired historical handler behavior.
Both MCP and addin component profiles passed with all fixtures cleaned and
identical source hashes before/after each run. Full broker CI is pending.
API verification covers 51 methods and 14 property accessors. Native execution
remains deferred.

An initial raw-script test flattened the full CAD runtime and exhausted the
checker's fixed memory budget. The scenarios now use the existing public
`--helpers cad-v1` preparation, preserving source units and their provenance in
both the component and real-broker paths. No checker limit or acceptance rule
was relaxed. Native and model backends submit the same helper source.

CI keeps the full matrix on pull requests and pushes to `main`, avoiding duplicate
branch-push runs. Every model family still runs through the real broker on both
transports. The separate component smoke check now selects the foundation suite;
family admission and model checks remain in their dedicated broker jobs. The
attribute job uses two owned files with a concurrency ceiling of ten. Unit tests
exercise limits one, two and ten independently.

Attribute operations use one checked helper batch per owner, followed by a
separate exact-token SDK read after other scenarios can run. The batch stops at
an unexpected exception or nonpassing result; expected invalid-value/key errors
are checked before continuing. This avoids repeatedly rechecking the complete
CAD runtime for each small attribute operation while retaining every API step
and assertion. Physical broker coverage remains a separate required CI gate.
