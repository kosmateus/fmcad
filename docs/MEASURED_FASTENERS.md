# Versioned native fastener measurements

`runtime/python/fmcad/domain/measured_fasteners.py`,
`runtime/python/fmcad/application/measured_fasteners.py` and
`runtime/python/fmcad/adapters/fusion/measured_fasteners.py` form an isolated,
read-only family module. `packages/node-adapters/src/python/measured-fasteners-manifest.ts`
declares its family bundle graph and `runtime/python/fmcad/application/measured_fasteners_handlers.py`
exports `fastener.measured-check`. The canonical Python bundle includes the
family after its existing `measure`, `fastener`, and `sequence` dependencies;
the public CAD catalog exposes it through the ordinary CLI/MCP/broker path.

## Input contract

The operation accepts `schemaVersion: 1`, `mode: "native"`, a `native` object
with `schemaVersion: 1`, an explicitly identified reference frame, and explicit
references for the screw axis/head-bearing/tip/thread boundaries, receptacle
axis/thread boundaries, and each measured layer's axial endpoints. A
Fusion `axis`/linear `edge` reference supplies its native origin and direction;
`point` and `vertex` references supply axial boundary locations. Assembly
occurrence proxies are read in their world geometry. All resolved references
must belong to one common component-local or assembly frame. A supplied `frame`
must match that actual frame.

The native request also declares `tolerance.axisOffset`, `tolerance.axisAngle`
and, when adequacy is to be judged, `tolerance.minimumEngagement`. Length
expressions are converted by Fusion `UnitsManager` and reported in millimetres;
angles are reported in radians. No default alignment or minimum-engagement
tolerance is invented.

The reference fields are ordinary `ctx.resolve` names or reference objects. A
complete request has this shape:

```json
{
  "schemaVersion": 1,
  "mode": "native",
  "native": {
    "schemaVersion": 1,
    "frame": {"space": "assembly", "component": {"kind": "component", "name": "root"}},
    "tolerance": {"axisOffset": "0.05 mm", "axisAngle": "1 deg", "minimumEngagement": "4 mm"},
    "screw": {
      "axis": {"kind": "axis", "name": "ScrewAxis"},
      "headBearing": {"kind": "point", "name": "HeadBearing"},
      "tip": {"kind": "point", "name": "ScrewTip"},
      "threadStart": {"kind": "point", "name": "ScrewThreadStart"},
      "threadEnd": {"kind": "point", "name": "ScrewThreadEnd"}
    },
    "receptacle": {
      "kind": "blind",
      "axis": {"kind": "axis", "name": "HoleAxis"},
      "threadStart": {"kind": "point", "name": "HoleThreadStart"},
      "threadEnd": {"kind": "point", "name": "HoleThreadEnd"},
      "bottom": {"kind": "point", "name": "HoleBottom"}
    },
    "layers": [{"id": "bracket", "start": {"kind": "point", "name": "StackNear"},
                 "end": {"kind": "point", "name": "StackFar"}}]
  },
  "declaredEvidence": {
    "operation": "fastener.check", "schemaVersion": 1, "frame": "component",
    "screw": {"length": "12 mm", "threadLength": "10 mm"},
    "stack": [{"id": "bracket", "thickness": "5 mm"}]
  },
  "toolAccess": {
    "tool": {"diameter": "4 mm", "length": "30 mm"},
    "target": {"origin": {"kind": "point", "name": "HeadBearing"},
                "axis": {"kind": "axis", "name": "ScrewAxis"}, "engagementDepth": "0 mm"},
    "entry": {"origin": {"kind": "point", "name": "ToolEntry"},
               "direction": {"kind": "axis", "name": "ToolApproach"}},
    "nativeObstacles": [{"name": "Wall", "body": {"kind": "body", "name": "WallBody"}}],
    "declaredObstacles": [{"name": "Fixture", "box": {"min": ["-5 mm", "-5 mm", "8 mm"],
                                                            "max": ["5 mm", "5 mm", "12 mm"]}}],
    "minimumClearance": "0 mm", "samples": 20
  }
}
```

`nativeObstacles` takes solid `body` references. `declaredObstacles` takes the
existing `tool.access` point/radius or axis-aligned-box inputs and remains
separately labeled; it is not represented as a Fusion read.

Each successful read carries `sourceRef`, `sourceVersion: 1`, its resolved
frame, and a coverage description. Here `sourceVersion` identifies the
measurement DTO/extractor contract; it is **not** a revision number for the
Fusion document. `documentIdentity` (when the host exposes it), the stable
native reference, and frame are the document/source provenance. Missing and
unsupported reads are reported as such and do not fall back to declared stack
values.

