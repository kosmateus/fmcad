# Autodesk Python definitions: redistribution review

**Current project decision: redistribution authorized by the user with the
reported licensing uncertainty accepted; Autodesk rights remain unverified.**

## User override — 2026-10-24

After receiving the findings below, the user explicitly authorized
redistribution despite the uncertainty and directed that further license
investigation stop without requesting documents. This records project-owner
risk acceptance, **not a grant from Autodesk, legal clearance, or evidence that
the original acceptance criteria were met**. No further investigation is planned.

The earlier recommendation to block redistribution and require additional
rights evidence before implementation is superseded as a project instruction.
The factual findings, source inventory and notice caveats remain unchanged.
The previously proposed rights-approval gate below is historical advice, not
an implementation requirement under the current user instruction. Provenance
and honest notice handling remain relevant; this change implements no gate.

Suggested administrative disposition: the coordinator may close
`fmcad-adsk-license` as **superseded by explicit user risk acceptance**, explicitly
not as legally verified/completed against its original criteria, and remove or
waive its blocking dependency on further implementation. Until that disposition,
the ticket remains `blocked` as a record of the unresolved original criterion;
the next action is administrative, not further research. This documentation
change does not alter other agents' tickets or dependencies.

Reviewed on 2026-10-24 for Beads `fmcad-adsk-license`. This is a documented
engineering release decision, not a legal opinion or permission from Autodesk.
No Autodesk definition files are vendored by this documentation change.

## Exact material reviewed

Repository: <https://github.com/AutodeskFusion360/FusionAPIReference>

Snapshot: `07814d19ac63bb3ff0d55e3d35517cf3a71bad8c`, committed
2026-06-10T19:06:08Z. Its README identifies the **Fusion May 2026 Major Release**;
this is an upstream label, not a compatibility test against installed Fusion.
The relevant subtree is `Fusion_API_Python_Reference/defs/adsk`.

The GitHub recursive tree response was not truncated. All eight blobs were
downloaded from that immutable commit and read as text, never imported/executed.
There is no nested LICENSE/NOTICE in the Python reference tree, nor a separate
license header in any of these files. Seven files start with the warning that
they are automatically generated for code intellisense, not actual
implementations; `__init__.py` starts directly with function definitions.
Mentions of a 3MF file's copyright/license in `cam.py` describe API properties,
not permission to redistribute the Python file.

See [the inventory](adsk-snapshot-inventory.md) for every file and SHA-256.

## Evidence and scope

