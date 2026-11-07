import { createRequire } from "node:module";
import { createWorkerExecutionService } from "../../packages/core/src/application/execution-service.js";
import type {
  WorkerBackend,
  WorkerRequest,
} from "../../packages/core/src/application/execution-worker.js";

const runtimeRequire = createRequire(__filename);

interface VerifiedWorkerInputs {
  jobId: string;
  brokerDirectory: string;
  projectDirectory?: string;
  buildHash: string;
}

type Outcome = (value: unknown) => void;

interface RuntimeModules {
  cadService: {
    execute(
      request: WorkerRequest,
      backend: WorkerBackend,
      onOutcome: Outcome,
      io: Record<string, never>,
      internal: { stageDependencies: unknown },
    ): Promise<number>;
  };
  invocation: {
    context: {
      run<T>(store: { description?: string }, action: () => T): T;
    };
  };
  legacyWorker: {
    execute(
      request: WorkerRequest,
      backend: WorkerBackend,
      onOutcome: Outcome,
    ): Promise<number>;
  };
  stageDependencies: {
    createAuthenticatedStageDependencies(
      inputs: VerifiedWorkerInputs,
    ): Promise<unknown>;
  };
}

const runtimeModules = {
  cadService: runtimeRequire("../../cad-service.js"),
  invocation: runtimeRequire("../../invocation.js"),
  legacyWorker: runtimeRequire("../../composition/legacy-worker.js"),
  stageDependencies: runtimeRequire("../../composition/stage-dependencies.js"),
} as RuntimeModules;

/** TypeScript worker composition; legacy CLI adapters remain behind one port. */
export async function execute(
  request: WorkerRequest,
  backend: WorkerBackend,
  onOutcome: Outcome,
  verifiedWorkerInputs?: VerifiedWorkerInputs,
): Promise<number> {
  if (request.payload?.["kind"] === "legacy-command") {
    const purpose = request.payload["purpose"];
    return runtimeModules.invocation.context.run(
      { ...(typeof purpose === "string" ? { description: purpose } : {}) },
      () => runtimeModules.legacyWorker.execute(request, backend, onOutcome),
    );
  }
  const service = createWorkerExecutionService({
    cad: async (input, client, outcome) => {
      const stageDependencies = verifiedWorkerInputs
        ? await runtimeModules.stageDependencies.createAuthenticatedStageDependencies(
            verifiedWorkerInputs,
          )
        : null;
      return runtimeModules.cadService.execute(
        input,
        client,
        outcome,
        {},
        { stageDependencies },
      );
    },
    legacy: (input, client, outcome) =>
      runtimeModules.legacyWorker.execute(input, client, outcome),
    withPurpose: (description, action) =>
      runtimeModules.invocation.context.run(
        { ...(description === undefined ? {} : { description }) },
        action,
      ),
  });
  return service(request, backend, onOutcome);
}
