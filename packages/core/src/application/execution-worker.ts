export interface WorkerInput {
  path: string;
  sha256: string;
}

export interface WorkerRequest {
  cwd: string;
  argv: string[];
  inputFiles?: WorkerInput[] | undefined;
  payload?: Record<string, unknown> | undefined;
}

export interface WorkerEnvelope {
  id: string;
  request: WorkerRequest;
  buildHash: string;
  deadline: number;
  properties?: Record<string, unknown> | undefined;
}

export type WorkerBackendMethod =
  "callTool" | "listTools" | "executeUiGuardedScript";

export interface WorkerBackend {
  readonly brokerSdkProbePort?: import("./execution-probe").WorkerSdkProbePort;
  callTool(...args: unknown[]): Promise<unknown>;
  listTools(...args: unknown[]): Promise<unknown>;
  executeUiGuardedScript(...args: unknown[]): Promise<unknown>;
}

export interface WorkerResult {
  jobId: string;
  code: number | null;
  terminal: boolean;
  workflowOutcome: unknown;
  nonterminal: boolean;
}

export interface WorkerApplicationPorts {
  verify(envelope: WorkerEnvelope): void;
  backend: WorkerBackend;
  /** A typed CAD/run/batch service, never an argv interpreter. */
  execute(
    request: WorkerRequest,
    backend: WorkerBackend,
    outcome: (value: unknown) => void,
  ): Promise<number>;
  nonterminal(outcome: unknown): boolean;
  persist(result: WorkerResult): void;
}

/** A worker owns only local preparation/publication. Each backend request goes
 * through the broker capability port and obtains its own durable SDK turn. */
export async function executeWorker(
  envelope: WorkerEnvelope,
  ports: WorkerApplicationPorts,
): Promise<number> {
  ports.verify(envelope);
  let workflowOutcome: unknown = null;
  const publish = (code: number | null, terminal: boolean): void => {
    ports.persist({
      jobId: envelope.id,
      code,
      terminal,
      workflowOutcome,
      nonterminal: ports.nonterminal(workflowOutcome),
    });
  };
  const code = await ports.execute(envelope.request, ports.backend, (value) => {
    workflowOutcome = value;
    publish(null, false);
  });
  publish(code, true);
  return code;
}
