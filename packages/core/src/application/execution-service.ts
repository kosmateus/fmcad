import type { WorkerApplicationPorts } from "./execution-worker.js";

type Execute = WorkerApplicationPorts["execute"];

/** Typed worker composition; services cannot manufacture a physical backend. */
export function createWorkerExecutionService(services: {
  cad: Execute;
  legacy: Execute;
  withPurpose(
    purpose: string | undefined,
    action: () => Promise<number>,
  ): Promise<number>;
}): Execute {
  return (request, backend, onOutcome) => {
    if (request.payload?.["kind"] === "legacy-command") {
      const purpose = request.payload["purpose"];
      return services.withPurpose(
        typeof purpose === "string" ? purpose : undefined,
        () => services.legacy(request, backend, onOutcome),
      );
    }
    return services.cad(request, backend, onOutcome);
  };
}
