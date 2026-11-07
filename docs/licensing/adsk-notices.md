# adsk notice requirements — pending rights clarification

**Not a shipping approval or a final third-party notice for bundled assets.**
No adsk source files accompany this record. See [the decision](README.md) and
[the exact inventory](adsk-snapshot-inventory.md).

**User override, 2026-10-24:** the user authorized redistribution with the
reported uncertainty accepted and stopped further investigation. This does not
confirm Autodesk's rights grant or resolve the final notice scope. Conditional
legal-clearance recommendations below record the earlier review; they are not
a renewed request for documents or a project-level veto of that instruction.

## Observed upstream notices

The snapshot's README says:

> This repository is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported (CC BY-NC-SA 3.0). See the `LICENSE` file for the full text.

The root LICENSE says:

> Except where otherwise noted, this work is licensed under a Creative Commons
> Attribution-NonCommercial-ShareAlike 3.0 Unported License.

and:

> Note: This notice applies "except where otherwise noted". If any files in this
> repository are accompanied by a different license header or a separate
> LICENSE file in a subdirectory, that other license governs for those files.

It then appends MIT with `Copyright (c) 2025 Patrick Rainsberry`. The precise
source is the [pinned LICENSE](https://github.com/AutodeskFusion360/FusionAPIReference/blob/07814d19ac63bb3ff0d55e3d35517cf3a71bad8c/LICENSE).
The MIT scope for the Autodesk definitions is unresolved; do not label these
files MIT or dual-licensed based only on this concatenation.

## If an authorized CC-based distribution is approved

Review the actual [CC BY-NC-SA 3.0 legal code](https://creativecommons.org/licenses/by-nc-sa/3.0/legalcode),
not only the upstream summary. At minimum the final notice set must address:

- Work title (`FusionAPIReference`, relevant Python definitions), supplied
  author/licensor/attribution parties, source URI and immutable commit/file
  provenance; confirm the correct Autodesk attribution with the rights holder.
- Retained copyright, license and warranty-disclaimer notices and a copy of,
  or URI for, the applicable license. Do not replace it with fmcad's MIT license.
- Identification of actual modifications (e.g. `.py` to `.pyi`, removed bodies,
  overlays) and appropriate adaptation credits and ShareAlike license, if
  applicable. A collection does not automatically relicense its other works.
- NonCommercial restrictions, downstream terms and absence of additional
  restrictions/technological measures incompatible with the license. A notice
  is not evidence that the planned commercial-capable use complies.
- No implication of Autodesk sponsorship or endorsement.

This conditional checklist does not authorize the planned package. Resolve
scope/use first; do not ship a misleading attribution-only workaround.

## If a permissive/special grant or replacement is approved

Retain the actual grant and its scope in the licensing record. Produce final
notices from that grant, including required copyright, permission text and
disclaimers, any retained source notices, exact provenance and change record.
An MIT grant normally requires retaining its copyright and permission notice
in all copies/substantial portions; do not invent an Autodesk grant or silently
substitute Patrick Rainsberry's copyright for the Autodesk-origin material.

Verify the actual packed npm artifact contains the approved notices next to
its provenance manifest. Final text and inclusion remain pending; this review
does not claim that notices or the release gate are already integrated.
