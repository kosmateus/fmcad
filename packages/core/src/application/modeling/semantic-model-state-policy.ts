const operations = new Set([
  "frame.context_audit",
  "snapshot.capture_v2",
  "snapshot.diff_v2",
]);
const channels = new Set([
  "geometry",
  "pose",
  "attributes",
  "topology",
  "visibility",
]);
const referenceFields = new Set([
  "token",
  "kind",
  "name",
  "component",
  "occurrence",
  "path",
]);
const MAX_BINDINGS = 256;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(label + " must be an object");
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const keys = new Set([...required, ...optional]);
  if (
    Object.keys(value).some((key) => !keys.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error(label + " has missing or unsupported fields");
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(label + " must be a nonempty string");
}

function finite(value: unknown, label: string, positive = false) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (positive && value <= 0)
  )
    throw new Error(
      label + (positive ? " must be positive and finite" : " must be finite"),
    );
}

function reference(value: unknown, label: string) {
  if (typeof value === "string") return text(value, label);
  const input = object(value, label);
  exactKeys(input, [], [...referenceFields], label);
  if (
    !Object.keys(input).length ||
    !["token", "name"].some((key) => input[key] !== undefined)
  )
    throw new Error(label + " must contain an explicit token or name");
  if (input["kind"] !== undefined && input["kind"] !== "body")
    throw new Error(label + ".kind must be body");
  for (const key of ["token", "name", "kind"]) {
    if (input[key] !== undefined) text(input[key], label + "." + key);
  }
  for (const key of ["component", "occurrence"]) {
    if (input[key] !== undefined) reference(input[key], label + "." + key);
  }
  if (input["path"] !== undefined)
    instancePath(input["path"], label + ".path", false);
}

function instancePath(value: unknown, label: string, allowRoot: boolean) {
  if (
    !Array.isArray(value) ||
    (!allowRoot && value.length === 0) ||
    value.length > 64 ||
    value.some((part) => typeof part !== "string" || !part.trim())
  )
    throw new Error(
      label +
        " must be a " +
        (allowRoot ? "root-qualified" : "nonempty root-qualified") +
        " path",
    );
}

function matrix(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length !== 16)
    throw new Error(label + " must contain 16 numbers");
  value.forEach((number, index) => finite(number, label + "[" + index + "]"));
}

function datumSource(value: unknown) {
  const source = object(value, "datumSource");
  exactKeys(source, ["kind", "version"], [], "datumSource");
  text(source["kind"], "datumSource.kind");
  if (
    typeof source["version"] !== "string" &&
    typeof source["version"] !== "number"
  )
    throw new Error("datumSource.version must be a string or number");
  if (typeof source["version"] === "string")
    text(source["version"], "datumSource.version");
  else finite(source["version"], "datumSource.version");
}

function documentPin(value: unknown) {
  const pin = object(value, "scope.document");
  exactKeys(pin, ["creationId", "fileId", "version"], [], "scope.document");
  text(pin["creationId"], "scope.document.creationId");
  text(pin["fileId"], "scope.document.fileId");
  if (
    typeof pin["version"] !== "number" ||
    !Number.isSafeInteger(pin["version"]) ||
    pin["version"] < 0
  )
    throw new Error("scope.document.version must be a nonnegative integer");
}

function binding(value: unknown, index: number) {
  const item = object(value, "bindings[" + index + "]");
  exactKeys(
    item,
    ["role", "sourceId", "ref", "instance"],
    [],
    "bindings[" + index + "]",
  );
  text(item["role"], "bindings[" + index + "].role");
  text(item["sourceId"], "bindings[" + index + "].sourceId");
  reference(item["ref"], "bindings[" + index + "].ref");
  instancePath(item["instance"], "bindings[" + index + "].instance", true);
}

