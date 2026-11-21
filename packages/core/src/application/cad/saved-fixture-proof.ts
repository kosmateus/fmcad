import { record } from "./contracts";
import { hash as canonicalHash, utf8Length } from "./json";
const fail = (message: string): never => {
  throw Object.assign(new Error(message), {
    code: "SAVED_FIXTURE_PROOF_INVALID",
  });
};
export function parseSavedFixtureReader(
  reply: unknown,
  _identity: unknown,
  binding: Record<string, unknown>,
) {
  const envelope = record(reply) ? reply["result"] : undefined;
  const content = record(envelope) ? envelope["content"] : undefined;
  const row: unknown = Array.isArray(content)
    ? content.find((item: unknown) => record(item) && item["type"] === "text")
    : undefined;
  const candidate = record(row) ? row["text"] : undefined;
  if (typeof candidate !== "string" || utf8Length(candidate) > 32768)
    return fail("No bounded saved fixture result");
  let text: string = candidate;
  try {
    const wrapped: unknown = JSON.parse(text);
    if (record(wrapped) && typeof wrapped["stdout"] === "string")
      text = wrapped["stdout"];
  } catch {
    /* Plain text result. */
  }
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FMCAD_RESULT "));
  let parsed: unknown;
  try {
    if (lines.length !== 1) fail("One saved fixture result required");
    parsed = JSON.parse(lines[0]!.slice(13));
  } catch {
    fail("Malformed saved fixture result");
  }
  if (!record(parsed)) return fail("Malformed saved fixture result");
  const result = parsed;
  const document = record(binding["document"]) ? binding["document"] : {};
  if (
    result["version"] !== 1 ||
    result["purpose"] !== binding["purpose"] ||
    result["epochId"] !== binding["epochId"] ||
    result["bindingHash"] !== canonicalHash(binding) ||
    canonicalHash(result["document"]) !== canonicalHash(binding["document"])
  )
    fail("Saved fixture result does not match its original owner binding");
  const keys = [
    "version",
    "purpose",
    "epochId",
    "bindingHash",
    "document",
    ...(binding["purpose"] === "saved-fixture-retain-v1"
      ? [
          "savedDocument",
          "closed",
          "saved",
          "retained",
          "activeBeforeCloseCreationId",
          "restoredActiveCreationId",
          "activeDocumentRestored",
        ]
      : binding["purpose"] === "saved-fixture-destination-v1"
        ? ["destination", "readOnly"]
        : ["observed", "readOnly"]),
  ];
  if (Object.keys(result).sort().join(",") !== keys.sort().join(","))
    fail("Unexpected saved fixture proof fields");
  if (binding["purpose"] === "saved-fixture-retain-v1") {
    if (
      result["closed"] !== true ||
      result["saved"] !== true ||
      result["retained"] !== true ||
      result["activeDocumentRestored"] !== true ||
      canonicalHash(result["savedDocument"]) !==
        canonicalHash(binding["savedDocument"])
    )
      fail("Exact retained saved-file close proof required");
    const target =
      result["activeBeforeCloseCreationId"] === document["creationId"]
        ? (binding["restoreActiveCreationId"] ?? null)
        : result["activeBeforeCloseCreationId"];
    if (result["restoredActiveCreationId"] !== target)
      fail("Captured active document restore differs");
  } else if (binding["purpose"] === "saved-fixture-destination-v1") {
    const destination = result["destination"];
    const expected = record(binding["destination"])
      ? binding["destination"]
      : {};
    if (
      result["readOnly"] !== true ||
      !record(destination) ||
      destination["projectName"] !== expected["projectName"] ||
      destination["folderName"] !== expected["folderName"] ||
      destination["folderId"] !== expected["folderId"] ||
      !["nativeProjectId", "nativeHubId", "nativeHubName"].every(
        (key) => typeof destination[key] === "string" && destination[key],
      )
    )
      fail("Exact read-only native destination identity required");
  } else {
    const observed = result["observed"];
    if (
      result["readOnly"] !== true ||
      !record(observed) ||
      observed["creationId"] !== document["creationId"] ||
      observed["name"] !== document["name"]
    )
      fail("Exact read-only publication observation required");
  }
  return result;
}
