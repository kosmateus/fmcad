# Immutable Autodesk typing refresh

The root package owns these build modes:

- `npm run build`: compile strict TypeScript, resolve the default branch's HEAD,
  and refresh from that one immutable commit. Network/integrity/policy failure
  fails the build, preserving the previous pointer. No stale-cache fallback.
- `npm run build:dev`: compile and verify the explicit local cache at
  `dist/runtime/python/typing`. Missing or modified resources fail. No network.
- `npm run build:code`: compile code only, **not a complete distributable build**.
  Unit tests use this mode so they remain deterministic/offline.
- `npm run test:adsk`: deterministic upstream and negative refresh fixtures.

The generated directory is on npm's files allowlist. Its `current.json` points
to a SHA-256-addressed snapshot, with annotated `.py`, `manifest.json`, original
`LICENSE.upstream`, original `README.upstream.md`, and `NOTICES.md`. The generated
directory must be retained as a unit when packaging; consumers resolve only the
pointer's snapshot. Older snapshots are deliberately retained for concurrent
readers, not selected as a fallback. No generated resources are written into
Fusion or a user's installed definitions. Type resources are not SDK execution
modules. Runtime never downloads them.

The downloader has 30-second request deadlines, rejects HTTP errors/redirects,
checks declared lengths where meaningful, caps metadata/tree/blob/total sizes,
and verifies each blob's immutable Git hash and byte size before staging.
Archives are never downloaded or extracted, eliminating archive traversal.
Every tree path is validated; required files must be regular non-executable
blobs, and added definitions or nested licensing notices require review. No
upstream `exec`, Python import, installer or generator is used. Local staging is
private; an atomic pointer rename publishes the completed snapshot. Failed
staging never publishes a partial snapshot. This is process-level atomicity,
not a filesystem crash-durability/fsync guarantee.

## Distribution decision, not legal clearance

The user explicitly authorized redistribution on 2026-10-24 despite reported
uncertainty and stopped further investigation. This is risk acceptance, not an
Autodesk grant or a legal clearance. The manifest records that distinction.
Retained upstream terms include CC BY-NC-SA 3.0 and appended Patrick Rainsberry
MIT text with unresolved scope. fmcad's MIT license does not relicense them.

The accepted upstream root LICENSE hash is
`e9ca54e95f2f1d0782c1b2d54d4b3fad8fec890c05b3549f0a74452246d34f34`.
The README license section is also compared exactly. Changed terms or added
nested notice files fail closed for a new explicit user decision; checking
unchanged text is **not** verification of Autodesk rights. There is no public
CLI bypass or automatic SPDX clearance. Existing cached outputs are hash-checked
against the same policy and generator. Intentional policy updates need a source
change and review. No further licensing investigation is part of this work.
