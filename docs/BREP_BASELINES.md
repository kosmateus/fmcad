# Exact BRep baselines — offline implementation

The feature now owns canonical bundle composition, the shared measure catalog,
handler registration, generated command routes and MCP tool projection on
`impl/brep-baselines`. Its final call site in the shared CAD dispatcher is an
explicit 4-line owner handoff and is not changed in this worktree. Do not merge
or claim native geometry acceptance until that dispatch hook is integrated and
the required authorized Fusion roundtrip has run.

## Boundaries and contract

- `runtime/python/fmcad/domain/brep_baseline.py`: capture, inspect and many-body
  compare through an injected port, with unique explicit roles, pinned source
  document/version, body and occurrence/native instance identity, frame, pose,
  and explicit volume/length/angle dimensional expressions. No SDK import.
- `runtime/python/fmcad/adapters/fusion/brep_baseline.py`: delegates snapshots
  and both directional Boolean differences to the retained measure helpers. It
  rejects nonfinite tolerances before those helpers. No bbox/volume shortcut,
  document import, mesh fallback, document save or automatic replay.
- Public capture currently exposes only `scope: durable`; no session object
  survives SDK turns. The internal domain can still model session references,
  but the public service does not promise their persistence.
- `packages/core/src/ports/brep-baseline.ts` and the Node persistence adapter
  bind the owner to the canonical project. Per-body `.smt` payloads and the
  versioned manifest have SHA-256 and byte limits. The manifest is published
  last through the **existing** exclusive durable publication primitives.
  Reads reuse containment, regular-file, no-follow, inode-path and bounded-read
  checks. Foreign owners, changed bytes, symlinks and unsupported versions fail
  closed. Incomplete publication is not a baseline. Orphaned evidence is not
  automatically deleted after uncertain I/O.

Comparison distinguishes geometry (`volumeEqual` from A−B **and** B−A), pose and
aggregate equality. Equal scalar volume alone is never evidence. Missing roles
or bodies return `missing`, identity/version drift returns `stale`, kernel
failure returns `unknown`, and negative geometric/pose evidence returns `fail`.
Budget exceptions propagate to the existing runtime error boundary; they do not
return pass or retry. `pass` describes the exact-kernel method within declared
tolerances, not mathematical equality of all boundary topology or manufacturing
qualification. A source version mismatch refuses comparison; intentional version
changes require a new capture rather than silently bypassing source policy.

## Exact serializer gate

`FusionExactBrepSerializer` checks for callable temporary-manager `exportToFile`
and `createFromFile` (Autodesk's documented reader name; there is no
`importFromFile` member). Both methods operate on temporary BRep bodies. Autodesk
documents `.smt`/`.sat` output for `exportToFile` and `.smt`, `.smb`, `.sat`, or
`.sab` input for `createFromFile`; this implementation uses the common `.smt`
roundtrip. Their presence is only **feature detection**, not proof of a legal
working SDK implementation. SDK versions without both return unsupported on
capture; no mesh or document export is substituted. Export failure, invalid
import or body-count mismatch cannot pass. One payload per body avoids assuming
that an SDK preserves order in a multi-body file. See Autodesk's
[TemporaryBRepManager reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/TemporaryBRepManager.htm),
[createFromFile reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/TemporaryBRepManager_createFromFile.htm),
and [API sample](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/TemporaryBRepManager_Sample.htm).

The adapter depends on a trusted staging/broker binder. Public payloads never
accept a filesystem path; only the internal `*_internal` prepared turn receives
the broker-generated `.smt` path list and checksum-verified manifest. Node owns
the private directory, byte reads/writes, durable publication, scope and hashes.
Python uses that same staging directory only during the settled SDK turn; there
is no Python file store, second scheduler or second bundle.

### Exact minimal dispatch/binder contract

The shared CAD dispatcher uses this minimal hook:

```js
if (service === 'brep-baseline') return require('./brep-baseline').execute(
  client, operation, data, context, {
    executeNative: (action, payload, ctx) =>
      executeCad(client, `measure.baseline.${action}_internal`, payload, ctx),
    toFusionPath: fusionPath,
  });
```

This hook is implemented in `src/cad.js`. `src/brep-baseline.js` canonicalizes `process.cwd()` with the existing owned
project resolver and calls the typed core service with the Node adapter. The
service port is:

```ts
{
  artifacts: BrepBaselineArtifacts; // brepBaselineArtifacts(project)
  stage(count): {
    id: string;
    fusionPaths: readonly string[]; // host-mapped, fresh, private .smt files
    read(index): Uint8Array;
    write(index, bytes): void;
    dispose(): void; // only after a settled turn and confirmed publish/result
  };
  executeNative(action: "capture" | "compare", payload, context): Promise<unknown>;
  newSession(): string;
}
```

Internal `measure.baseline.capture_internal` / `compare_internal` are excluded
from the public catalog/MCP/CLI routes and `validateInvocation`. The private
catalog validator also requires a per-payload `WeakSet` capability issued only
by `src/brep-baseline.js`; a caller-provided `_trustedBinding` alone is rejected.
An unknown/throwing broker turn preserves its unique stage directory and records
its stage ID on the error; the operation must not be replayed. Known settled
negative/unsupported results may clean only their own stage. This wiring is not
a new entrypoint or transport: it reuses the common CAD typed executor, current
project scope, `brepBaselineArtifacts`, existing durable I/O and Fusion client.

The helper itself does not call a new transport. The callback uses the existing
`executeCad` service for the private Python turn; the original public operation
is dispatched through this same branch by both CLI and MCP typed invocation.

## Integrated offline status

1. Shared dispatch is integrated. The positive fake-broker test runs CLI capture
   followed by MCP typed inspect/compare through `executeInvocation`, the real
   `src/cad.js` coordinator route, prepared bundle, private staging and owned
   artifact store. It verifies the actual service path without Fusion.
2. The canonical help audit files are generated/current. `--check` still exits
   nonzero for the unrelated existing `review` route audit gap, owned by another
   workflow; that result is not reported as PASS.
3. Offline code is ready for the later assigned master slot. No live Fusion was
   run and no native acceptance is inferred.

The runtime public catalog entries, bundle registrations, typed dispatch and
project-owned persistence are integrated on this branch. They are not yet merged
to `master`, and native serializer/geometry qualification remains outstanding.

## Verification and native blocker

```sh
npm run build:code
node --test tests/brep-baseline.test.js
python3 -B tests/brep_baseline_test.py
```

Python tests cover fake many-body geometry/pose, equal-volume different-shape
Boolean evidence, missing/stale bodies, source version, roles, kernel failure,
budget, tolerance routing and serializer refusal. Node tests verify bytes across
a fresh Node process, owner checks, corruption, missing data and symlink refusal.
Neither suite runs the native kernel.

`tests/native/brep_baseline_fixture.py` is a two-invocation acceptance driver
with mandatory consent and owned scratch identity guards. It still needs the
native scratch adapter and final public dispatch wiring. Once explicitly
authorized, capture exact synthetic solids, end the SDK invocation, restore
from owned durable bytes in a fresh invocation, check A−B/B−A, pose change,
equal-volume different shape, missing/stale body and final scratch restoration.
Also inject native kernel/export/import failure and exhausted work budget.
No unrelated/user document may be edited, saved or closed. This native stage
remains a concrete blocker to ticket close even after offline merge.
