import { createOperationCatalog } from "../../catalog";
import { validate } from "./brep-baseline-policy";

const declarations = {
  "measure.baseline.capture_internal": {
    summary: "Internal broker-authorized exact baseline export turn.",
    required: ["bodies", "frame", "scope", "_trustedBinding"],
    inputs: {
      bodies: "Coordinator-authenticated role/body references.",
      frame: "Explicit source coordinate frame.",
      scope: "Must be durable.",
      workBudgetMs: "Optional bounded work budget.",
      _trustedBinding: "Broker-generated stage paths and serialization limits.",
    },
    example: {},
    limitations: ["Private SDK turn; never exposed as CLI/MCP contract."],
    readOnly: true,
    internalOnly: true,
  },
  "measure.baseline.compare_internal": {
    summary: "Internal broker-authorized exact baseline import/compare turn.",
    required: ["baseline", "bodies", "tolerances", "_trustedBinding"],
    inputs: {
      baseline: "Broker-verified durable baseline reference.",
      bodies: "Role/body references.",
      tolerances: "Explicit dimensional tolerances.",
      workBudgetMs: "Optional bounded work budget.",
      _trustedBinding:
        "Broker-generated stage paths and checksum-verified manifest.",
    },
    example: {},
    limitations: ["Private SDK turn; never exposed as CLI/MCP contract."],
    readOnly: true,
    internalOnly: true,
  },
};

const privateCatalog = createOperationCatalog(declarations, {
  services: {},
  validators: [validate],
});
const authorizedPayloads = new WeakSet<object>();

function isInternal(operation: string) {
  return Object.hasOwn(privateCatalog.contracts, operation);
}

function validateInternal(operation: string, data: unknown) {
  if (!data || typeof data !== "object" || !authorizedPayloads.has(data)) {
    throw new Error(
      "Private BRep baseline SDK turns require an owned coordinator capability",
    );
  }
  return privateCatalog.validate(operation, data);
}

function authorize(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Private BRep baseline payload must be an object");
  authorizedPayloads.add(data);
}

export { isInternal, validateInternal, authorize };
