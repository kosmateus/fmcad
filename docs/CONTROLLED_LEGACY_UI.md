# Controlled legacy Qt UI port

`createControlledLegacyHostUi` is a private, separate adapter for the pinned
vendor `Nu::QTScriptsManagerDialog`. It does not translate the old WPF fixture
into a vendor qualification and never uses the QML manager as a fallback.
There is no SDK, broker, console, deployment or Fusion lifecycle operation in
this port.

## Composition and lifetime

ROOT supplies the existing, preflighted `ControlledNativeAdapter`, the actual
held `ControlledHostUiLease`, exact PowerShell/config and Fusion image hashes,
original native references for `NuBase10.dll`/`XLayerUI10.dll`, and a fresh
private audit directory. Include `controlledLegacyUiAuditPaths` in the native
original-path/mapping whitelist. Audit output must be outside installed source.
The lease fence is synchronous and checked across every await; a DTO, flag,
serialized window observation or successful input cannot replace it.

Use a single instance and always restore in the caller's `finally`:

```ts
try {
  const prepared = await ui.prepareExactHost({ process, entry });
  // ROOT creates and publishes the original audited isolated-stdout v2 intent.
  const delivered = await ui.startReviewedFork({ process, entry, intent });
  // delivered is input evidence only. Await and validate the native receipts.
} finally {
  await ui.restorePresentation();
}
```

`inspectExactHost` observes an already open legacy manager without any UI input.
It never enables `startReviewedFork`. A refusal still retains the original
private capture. It is not a substitute for preparation or a qualified lease.

Preparation requires an owned main-only starting state. It opens Preferences,
selects the visible API category if needed, reads the original legacy checkbox
state, journals it, and changes only that presentation option through the
normal widget and Apply. Every change has a separate getter postcondition.
It then opens the manager, selects the Add-ins tab, expands Details and selects
the installed entry. No restart, autoload setting, Add, Link, Unlink or Stop is
available. Category navigation is bounded; an unavailable API category refuses
rather than guessing coordinates or using a private setter.

Restoration uses only the known owned dialog HWND and the original observed
checkbox state. It never overwrites old XML or profile bytes. Foreign dialogs,
pending unknown preferences, lease/source revocation or unobserved delivery
may prevent safe restoration; report that concrete UNKNOWN instead of blindly
replaying an input or claiming cleanup. Known post-prepare DENY remains
restorable while the same real lease/source/process are current.

## Entry binding and deliberate refusals

The adapter independently checks:

- exact process birth/image, main/dialog HWND ownership and pinned vendor bytes;
- active Add-ins tab, scoped tree, one selected concrete TreeItem and matching
  native `SelectionPattern.GetSelection` result;
- a separate **readonly full entry-file path**, bound as the immediate sibling
  of the unique `Pełna ścieżka` label, not a row basename or table/tab index;
- original installed entry/manifest native final path, SHA, file identity and
  private ACL, protected again in the native action process;
- enabled **Uruchom**, not **Debuguj**, and startup checkbox OFF;
- original audited v2 isolated-stdout intent, executable pin, source manifest,
  receipts and a **freshly read** ALL-OFF profile.

The actual vendor has returned a previous, unselected row through
`GetSelection` while concrete row flags/path show a new selection. Such a
disagreement is DENY. Selecting a category can leave Run enabled with an empty
path; it is DENY. A running fork can expose disabled Debug rather than Run;
it is DENY. No criterion is removed to make these cases pass.

The real legacy option is marked by the vendor as potentially removed in a
future release. This is an exact-version adapter, not a compatibility promise.

## Input, evidence and source versions

Every input requires a fresh original observation and an exclusive, synced,
private action journal plus a permanent native dispatch file. The native
process rechecks the original view after journal I/O. UNKNOWN poisons Start;
neither a second instance/audit directory nor a new caller can replay the same
original intent's `.legacy-start-attempt.json` fence.

Successful invocation records `inputDelivered: true`, `startupProven: false`.
Only the separately qualified audited native producer/receipt consumer can
establish startup facts. The UI-local `ControlledUiEntryIntentV2` mirrors the
frozen audited intent schema while the independent receipt-reader migration
lands. Both UI adapters reject isolated-stdout v1 and require exact executable
path/SHA; there is no legacy fallback for that purpose.

Closing a vendor manager may replace `JSLoadedScriptsinfo` with identical bytes
but a new File ID/mtime. Do not reuse historical native profile pins. This port
reads the profile afresh for Start and does not restore an old cache.
Previously captured originals remain historical evidence, not current pins.

The fixed OS program is compressed and hash-checked only to fit the Windows
command-line limit. It is not caller-provided script/code. Captures cover only
the scoped Preferences/manager dialog; the main-window project list is not
captured.

## Verification labels

`npm run test:controlled-legacy-ui` exercises the whole port through a benign
Qt-shaped process-boundary fixture. It does not run Fusion or qualify a vendor
UI. The optional Windows test (`FMCAD_LEGACY_UI_WINDOWS_TEST_POWERSHELL`) loads
UIA declarations, compiles native OS bindings and parses the fixed program
without enumerating or creating any window. Its success is not UI behavior or
vendor PASS. Actual read-only qualification and its precise DENY stage must
be recorded separately.
