import { createRequire } from "node:module";
const adapter = createRequire(__filename)(
  "./dist/node-adapters/persistence/migration-files",
) as typeof import("../packages/node-adapters/src/persistence/migration-files");
export const {
  directory,
  fileHash,
  inventory,
  exclusive,
  backupTree,
  verifyTree,
} = adapter;
