import type {
  BrepBaselineArtifacts,
  BrepBaselineManifest,
  BrepBaselineReference,
} from "../../ports/brep-baseline";

export interface BrepBaselineStage {
  readonly id: string;
  readonly fusionPaths: readonly string[];
  read(index: number): Uint8Array;
  write(index: number, bytes: Uint8Array): void;
  dispose(): void;
}

export interface BrepBaselineServicePorts {
  readonly artifacts: BrepBaselineArtifacts;
  readonly stage: (count: number) => BrepBaselineStage;
  /** Settled native turn through the existing CAD execution capability. */
  readonly executeNative: (
    action: "capture" | "compare",
    data: Record<string, unknown>,
    context: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
  readonly newSession: () => string;
  readonly maxBytes?: number;
}

export type BrepBaselineOperation =
  | "measure.baseline.capture"
  | "measure.baseline.inspect"
  | "measure.baseline.compare";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native BRep baseline result");
  return value as Record<string, unknown>;
}

function result(value: unknown): Record<string, unknown> {
  const output = object(value);
  return object(output["result"] ?? output);
}

function reference(value: unknown): BrepBaselineReference {
  const input = object(value);
  if (
    Object.keys(input).sort().join(",") !== "id,owner,scope,sha256,version" ||
    input["version"] !== 1 ||
    input["scope"] !== "durable" ||
    typeof input["owner"] !== "string" ||
    typeof input["id"] !== "string" ||
    typeof input["sha256"] !== "string"
  )
    throw new Error("Invalid durable BRep baseline reference");
  return input as unknown as BrepBaselineReference;
}

function cleanFailure(error: unknown, stage: BrepBaselineStage): never {
  // A thrown transport/native turn can have an unknown outcome. Preserve its
  // private staging bytes for reconciliation; never automatically replay or
  // remove evidence when the SDK acknowledgement is ambiguous.
  const failure = error instanceof Error ? error : new Error(String(error));
  failure.message += ` Exact staging evidence was retained in project .cad/baseline-staging/${stage.id}; inspect before retry.`;
  Object.assign(failure, { stagingEvidence: stage.id });
  throw failure;
}

function missingArtifact(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function dispose(stage: BrepBaselineStage): string[] {
  try {
    stage.dispose();
    return [];
  } catch {
    return [
      "Owned staging cleanup needs inspection under project .cad/baseline-staging.",
    ];
  }
}

export function createBrepBaselineService(ports: BrepBaselineServicePorts) {
  const maxBytes = ports.maxBytes ?? 128 * 1024 * 1024;
  return Object.freeze({
    async execute(
      operation: BrepBaselineOperation,
      data: Record<string, unknown>,
      context: Readonly<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
      if (operation === "measure.baseline.inspect") {
        let stored: ReturnType<BrepBaselineArtifacts["read"]>;
        try {
          stored = ports.artifacts.read(reference(data["baseline"]));
        } catch (error) {
          if (!missingArtifact(error)) throw error;
          return {
            success: false,
            operation,
            result: { status: "missing", precision: "exact" },
          };
        }
        return {
          success: true,
          operation,
          result: {
            status: "pass",
            precision: "exact",
            manifest: stored.manifest,
            baseline: data["baseline"],
            bodyPayloads: stored.bodyPayloads,
            limitations: [
              "Integrity and manifest were verified offline; this does not qualify native Fusion serialization or geometry.",
            ],
          },
        };
      }

      const baseline =
        operation === "measure.baseline.compare"
          ? reference(data["baseline"])
          : undefined;
      let stored: ReturnType<BrepBaselineArtifacts["read"]> | undefined;
      if (baseline) {
        try {
          stored = ports.artifacts.read(baseline);
        } catch (error) {
          if (!missingArtifact(error)) throw error;
          return {
            success: false,
            operation,
            result: { status: "missing", precision: "exact" },
          };
        }
      }
      const bodies = data["bodies"];
      if (!Array.isArray(bodies) || bodies.length < 1 || bodies.length > 1000)
        throw new Error("BRep baseline requires 1..1000 role/body entries");
      const count = stored?.exactBodies.length ?? bodies.length;
      if (stored && count !== bodies.length)
        return {
          success: false,
          operation,
          result: {
            status: "missing",
            precision: "exact",
            reason: "Body role coverage differs from the durable baseline",
          },
        };
      const stage = ports.stage(count);
      if (stage.fusionPaths.length !== count || !stage.id)
        throw new Error("Trusted BRep stage returned the wrong path count");
      const binding = {
        version: 1,
        session: ports.newSession(),
        stagePaths: [...stage.fusionPaths],
        maxBytes,
        workBudgetMs: data["workBudgetMs"] ?? 30_000,
        ...(stored ? { manifest: stored.manifest } : {}),
      };
      try {
        if (stored)
          stored.exactBodies.forEach((bytes, index) =>
            stage.write(index, bytes),
          );
        const native = result(
          await ports.executeNative(
            stored ? "compare" : "capture",
            {
              ...data,
              ...(stored ? { baseline } : { scope: "durable" }),
              _trustedBinding: binding,
            },
            context,
          ),
        );
        if (native["status"] !== "pass") {
          const limitations = dispose(stage);
          return {
            success: false,
            operation,
            result: {
              ...native,
              ...(limitations.length ? { limitations } : {}),
            },
          };
        }
        if (stored) {
          const limitations = dispose(stage);
          return {
            success: native["passed"] === true,
            operation,
            result: {
              ...native,
              ...(limitations.length ? { limitations } : {}),
            },
          };
        }
        const manifest = object(
          native["manifest"],
        ) as unknown as BrepBaselineManifest;
        if (
          native["stagedPayloadCount"] !== count ||
          manifest.version !== 1 ||
          manifest.scope !== "durable"
        )
          throw new Error(
            "Native capture did not return complete exact evidence",
          );
        const payloads = Array.from({ length: count }, (_, index) =>
          stage.read(index),
        );
        if (payloads.some((bytes) => !bytes.byteLength))
          throw new Error("Native exact BRep payload is missing");
        const baselineRef = ports.artifacts.publish(manifest, payloads);
        const cleanupWarnings = dispose(stage);
        return {
          success: true,
          operation,
          result: {
            status: "pass",
            precision: "exact",
            baseline: baselineRef,
            manifest,
            bodyPayloads: payloads.map((bytes, index) => ({
              role: manifest.bodies[index]?.role,
              bytes: bytes.byteLength,
            })),
            limitations: [
              "Native export/import and geometry correctness still require explicit scratch-document qualification.",
              ...cleanupWarnings,
            ],
          },
        };
      } catch (error) {
        cleanFailure(error, stage);
      }
    },
  });
}
