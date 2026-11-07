# Partial Fusion test model

Model version 1 implements document identity/lifecycle, literal length user parameters,
and a **test state export**. The exported `.f3d` fixture contains a JSON marker
`nativeF3d: false`; it is not a native Fusion archive and must not be imported into Fusion.
Native export/import assertions require `native-f3d`, which this model does not advertise.

The Python process persists one Application shared by all scenarios, so cross-document
routing faults remain observable. It executes the submitted source, never precomputed
answers selected by test name. Unsupported members fail; no generic mock returns success.

Signatures are checked against the verified Autodesk snapshot selected by
`runtime/python/typing/current.json` (initially commit
`07814d19ac63bb3ff0d55e3d35517cf3a71bad8c`). Types specify interface, not behavior.
Parameter units and owner isolation follow `tests/live-normal-multidocument.ts`;
the unsaved-document export precondition still requires live qualification.

No geometry kernel, cloud DataFile, parameter expression engine, camera or UI event
simulation is provided. This directory is test-only and excluded from the published package.
