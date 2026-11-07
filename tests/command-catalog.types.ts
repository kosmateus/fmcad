import {
  createOperationCatalog,
  type OperationDeclaration,
  type CatalogInvocation,
} from "../packages/core/src/catalog";

const declaration: OperationDeclaration = {
  summary: "Offline test",
  inputs: {},
  required: [],
  example: {},
  limitations: [],
  readOnly: true,
};
createOperationCatalog({ "test.op": declaration }, { services: {} });
const wrongReadOnly: OperationDeclaration = {
  ...declaration,
  // @ts-expect-error Read-only declarations are booleans, never textual coercions.
  readOnly: "true",
};
const wrongInput: OperationDeclaration = {
  ...declaration,
  // @ts-expect-error Input descriptions cannot be mistaken for executable schemas.
  inputs: { value: 1 },
};
// @ts-expect-error Service mapping is mandatory for validation of local dispatch.
createOperationCatalog({ "test.op": declaration }, {});
void wrongReadOnly;
void wrongInput;
const invocation: CatalogInvocation = {
  version: 1,
  kind: "cad",
  operation: "entity.list",
  data: {},
};
// @ts-expect-error Physical backend RPC is not a typed CAD application invocation.
const rawInvocation: CatalogInvocation = { ...invocation, kind: "rpc" };
void rawInvocation;
