import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import type {
  PythonChecker,
  PythonCheckContext,
  PythonCheckDiagnostic,
  PythonCheckAbortSignal,
  PythonCheckReport,
  PythonCheckRequest,
} from "../../../core/src/domain/python-checker.js";
import type {
  PreparedPythonArtifact,
  PythonSourceMapEntry,
} from "../../../core/src/domain/python-artifact.js";
import { preparePythonArtifact, verifyPythonArtifact } from "./artifact.js";
import { cadBundleUnits } from "./bundle.js";
import { mapPythonOrigin } from "./context-binding.js";
import {
  checkerHash,
  checkerObject,
  stageCheckerDefinitions,
} from "./checker-definitions.js";
import { runCheckerProcess } from "./checker-process.js";
import type { CheckerProcessLimits } from "./checker-process.js";

export interface PythonCheckerOptions {
  /** runtime/python/typing, from the installed runtime path resolver. */
  readonly typingRoot: string;
  readonly definitionsRoot?: string;
  readonly pythonExecutable?: string;
  readonly pythonVersion?: "3.10" | "3.11" | "3.12";
  /** Target SDK host, independent of the offline checker process host. */
  readonly pythonPlatform?: "Windows" | "Linux" | "Darwin";
  readonly temporaryRoot?: string;
  readonly limits?: Partial<CheckerProcessLimits>;
  /** Production admission supplies a content-tree fingerprint that it fences
   * before and after this check; standalone checker use hashes the engine here. */
  readonly checkerResources?: () => string;
  /** Explicit process seam for deterministic failure tests, not user configuration. */
  readonly engineEntrypoint?: string;
}
interface Unit {
  id: string;
  filename: string;
  source: string;
  analysisSourceHash: string;
  originalSourceHash?: string;
  originalSourceFile?: string;
  sha256?: string;
  context: PythonCheckContext;
  insert: number;
  gaps: number[];
  early: { line: number; column: number }[];
  directives: number[];
  top_calls: number[];
  analysisColumnAdjustments?: { line: number; afterColumn: number; delta: number }[];
  sanitizedLiterals?: { filename: string; unitId: string; sourceHash: string }[];
  projectedBodies?: { id: string; unitId: string; startLine: number; endLine: number; sha256: string }[];
  has_run: boolean;
  run_line: number;
}
interface ProjectionBody {
  readonly id: string;
  readonly unitId: string;
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly bodyStartLine: number;
  readonly bodyEndLine: number;
  readonly bodyHash: string;
  readonly policy: "projectable" | "preserved";
  readonly weight: number;
}
interface PythonAnalysisPlan {
  readonly version: 1;
  readonly unitHashes: readonly { id: string; filename: string; role: string; sha256: string }[];
  readonly groups: readonly (readonly string[])[];
  readonly bodyInventory: readonly ProjectionBody[];
  readonly classUseWitnesses: Readonly<Record<string, string>>;
  readonly classUseOwners: Readonly<Record<string, {
    readonly unitId: string;
    readonly line: number;
    readonly column: number;
  }>>;
  readonly sha256: string;
}
interface AnalysisProjection {
  readonly plan: PythonAnalysisPlan;
  readonly groupIndex: number;
  readonly selectedUnitIds: readonly string[];
  readonly sourceMap: readonly PythonSourceMapEntry[];
  readonly sourceHash: string;
  readonly checkerUnitId: string;
}
interface OriginProjectionMetadata {
  readonly sourceHash: string;
  readonly sourceMap: readonly PythonSourceMapEntry[];
  readonly units: readonly { id: string; filename: string; role: string; sha256: string }[];
  readonly segments: readonly { sha256: string; startLine: number; endLine: number }[];
}
interface ProjectionSourceMetadata {
  readonly id: string;
  readonly filename: string;
  readonly role: string;
  readonly sha256: string;
  readonly source?: string;
}
function aggregateAnalysisReports(
  reports: readonly PythonCheckReport[],
  plan: PythonAnalysisPlan,
  limits: CheckerProcessLimits,
): PythonCheckReport {
  const first = reports[0];
  if (!first)
    return {
      status: "tool_error",
      diagnostics: [],
      reasons: ["Aggregate checker produced no analysis passes"],
      provenance: {
        artifactHash: "invalid", wireHash: "invalid", checker: "basedpyright",
        checkerVersion: "1.40.2", checkerHash: null, pythonVersion: "unknown",
        pythonInterpreterVersion: null, definitionsHash: null, contextHash: "invalid",
        configHash: null, typingHash: null, analysisHash: null, cache: "disabled",
      },
    };
  if (reports.length !== plan.groups.length)
    return {
      status: "tool_error",
      diagnostics: [],
      reasons: [
        `Aggregate checker completed ${reports.length} of ${plan.groups.length} required analyses`,
      ],
      provenance: first.provenance,
    };
  const { analysisHash: _firstAnalysisHash, ...identity } = first.provenance;
  void _firstAnalysisHash;
  const sameIdentity = reports.every((report) => {
    const { analysisHash: _analysisHash, ...current } = report.provenance;
    void _analysisHash;
    return stableJson(current) === stableJson(identity);
  });
  if (!sameIdentity)
    return {
      status: "tool_error",
      diagnostics: [],
      reasons: ["Aggregate checker provenance changed between analysis passes"],
      provenance: first.provenance,
    };
  const diagnostics = new Map<string, PythonCheckDiagnostic>();
  const reasons = new Set<string>();
  for (const report of reports) {
    for (const diagnostic of report.diagnostics)
      diagnostics.set(stableJson(diagnostic), diagnostic);
    for (const reason of report.reasons) reasons.add(reason);
  }
  const combinedDiagnostics = [...diagnostics.values()];
  const combinedReasons = [...reasons];
  const passHashes = reports.map((report) => report.provenance.analysisHash);
  const provenance = {
    ...identity,
    analysisHash: checkerHash(stableJson({
      policy: "fmcad-python-aggregate-analysis-v1",
      artifactHash: identity.artifactHash,
      planHash: plan.sha256,
      passHashes,
    })),
  };
  if (
    combinedDiagnostics.length > 2000 ||
    Buffer.byteLength(JSON.stringify({ combinedDiagnostics, combinedReasons, provenance })) > limits.outputBytes
  )
    return {
      status: "tool_error",
      diagnostics: [],
      reasons: ["Aggregate checker report exceeds output limit"],
      provenance,
    };
  const status: PythonCheckReport["status"] = reports.some((report) => report.status === "tool_error")
    ? "tool_error"
    : reports.some((report) => report.status === "failed")
      ? "failed"
      : reports.some((report) => report.status === "incomplete")
        ? "incomplete"
        : "passed";
  return { status, diagnostics: combinedDiagnostics, reasons: combinedReasons, provenance };
}
const defaults: CheckerProcessLimits = {
  timeoutMs: 30_000,
  outputBytes: 2 * 1024 * 1024,
  memoryBytes: 768 * 1024 * 1024,
};
const incompleteRules =
  /Unknown|MissingImports|MissingModuleSource|MissingTypeStubs|MissingParameterType|reportAny|reportExplicitAny|reportUntyped/;
const entrypointImport =
  "from typing import Callable as _fmcad_checked_callable";
const entrypointDeclaration =
  "_fmcad_checked_entrypoint: _fmcad_checked_callable[[str], object] = run";
