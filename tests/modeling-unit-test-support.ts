export interface Descriptor {
  summary: string;
  readOnly: boolean;
  limitations: string[];
  required: string[];
  inputs: Record<string, string>;
  example: Record<string, unknown>;
  nodeOnly?: boolean;
  internalOnly?: boolean;
  envelope?: boolean;
  surface?: boolean;
  featureRework?: boolean;
}
export interface ModelingApi {
  catalog: Record<string, Descriptor>;
  validateCad(operation: string, data: unknown): Descriptor;
  buildCadScript(operation: string, data: unknown, context: unknown): string;
  executeCad(
    client: unknown,
    operation: string,
    data: unknown,
    context: unknown,
  ): Promise<{
    status: string;
    success: boolean;
    affected: unknown;
    result: { actual: unknown };
  }>;
}
export interface CurvePlan {
  geometry: { start: string[] }[];
  provenance: { sha256: string };
  loops: unknown[];
  sampleMap: { index: number; point: number[]; line: number; status: string }[];
}
export interface Manual {
  sections: { title: string }[];
  audit: { tests: string[] };
  examples: { data: unknown }[];
}
export interface NativeRequest {
  object: { readOnly: boolean; script: string };
}