## Measurements and scope

- `actualEngagement` is the overlap of the selected screw and receptacle axial
  thread-boundary intervals after projection into the common frame.
- `bottoming` compares the measured screw tip with an explicitly selected
  blind-hole bottom. A missing bottom produces an unknown check, not a declared
  depth substitution.
- `protrusion` is the signed screw-tip station beyond the farthest selected
  layer endpoint; negative values stop short.
- `alignment` reports the measured axis-line offset and unsigned direction
  angle against the caller's tolerances.
- `toolAccess` sends native target/entry references and conservative solid-body
  bounds through the existing `tool.access` adapter. The tool's swept cylindrical
  envelope remains sampled; BRep obstacles are represented by conservative
  axis-aligned bounds of temporary body copies. At least one native body ref is
  required before access can pass. Coverage is only the selected native refs,
  not an exhaustive scene scan; callers must not infer unlisted solids are
  clear. Caller-supplied point/radius or box obstacles remain a separate
  `declaredObstacleEvidence` list. These bounds and samples are not a continuous
  collision proof or a full grip/tool model.

Fusion does not expose exact helical thread-flank engagement through this
measurement path. Boundary references therefore prove only axial-interval
overlap; the result explicitly does not claim exact-thread contact, strength or
manufacturability.

## Legacy evidence

An optional `declaredEvidence` contains an unchanged `fastener.stack` or
`fastener.check` request with its legacy `schemaVersion: 1` and
`frame: "component"`. The adapter calls the existing implementation through a
port and embeds its original local-frame units/result separately. That result
is retained for comparison, never substituted into the native measurements.
The new application layer calls the existing stack and `tool.access`
implementations through ports instead of duplicating their calculators.

## Offline fixtures and qualification boundary

Run the dedicated synthetic suite with:

```sh
python3 -B tests/measured_fasteners_test.py
node --test tests/measured-fasteners-bundle.test.js
```

The bundle test verifies that the canonical manifest includes the family once
after its `measure`, `fastener` and `sequence` dependencies and executes the
actual prepared artifact with checkout filesystem reads blocked. The same test
drives the typed CLI and MCP catalog through a fake broker and checks the
read-only artifact route, result classification, legacy evidence and help.

The JSON fixture and fake Fusion adapter exercise a translated/rotated
occurrence, blind-hole bottoming, a short bolt in a deep receptacle, axis
misalignment, a native body obstacle, separate declared obstacles, provenance,
and missing reads. They verify DTO/math and adapter port behavior only. **They
are not native Fusion qualification.** The acceptance gate remains a synthetic
document exercised in real Fusion after explicit user approval, including
positive/negative cases and required restoration. No live Fusion operation is
performed by this implementation task.

The prepared native-document specification is
`tests/fixtures/measured-fasteners/native-document-spec.json`. Its dimensions
match `tests/fixtures/measured-fasteners/native-axial-fixture.json`: screw axis and
head-bearing plane at `z=0`, tip at `z=10 mm`, screw thread boundary points at
`z=4..10 mm`, receptacle thread interval at `z=5..13 mm`, a single stack layer
at `z=0..5 mm`, blind bottom at `z=13 mm`, and minimum engagement `4 mm`.
Expected baseline readings are `5 mm` axial interval overlap, `5 mm` signed
protrusion, `3 mm` bottom clearance, and aligned axes. The eventual Fusion
qualification should include:

| Variant | Native change | Expected native result |
| --- | --- | --- |
| Rotated occurrence | Rotate the whole fixture off global `Z` and translate it | Baseline values remain unchanged in the occurrence-qualified assembly frame |
| Blind-hole bottoming | Move blind bottom to `z=8 mm`; retain the legacy declared depth `8 mm` | Native bottoming fails while the legacy calculator still reports its own separate result |
| Short bolt / deep receptacle | Move screw tip/thread end to `z=8 mm` | Actual overlap is `3 mm`, below the `4 mm` requirement |
| Misalignment | Offset the receptacle axis by `0.2 mm` | Alignment fails the declared `0.05 mm` offset tolerance |
| Tool obstacle | Add a solid body whose bounds cross the native entry path | Existing sampled `tool.access` reports the blocker, with conservative-bound coverage identified |
| Missing read | Omit the receptacle thread-end reference | Native engagement is unknown; legacy declared evidence is not substituted |

This table is a fixture specification, not a claim that these native Fusion
cases have already been created or qualified.
