# Private native runtime rebaseline composition

These ports belong to trusted local composition, not an invocation decoder,
public environment variable, grant descriptor or SDK header.

`createNativeRuntimeRebaselineAuthorityPorts(options)` requires:

- The canonical private queue store and a maintained writer capability.
- The pinned native interpreter, complete installed package and provision.
- Immutable original process, retirement, handoff and row-preservation evidence.
- A private durable POSIX publication key reference and its matching native
  operator carrier. The carrier is not a modeling grant.

The private core passes `publish-or-resume` or `verify-completed` before the
provider makes a native decision. An authenticated absent row can begin only in
the first mode. A consumed row is never an active no-grant barrier: recovery
requires the existing exact NEW pointer and original authenticated native
receipt. It re-fsyncs that publication without another CAS or consume.

The native persistent fence protects issuance independently of child/parent
lifetimes. Publication uses actual POSIX file and directory fsync, not Windows
UNC rename durability. An uncertain operation retains its local marker and
native fence; neither process death nor a timeout clears them.

## Ordinary grants after rebaseline

Keep the same private ports closure used by the approved-root verifier:

```ts
const ports = createNativeRuntimeRebaselineAuthorityPorts(options);
const authority = createRuntimeRebaselineAuthority(ports);
await runtimeRebaselineRoot(options.store, authority);

const provision = createNativePhysicalGenerationProvision({
  ...nativeOptions,
  getVerifiedActivation: ports.getVerifiedActivation,
  assertBrokerOwner: () => context.assertBrokerOwner(),
});
```

Normal composition forwards its actual synchronous, maintained broker-owner
assertion. The provisioner rechecks it after the activation lookup, after native
preparation and immediately before grant spawn. Loss before that spawn refuses
as `notStarted`; uncertainty after a grant process started remains `unknown`.
`getVerifiedActivation(descriptor)` does not acquire another writer
lease or issue a grant. It becomes usable only after the core has re-fsynced its
completion dependencies and verified the original native consume receipt.
Each read rechecks the exact current pointer, descriptor/store/runtime binding,
raw receipt bytes and authenticated native query.

The resulting private approval has exactly five non-secret fields:
`requestId`, `fenceNonce`, `newHead`, `publicationDigest`, `receiptDigest`.
The native provisioner supplies these through the supported private
`--activation` channel. A retained Windows read handle prevents the verified
activation file from being written, deleted or replaced during the CLI read.

Without an approved context the reader returns `undefined`; the native issuer
independently refuses missing approval when one is required. Do not reconstruct
the tuple from public input or a local completion projection. The public
`PhysicalGenerationDescriptor`, grant file and SDK header remain unchanged.
