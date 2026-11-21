/** Validated measurement boundaries; missing evidence remains missing. */
export function json(source: string): unknown {
  return JSON.parse(source);
}
export type Fields = Record<string, unknown>;
export function record(value: unknown): Fields {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected benchmark object");
  return value as Fields;
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected benchmark text");
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Expected benchmark array");
  return value;
}
export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError("Expected finite benchmark number");
  return value;
}
const optionalNumber = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError("Expected finite benchmark measurement");
  return value;
};
const optionalText = (value: unknown): string | undefined =>
  value === undefined ? undefined : text(value);
const optionalStrings = (value: unknown): string[] | undefined =>
  value === undefined ? undefined : array(value).map(text);
export interface FakeQueue extends Fields {
  wrapperCalls?: number | undefined;
  registerCalls?: number | undefined;
  queueSummaryCalls?: number | undefined;
  requestBytes?: number | undefined;
  responseBytes?: number | undefined;
}
export interface Sample extends Fields {
  operationMs?: number | undefined;
  rssBytes?: number | undefined;
  bytes?: number | undefined;
  sha256?: string | undefined;
  exportCount?: number | undefined;
  processLaunchCalls?: number | undefined;
  newActiveResources?: string[] | undefined;
  newActiveHandles?: string[] | undefined;
  statusMs?: number | null | undefined;
  catalogTools?: number | null | undefined;
  catalogBytes?: number | null | undefined;
  catalogFrameBytes?: number | null | undefined;
  fakeRpcOperationMs?: number | undefined;
  fakeQueue?: FakeQueue | undefined;
  warmSamples?: Sample[] | undefined;
}
export interface WorkerData extends Fields {
  status?: string | undefined;
  processCount?: number | undefined;
  childProcessLaunchCalls?: number | undefined;
  operationMs?: number | undefined;
  rssBytes?: number | undefined;
  first?: Sample | undefined;
  warmSamples?: Sample[] | undefined;
  clients?: Run[] | undefined;
  fakeQueue?: FakeQueue | undefined;
}
export interface Run extends Fields {
  status?: string | undefined;
  elapsedMs?: number | undefined;
  processCount?: number | undefined;
  data?: WorkerData | null | undefined;
}
export interface Workload {
  coldRuns: Run[];
  warmRuns: Run[];
}
export interface FinalRuntime extends Fields {
  version?: number | undefined;
  fixtureSha256?: string | undefined;
  isolation?: Fields | undefined;
  workloads: Record<string, Workload>;
  status?: string | undefined;
}
export interface PackageData {
  size?: number | undefined;
  unpackedSize?: number | undefined;
  entryCount?: number | undefined;
}
export interface PackageMeasurement extends Fields {
  status?: string | undefined;
  elapsedMs?: number | undefined;
  processCount?: number | undefined;
  data?: PackageData[] | null | undefined;
}
export interface Report extends Fields {
  source?: string | undefined;
  environment?: Fields | undefined;
  finalRuntime?: FinalRuntime | undefined;
  suites: Record<string, Fields & { status?: string | undefined }>;
  measurements: Record<string, unknown> & {
    package?: PackageMeasurement | undefined;
  };
}
export function fakeQueue(value: unknown): FakeQueue {
  const r = record(value);
  return {
    ...r,
    wrapperCalls: optionalNumber(r["wrapperCalls"]),
    registerCalls: optionalNumber(r["registerCalls"]),
    queueSummaryCalls: optionalNumber(r["queueSummaryCalls"]),
    requestBytes: optionalNumber(r["requestBytes"]),
    responseBytes: optionalNumber(r["responseBytes"]),
  };
}
export function sample(value: unknown): Sample {
  const r = record(value);
  const nullable = (key: string) =>
    r[key] === null ? null : optionalNumber(r[key]);
  return {
    ...r,
    operationMs: optionalNumber(r["operationMs"]),
    rssBytes: optionalNumber(r["rssBytes"]),
    bytes: optionalNumber(r["bytes"]),
    sha256: optionalText(r["sha256"]),
    exportCount: optionalNumber(r["exportCount"]),
    processLaunchCalls: optionalNumber(r["processLaunchCalls"]),
    newActiveResources: optionalStrings(r["newActiveResources"]),
    newActiveHandles: optionalStrings(r["newActiveHandles"]),
    statusMs: nullable("statusMs"),
    catalogTools: nullable("catalogTools"),
    catalogBytes: nullable("catalogBytes"),
    catalogFrameBytes: nullable("catalogFrameBytes"),
    fakeRpcOperationMs: optionalNumber(r["fakeRpcOperationMs"]),
    fakeQueue:
      r["fakeQueue"] === undefined ? undefined : fakeQueue(r["fakeQueue"]),
    warmSamples:
      r["warmSamples"] === undefined
        ? undefined
        : array(r["warmSamples"]).map(sample),
  };
}
export function workerData(value: unknown): WorkerData {
  const r = record(value);
  return {
    ...r,
    status: optionalText(r["status"]),
    processCount: optionalNumber(r["processCount"]),
    childProcessLaunchCalls: optionalNumber(r["childProcessLaunchCalls"]),
    operationMs: optionalNumber(r["operationMs"]),
    rssBytes: optionalNumber(r["rssBytes"]),
    first: r["first"] === undefined ? undefined : sample(r["first"]),
    warmSamples:
      r["warmSamples"] === undefined
        ? undefined
        : array(r["warmSamples"]).map(sample),
    clients:
      r["clients"] === undefined ? undefined : array(r["clients"]).map(run),
    fakeQueue:
      r["fakeQueue"] === undefined ? undefined : fakeQueue(r["fakeQueue"]),
  };
}
export function run(value: unknown): Run {
  const r = record(value);
  return {
    ...r,
    status: optionalText(r["status"]),
    elapsedMs: optionalNumber(r["elapsedMs"]),
    processCount: optionalNumber(r["processCount"]),
    data:
      r["data"] === null || r["data"] === undefined
        ? r["data"]
        : workerData(r["data"]),
  };
}
export function finalRuntime(value: unknown): FinalRuntime {
  const r = record(value),
    workloads: Record<string, Workload> = {};
  for (const [name, value] of Object.entries(record(r["workloads"] ?? {}))) {
    const workload = record(value);
    workloads[name] = {
      coldRuns: array(workload["coldRuns"] ?? []).map(run),
      warmRuns: array(workload["warmRuns"] ?? []).map(run),
    };
  }
  return {
    ...r,
    version: optionalNumber(r["version"]),
    fixtureSha256: optionalText(r["fixtureSha256"]),
    status: optionalText(r["status"]),
    isolation:
      r["isolation"] === undefined ? undefined : record(r["isolation"]),
    workloads,
  };
}
export function packageData(value: unknown): PackageData[] {
  return array(value).map((value) => {
    const r = record(value);
    return {
      size: optionalNumber(r["size"]),
      unpackedSize: optionalNumber(r["unpackedSize"]),
      entryCount: optionalNumber(r["entryCount"]),
    };
  });
}
export function report(value: unknown): Report {
  const r = record(value),
    suites: Report["suites"] = {},
    measurements = record(r["measurements"] ?? {});
  for (const [name, value] of Object.entries(record(r["suites"] ?? {})))
    suites[name] = { status: optionalText(record(value)["status"]) };
  const p =
    measurements["package"] === undefined
      ? undefined
      : record(measurements["package"]);
  return {
    ...r,
    source: optionalText(r["source"]),
    environment:
      r["environment"] === undefined ? undefined : record(r["environment"]),
    finalRuntime:
      r["finalRuntime"] === undefined
        ? undefined
        : finalRuntime(r["finalRuntime"]),
    suites,
    measurements: {
      ...measurements,
      package:
        p === undefined
          ? undefined
          : {
              ...p,
              status: optionalText(p["status"]),
              elapsedMs: optionalNumber(p["elapsedMs"]),
              processCount: optionalNumber(p["processCount"]),
              data:
                p["data"] === undefined || p["data"] === null
                  ? p["data"]
                  : packageData(p["data"]),
            },
    },
  };
}
