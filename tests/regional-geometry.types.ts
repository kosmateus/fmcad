import type {
  GeometryCompareRegionInput,
  RegionalGeometryResult,
} from "../packages/core/src/domain/regional-geometry";
import type {
  FmcadServices,
  RegionalGeometryInvocation,
} from "../src/api/contracts";

const request: GeometryCompareRegionInput = {
  before: "before",
  after: "after",
  frame: { space: "assembly", component: "root" },
  allowed: { include: ["mask"], exclude: ["hole"] },
};
void request;

function consume(result: RegionalGeometryResult): number | null {
  if (result.status === "unknown") {
    const unresolved: null = result.passed;
    void unresolved;
    // @ts-expect-error unresolved data cannot masquerade as exact geometry
    return result.delta.added.total.volume;
  }
  return result.delta.added.outsideAllowed.volume;
}
void consume;

const incomplete: GeometryCompareRegionInput = {
  before: "a",
  after: "b",
  // @ts-expect-error no implicit frame or guessed component
  frame: { space: "assembly" },
  allowed: { include: [] },
};
void incomplete;

function typedCadService(services: FmcadServices) {
  const delta: RegionalGeometryInvocation = {
    version: 1,
    kind: "cad",
    operation: "geometry.delta",
    doc: "synthetic",
    docId: "doc-1",
    data: {
      before: "before",
      after: "after",
      frame: { space: "assembly", component: "root" },
    },
  };
  const compare: RegionalGeometryInvocation = {
    ...delta,
    operation: "geometry.compare-region",
    data: {
      before: "before",
      after: "after",
      frame: { space: "assembly", component: "root" },
      allowed: { include: ["allowed"] },
    },
  };
  return [
    services.execute(delta, { requestId: "regional-delta" }),
    services.execute(compare, { requestId: "regional-compare" }),
  ];
}
void typedCadService;
