import { record } from "./contracts";
import { hash, utf8Length } from "./json";

const fail = (message: string): never => {
  throw Object.assign(new Error(message), { code: "AUDIT_OUTPUT_INVALID" });
};
const fields = (
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> => {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    return fail("Audit contains unapproved fields");
  return value;
};
const count = (
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= maximum;
const errorType = (row: Record<string, unknown>) =>
  typeof row["errorType"] === "string" &&
  /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row["errorType"]);

/** Extract one bounded audit result from the supported MCP response envelopes. */
export function auditOutputText(reply: unknown): string {
  const result = record(reply) ? reply["result"] : undefined;
  const content = record(result) ? result["content"] : undefined;
  const texts = Array.isArray(content)
    ? content.filter(
        (row): row is Record<string, unknown> =>
          record(row) && row["type"] === "text",
      )
    : [];
  if (texts.length !== 1) return fail("Expected exactly one audit text result");
  const candidate = texts[0]!["text"];
  if (typeof candidate !== "string" || utf8Length(candidate) > 32768)
    return fail("Missing bounded audit output");

  let text = candidate;
  let wrapped: unknown;
  try {
    wrapped = JSON.parse(candidate);
  } catch {
    /* Plain result line. */
  }
  if (record(wrapped)) {
    const keys = Object.keys(wrapped).sort();
    if (
      "message" in wrapped ||
      ("success" in wrapped && !("stdout" in wrapped))
    ) {
      if (
        keys.length !== 2 ||
        keys[0] !== "message" ||
        keys[1] !== "success" ||
        wrapped["success"] !== true ||
        typeof wrapped["message"] !== "string"
      )
        return fail("Invalid native MCP audit response envelope");
      text = wrapped["message"];
    } else if ("stdout" in wrapped) {
      const legacyKeys =
        keys.length === 1
          ? keys[0] === "stdout"
          : keys.length === 2
            ? keys[0] === "stdout" && keys[1] === "success"
            : keys.length === 3 &&
              keys[0] === "stderr" &&
              keys[1] === "stdout" &&
              keys[2] === "success";
      if (
        !legacyKeys ||
        typeof wrapped["stdout"] !== "string" ||
        ("success" in wrapped && wrapped["success"] !== true) ||
        ("stderr" in wrapped && typeof wrapped["stderr"] !== "string")
      )
        return fail("Invalid legacy audit stdout envelope");
      text = wrapped["stdout"];
    }
  }
  if (utf8Length(text) > 32768) return fail("Missing bounded audit output");
  const markers = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FMCAD_RESULT "));
  if (markers.length !== 1) return fail("Expected exactly one audit result");
  return text;
}

/** Read-only recovery observations never settle a historical mutation. */
export function auditSummary(
  reply: unknown,
  identity: unknown,
): Record<string, unknown> {
  const text = auditOutputText(reply);
  const lines = text
    .split(/\r?\n/)
    .filter((row) => row.startsWith("FMCAD_RESULT "));
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]!.slice(13));
  } catch {
    return fail("Malformed audit result");
  }
  const value = fields(parsed, [
    "version",
    "purpose",
    "profile",
    "requestIdentity",
    "nativeOutcome",
    "modelValidation",
    "rollbackVerification",
    "modulePresent",
    "ui",
    "commandDefinition",
    "document",
    "snapshot",
    "fingerprint",
  ]);
  if (
    value["version"] !== 1 ||
    value["purpose"] !== "atomic-recovery-audit-v1" ||
    value["profile"] !== "atomic-recovery-counts-v1" ||
    hash(value["requestIdentity"]) !== hash(identity) ||
    typeof value["modulePresent"] !== "boolean" ||
    value["nativeOutcome"] !== "unknown" ||
    value["modelValidation"] !== "not_performed" ||
    value["rollbackVerification"] !== "not_performed"
  )
    return fail("Audit facts cannot assert historical outcome or change scope");
  const ui = fields(value["ui"], [
    "activeCommand",
    "idle",
    "status",
    "errorType",
  ]);
  const definition = fields(value["commandDefinition"], [
    "status",
    "idMatches",
    "isNative",
    "isValid",
    "errorType",
  ]);
  const document = fields(value["document"], [
    "status",
    "identity",
    "matches",
    "errorType",
  ]);
  const snapshot =
    value["snapshot"] === null
      ? null
      : fields(value["snapshot"], [
          "identity",
          "version",
          "isSaved",
          "isModified",
          "bodies",
          "sketches",
          "occurrences",
          "parameters",
          "timeline",
          "references",
        ]);
  for (const row of [document, snapshot]) {
    if (
      row?.["identity"] &&
      (!record(identity) ||
        hash(row["identity"]) !== hash(identity["resolvedIdentity"]))
    )
      return fail("Audit returned facts about a different document");
  }
  for (const row of [ui, definition, document]) {
    if (row["errorType"] !== undefined && !errorType(row))
      return fail("Invalid getter error type");
    for (const key of ["idle", "idMatches", "isNative", "isValid"])
      if (row[key] !== undefined && typeof row[key] !== "boolean")
        return fail("Non-boolean audit fact");
  }
  if (
    (ui["activeCommand"] !== undefined &&
      (typeof ui["activeCommand"] !== "string" ||
        ui["activeCommand"].length > 256)) ||
    (document["matches"] !== undefined && !count(document["matches"], 256))
  )
    return fail("Unbounded audit facts");
  if (
    !(ui["status"] === "unavailable"
      ? errorType(ui)
      : ui["status"] === undefined &&
        typeof ui["activeCommand"] === "string" &&
        ui["activeCommand"].length <= 256 &&
        ui["idle"] === ["", "SelectCommand"].includes(ui["activeCommand"]))
  )
    return fail("Invalid bounded UI facts");
  if (!(
    definition["status"] === "absent" ||
    (definition["status"] === "unavailable" && errorType(definition)) ||
    (["owned", "foreign_or_invalid"].includes(String(definition["status"])) &&
      ["idMatches", "isNative", "isValid"].every(
        (key) => typeof definition[key] === "boolean",
      ) &&
      (definition["status"] !== "owned" ||
        (definition["idMatches"] &&
          !definition["isNative"] &&
          definition["isValid"])))
  ))
    return fail("Invalid owned-definition facts");
  if (!(
    (document["status"] === "observed" && document["identity"]) ||
    (document["status"] === "unavailable" && errorType(document)) ||
    (["absent", "ambiguous"].includes(String(document["status"])) &&
      count(document["matches"], 256))
  ))
    return fail("Invalid exact document facts");
  if (snapshot !== null) {
    if (
      document["status"] !== "observed" ||
      ![
        "bodies",
        "sketches",
        "occurrences",
        "parameters",
        "timeline",
        "references",
      ].every((key) => count(snapshot[key])) ||
      typeof snapshot["isSaved"] !== "boolean" ||
      typeof snapshot["isModified"] !== "boolean" ||
      !(snapshot["version"] === null || count(snapshot["version"])) ||
      hash(snapshot) !== value["fingerprint"]
    )
      return fail("Audit snapshot/fingerprint is incomplete or inconsistent");
  } else if (value["fingerprint"] !== null)
    return fail("Fingerprint without a complete snapshot");
  return value;
}
