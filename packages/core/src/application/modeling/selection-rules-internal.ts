import { createOperationCatalog } from "../../catalog";
import * as selectionRules from "./selection-rules-policy";

const declarations = {
  "selection.rule.define_internal": {
    summary: "Private broker-authorized selection rule definition turn.",
    required: ["definition", "_trustedBinding"],
    inputs: {
      definition: "Validated public selection rule definition.",
      _trustedBinding: "Coordinator-owned operation binding.",
    },
    example: {},
    limitations: [
      "Private Fusion turn; never exposed as a CLI or MCP operation.",
    ],
    readOnly: true,
    internalOnly: true,
  },
  "selection.rule.inspect_internal": {
    summary: "Private broker-authorized selection rule inspection turn.",
    required: ["manifest", "_trustedBinding"],
    inputs: {
      manifest: "Project/document-owned version-1 selection rule manifest.",
      _trustedBinding: "Coordinator-owned operation binding.",
    },
    example: {},
    limitations: [
      "Private Fusion turn; never exposed as a CLI or MCP operation.",
    ],
    readOnly: true,
    internalOnly: true,
  },
  "selection.rule.resolve_internal": {
    summary:
      "Private broker-authorized current-topology selection rule resolve turn.",
    required: ["manifest", "_trustedBinding"],
    inputs: {
      manifest: "Project/document-owned version-1 selection rule manifest.",
      _trustedBinding: "Coordinator-owned operation binding.",
    },
    example: {},
    limitations: [
      "Private Fusion turn; never exposed as a CLI or MCP operation.",
    ],
    readOnly: true,
    internalOnly: true,
  },
  "selection.rule.check_internal": {
    summary:
      "Private broker-authorized current-topology selection rule check turn.",
    required: ["manifest", "_trustedBinding"],
    inputs: {
      manifest: "Project/document-owned version-1 selection rule manifest.",
      _trustedBinding: "Coordinator-owned operation binding.",
    },
    example: {},
    limitations: [
      "Private Fusion turn; never exposed as a CLI or MCP operation.",
    ],
    readOnly: true,
    internalOnly: true,
  },
};

const authorized = new WeakMap<object, string>();
const privateCatalog = createOperationCatalog(declarations, {
  services: {},
  validators: [
    (operation, data) => {
      const binding = data["_trustedBinding"];
      if (
        !binding ||
        (typeof binding !== "object" && typeof binding !== "function") ||
        !("version" in binding) ||
        binding.version !== 1 ||
        !("service" in binding) ||
        binding.service !== "selection-rules"
      ) {
        throw new Error("Invalid selection-rule coordinator binding");
      }
      if (operation === "selection.rule.define_internal")
        selectionRules.definition(data["definition"]);
      else if (
        !data["manifest"] ||
        typeof data["manifest"] !== "object" ||
        Array.isArray(data["manifest"])
      ) {
        throw new Error(
          "Selection-rule internal operation requires a manifest object",
        );
      }
    },
  ],
});

function isInternal(operation: string) {
  return Object.hasOwn(privateCatalog.contracts, operation);
}

function authorize(operation: string, data: unknown) {
  if (
    !isInternal(operation) ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  )
    throw new Error("Invalid private selection-rule turn");
  authorized.set(data, operation);
}

function validateInternal(operation: string, data: unknown) {
  if (!data || typeof data !== "object" || authorized.get(data) !== operation)
    throw new Error(
      "Private selection-rule turns require an owned coordinator capability",
    );
  return privateCatalog.validate(operation, data);
}

export { isInternal, authorize, validateInternal };
