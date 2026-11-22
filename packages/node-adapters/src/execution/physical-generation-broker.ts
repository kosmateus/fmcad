import fs from "node:fs";
import {
  createPhysicalGenerationAuthorization,
  type PhysicalGenerationDescriptor,
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
  let authorization:
    ReturnType<typeof createPhysicalGenerationAuthorization> | undefined;
  function unavailable(): never {
    throw Object.assign(
      new Error("Physical generation has not been prepared"),
      {
        code: "PHYSICAL_GENERATION_REJECTED",
        notStarted: true,
      },
    );
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
      // A provisioning callback may be asynchronous. It receives a copy, not
      // the descriptor used to pin the resulting private file.
      const grant = await options.provision(structuredClone(descriptor));
      context.assertBrokerOwner();
      const candidate = createPhysicalGenerationAuthorization({
        ...grant,
        expected: descriptor,
        assertBrokerOwner: context.assertBrokerOwner,
        ...(options.transport ? { transport: options.transport } : {}),
      });
      // Validate the private file and current owner before publishing any
      // capability. Creating the object alone does not read/validate the grant.
      candidate.headers(descriptor.endpointURL);
      context.assertBrokerOwner();
      authorization = candidate;
    },
    authorization() {
      return authorization ?? unavailable();
    },
  };
}
