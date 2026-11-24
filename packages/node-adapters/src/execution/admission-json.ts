import { types } from "node:util";

/** Decode evidence without discarding duplicate keys or numeric information. */
export function decodeAdmissionJson(text: string): unknown {
  return decodeJson(text, "protocol");
}

/** Validate an opaque native JSON object without materializing its numbers. */
export function validateOpaqueJsonObject(text: string): void {
  decodeJson(text, "opaque-manifest");
}

/** Queue execution metadata stays protocol-strict; only declared user blobs
 * use finite JSON numbers. Numeric policy is applied before returning values. */
export function decodeOpaqueQueueJson(text: string): unknown {
  return decodeJson(text, "queue-snapshot");
}
function opaqueSnapshotPath(path: readonly string[]): boolean {
  if (path[0] === "controlBlocked") return true;
  if (
    (path[0] === "blocked" || path[0] === "localUnknown") &&
    path[1] === "reason"
  )
    return true;
  if (path[0] !== "jobs" || path[1] === undefined) return false;
  if (
    path[2] === "request" &&
    (path[3] === "payload" || (path[3] === "rpc" && path[4] === "payload"))
  )
    return true;
  const detail =
    path[2] === "details"
      ? 3
      : path[2] === "dispatch" && path[3] === "details"
        ? 4
        : -1;
  return (
    detail >= 0 && ["reason", "result", "response"].includes(path[detail] ?? "")
  );
}

/** Only the original uncertainty blobs are opaque inside a runtime record.
 * All bindings, counters, versions and other evidence remain protocol-strict. */
export function decodeRuntimeRebaselineRecordJson(text: string): unknown {
  return decodeJson(text, "runtime-record");
}
function opaqueRecordPath(path: readonly string[]): boolean {
  const start = path[0] === "layers" ? 2 : 0;
  if (path[start] !== "carriedExposures" || path[start + 2] !== "original")
    return false;
  const entry = path[start + 1] ?? "";
  return (
    /^(?:admission-epochs\/[A-Za-z0-9_-]{1,128}\/)?runtime:controlBlocked:*$/.test(
      entry,
    ) ||
    (/^(?:admission-epochs\/[A-Za-z0-9_-]{1,128}\/)?runtime:localUnknown:*$/.test(
      entry,
    ) &&
      path[start + 3] === "reason")
  );
}

function decodeJson(
  text: string,
  numberPolicy:
    "protocol" | "queue-snapshot" | "runtime-record" | "opaque-manifest",
): unknown {
  let cursor = 0;
  const fail = (): never => {
    throw new Error("Ambiguous admission JSON");
  };
  const space = () => {
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code !== 32 && code !== 9 && code !== 13 && code !== 10) break;
      cursor++;
    }
  };
  function string(decode: true): string;
  function string(decode: false): void;
  function string(decode: boolean): string | void {
    const start = cursor++;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === "\\") cursor++;
      else if (char === '"') {
        if (decode || numberPolicy === "opaque-manifest") {
          const parsed = JSON.parse(text.slice(start, cursor)) as string;
          return decode ? parsed : undefined;
        }
        return undefined;
      }
    }
    return fail();
  }
  function decimal(raw: string): string {
    const [mantissa = "", exponent = "0"] = raw.toLowerCase().split("e");
    const negative = mantissa.startsWith("-");
    const unsigned = negative ? mantissa.slice(1) : mantissa;
    const [whole = "", fraction = ""] = unsigned.split(".");
    let digits = (whole + fraction).replace(/^0+/, "");
    if (!digits) return "0";
    let scale = BigInt(exponent) - BigInt(fraction.length);
    while (digits.endsWith("0")) {
      digits = digits.slice(0, -1);
      scale++;
    }
    return `${negative ? "-" : ""}${digits}e${scale}`;
  }
  const numberToken = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const currentPath: string[] = [];
  function value(depth: number): void {
    if (depth > 128) return fail();
    space();
    const char = text[cursor];
    if (char === '"') return string(false);
    if (char === "{" || char === "[") {
      const array = char === "[";
      const end = array ? "]" : "}";
      cursor++;
      const keys = array ? undefined : new Set<string>();
      let index = 0;
      space();
      if (text[cursor] === end) {
        cursor++;
        return;
      }
      while (true) {
        space();
        let key: string;
        if (array) key = String(index++);
        else {
          if (text[cursor] !== '"') return fail();
          key = string(true);
          if (keys!.has(key)) return fail();
          keys!.add(key);
          space();
          if (text[cursor++] !== ":") return fail();
        }
        if (numberPolicy !== "protocol") currentPath.push(key);
        value(depth + 1);
        if (numberPolicy !== "protocol") currentPath.pop();
        space();
        const separator = text[cursor++];
        if (separator === end) return;
        if (separator !== ",") return fail();
      }
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length;
        return;
      }
    }
    numberToken.lastIndex = cursor;
    const raw = numberToken.exec(text)?.[0];
    if (!raw) return fail();
    cursor += raw.length;
    const arbitraryInteger =
      numberPolicy === "opaque-manifest" && !/[.eE]/.test(raw);
    if (arbitraryInteger) return;
    const opaque =
      numberPolicy === "queue-snapshot"
        ? opaqueSnapshotPath(currentPath)
        : numberPolicy === "runtime-record"
          ? opaqueRecordPath(currentPath)
          : false;
    const number = Number(raw);
    if (
      !Number.isFinite(number) ||
      (numberPolicy !== "opaque-manifest" &&
        !opaque &&
        ((Number.isInteger(number) && !Number.isSafeInteger(number)) ||
          (/[.eE]/.test(raw) && decimal(raw) !== decimal(String(number)))))
    )
      return fail();
  }
  // Opaque manifests are syntax-checked without materializing their arbitrary
  // precision integers. All other modes validate tokens before JSON.parse.
  space();
  if (numberPolicy === "opaque-manifest" && text[cursor] !== "{") return fail();
  value(0);
  space();
  if (cursor !== text.length) return fail();
  if (numberPolicy === "opaque-manifest") return;
  return JSON.parse(text) as unknown;
}

/** Copy data properties only; never invoke getters or serialization hooks. */
export function admissionData(
  value: unknown,
  seen = new Set<object>(),
): unknown {
  if (types.isProxy(value))
    throw new Error("Proxy admission input is forbidden");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || seen.has(value))
    throw new Error("Admission input must contain only JSON values");
  const array = Array.isArray(value);
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Admission input must contain only plain JSON data");
  seen.add(value);
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  const items: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor ||
      !("value" in descriptor) ||
      key === "toJSON" ||
      !descriptor.enumerable
    )
      throw new Error("Executable admission input is forbidden");
    const copied = admissionData(descriptor.value, seen);
    if (array) {
      if (key !== String(items.length))
        throw new Error("Sparse admission array");
      items.push(copied);
    } else result[key] = copied;
  }
  if (array && items.length !== (value as unknown[]).length)
    throw new Error("Sparse admission array");
  seen.delete(value);
  return array ? items : result;
}
