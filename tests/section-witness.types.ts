import type {
  FmcadServices,
  SectionSeriesInput,
  SectionSeriesResult,
  SectionWitnessInvocation,
  WitnessCheckInput,
  WitnessCheckResult,
} from "../src/api/contracts";

const section: SectionSeriesInput = {
  body: { kind: "body", name: "BodyA" },
  frame: { space: "component local", component: "root" },
  origin: ["0 mm", "0 mm", "0 mm"],
  normal: [0, 0, 1],
  stations: ["2 mm", "5 mm"],
  limits: {
    stations: 32,
    edges: 2048,
    kernelCalls: 256,
    bytes: 65536,
    timeMs: 10000,
  },
};
const witness: WitnessCheckInput = {
  body: "BodyA",
  witness: "RequiredMaterial",
  frame: { space: "assembly", component: "root" },
  expect: "material",
  volumeTolerance: "0.001 mm^3",
  limits: { kernelCalls: 128, bytes: 65536, timeMs: 10000 },
};
const sectionInvocation: SectionWitnessInvocation = {
  version: 1,
  kind: "cad",
  operation: "measure.section-series",
  doc: "Synthetic",
  data: {
    body: { kind: "body", name: "BodyA" },
    frame: { space: "component local", component: "root" },
    origin: ["0 mm", "0 mm", "0 mm"],
    normal: [0, 0, 1],
    stations: ["2 mm", "5 mm"],
    limits: {
      stations: 32,
      edges: 2048,
      kernelCalls: 256,
      bytes: 65536,
      timeMs: 10000,
    },
  },
};
const witnessInvocation: SectionWitnessInvocation = {
  ...sectionInvocation,
  operation: "measure.witness-check",
  data: {
    body: "BodyA",
    witness: "RequiredMaterial",
    frame: { space: "assembly", component: "root" },
    expect: "material",
    volumeTolerance: "0.001 mm^3",
    limits: { kernelCalls: 128, bytes: 65536, timeMs: 10000 },
  },
};

function narrow(
  result: SectionSeriesResult | WitnessCheckResult,
): boolean | null {
  if (result.operation === "measure.section-series") {
    const unresolved: "partial" | "unknown" = result.coverage;
    const continuous: false = result.coverageDetail.continuous;
    void unresolved;
    void continuous;
    return result.status === "unknown" ? null : true;
  }
  if (result.status === "unknown") {
    const unresolved: null = result.passed;
    void unresolved;
    return null;
  }
  return result.passed;
}
void narrow;

function typedServices(services: FmcadServices) {
  return [
    services.execute(sectionInvocation, { requestId: "section-series" }),
    services.execute(witnessInvocation, { requestId: "witness-check" }),
  ];
}
void typedServices;

const invalidNormal: SectionSeriesInput = {
  ...section,
  // @ts-expect-error a zero vector cannot be represented as a valid fixed-length direction tuple
  normal: [0, 0],
};
void invalidNormal;

const invalidWitness: WitnessCheckInput = {
  ...witness,
  // @ts-expect-error finite proof does not accept sampled-point mode
  expect: "sampled",
};
void invalidWitness;

function noExactPromotion(result: SectionSeriesResult) {
  // @ts-expect-error section-series never claims exact continuous coverage
  const continuous: true = result.coverageDetail.continuous;
  return continuous;
}
void noExactPromotion;
