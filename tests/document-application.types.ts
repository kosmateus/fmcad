import {
  executeDocumentCommand,
  type DocumentCommandPorts,
} from "../packages/core/src/application/documents/commands";
import {
  execute,
  type SaveServices,
} from "../packages/core/src/application/documents/save";
declare const commands: DocumentCommandPorts;
declare const save: SaveServices;
// @ts-expect-error The shared service accepts a typed request, never argv.
executeDocumentCommand(["doc", "save"], commands);
// @ts-expect-error Explicit close authorization is mandatory in the DTO.
executeDocumentCommand({ kind: "close" }, commands);
// @ts-expect-error The save application needs all durable journal and SDK ports.
execute("document.save.once", {}, {}, { now: () => 0 });
// @ts-expect-error Native save cannot be substituted for the status observation port.
save.status = save.save;