const checksEntrypoint = (unit: Unit): boolean =>
  unit.context.entrypoint === "run" ||
  (unit.context.entrypoint === "run-if-present" && unit.has_run);

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Value is not JSON serializable");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`,
  ).join(",")}}`;
}

function originProjectionMetadata(artifact: PreparedPythonArtifact): OriginProjectionMetadata | null {
  if (!artifact.context || typeof artifact.context !== "object" || Array.isArray(artifact.context))
    return null;
  const context = checkerObject(artifact.context);
  if (context["origin"] === undefined) return null;
  const origin = checkerObject(context["origin"]);
  const sourceHash = origin["sha256"];
  const rawMap = origin["sourceMap"];
  const rawUnits = origin["units"];
  const rawSegments = origin["segments"];
  if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash) ||
      !Array.isArray(rawMap) || !Array.isArray(rawUnits) ||
      (rawSegments !== undefined && !Array.isArray(rawSegments)) ||
      (Array.isArray(rawSegments) && rawSegments.length > 256))
    throw new Error("Invalid retained Python source origin");
  const sourceMap: PythonSourceMapEntry[] = rawMap.map((raw) => {
    const entry = checkerObject(raw);
    const unitId = entry["unitId"], generatedStartLine = entry["generatedStartLine"];
    const generatedEndLine = entry["generatedEndLine"], sourceStartLine = entry["sourceStartLine"];
    if (typeof unitId !== "string" || !Number.isSafeInteger(generatedStartLine) ||
        !Number.isSafeInteger(generatedEndLine) || !Number.isSafeInteger(sourceStartLine) ||
        Number(generatedStartLine) < 1 || Number(generatedEndLine) < Number(generatedStartLine) ||
        Number(sourceStartLine) < 1)
      throw new Error("Invalid retained Python source map");
    return {
      unitId,
      generatedStartLine: Number(generatedStartLine),
      generatedEndLine: Number(generatedEndLine),
      sourceStartLine: Number(sourceStartLine),
    };
  });
  const units = rawUnits.map((raw) => {
    const unit = checkerObject(raw);
    const id = unit["id"], filename = unit["filename"], role = unit["role"], sha256 = unit["sha256"];
    if (typeof id !== "string" || typeof filename !== "string" || typeof role !== "string" ||
        typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256))
      throw new Error("Invalid retained Python source-unit inventory");
    return { id, filename, role, sha256 };
  });
  const segments = (rawSegments ?? []).map((raw) => {
    const segment = checkerObject(raw);
    const sha256 = segment["sha256"];
    const startLine = segment["startLine"];
    const endLine = segment["endLine"];
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) ||
        !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
        Number(startLine) < 1 || Number(endLine) < Number(startLine))
      throw new Error("Invalid retained Python origin segment");
    return { sha256, startLine: Number(startLine), endLine: Number(endLine) };
  });
  const mappedUnitIds = new Set(sourceMap.map((entry) => entry.unitId));
  if (!sourceMap.length || mappedUnitIds.size !== sourceMap.length ||
      sourceMap.some((entry) => !units.some((unit) => unit.id === entry.unitId)) ||
      units.some((unit) => unit.role === "runtime" && !mappedUnitIds.has(unit.id)))
    throw new Error("Retained Python source map does not bind its declared units");
  return { sourceHash, sourceMap, units, segments };
}

function verifiedArtifactSourceMap(artifact: PreparedPythonArtifact): Set<string> {
  const entries = new Map(artifact.sourceMap.map((entry) => [entry.unitId, entry]));
  if (entries.size !== artifact.sourceMap.length)
    throw new Error("Prepared Python source map contains duplicate units");
  const mapped = artifact.units.filter((unit) => entries.has(unit.id));
  if (mapped.length !== entries.size ||
      JSON.stringify(mapped.map((unit) => unit.id)) !==
        JSON.stringify(artifact.sourceMap.map((entry) => entry.unitId)))
    throw new Error("Prepared Python source map has an unknown or reordered unit");
  let generatedStartLine = 1;
  const sourceParts: string[] = [];
  for (const unit of mapped) {
    const entry = entries.get(unit.id)!;
    const lineCount = unit.source.split("\n").length;
    if (entry.generatedStartLine !== generatedStartLine ||
        entry.generatedEndLine !== generatedStartLine + lineCount - 1 ||
        entry.sourceStartLine !== 1)
      throw new Error("Prepared Python source map does not match its source bytes");
    sourceParts.push(unit.source);
    generatedStartLine += lineCount + 1;
  }
  if (!mapped.length || sourceParts.join("\n\n") !== artifact.script)
    throw new Error("Prepared Python source map does not cover the final script");
  const mappedIds = new Set(mapped.map((unit) => unit.id));
  if (artifact.units.some((unit) => unit.role === "runtime" && !mappedIds.has(unit.id)))
    throw new Error("Runtime source unit is absent from the prepared source map");
  return mappedIds;
}

interface CanonicalBundleRecoveryBinding {
  readonly version: 1;
  readonly mode: "flat-wire" | "queue-literal";
  readonly sourceSha256: string;
  readonly sourceArtifactHash: string;
  readonly sourceMapHash: string;
  readonly unitManifestHash: string;
  readonly embeddedUnitId: string | null;
}
interface CanonicalBundleRecovery {
  readonly artifact: PreparedPythonArtifact;
  readonly binding: CanonicalBundleRecoveryBinding;
}

function recoveredCanonicalSource(
  source: string,
  typingRoot: string,
): PreparedPythonArtifact | null {
  const canonicalUnits = cadBundleUnits(resolve(typingRoot, "../../.."), "full");
  if (!canonicalUnits.length) return null;
  const separator = "\n\n";
  let offset = 0;
  for (const unit of canonicalUnits) {
    if (!source.startsWith(unit.source, offset)) return null;
    offset += unit.source.length;
    if (!source.startsWith(separator, offset)) return null;
    offset += separator.length;
  }
  const rootSource = source.slice(offset);
  const runDefinitions = [...rootSource.matchAll(/^def run\(_context: str\):$/gm)];
  const runOffset = runDefinitions[0]?.index;
  if (runDefinitions.length !== 1 || runOffset === undefined || !rootSource.slice(runOffset).trim())
    return null;
  let separatorStart = runOffset;
  while (separatorStart > 0 && rootSource[separatorStart - 1] === "\n")
    separatorStart--;
  if (runOffset - separatorStart < 2) return null;
  const recovered = preparePythonArtifact(
    [
      ...canonicalUnits,
      {
        id: "wrapper",
        filename: "<fmcad-wrapper>",
        source: rootSource,
        role: "wrapper",
      },
    ],
  );
  if (recovered.script !== source || recovered.sha256 !== checkerHash(source))
    return null;
  return recovered;
}

function recoveryBinding(
  source: PreparedPythonArtifact,
  mode: CanonicalBundleRecoveryBinding["mode"],
  embeddedUnitId: string | null,
): CanonicalBundleRecoveryBinding {
  return {
    version: 1,
    mode,
    sourceSha256: source.sha256,
    sourceArtifactHash: source.artifactHash,
    sourceMapHash: checkerHash(stableJson(source.sourceMap)),
    unitManifestHash: checkerHash(stableJson(source.units.map(({ id, filename, role, sha256 }) => ({
      id, filename, role, sha256,
    })))),
    embeddedUnitId,
  };
}

function recoverCanonicalBundleArtifact(
  artifact: PreparedPythonArtifact,
  typingRoot: string,
): CanonicalBundleRecovery | null {
  if (artifact.units.length === 1 && artifact.context === null && artifact.request === null) {
    const wire = artifact.units[0];
    const sourceMap = artifact.sourceMap[0];
    if (
      wire?.id === "wire" && wire.filename === "<fmcad-wire>" &&
      wire.role === "wrapper" && artifact.sourceMap.length === 1 && sourceMap?.unitId === wire.id &&
      sourceMap.generatedStartLine === 1 && sourceMap.generatedEndLine === artifact.script.split("\n").length &&
      sourceMap.sourceStartLine === 1 && wire.source === artifact.script
    ) {
      const original = recoveredCanonicalSource(artifact.script, typingRoot);
      if (original)
        return {
          artifact: original,
          binding: recoveryBinding(original, "flat-wire", null),
        };
    }
  }

  if (
    artifact.units.length !== 2 || artifact.sourceMap.length !== 1 ||
    !artifact.context || typeof artifact.context !== "object" || Array.isArray(artifact.context)
  )
    return null;
  const context = checkerObject(artifact.context);
  if (context["origin"] !== undefined || !Array.isArray(context["entrypoints"]) ||
      stableJson(context["entrypoints"]) !== stableJson(["<fmcad-queue>"]))
    return null;
  const mappedIds = new Set(artifact.sourceMap.map((entry) => entry.unitId));
  const mapped = artifact.units.filter((unit) => mappedIds.has(unit.id));
  const embedded = artifact.units.filter((unit) => !mappedIds.has(unit.id));
  if (
    mapped.length !== 1 || embedded.length !== 1 ||
    mapped[0]!.id !== "wire" || mapped[0]!.filename !== "<fmcad-wire>" || mapped[0]!.role !== "wrapper" ||
    embedded[0]!.id !== "embedded:0" || embedded[0]!.filename !== "<fmcad-queue>" || embedded[0]!.role !== "user"
  )
    return null;
  const original = recoveredCanonicalSource(embedded[0]!.source, typingRoot);
  if (!original || original.sha256 !== embedded[0]!.sha256)
    return null;

  const origin = {
    artifactHash: original.artifactHash,
    sha256: original.sha256,
    context: original.context,
    request: original.request,
    sourceMap: original.sourceMap,
    segments: [{
      sha256: embedded[0]!.sha256,
      startLine: 1,
      endLine: embedded[0]!.source.split("\n").length,
    }],
    units: original.units.map(({ id, filename, role, sha256 }) => ({ id, filename, role, sha256 })),
  };
  const normalized = preparePythonArtifact(
    artifact.units.map((unit) => ({ ...unit, embedded: !mappedIds.has(unit.id) })),
    { context: { ...context, origin }, request: artifact.request },
  );
  if (normalized.script !== artifact.script || normalized.sha256 !== artifact.sha256)
    return null;
  return {
    artifact: normalized,
    binding: recoveryBinding(original, "queue-literal", embedded[0]!.id),
  };
}

function sourceLineOffsets(source: Buffer): number[] {
  const offsets = [0];
  for (let index = 0; index < source.length; index++)
    if (source[index] === 0x0a) offsets.push(index + 1);
  return offsets;
}

function sourceBodyBytes(
  source: Buffer,
  lineOffsets: readonly number[],
  startLine: number,
  endLine: number,
): Buffer {
  const start = lineOffsets[startLine - 1];
  const end = lineOffsets[endLine] ?? source.length;
  if (start === undefined || end < start)
    throw new Error("Aggregate body range is outside the mapped source");
  return source.subarray(start, end);
}

function verifiedProjectionPlan(
  value: unknown,
  expectedUnits: readonly ProjectionSourceMetadata[],
  projectionUnitIds: ReadonlySet<string>,
): PythonAnalysisPlan {
  const raw = checkerObject(value);
  const version = raw["version"];
  const unitHashes = raw["unitHashes"];
  const groups = raw["groups"];
  const bodyInventory = raw["bodyInventory"];
  const classUseWitnesses = raw["classUseWitnesses"];
  const classUseOwners = raw["classUseOwners"];
  const sha256 = raw["sha256"];
  if (
    version !== 1 || !Array.isArray(unitHashes) || !Array.isArray(groups) ||
    !Array.isArray(bodyInventory) || typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(sha256)
  ) throw new Error("Malformed aggregate analysis plan");
  const declared = new Map<string, ProjectionSourceMetadata>(expectedUnits.map((unit) => [unit.id, unit]));
  const plannedUnits = new Map<string, { id: string; filename: string; role: string; sha256: string }>();
  for (const entryValue of unitHashes) {
    const entry = checkerObject(entryValue);
    const id = entry["id"], filename = entry["filename"], role = entry["role"], sourceHash = entry["sha256"];
    if (typeof id !== "string" || typeof filename !== "string" || typeof role !== "string" ||
        typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash) || plannedUnits.has(id))
      throw new Error("Malformed aggregate source-unit fingerprint");
    const source = declared.get(id);
    if (!source || source.filename !== filename || source.role !== role || source.sha256 !== sourceHash ||
        (source.source !== undefined && checkerHash(source.source) !== sourceHash))
      throw new Error("Aggregate analysis source differs from the prepared artifact");
    plannedUnits.set(id, { id, filename, role, sha256: sourceHash });
  }
  if (plannedUnits.size !== declared.size)
    throw new Error("Aggregate analysis plan omits a declared source unit");

  for (const unitId of projectionUnitIds) {
    if (declared.get(unitId)?.role !== "runtime")
      throw new Error("Aggregate projection scope contains a non-runtime unit");
  }
  const runtimeIds = projectionUnitIds;
  const assigned = new Set<string>();
  for (const groupValue of groups) {
    if (!Array.isArray(groupValue) || !groupValue.length)
      throw new Error("Aggregate analysis contains an empty group");
    for (const id of groupValue) {
      if (typeof id !== "string" || !runtimeIds.has(id) || assigned.has(id))
        throw new Error("Aggregate analysis has an unknown or duplicate runtime unit");
      assigned.add(id);
    }
  }
  if (assigned.size !== runtimeIds.size)
    throw new Error("Aggregate analysis does not assign every runtime unit");
  if ((runtimeIds.size === 0 && groups.length !== 0) ||
      (runtimeIds.size > 0 && groups.length === 0) || groups.length > 16)
    throw new Error("Aggregate analysis group count is outside the bounded policy");

  const bodies: ProjectionBody[] = [];
  const bodyIds = new Set<string>();
  for (const bodyValue of bodyInventory) {
    const item = checkerObject(bodyValue);
    const id = item["id"], unitId = item["unitId"], name = item["name"];
    const line = item["line"], column = item["column"];
    const bodyStartLine = item["bodyStartLine"], bodyEndLine = item["bodyEndLine"];
    const bodyHash = item["bodyHash"], policy = item["policy"], weight = item["weight"];
    if (
      typeof id !== "string" || bodyIds.has(id) || typeof unitId !== "string" || !declared.has(unitId) ||
      typeof name !== "string" || !Number.isSafeInteger(line) || Number(line) < 1 ||
      !Number.isSafeInteger(column) || Number(column) < 0 ||
      !Number.isSafeInteger(bodyStartLine) || Number(bodyStartLine) < 1 ||
      !Number.isSafeInteger(bodyEndLine) || Number(bodyEndLine) < Number(bodyStartLine) ||
      typeof bodyHash !== "string" || !/^[a-f0-9]{64}$/.test(bodyHash) ||
      (policy !== "projectable" && policy !== "preserved") ||
      !Number.isSafeInteger(weight) || Number(weight) < 0
    ) throw new Error("Malformed aggregate function-body inventory");
    if ((policy === "projectable") !== (projectionUnitIds.has(unitId) && Number(weight) > 0))
      throw new Error("Aggregate function body has an inconsistent projection policy");
    bodyIds.add(id);
    bodies.push({
      id, unitId, name, line: Number(line), column: Number(column),
      bodyStartLine: Number(bodyStartLine), bodyEndLine: Number(bodyEndLine),
      bodyHash, policy, weight: Number(weight),
    });
  }
  const witnesses = checkerObject(classUseWitnesses);
  const owners = checkerObject(classUseOwners);
  for (const [name, ownerValue] of Object.entries(owners)) {
    const owner = checkerObject(ownerValue);
    if (!name || typeof owner["unitId"] !== "string" || !declared.has(owner["unitId"]) ||
        !Number.isSafeInteger(owner["line"]) || Number(owner["line"]) < 1 ||
        !Number.isSafeInteger(owner["column"]) || Number(owner["column"]) < 1)
      throw new Error("Aggregate analysis has an invalid class owner");
  }
  for (const [name, bodyId] of Object.entries(witnesses)) {
    const owner = checkerObject(owners[name]);
    const ownerUnitId = owner["unitId"];
    const body = typeof bodyId === "string" ? bodies.find((item) => item.id === bodyId) : undefined;
    if (!name || typeof ownerUnitId !== "string" || !body || body.policy !== "projectable")
      throw new Error("Aggregate analysis has an invalid class-use witness");
    const ownerGroup = projectionUnitIds.has(ownerUnitId)
      ? groups.findIndex((group) => group.includes(ownerUnitId))
      : -1;
    const witnessGroup = groups.findIndex((group) => group.includes(body.unitId));
    if (witnessGroup < 0 || (ownerGroup >= 0 && ownerGroup !== witnessGroup))
      throw new Error("Class declaration and complete use body are separated between groups");
  }

  const material = { version, unitHashes, groups, bodyInventory, classUseWitnesses, classUseOwners };
  if (checkerHash(stableJson(material)) !== sha256)
    throw new Error("Aggregate analysis plan fingerprint mismatch");
  return {
    version: 1,
    unitHashes: unitHashes as PythonAnalysisPlan["unitHashes"],
    groups: groups as PythonAnalysisPlan["groups"],
    bodyInventory: bodies,
    classUseWitnesses: witnesses as Record<string, string>,
    classUseOwners: owners as PythonAnalysisPlan["classUseOwners"],
    sha256,
  };
}

function throwIfAborted(signal?: PythonCheckAbortSignal): void {
  if (signal?.aborted)
    throw Object.assign(new Error("Python checker process was cancelled"), {
      code: "ABORT_ERR",
    });
}

async function hashFiles(
  root: string,
  files: readonly string[],
  signal?: PythonCheckAbortSignal,
): Promise<string[]> {
  const hashes = new Array<string>(files.length);
  let next = 0;
  // Typeshed files are small; bounded whole-file reads avoid thousands of
  // short-lived stream handles while keeping parent-side memory bounded.
  const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
    while (next < files.length) {
      throwIfAborted(signal);
      const index = next++;
      hashes[index] = checkerHash(await readFile(join(root, files[index]!)));
    }
  });
  await Promise.all(workers);
  return hashes;
}

export function createPythonChecker(
  options: PythonCheckerOptions,
): PythonChecker {
  const checkOne = async (
    request: PythonCheckRequest,
    checkOptions: { readonly signal?: PythonCheckAbortSignal },
    projection?: AnalysisProjection,
  ): Promise<PythonCheckReport> => {
      const { signal } = checkOptions;
      let { artifact } = request;
      let sourceRecovery: CanonicalBundleRecoveryBinding | null = null;
      const limits = { ...defaults, ...options.limits };
      const pythonVersion = options.pythonVersion ?? "3.11";
      const provenance: {
        -readonly [
          K in keyof PythonCheckReport["provenance"]
        ]: PythonCheckReport["provenance"][K];
      } = {
        artifactHash: /^[a-f0-9]{64}$/.test(artifact.artifactHash)
          ? artifact.artifactHash
          : "invalid",
        wireHash: /^[a-f0-9]{64}$/.test(artifact.sha256)
          ? artifact.sha256
          : "invalid",
        checker: "basedpyright",
        checkerVersion: "1.40.2",
        checkerHash: null,
        pythonVersion,
        pythonInterpreterVersion: null,
        definitionsHash: null,
        contextHash: checkerHash(
          JSON.stringify({
            context: request.context,
            units: request.unitContexts ?? {},
            metadata: artifact.context,
            request: artifact.request,
          }),
        ),
        configHash: null,
        typingHash: null,
        analysisHash: null,
        cache: "disabled",
      };
      const diagnostics: PythonCheckDiagnostic[] = [];
      const reasons: string[] = [];
      let projectedBytes = 0,
        projectionExceeded = false;
      const accountProjection = (value: unknown): void => {
        projectedBytes += Buffer.byteLength(JSON.stringify(value));
        if (projectedBytes > Math.max(64 * 1024, limits.outputBytes)) {
          projectionExceeded = true;
          throw new Error("Mapped checker report exceeds output limit");
        }
      };
      const addReason = (reason: string): void => {
        accountProjection(reason);
        reasons.push(reason);
      };
      const addDiagnostic = (diagnostic: PythonCheckDiagnostic): void => {
        accountProjection(diagnostic);
        diagnostics.push(diagnostic);
      };
      const report = (
        status: PythonCheckReport["status"],
      ): PythonCheckReport =>
        projectionExceeded
          ? {
              status: "tool_error",
              diagnostics: [],
              reasons: ["Mapped checker report exceeds output limit"],
              provenance,
            }
          : { status, diagnostics, reasons, provenance };
      let directory: string | undefined;
      let temporaryDirectory: string | undefined;
      try {
        throwIfAborted(signal);
        request = structuredClone(request);
        artifact = request.artifact;
        if (
          artifact.bytes.length > 8 * 1024 * 1024 ||
          artifact.units.length > 256 ||
          artifact.units.reduce(
            (total, unit) => total + Buffer.byteLength(unit.source),
            0,
          ) > 16 * 1024 * 1024
        )
          throw new Error("Source inventory limit exceeded");
        verifyPythonArtifact(artifact);
        verifiedArtifactSourceMap(artifact);
        const recovered = recoverCanonicalBundleArtifact(artifact, options.typingRoot);
        if (recovered) {
          artifact = recovered.artifact;
          sourceRecovery = recovered.binding;
        }
        verifyPythonArtifact(artifact);
        if (
          artifact.bytes.length > 8 * 1024 * 1024 ||
          artifact.units.length > 256 ||
          artifact.units.reduce(
            (total, unit) => total + Buffer.byteLength(unit.source),
            0,
          ) > 16 * 1024 * 1024
        )
          throw new Error("Source inventory limit exceeded");
        const originalOrigin = originProjectionMetadata(artifact);
        let projectionSourceMap = originalOrigin?.sourceMap ?? artifact.sourceMap;
        const projectionSourceHash = originalOrigin?.sourceHash ?? artifact.sha256;
        const projectionUnitMetadata = originalOrigin?.units ?? artifact.units;
        const projectionUnitMetadataById = new Map(
          projectionUnitMetadata.map((unit) => [unit.id, unit]),
        );
        const projectionUnitIds = new Set<string>();
        for (const entry of projectionSourceMap) {
          const source = projectionUnitMetadataById.get(entry.unitId);
          if (!source) throw new Error("Source map references an undeclared projection unit");
          if (source.role === "runtime") projectionUnitIds.add(source.id);
        }
        const mappedIds = verifiedArtifactSourceMap(artifact);
        if (
          Object.values(limits).some(
            (value) => !Number.isSafeInteger(value) || value <= 0,
          )
        )
          throw new Error("Invalid checker process limits");
        temporaryDirectory = await mkdtemp(
          join(options.temporaryRoot ?? tmpdir(), "fmcad-check-"),
        );
        directory = join(temporaryDirectory, "analysis");
        const inventoryDirectory = join(temporaryDirectory, "inventory");
        await Promise.all([mkdir(directory), mkdir(inventoryDirectory)]);
        const stubs = join(directory, "stubs");
        await mkdir(stubs);
        if (options.definitionsRoot) {
          try {
            throwIfAborted(signal);
            provenance.definitionsHash = await stageCheckerDefinitions(
              options.definitionsRoot,
              stubs,
            );
            throwIfAborted(signal);
          } catch (error) {
            addReason("Definitions unavailable: " + String(error));
          }
        } else if (
          [request.context, ...Object.values(request.unitContexts ?? {})].some(
            (context) =>
              context.kind !== "raw" ||
              context.app ||
              context.ui ||
              context.deferredFacade,
          )
        )
          addReason("SDK definitions producer is not configured");
        const typing = await readFile(
          join(options.typingRoot, "fmcad_context.pyi"),
        );
        const helper = await readFile(
          join(options.typingRoot, "checker-project.py"),
        );
        const injected =
          "import adsk.core\nfrom fmcad_context import Facade\napp: adsk.core.Application\nui: adsk.core.UserInterface\nFMCAD: Facade\n";
        provenance.typingHash = checkerHash(
          Buffer.concat([
            typing,
            helper,
            Buffer.from(injected),
            Buffer.from(entrypointImport + "\n" + entrypointDeclaration),
          ]),
        );
        await writeFile(join(stubs, "fmcad_context.pyi"), typing);
        await writeFile(join(stubs, "fmcad_injected.pyi"), injected);
        const helperPath = join(inventoryDirectory, "project.py");
        await writeFile(helperPath, helper);
        const seeds = [
          {
            id: "wire",
            filename: "<fmcad-artifact>",
            source: artifact.script,
            sha256: artifact.sha256,
            context: request.context,
          },
          ...artifact.units
            .filter((unit) => !mappedIds.has(unit.id))
            .map((unit) => ({
              ...unit,
              context: request.unitContexts?.[unit.id] ?? {
                kind: "raw" as const,
              },
            })),
        ];
        const inventory = await runCheckerProcess(
          options.pythonExecutable ?? "python3",
          ["-I", "-S", helperPath],
          inventoryDirectory,
          limits,
          JSON.stringify({
            units: seeds,
            ...(projection
              ? { skipAnalysisPlan: true }
              : originalOrigin
                ? {}
                : {
                    sourceUnits: artifact.units.map((unit) => ({
                      id: unit.id,
                      filename: unit.filename,
                      role: unit.role,
                      sha256: unit.sha256,
                      source: unit.source,
                    })),
                  }),
            projectionUnitIds: [...projectionUnitIds],
          }),
          signal,
        );
        if (inventory.problem || inventory.code !== 0)
          throw new Error(
            "AST inventory failed: " + (inventory.problem ?? inventory.stderr),
          );
        const prepared = checkerObject(JSON.parse(inventory.stdout) as unknown);
        if (typeof prepared["pythonVersion"] !== "string")
          throw new Error("Missing Python interpreter identity");
        provenance.pythonInterpreterVersion = prepared["pythonVersion"];
        const preparedPlan = prepared["analysisPlan"];
        const units = prepared["units"] as Unit[];
        if (!Array.isArray(units) || units.length > 256)
          throw new Error("Invalid AST inventory");
        const seedsById = new Map(seeds.map((seed) => [seed.id, seed]));
        for (const unit of units) {
          const literals = unit.sanitizedLiterals ?? [];
          const adjustments = unit.analysisColumnAdjustments ?? [];
          if (
            !Array.isArray(literals) ||
            !Array.isArray(adjustments) ||
            literals.length !== adjustments.length
          )
            throw new Error("Invalid sanitized-source map");
          for (let index = 0; index < literals.length; index++) {
            const literal = literals[index]!;
            const adjustment = adjustments[index]!;
            const seed = seedsById.get(literal.unitId);
            if (
              unit.id !== "wire" ||
              !seed ||
              seed.id === "wire" ||
              seed.filename !== literal.filename ||
              checkerHash(seed.source) !== literal.sourceHash ||
              !Number.isSafeInteger(adjustment.line) ||
              adjustment.line < 1 ||
              !Number.isSafeInteger(adjustment.afterColumn) ||
              adjustment.afterColumn < 1 ||
              !Number.isSafeInteger(adjustment.delta) ||
              adjustment.delta <= 0
            )
              throw new Error(
                "Sanitized wrapper literal is not bound to a complete checked source unit",
              );
          }
        }
        let analysisBytes = 0;
        for (const [index, unit] of units.entries()) {
          throwIfAborted(signal);
          const source = await readFile(
            join(inventoryDirectory, `source-${index}.txt`),
          );
          analysisBytes += source.length;
          if (
            analysisBytes > 16 * 1024 * 1024 ||
            checkerHash(source) !== unit.analysisSourceHash
          )
            throw new Error("Analyzed source inventory content/size mismatch");
          unit.source = source.toString("utf8");
        }
        if (
          seeds.some(
            (seed) =>
              !units.some(
                (unit) =>
                  unit.id === seed.id &&
                  unit.filename === seed.filename &&
                  unit.sha256 === seed.sha256 &&
                  JSON.stringify(unit.context) === JSON.stringify(seed.context),
              ),
          )
        )
          throw new Error(
            "AST inventory omitted or changed a required source namespace",
          );
        let expectedPlanUnits: readonly ProjectionSourceMetadata[];
        let analysisPlan: PythonAnalysisPlan;
        let projectionCheckerUnitId = "wire";
        const projectionClassUses = new Map<string, {
          readonly ownerUnitId: string;
          readonly line: number;
          readonly column: number;
          readonly witnessGroup: number;
        }>();
        if (originalOrigin) {
          const mappedUnitIds = new Set(originalOrigin.sourceMap.map((entry) => entry.unitId));
          const extraUnits: (ProjectionSourceMetadata & { source: string })[] = [];
          for (const sourceUnit of originalOrigin.units) {
            if (mappedUnitIds.has(sourceUnit.id)) continue;
            const embedded = artifact.units.find((unit) =>
              unit.filename === sourceUnit.filename && unit.sha256 === sourceUnit.sha256);
            if (!embedded)
              throw new Error("Retained embedded source is absent from the final artifact");
            extraUnits.push({ ...sourceUnit, source: embedded.source });
          }
          let originalWireIndex = units.findIndex((unit) =>
            unit.originalSourceHash === originalOrigin.sourceHash);
          let originalSourcePath = units[originalWireIndex]?.originalSourceFile;
          if (originalWireIndex < 0 || !originalSourcePath) {
            // A broker transport can wrap the exact admitted source with a
            // guard/entrypoint. In that case the source is a verified line
            // span of the final wire unit, rather than a separate compile()
            // literal discoverable by the AST inventory.
            let retained: { unitIndex: number; bytes: Buffer } | undefined;
            for (const segment of originalOrigin.segments) {
              const unitIndex = units.findIndex((unit) =>
                unit.originalSourceHash === segment.sha256 && unit.originalSourceFile);
              if (unitIndex < 0) continue;
              const full = await readFile(join(inventoryDirectory, units[unitIndex]!.originalSourceFile!));
              if (checkerHash(full) !== segment.sha256)
                throw new Error("Retained origin wire source hash changed");
              const lines = full.toString("utf8").split("\n");
              if (segment.endLine > lines.length)
                throw new Error("Retained origin source span is outside the wire source");
              const bytes = Buffer.from(
                lines.slice(segment.startLine - 1, segment.endLine).join("\n"),
                "utf8",
              );
              if (checkerHash(bytes) !== originalOrigin.sourceHash)
                throw new Error("Retained origin source span does not match its manifest");
              retained = { unitIndex, bytes };
              // The projection runs on the full inventoried wire unit (which
              // can include an add-in UI guard), not on retained.bytes. Keep
              // local source/body IDs unchanged, but translate generated lines
              // by the exact already hash-verified retained span offset.
              projectionSourceMap = originalOrigin.sourceMap.map((entry) => ({
                ...entry,
                generatedStartLine: entry.generatedStartLine + segment.startLine - 1,
                generatedEndLine: entry.generatedEndLine + segment.startLine - 1,
              }));
              break;
            }
            if (!retained)
              throw new Error("Original compiled helper source is absent from the checker inventory");
            originalWireIndex = retained.unitIndex;
            originalSourcePath = "retained-origin-source.txt";
            await writeFile(join(inventoryDirectory, originalSourcePath), retained.bytes, { flag: "wx" });
          }
          const originalSource = await readFile(join(inventoryDirectory, originalSourcePath));
          if (checkerHash(originalSource) !== originalOrigin.sourceHash)
            throw new Error("Original compiled helper source hash differs from its origin manifest");
          expectedPlanUnits = [
            ...originalOrigin.units.filter((unit) => mappedUnitIds.has(unit.id)),
            ...extraUnits,
          ];
          projectionCheckerUnitId = units[originalWireIndex]!.id;
          if (projection) {
            // The parent pass already derived this plan from the exact original
            // source. Re-verify its complete unit/body/hash inventory against
            // this pass's freshly inventoried artifact instead of rescanning
            // every function body in a Python subprocess for each group.
            analysisPlan = verifiedProjectionPlan(
              projection.plan, expectedPlanUnits, projectionUnitIds);
          } else {
            const planResult = await runCheckerProcess(
              options.pythonExecutable ?? "python3",
              ["-I", "-S", helperPath],
              inventoryDirectory,
              limits,
              JSON.stringify({
                analysisSourcePath: originalSourcePath,
                analysisSourceHash: originalOrigin.sourceHash,
                sourceMap: originalOrigin.sourceMap,
                sourceUnits: originalOrigin.units,
                extraUnits,
                projectionUnitIds: [...projectionUnitIds],
              }),
              signal,
            );
            if (planResult.problem || planResult.code !== 0 || planResult.stderr.trim())
              throw new Error("Original source projection plan: " +
                (planResult.problem ?? (planResult.stderr || "invalid plan exit")));
            const planObject = checkerObject(JSON.parse(planResult.stdout) as unknown);
            analysisPlan = verifiedProjectionPlan(
              planObject["analysisPlan"], expectedPlanUnits, projectionUnitIds);
          }
        } else {
          expectedPlanUnits = artifact.units;
          analysisPlan = verifiedProjectionPlan(
            projection ? projection.plan : preparedPlan,
            expectedPlanUnits,
            projectionUnitIds,
          );
        }
        if (!projection && analysisPlan.groups.length > 1) {
          if (temporaryDirectory) {
            await rm(temporaryDirectory, { recursive: true, force: true });
            temporaryDirectory = undefined;
            directory = undefined;
          }
          const reports: PythonCheckReport[] = [];
          for (const [groupIndex, selectedUnitIds] of analysisPlan.groups.entries()) {
            throwIfAborted(signal);
            const childReport = await checkOne(request, checkOptions, {
              plan: analysisPlan,
              groupIndex,
              selectedUnitIds,
              sourceMap: projectionSourceMap,
              sourceHash: projectionSourceHash,
              checkerUnitId: projectionCheckerUnitId,
            });
            reports.push(childReport);
            if (childReport.status === "tool_error") break;
          }
          return aggregateAnalysisReports(reports, analysisPlan, limits);
        }
        if (projection) {
          if (
            analysisPlan.sha256 !== projection.plan.sha256 ||
            projection.groupIndex < 0 ||
            projection.groupIndex >= analysisPlan.groups.length ||
            stableJson(analysisPlan.groups[projection.groupIndex]) !== stableJson(projection.selectedUnitIds)
          )
            throw new Error("Aggregate checker plan changed between passes");
          const bodiesById = new Map(
            analysisPlan.bodyInventory.map((body) => [body.id, body]),
          );
          for (const [name, bodyId] of Object.entries(analysisPlan.classUseWitnesses)) {
            const owner = analysisPlan.classUseOwners[name];
            const body = bodiesById.get(bodyId);
            const witnessGroup = body
              ? analysisPlan.groups.findIndex((group) => group.includes(body.unitId))
              : -1;
            if (!owner || !body || witnessGroup < 0)
              throw new Error("Aggregate class-use witness has no complete analysis group");
            projectionClassUses.set(name, {
              ownerUnitId: owner.unitId,
              line: owner.line,
              column: owner.column,
              witnessGroup,
            });
          }
        }
        const locations = new Map<
          string,
          { unit: Unit; preludeLines: number }
        >();
        const locate = (
          unit: Unit,
          line: number,
          column: number,
        ): Pick<
          PythonCheckDiagnostic,
          "filename" | "unitId" | "line" | "column"
        > => {
          const original = mapPythonOrigin(
            artifact,
            unit.sha256 ?? checkerHash(unit.source),
            line,
            unit.filename,
          );
          if (original) return { ...original, column };
          if (unit.filename === "<fmcad-artifact>") {
            const entry = artifact.sourceMap.find(
              (item) =>
                line >= item.generatedStartLine &&
                line <= item.generatedEndLine,
            );
            const source = artifact.units.find(
              (item) => item.id === entry?.unitId,
            );
            if (entry && source)
              return {
                filename: source.filename,
                unitId: source.id,
                line: line - entry.generatedStartLine + entry.sourceStartLine,
                column,
              };
          }
          const declared = artifact.units.find(
            (item) => item.filename === unit.filename,
          );
          return {
            filename: unit.filename,
            unitId: declared?.id ?? unit.id,
            line,
            column,
          };
        };
        if (projection) {
          const wireIndex = units.findIndex((unit) => unit.id === projection.checkerUnitId);
          if (wireIndex < 0) throw new Error("Aggregate checker has no mapped helper source unit");
          const sourcePath = `source-${wireIndex}.txt`;
          const projectedPath = `projection-${projection.groupIndex}.txt`;
          const sourceBytes = await readFile(join(inventoryDirectory, sourcePath));
          const projected = await runCheckerProcess(
            options.pythonExecutable ?? "python3",
            ["-I", "-S", helperPath],
            inventoryDirectory,
            limits,
            JSON.stringify({
              projectionSourcePath: sourcePath,
              projectionOutputPath: projectedPath,
              sourceMap: projection.sourceMap,
              sourceRoles: Object.fromEntries(projection.plan.unitHashes.map((unit) => [unit.id, unit.role])),
              selectedUnitIds: projection.selectedUnitIds,
            }),
            signal,
          );
          if (projected.problem || projected.code !== 0 || projected.stderr.trim())
            throw new Error("Checker body projection: " +
              (projected.problem ?? (projected.stderr || "invalid projection exit")));
          const projectedMetadata = checkerObject(JSON.parse(projected.stdout) as unknown);
          if (
            projectedMetadata["sourceSha256"] !== checkerHash(sourceBytes) ||
            typeof projectedMetadata["analysisSourceHash"] !== "string" ||
            !/^[a-f0-9]{64}$/.test(projectedMetadata["analysisSourceHash"])
          )
            throw new Error("Projected source is not bound to the original analysis bytes");
          const projectedBodies = projectedMetadata["projectedBodies"];
          if (!Array.isArray(projectedBodies))
            throw new Error("Malformed projected body inventory");
          const projectedSource = await readFile(join(inventoryDirectory, projectedPath));
          const originalLineOffsets = sourceLineOffsets(sourceBytes);
          const projectedLineOffsets = sourceLineOffsets(projectedSource);
          if (
            projectedSource.length > 16 * 1024 * 1024 ||
            checkerHash(projectedSource) !== projectedMetadata["analysisSourceHash"] ||
            projectedLineOffsets.length !== originalLineOffsets.length
          )
            throw new Error("Projected source content/size mismatch");
          const expectedById = new Map(projection.plan.bodyInventory
            .filter((body) => body.policy === "projectable" &&
              !projection.selectedUnitIds.includes(body.unitId))
            .map((body) => [body.id, body]));
          const expectedProjected = [...expectedById.keys()].sort((left, right) =>
            left.localeCompare(right),
          );
          const actualProjected: string[] = [];
          for (const value of projectedBodies) {
            const body = checkerObject(value);
            const id = body["id"];
            const expected = typeof id === "string" ? expectedById.get(id) : undefined;
            if (
              !expected ||
              typeof body["unitId"] !== "string" ||
              !Number.isSafeInteger(body["startLine"]) || Number(body["startLine"]) < 1 ||
              !Number.isSafeInteger(body["endLine"]) || Number(body["endLine"]) < Number(body["startLine"]) ||
              typeof body["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(body["sha256"]) ||
              body["unitId"] !== expected.unitId ||
              body["startLine"] !== expected.bodyStartLine ||
              body["endLine"] !== expected.bodyEndLine ||
              body["sha256"] !== expected.bodyHash
            )
              throw new Error("Malformed projected function-body record");
            actualProjected.push(id as string);
          }
          actualProjected.sort((left, right) => left.localeCompare(right));
          if (stableJson(actualProjected) !== stableJson(expectedProjected))
            throw new Error("Aggregate projection omitted or changed a function body");
          const projectedIds = new Set(expectedProjected);
          const sourceMapByUnit = new Map(
            projection.sourceMap.map((entry) => [entry.unitId, entry]),
          );
          for (const body of projection.plan.bodyInventory) {
            const entry = sourceMapByUnit.get(body.unitId);
            if (!entry || projectedIds.has(body.id)) continue;
            const startLine = entry.generatedStartLine + body.bodyStartLine - entry.sourceStartLine;
            const endLine = entry.generatedStartLine + body.bodyEndLine - entry.sourceStartLine;
            if (!sourceBodyBytes(sourceBytes, originalLineOffsets, startLine, endLine).equals(
              sourceBodyBytes(projectedSource, projectedLineOffsets, startLine, endLine),
            ))
              throw new Error("Aggregate analysis changed a function body required in full");
          }
          units[wireIndex]!.source = projectedSource.toString("utf8");
          units[wireIndex]!.analysisSourceHash = projectedMetadata["analysisSourceHash"] as string;
          units[wireIndex]!.projectedBodies = projectedBodies.map((value) => {
            const body = checkerObject(value);
            return {
              id: body["id"] as string,
              unitId: body["unitId"] as string,
              startLine: body["startLine"] as number,
              endLine: body["endLine"] as number,
              sha256: body["sha256"] as string,
            };
          });
        }
        for (const [index, unit] of units.entries()) {
          if (
            typeof unit.has_run !== "boolean" ||
            !Number.isSafeInteger(unit.run_line) ||
            unit.run_line < 1
          )
            throw new Error("Invalid entrypoint inventory");
          if (
            unit.context.entrypoint === "run-if-present" &&
            !unit.has_run &&
            unit.top_calls.length &&
            !unit.context.deferredFacade
          )
            addReason(
              `${unit.filename}: optional entrypoint cannot be established after dynamic module calls`,
            );
          // Newly discovered literal namespaces are deliberately empty. Admission
          // must supply explicit prepared units/contexts to model injected globals.
          if (unit.gaps.length)
            addReason(
              `${unit.filename}: unresolved dynamic exec/compile/eval at ${unit.gaps.join(",")}`,
            );
          if (unit.directives.length)
            addReason(
              `${unit.filename}: checker suppression directives were neutralized at ${unit.directives.join(",")}`,
            );
          if (unit.context.deferredFacade && unit.top_calls.length)
            addReason(
              `${unit.filename}: top-level calls cannot establish deferred FMCAD lifecycle safety at ${unit.top_calls.join(",")}`,
            );
          if (unit.context.deferredFacade)
            for (const position of unit.early)
              addDiagnostic({
                severity: "error",
                message: "FMCAD is injected only after module initialization",
                rule: "fmcadDeferredFacade",
                ...locate(unit, position.line, position.column),
              });
          const prelude: string[] = [];
          if (
            unit.context.app ||
            unit.context.ui ||
            unit.context.deferredFacade
          )
            prelude.push(
              "from typing import TYPE_CHECKING",
              "if TYPE_CHECKING:",
            );
          if (unit.context.app)
            prelude.push("    from fmcad_injected import app");
          if (unit.context.ui)
            prelude.push("    from fmcad_injected import ui");
          if (unit.context.deferredFacade)
            prelude.push("    from fmcad_injected import FMCAD");
          if (checksEntrypoint(unit)) prelude.push(entrypointImport);
          const lines = unit.source.split("\n");
          lines.splice(unit.insert, 0, ...prelude);
          if (checksEntrypoint(unit)) lines.push(entrypointDeclaration);
          const name = `unit-${index}.py`;
          await writeFile(join(directory, name), lines.join("\n"));
          locations.set(name, { unit, preludeLines: prelude.length });
        }
        const config = {
          include: [...locations.keys()],
          exclude: ["stubs"],
          stubPath: "stubs",
          extraPaths: [],
          pythonVersion,
          pythonPlatform: options.pythonPlatform ?? "Linux",
          typeCheckingMode: "strict",
          useLibraryCodeForTypes: false,
          reportMissingImports: "error",
          reportMissingModuleSource: "error",
          reportMissingTypeStubs: "error",
          reportAny: "error",
          reportExplicitAny: "error",
          enableTypeIgnoreComments: false,
          reportUnusedImport: "none",
          reportUnusedVariable: "none",
          reportUnusedFunction: "none",
        };
        const configText = JSON.stringify(config);
        provenance.configHash = checkerHash(configText);
        await writeFile(join(directory, "pyrightconfig.json"), configText);
        const engine =
          options.engineEntrypoint ?? require.resolve("basedpyright/index.js");
        const packageRoot = resolve(
          require.resolve("basedpyright/package.json"),
          "..",
        );
        const version = checkerObject(
          JSON.parse(
            (await readFile(join(packageRoot, "package.json"))).toString(),
          ) as unknown,
        )["version"];
        if (version !== provenance.checkerVersion)
          throw new Error("Unexpected checker dependency version");
        if (options.checkerResources) {
          throwIfAborted(signal);
          provenance.checkerHash = options.checkerResources();
          if (!/^[a-f0-9]{64}$/.test(provenance.checkerHash))
            throw new Error("Invalid checker resource fingerprint");
          throwIfAborted(signal);
        } else {
          const checkerFiles: string[] = [];
          const inventoryTypeshed = async (dir: string): Promise<void> => {
            throwIfAborted(signal);
            for (const entry of await readdir(join(packageRoot, dir), {
              withFileTypes: true,
            })) {
              throwIfAborted(signal);
              const name = join(dir, entry.name);
              if (entry.isDirectory()) await inventoryTypeshed(name);
              else if (entry.isFile()) checkerFiles.push(name);
              else throw new Error("Invalid checker dependency file");
            }
          };
          await inventoryTypeshed("dist/typeshed-fallback");
          throwIfAborted(signal);
          checkerFiles.push("package.json", "index.js", "dist/pyright.js");
          const orderedCheckerFiles = checkerFiles.sort();
          const checkerFileHashes = await hashFiles(
            packageRoot,
            orderedCheckerFiles,
            signal,
          );
          throwIfAborted(signal);
          const engineParts = [checkerHash(await readFile(engine))];
          for (let index = 0; index < orderedCheckerFiles.length; index++)
            engineParts.push(
              orderedCheckerFiles[index]!,
              checkerFileHashes[index]!,
            );
          provenance.checkerHash = checkerHash(JSON.stringify(engineParts));
        }
        // Bind actual engine bytes in the final identity too.
        provenance.analysisHash = checkerHash(
          stableJson({
            policy: "fmcad-python-checker-v1",
            provenance,
            limits,
            units,
            sourceRecovery,
            projection: projection
              ? {
                  planHash: projection.plan.sha256,
                  groupIndex: projection.groupIndex,
                  selectedUnitIds: projection.selectedUnitIds,
                }
              : null,
          }),
        );
        const result = await runCheckerProcess(
          process.execPath,
          [
            "--max-old-space-size=512",
            engine,
            "--outputjson",
            "--pythonpath",
            join(directory, "no-host-python"),
            "--project",
            join(directory, "pyrightconfig.json"),
          ],
          directory,
          limits,
          "",
          signal,
        );
        if (result.problem)
          throw new Error("Checker process: " + result.problem);
        if (result.code !== 0 && result.code !== 1)
          throw new Error("Checker exit: " + result.code + " " + result.stderr);
        if (result.stderr.trim())
          throw new Error("Unexpected checker stderr: " + result.stderr);
        const output = checkerObject(JSON.parse(result.stdout) as unknown);
        if (
          output["version"] !== provenance.checkerVersion ||
          !Array.isArray(output["generalDiagnostics"])
        )
          throw new Error("Invalid checker version/output");
        const summary = checkerObject(output["summary"]);
        const rawDiagnostics = output["generalDiagnostics"];
        if (rawDiagnostics.length > 2000)
          throw new Error("Diagnostic limit exceeded");
        if (summary["filesAnalyzed"] !== units.length)
          throw new Error("Checker did not analyze every declared unit");
        let errors = 0;
        for (const raw of rawDiagnostics) {
          const item = checkerObject(raw);
          const range = checkerObject(item["range"]);
          const start = checkerObject(range["start"]);
          const file = item["file"];
          const severity = item["severity"];
          const message = item["message"];
          const rule = item["rule"] ?? "syntax";
          const line = start["line"],
            character = start["character"];
          if (
            typeof file !== "string" ||
            typeof message !== "string" ||
            typeof rule !== "string" ||
            !["error", "warning", "information"].includes(String(severity)) ||
            typeof line !== "number" ||
            !Number.isSafeInteger(line) ||
            line < 0 ||
            typeof character !== "number" ||
            !Number.isSafeInteger(character) ||
            character < 0
          )
            throw new Error("Malformed checker diagnostic");
          if (severity === "error") errors++;
          const location = locations.get(basename(file));
          if (!location || resolve(file) !== join(directory, basename(file))) {
            addReason(
              "Diagnostic in typing dependency: " + file + ": " + message,
            );
            continue;
          }
          // This one generated import describes injected values, not a runtime
          // module. Keep the rule enabled for every byte of submitted code.
          if (
            line >= location.unit.insert &&
            line < location.unit.insert + location.preludeLines &&
            rule === "reportMissingModuleSource" &&
            message.startsWith('Import "fmcad_injected"')
          )
            continue;
          let originalLine =
            line + 1 > location.unit.insert
              ? Math.max(
                  location.unit.insert + 1,
                  line + 1 - location.preludeLines,
                )
              : line + 1;
          if (
            originalLine > location.unit.source.split("\n").length &&
            checksEntrypoint(location.unit)
          )
            originalLine = location.unit.run_line;
          const diagnosticLocation = locate(
            location.unit,
            originalLine,
            (location.unit.analysisColumnAdjustments ?? []).reduce(
              (column, adjustment) =>
                originalLine === adjustment.line &&
                character + 1 >= adjustment.afterColumn
                  ? column + adjustment.delta
                  : column,
              character + 1,
            ),
          );
          if (
            projection && location.unit.projectedBodies?.some((body) =>
              body.unitId === diagnosticLocation.unitId &&
              diagnosticLocation.line >= body.startLine &&
              diagnosticLocation.line <= body.endLine,
            )
          ) continue;
          if (projection && rule === "reportUnusedClass") {
            const match = /^Class "([^"]+)" is not accessed$/.exec(message);
            const witness = match ? projectionClassUses.get(match[1]!) : undefined;
            if (
              witness &&
              diagnosticLocation.unitId === witness.ownerUnitId &&
              diagnosticLocation.line === witness.line &&
              diagnosticLocation.column === witness.column &&
              witness.witnessGroup !== projection.groupIndex
            )
              continue;
          }
          addDiagnostic({
            severity: severity as PythonCheckDiagnostic["severity"],
            message,
            rule,
            ...diagnosticLocation,
          });
          if (incompleteRules.test(rule))
            addReason(`${diagnosticLocation.filename}: ${rule}`);
        }
        if (
          summary["errorCount"] !== errors ||
          (result.code === 1) !== errors > 0
        )
          throw new Error("Inconsistent checker summary/exit");
        if (
          diagnostics.some(
            (item) =>
              item.severity === "error" && !incompleteRules.test(item.rule),
          )
        )
          return report("failed");
        return report(
          reasons.length ||
            diagnostics.some((item) => item.severity !== "information")
            ? "incomplete"
            : "passed",
        );
      } catch (error) {
        if (!projectionExceeded) {
          try {
            addReason(error instanceof Error ? `${String(error)}\n${error.stack ?? ""}` : String(error));
          } catch {
            /* The bounded tool_error report below replaces the oversized projection. */
          }
        }
        return report("tool_error");
      } finally {
        if (temporaryDirectory)
          await rm(temporaryDirectory, { recursive: true, force: true });
      }
  };
  return {
    async check(
      request: PythonCheckRequest,
      checkOptions: { readonly signal?: PythonCheckAbortSignal } = {},
    ): Promise<PythonCheckReport> {
      return checkOne(request, checkOptions);
    },
  };
}