1. [Pinned README](https://github.com/AutodeskFusion360/FusionAPIReference/blob/07814d19ac63bb3ff0d55e3d35517cf3a71bad8c/README.md),
   lines 5, 15, 35–43: explicitly includes Python object stubs, declares the
   repository CC BY-NC-SA 3.0 Unported, and describes the bundled material as
   official Autodesk Fusion API reference material.
2. [Pinned LICENSE](https://github.com/AutodeskFusion360/FusionAPIReference/blob/07814d19ac63bb3ff0d55e3d35517cf3a71bad8c/LICENSE),
   lines 1–23: CC BY-NC-SA 3.0 applies except where a file header or nested
   license says otherwise. Lines 24–44 append MIT, copyright 2025 Patrick
   Rainsberry, without identifying which files it covers. No such exception
   was found in the target subtree. These facts do **not** establish a choice
   of MIT for the Autodesk definitions or authority to offer them under MIT.
3. [LICENSE history](https://api.github.com/repos/AutodeskFusion360/FusionAPIReference/commits?path=LICENSE&per_page=100)
   was inspected, including the actual LICENSE blobs at
   [`53d585e1852605ffb6c8cd31ec0870183df58e03`](https://github.com/AutodeskFusion360/FusionAPIReference/blob/53d585e1852605ffb6c8cd31ec0870183df58e03/LICENSE)
   (initial MIT text) and
   [`1ee95b2d34b4a4344d107d4e7e1cf54a4076e900`](https://github.com/AutodeskFusion360/FusionAPIReference/blob/1ee95b2d34b4a4344d107d4e7e1cf54a4076e900/LICENSE)
   (CC notice prepended, MIT retained). The history explains the juxtaposed
   texts but does not establish a file-specific permissive grant for the
   reviewed May 2026 definitions. No earlier snapshot was approved instead.
4. [CC BY-NC-SA 3.0 legal code](https://creativecommons.org/licenses/by-nc-sa/3.0/legalcode)
   was read. Sections 3 and 4 allow copying/adaptation subject to conditions;
   §4(c) restricts exercise of the rights for commercial advantage/private
   monetary compensation, §4(d) requires attribution and retained notices,
   §4(b) governs adaptations, and §4(a) governs collections. This is not a
   blanket prohibition on all sharing, but it is not an unrestricted grant
   for fmcad's planned distributable package and downstream commercial use.
   A free npm download alone does not establish NonCommercial compliance.
5. Autodesk's [Creative Commons page](https://www.autodesk.com/company/creative-commons)
   and the [forum question about publishing stubs for static analysis](https://forums.autodesk.com/t5/fusion-api-and-scripts-forum/python-stub-files-for-static-analysis/td-p/12616183)
   returned HTTP 403 during direct access. Search results exposed the forum
   question, not a verified permission. Neither is treated as an authorization.

Converting `.py` to `.pyi`, deleting docstrings, extracting signatures or
packaging a database does not by itself establish new rights or remove the
source license conditions. Whether a particular transformation is an adaptation
requires review; conversion is not the remediation for this blocker. MIT in
fmcad's own manifest does not relicense third-party assets. Collection rules
also do not mean that all of fmcad must automatically become CC-licensed.

## Replacement investigated (not approved)

Candidate: [DannoPeters/adsk](https://github.com/DannoPeters/adsk/tree/3b328ebbc8ea0292ccfa33327f93c978e10cf88d)
at `3b328ebbc8ea0292ccfa33327f93c978e10cf88d`, and
[PyPI adsk](https://pypi.org/project/adsk/), inspected via its JSON metadata.

- [README](https://github.com/DannoPeters/adsk/blob/3b328ebbc8ea0292ccfa33327f93c978e10cf88d/README.md)
  calls this an upload of API code created, owned and maintained by Autodesk.
- [LICENSE.txt](https://github.com/DannoPeters/adsk/blob/3b328ebbc8ea0292ccfa33327f93c978e10cf88d/LICENSE.txt)
  contains MIT with `Copyright (c) 2021 Autodesk`; `setup.py` and PyPI declare
  MIT and version `2.0.12157`. The metadata inspected lists only that release.
  A third-party upload and copyright assertion alone do not resolve the
  uploader's authority for Autodesk-origin files.
- Its complete Git tree has `adsk/__init__.py`, `cam.py`, `core.py`, `drawing.py`
  and `fusion.py`, but no `electron.py`, `sim.py` or `volume.py`. No complete,
  current typed API replacement satisfying the definitions/checker contract
  was demonstrated. It was not installed, executed or adopted.

Installed Autodesk SDK/editor definitions are not an approved replacement:
their presence on a user's machine neither establishes redistribution rights
nor supplies a self-contained npm package. No clean-room complete replacement
was produced or claimed. The search was not proof that no replacement exists.

## Notices and release integration (pre-override recommendation)

[Notice requirements](adsk-notices.md) records the observed notices and the
conditions to resolve before shipping. Attribution alone cannot cure missing
rights. The inventory is evidence, **not an allowlist of approved assets**.

Required follow-up for `fmcad-adsk-definitions`, `fmcad-npm-artifact` and build
integration (not implemented in this documentation-only task):

- Fail closed before marking a full build/package distribution-ready when
  the definitions have no approved rights record. Do not quietly omit required
  types and still claim the self-contained checker acceptance criteria.
- Match approval to the immutable source, exact allowed files/hashes, intended
  distribution/use, license scope and notice set. A repository-wide SPDX guess
  or GitHub's detected license is not sufficient. Review refreshed snapshots;
  network failure, changed terms or unresolved scope must not silently pass
  through an old cache or fallback source.
- Apply the same gate to converted/generated assets and caches. On failure,
  keep the prior verified resource state intact but do not report a successful
  full refresh. No runtime download is a substitute.
- Once cleared, include the approved notices and provenance manifest in the
  actual npm tarball and verify their contents with packaging tests. Test the
  present blocked snapshot, changed license/scope and absent approval as
  rejection cases, not just the positive fixture.

These are integration requirements, not claims that a gate currently exists.
No toolchain, package manifest, checker implementation, npm release or live
Fusion operation was changed/tested in this review.

## Original legal-clearance exit criteria (not pursued after user override)

The original next step was a written file-specific grant or clarification from Autodesk/the
authorized rights holder covering **all eight pinned files and their Autodesk
source material**, including commercial redistribution as part of a
self-contained npm package, downstream use, modification/conversion to `.pyi`,
and the required attribution/license/disclaimer notices, plus clarification
of the appended Patrick Rainsberry MIT text and authority to grant it
for these files. A proposed request is documentation only; none was sent.

Alternatively, the original criteria called for a verifiably authorized,
complete replacement with reviewable provenance and API/type coverage,
recorded grant/source, scope and final notices, and a tested release gate.
the original legal-clearance criteria remain unmet. The user has since
superseded further investigation and the project-level distribution block as
recorded above; this report itself still supplies no legal authorization.
