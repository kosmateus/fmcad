export const ADDIN_CAPABILITIES = Object.freeze({
  backend: "addin",
  implementation: "frankhommers/autodesk-fusion-mcp",
  readOnlyEnforced: false,
  automaticFallback: false,
  automaticMutationRetry: false,
  atomicBatch: true,
  unsupported: Object.freeze([
    "licensing",
    "document recent",
    "undo",
    "redo",
    "electronics",
  ]),
});
