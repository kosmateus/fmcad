# Private owned-autoload pre-resume producer

`createOwnedAutoloadLaunchAdapter` is a separate private local composition seam.
It exposes only `launchAfterDeath(old, nonce)`. It does not close Fusion, call an
SDK, deploy a package, start a broker, or qualify an isolated stdout provider.
The result explicitly carries `startupProven: false`.

## Original inputs and held boundary

### Controlled native runtime trust

The owned path uses the explicit `controlled-native-runtime-v1` trust model:
Autodesk Fusion and the fully pinned owned native add-in are trusted. It retains
process/executable/source, admission/owner/generation, queue, original receipt,
MAC and compiler/wire fences. `execute_python` still executes inside Fusion.

Observed startup/source roots and their original held witnesses are not proof
of every possible cold loader root. The host assurance is bound into the proof
hash and reports `globalCleanHost: NOT_PROVEN`; it is data, not a grant or a claim
of a globally clean process. The bounded stdout compiler still rejects imports,
SDK/file access and unsupported source. Legacy manual/all-roots contracts are
separate and do not become fallbacks for this path.

Supply the existing `ControlledFusionLaunchPins` and `owned` lifecycle originals:
the exact database identity, original committed handoff request/completion,
old provision SHA, complete installed inventory, and fresh original output paths.
These reuse the native NORMAL lifecycle validation implementation, not its policy
or authority. The separate native action is `owned-autoload-launch`.

`owned.admissionPins` is required and closed to `source` and `build`. These are
the original provision's admission protocol pins, independently of
`installedSource` and the full `installedBuild` manifest digest. The original
provision hash and native lifecycle/database checks bind them before process
creation. The producer preserves both admission fields; the v3 intent's
`installed.source` and `installed.files` describe the separately qualified native
installation. There is no fallback from missing admission pins to installed
identity. Manual and NORMAL constructors keep their existing contracts.

`owned.autorunOriginals` must be exactly two `ControlledFile` originals;
`owned.discoveryOriginals` must be nonempty. Each must be distinct and explicitly
allowlisted in `originalPaths` and `mappedOriginalPaths`. They must not alias
profile/provision, launch outputs, or the lifecycle database/receipts. Original
native path, full SHA, native identity and bytes are checked. Mapped aliases,
hardlinks, byte changes and mapped identity changes refuse in Node; native
canonical paths, ACLs, file identity, SHA and retained original handles are
checked independently, including immediately before resume.

The original references alone do **not** prove discovery completeness. ROOT
supplies its real startup-input witness and observed source-scope fence via
the synchronous, void-returning `assertBeforeResumeOriginals()` callback. It also
supplies `assertHeld()` for the genuine lifecycle window. Both callbacks run at
the parent continuation boundaries and other native-operation fences. A promise,
serialized DTO or boolean is not accepted as either callback.

## Process ordering

The producer preserves foreign registration fields but changes their startup
flags OFF and enables exactly the installed owned entry. The native helper
independently verifies that policy before writing, rather than trusting the plan.

1. Verify old-process death, full source/executable originals and committed
   handoff/database state; back up and apply the owned-only profile.
2. Obtain the held-parent continuation before creating a process.
3. Call `CreateProcessW(CREATE_SUSPENDED)` once and retain its process/thread
   handles. Derive the new PID/birth only from those original handles.
4. Journal the created tuple; bind the genuine old provision to that tuple and
   the already committed next generation using the original CAS/DB guards.
5. Read back the provision; exclusively publish and read back the v3 intent.
6. Emit the final owned checkpoint with nonce, new tuple and original
   provision/intent native references. Require the exact typed parent echo after
   its actual held-window/startup-original callbacks.
7. Recheck retained process/image, source, profile, database, all original inputs,
   provision and intent; release the database readers and call `ResumeThread`
   once, requiring prior suspend count one.

The private fixed program is length-framed to avoid the Windows command-line
limit. Its generated extension boundaries fail closed if the shared primitive
layout changes. No caller supplies program source or selects this mode through a
NORMAL flag.

## Closed intent v3

The intent has exactly the v2 fields, with `version: 3`, plus:

```ts
mode: "owned-autoload-v1";
provision: {
  path: string;
  sha256: string;
}
generation: {
  instance: string;
  epoch: string;
}
```

`purpose` remains `isolated-stdout-v1`; `engineVersion` remains 2. The process is
the actual suspended tuple. Executable, installed source, profile and provision
hashes come from pinned originals and native readbacks. Receipt paths are fresh
private originals.

The existing manual ALL-OFF/v2 and NORMAL paths are unchanged. NORMAL still has
no bootstrap intent and claims no isolation. There is no fallback between the
three paths. The v3 intent, journals and provision receipt are evidence inputs,
not a raw SDK/admission capability; ROOT's controlled consumer and native audited
producer must separately validate them and establish the existing MAC/window
bindings before any isolated operation.

## Refusal, uncertainty and testing

An adapter is one-shot even after an unsuccessful attempt. No unknown result
causes relaunch, forced resume, termination, profile restoration or output
replacement. Post-create refusal retains the suspended tuple and durable
originals; its production outcome remains UNKNOWN.

The Windows behavioral tests use owned benign children only. At their first user
instructions they read and verify the intent/provision/profile/executable and
actual PID/birth. Negative tests retain original evidence before an explicitly
separate fixture-only cleanup. Such cleanup is never a production recovery API,
and those tests are not actual Fusion qualification.
