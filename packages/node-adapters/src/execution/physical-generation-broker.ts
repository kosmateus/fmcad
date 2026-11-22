import fs from "node:fs";
import {
  createPhysicalGenerationAuthorization,
  validatePhysicalGenerationDescriptor,
  type PhysicalGenerationDescriptor,
  type PhysicalTurnBinding,
} from "./physical-generation";

export interface PhysicalGenerationClaim {
  directory: string;
  owner: Readonly<{ pid: number; birth: string; nonce: string }>;
  buildHash: string;
  configHash: string;
  assertBrokerOwner(): void;
}

/** Trusted composition only. This capability is not a public invocation DTO.
 * Provisioning is the local operator mailbox, never an SDK request or a fresh
 * store: its implementation must use the already provisioned host generation. */
export function prepareBrokerPhysicalGeneration(options: {
  runtime: Omit<PhysicalGenerationDescriptor, "brokerOwner">;
  clientId: string;
  provision(
    descriptor: PhysicalGenerationDescriptor,
  ): Promise<{ grantFile: string; grantDigest: string }>;
  transport?: "node" | "windows-curl";
}) {
  const runtime = structuredClone(options.runtime);
  const clientId = options.clientId;
  let attempted = false;
  let issuanceAttempted = false;
  let authorization:
    ReturnType<typeof createPhysicalGenerationAuthorization> | undefined;
  function unavailable(): never {
    throw Object.assign(
      new Error("Physical generation has not been prepared"),
      {
        code: "PHYSICAL_GENERATION_REJECTED",
        ...(issuanceAttempted
          ? { grantIssuance: "unknown" }
          : { notStarted: true }),
      },
    );
  }
  function current() {
    return authorization ?? unavailable();
  }
  return {
    async preparePhysicalGeneration(context: PhysicalGenerationClaim) {
      if (attempted) unavailable();
      attempted = true;
      context.assertBrokerOwner();
      if (
        fs.realpathSync(context.directory) !== context.directory ||
        !/^[a-f0-9]{64}$/.test(context.buildHash) ||
        !/^[a-f0-9]{64}$/.test(context.configHash)
      )
        unavailable();
      const descriptor: PhysicalGenerationDescriptor = {
        ...runtime,
        brokerOwner: {
          pid: context.owner.pid,
          birth: context.owner.birth,
          nonce: context.owner.nonce,
          clientId,
          queueDirectory: context.directory,
        },
      };
      validatePhysicalGenerationDescriptor(descriptor, options.transport);
      // A provisioning callback may be asynchronous. It receives a copy, not
      // the descriptor used to pin the resulting private file.
      try {
        issuanceAttempted = true;
        const grant = await options.provision(structuredClone(descriptor));
        context.assertBrokerOwner();
        const candidate = createPhysicalGenerationAuthorization({
          ...grant,
          expected: descriptor,
          assertBrokerOwner: context.assertBrokerOwner,
          ...(options.transport ? { transport: options.transport } : {}),
        });
        // This entire boundary follows a potentially successful issuance:
        // missing/private-file and ownership failures are uncertain too.
        candidate.headers(descriptor.endpointURL);
        context.assertBrokerOwner();
        authorization = candidate;
      } catch {
        // The operator may include credentials/private paths in its exception.
        // Preserve uncertainty by refusing retries, not by returning that error.
        unavailable();
      }
    },
    authorization: current,
    // These deferred ports are installed before startup but cannot expose a
    // credential until the real post-claim hook has published the capability.
    authorizePhysicalRequest(endpoint: string) {
      return current().headers(endpoint);
    },
    bindPhysicalTurn(
      request: Parameters<
        ReturnType<
          typeof createPhysicalGenerationAuthorization
        >["bindPhysicalTurn"]
      >[0],
    ) {
      return current().bindPhysicalTurn(request);
    },
    withPhysicalTurn<T>(binding: PhysicalTurnBinding, send: () => Promise<T>) {
      return current().withPhysicalTurn(binding, send);
    },
    physicalTurnQuiescence(binding: PhysicalTurnBinding) {
      return current().physicalTurnQuiescence(binding);
    },
  };
}
