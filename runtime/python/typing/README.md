# Autodesk editor definitions

Full builds download the allowlisted annotated `.py` definitions into
`dist/runtime/python/typing/snapshots/<manifest-sha256>/adsk`. These are **typing
resources**, never Python runtime implementations: do not put them on Fusion's
execution `sys.path`, import them, or execute their bodies. The checker should
resolve the snapshot via `current.json`, verify its manifest and use its `adsk`
directory for analysis only. Runtime performs no refresh or network request.

The full build resolves the upstream default branch once; all subsequent reads
use that immutable commit. `current.json` is the atomic commit point. Previous
content-addressed snapshots remain available to readers which already resolved
the pointer. All snapshots include provenance, exact source and output hashes,
API release label, generator/overlay identifiers and retained notices.

`Point3D.create`'s nullable return is a narrowly guarded annotation correction:
the upstream method documentation explicitly says it returns null on failure.
The overlay rejects changed/missing signatures or documentation instead of
guessing. Other methods are copied unchanged; this is not comprehensive SDK
correctness validation. In particular `sim.py` has no API declarations. A release
label does not assert compatibility with every installed Fusion version.

See `docs/ADSK_DEFINITIONS.md` for build and redistribution policy.
