import type { ObjectValue } from "./contracts.js";
import { object } from "./contracts.js";

export function buildBridgeScript(
  toolName: string,
  request: ObjectValue,
  source: string,
): string {
  const unsupported = (detail: string): never => {
    throw new Error(
      `${detail} is unsupported by the addin bridge; use --backend mcp explicitly. No automatic fallback is performed.`,
    );
  };
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new TypeError("Bridge request must be an object");
  if (toolName === "fusion_mcp_read") {
    if (
      !["document", "projects", "activeCommand"].includes(
        String(request["queryType"]),
      )
    )
      unsupported(`Read ${String(request["queryType"])}`);
    if (request["queryType"] === "document") {
      if (!["open", "search"].includes(String(request["operation"])))
        unsupported(`Document read ${String(request["operation"])}`);
      if (request["operation"] === "search") {
        if (typeof request["name"] !== "string" || !request["name"].trim())
          throw new TypeError("Search requires a nonempty name");
        if (
          request["project"] != null &&
          (typeof request["project"] !== "string" || !request["project"].trim())
        )
          throw new TypeError("Project must be a nonempty name or id");
      }
    }
  } else if (toolName === "fusion_mcp_execute") {
    if (request["featureType"] !== "document")
      unsupported(`Execute ${String(request["featureType"])}`);
    if (
      !request["object"] ||
      typeof request["object"] !== "object" ||
      Array.isArray(request["object"])
    )
      throw new TypeError("Document operation requires an object");
    const value = object(request["object"]);
    if (!["open", "save", "close"].includes(String(value["operation"])))
      unsupported(`Document execute ${String(value["operation"])}`);
    if (
      value["operation"] === "open" &&
      (typeof value["fileId"] !== "string" || !value["fileId"].trim())
    )
      throw new TypeError("Document open requires fileId");
    if (value["operation"] === "close") {
      for (const flag of [
        "userConfirmedSaveAndClose",
        "userConfirmedCloseWithoutSave",
      ]) {
        if (Object.hasOwn(value, flag) && typeof value[flag] !== "boolean")
          throw new TypeError(`${flag} must be boolean`);
      }
      if (
        (value["userConfirmedSaveAndClose"] === true) ===
        (value["userConfirmedCloseWithoutSave"] === true)
      )
        throw new Error(
          "Document close requires exactly one save or discard confirmation",
        );
    }
  } else unsupported(`Tool ${toolName}`);
  const json = JSON.stringify({ toolName, request }).replace(
    /[^\x00-\x7f]/g,
    (character) =>
      "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  return source.replace(
    "_BRIDGE_REQUEST = {}",
    () => `_BRIDGE_REQUEST = __import__('json').loads(${JSON.stringify(json)})`,
  );
}
