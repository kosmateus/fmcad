export function envelope<T extends Record<string, unknown>>(
  operation: string,
  result: T,
  status: string,
  warnings: string[],
  provenance: unknown[],
  created: string[],
) {
  return {
    schemaVersion: 1,
    success: !["fail", "blocked"].includes(status),
    status,
    operation,
    documentIdentity: result["documentIdentity"] || null,
    result,
    created,
    affected: [],
    units: { length: "mm", angle: "rad" },
    frame: "sheet",
    associativity: "snapshot",
    warnings,
    provenance,
    method:
      "Semantic external drawing artifacts (SVG/PDF/DXF) with item table, balloons and source map; no native Fusion drawing.",
    limitations: [
      "External artifact generation only; no native Fusion Drawing authoring, associativity or screenshot substitution.",
      "GD&T supported range: datum plane/axis features and flatness, position, perpendicularity, parallelism frames; other controls are rejected, never approximated.",
      "ESTIMATED/OPEN/DERIVED values cannot become production tolerances; OPEN sources block the package.",
      "Geometry checks are 2D sheet-space comparisons of declared entities; no 3D model verification. See docs/DRAWING.md for the manual native workflow.",
    ],
    nativeAcceptance: "notEvaluated",
  };
}