function snapshot(value: unknown, label: string) {
  const input = object(value, label);
  exactKeys(
    input,
    ["schemaVersion", "precision", "exactBRepEquivalence", "scope", "entities"],
    ["status", "coverage"],
    label,
  );
  if (
    input["schemaVersion"] !== 2 ||
    input["precision"] !== "observational" ||
    input["exactBRepEquivalence"] !== false ||
    !Array.isArray(input["entities"]) ||
    input["entities"].length > MAX_BINDINGS
  ) {
    throw new Error(
      label + " must be a bounded observational semantic snapshot v2",
    );
  }
  if (
    (input["status"] !== undefined && input["status"] !== "partial") ||
    (input["coverage"] !== undefined && input["coverage"] !== "partial")
  )
    throw new Error(label + " must retain partial observation status");
  const scope = object(input["scope"], label + ".scope");
  if (scope["kind"] !== "explicit-bindings")
    throw new Error(label + ".scope.kind must be explicit-bindings");
  documentPin(scope["document"]);
  for (const [index, entity] of input["entities"].entries()) {
    const row = object(entity, label + ".entities[" + index + "]");
    exactKeys(
      row,
      ["role", "source", "instance"],
      [
        "geometry",
        "pose",
        "attributes",
        "topology",
        "visibility",
        "observedTokens",
      ],
      label + ".entities[" + index + "]",
    );
    text(row["role"], label + ".entities[" + index + "].role");
    instancePath(
      row["instance"],
      label + ".entities[" + index + "].instance",
      true,
    );
    const source = object(
      row["source"],
      label + ".entities[" + index + "].source",
    );
    exactKeys(
      source,
      ["id", "document"],
      [],
      label + ".entities[" + index + "].source",
    );
    text(source["id"], label + ".entities[" + index + "].source.id");
    const sourceDocument = object(
      source["document"],
      label + ".entities[" + index + "].source.document",
    );
    exactKeys(
      sourceDocument,
      ["creationId", "fileId", "version"],
      [],
      label + ".entities[" + index + "].source.document",
    );
    for (const key of ["creationId", "fileId"]) {
      if (sourceDocument[key] !== null)
        text(
          sourceDocument[key],
          label + ".entities[" + index + "].source.document." + key,
        );
    }
    if (
      sourceDocument["version"] !== null &&
      (typeof sourceDocument["version"] !== "number" ||
        !Number.isSafeInteger(sourceDocument["version"]) ||
        sourceDocument["version"] < 0)
    )
      throw new Error(
        label +
          ".entities[" +
          index +
          "].source.document.version must be a nonnegative integer or null",
      );
    for (const channel of channels) {
      if (Object.hasOwn(row, channel) && row[channel] === null)
        throw new Error(
          label +
            ".entities[" +
            index +
            "]." +
            channel +
            " must be omitted when unobserved",
        );
    }
  }
}

function validate(operation: string, data: unknown) {
  if (!operations.has(operation)) return;
  const input = object(data, operation);
  if (operation === "frame.context_audit") {
    exactKeys(
      input,
      ["ref", "sourceId", "instance", "datumToRoot", "datumSource"],
      ["lengthToleranceCm", "matrixTolerance"],
      operation,
    );
    reference(input["ref"], "ref");
    text(input["sourceId"], "sourceId");
    instancePath(input["instance"], "instance", true);
    matrix(input["datumToRoot"], "datumToRoot");
    datumSource(input["datumSource"]);
    if (input["lengthToleranceCm"] !== undefined)
      finite(input["lengthToleranceCm"], "lengthToleranceCm", true);
    if (input["matrixTolerance"] !== undefined)
      finite(input["matrixTolerance"], "matrixTolerance", true);
    return;
  }

  if (operation === "snapshot.capture_v2") {
    exactKeys(input, ["scope", "bindings"], [], operation);
    const scope = object(input["scope"], "scope");
    exactKeys(scope, ["kind", "document"], [], "scope");
    if (scope["kind"] !== "explicit-bindings")
      throw new Error("scope.kind must be explicit-bindings");
    documentPin(scope["document"]);
    if (
      !Array.isArray(input["bindings"]) ||
      input["bindings"].length > MAX_BINDINGS
    )
      throw new Error(
        "bindings must contain at most " + MAX_BINDINGS + " entries",
      );
    input["bindings"].forEach(binding);
    return;
  }

  exactKeys(
    input,
    ["before", "after"],
    ["allowedMovedSubtrees", "tolerances"],
    operation,
  );
  snapshot(input["before"], "before");
  snapshot(input["after"], "after");
  if (input["allowedMovedSubtrees"] !== undefined) {
    if (
      !Array.isArray(input["allowedMovedSubtrees"]) ||
      input["allowedMovedSubtrees"].length > MAX_BINDINGS
    )
      throw new Error(
        "allowedMovedSubtrees must contain at most " + MAX_BINDINGS + " paths",
      );
    input["allowedMovedSubtrees"].forEach((subtree, index) =>
      instancePath(subtree, "allowedMovedSubtrees[" + index + "]", false),
    );
  }
  if (input["tolerances"] !== undefined) {
    const values = object(input["tolerances"], "tolerances");
    if (Object.keys(values).some((key) => !channels.has(key)))
      throw new Error("tolerances contains an unsupported channel");
    for (const [channel, tolerance] of Object.entries(values))
      finite(tolerance, "tolerances." + channel, true);
  }
}

export { validate };
