import { types } from "node:util";

/** Decode evidence without discarding duplicate keys or numeric information. */
export function decodeAdmissionJson(text: string): unknown {
  return decodeJson(text, "protocol");
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
  numberPolicy: "protocol" | "queue-snapshot" | "runtime-record",
): unknown {
  let cursor = 0;
  const fail = (): never => {
    throw new Error("Ambiguous admission JSON");
  };
  const space = () => {
    while (/[ \t\r\n]/.test(text[cursor] ?? "") && cursor < text.length)
      cursor++;
  };
  function string(): string {
    const start = cursor++;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === "\\") cursor++;
      else if (char === '"')
        return JSON.parse(text.slice(start, cursor)) as string;
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
  function value(depth: number, path: readonly string[] = []): unknown {
    if (depth > 128) return fail();
    space();
    const char = text[cursor];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      const array = char === "[";
      const end = array ? "]" : "}";
      cursor++;
      const entries: unknown[] = [];
      const result: Record<string, unknown> = {};
      const keys = new Set<string>();
      space();
      if (text[cursor] === end) {
        cursor++;
        return array ? entries : result;
      }
      while (true) {
        space();
        if (array)
          entries.push(
            value(
              depth + 1,
              numberPolicy !== "protocol"
                ? [...path, String(entries.length)]
                : path,
            ),
          );
        else {
          if (text[cursor] !== '"') return fail();
          const key = string();
          if (keys.has(key)) return fail();
          keys.add(key);
          space();
          if (text[cursor++] !== ":") return fail();
          Object.defineProperty(result, key, {
            value: value(
              depth + 1,
              numberPolicy !== "protocol" ? [...path, key] : path,
            ),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        space();
        const separator = text[cursor++];
        if (separator === end) return array ? entries : result;
        if (separator !== ",") return fail();
      }
    }
    for (const [literal, decoded] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length;
        return decoded;
      }
    }
    const raw = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(cursor),
    )?.[0];
    if (!raw) return fail();
    cursor += raw.length;
    const opaque =
      numberPolicy === "queue-snapshot"
        ? opaqueSnapshotPath(path)
        : numberPolicy === "runtime-record"
          ? opaqueRecordPath(path)
          : false;
    const number = Number(raw);
    if (
      !Number.isFinite(number) ||
      (!opaque &&
        ((Number.isInteger(number) && !Number.isSafeInteger(number)) ||
          decimal(raw) !== decimal(String(number))))
    )
      return fail();
    return number;
  }
  const result = value(0);
  space();
  if (cursor !== text.length) return fail();
  return result;
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
