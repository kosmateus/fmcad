import { createRequire } from "node:module";
import type { CadContext, CadData, CadOutput } from "@fmcad/core";
import type {
  NativeSaveResult,
  SaveBinding,
  SaveRecord,
  SaveServices,
  SaveOperation,
} from "../../packages/core/src/application/documents/save.js";
import type { DocumentSaveStages } from "../../packages/core/src/application/documents/stages.js";

const load = createRequire(__filename);
const service = load(
  "../core/application/documents/save.js",
) as typeof import("../../packages/core/src/application/documents/save.js");
const { openSaveJournal } = load(
  "../node-adapters/persistence/document-save.js",
) as typeof import("../../packages/node-adapters/src/persistence/document-save.js");
const { hash } = load(
  "../core/application/cad/json.js",
) as typeof import("../../packages/core/src/application/cad/json.js");
type JournalIo = NonNullable<Parameters<typeof openSaveJournal>[4]>;
const journal = load("../../batch-atomic.js") as {
  readOperationJournal(
    directory: string,
    binding: SaveBinding,
    io?: JournalIo,
  ): Promise<SaveRecord[]>;
  writeOperationRecord(
    directory: string,
    binding: SaveBinding,
    sequence: number,
    value: Parameters<
      import("../../packages/node-adapters/src/persistence/document-save.js").SaveJournalRecords["write"]
    >[3],
    io?: JournalIo,
  ): Promise<SaveRecord>;
};
export interface PublicationDependencies {
  stages?: DocumentSaveStages;
  fs?: JournalIo;
  now?: SaveServices["now"];
  sleep?: SaveServices["sleep"];
}
type Execute<Client> = (
  client: Client,
  operation: string,
  data: CadData,
  context: CadContext,
) => Promise<CadOutput>;

export async function execute<Client>(
  client: Client,
  operation: SaveOperation,
  data: CadData,
  context: CadContext,
  executeCad: Execute<Client>,
  dependencies: PublicationDependencies = {},
) {
  return service.execute(operation, data, context, {
    ...(dependencies.stages ? { stages: dependencies.stages } : {}),
    open: (request, binding, create) =>
      openSaveJournal(
        request,
        binding,
        create,
        {
          read: (directory, identity) =>
            journal.readOperationJournal(directory, identity, dependencies.fs),
          write: (directory, identity, sequence, value) =>
            journal.writeOperationRecord(
              directory,
              identity,
              sequence,
              value,
              dependencies.fs,
            ),
          hash,
        },
        dependencies.fs,
      ),
    async status(target) {
      const response = await executeCad(client, "document.status", {}, target);
      const result = response?.["result"];
      if (
        !response?.["success"] ||
        !result ||
        typeof result !== "object" ||
        Array.isArray(result)
      )
        throw new Error(
          "document.status readback did not return a scoped snapshot",
        );
      return result;
    },
    async save(request, target, targetContext) {
      const response = await executeCad(
        client,
        "document.save_native",
        {
          requestId: request.requestId,
          operationId: request.operationId,
          projectId: target.projectId,
          fileId: target.fileId,
          creationId: target.creationId,
          version: target.version,
          description:
            request.description ??
            "Authorized fmcad save " + request.operationId,
        },
        targetContext,
      );
      const result = response?.["result"];
      // The save use case interprets acceptance and completion evidence. This
      // boundary retains the original object-or-null transport contract.
      return result && typeof result === "object" && !Array.isArray(result)
        ? (result as NativeSaveResult)
        : null;
    },
    now: dependencies.now ?? (() => performance.now()),
    sleep:
      dependencies.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  });
}
export const { OPERATIONS, validate } = service;
