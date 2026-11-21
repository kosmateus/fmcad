import { createRequire } from "node:module";
const load = createRequire(__filename);
const adapter = load(
  "./dist/node-adapters/execution/migration-stop",
) as typeof import("../packages/node-adapters/src/execution/migration-stop");
export const { stopOwner, stopOwnerPreflight } = adapter;
