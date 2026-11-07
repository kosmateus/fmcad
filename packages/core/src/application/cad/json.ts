import { sha256 } from "../../domain/engineering/sha256";
import { record } from "./contracts";

export function canonical(value: unknown, stack = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (typeof value !== "object" || stack.has(value))
    throw new Error("Expected acyclic JSON data");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Expected plain JSON objects");
  stack.add(value);
  const result = Array.isArray(value)
    ? "[" + Array.from(value, (item) => canonical(item, stack)).join(",") + "]"
    : "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonical((value as Record<string, unknown>)[key], stack),
        )
        .join(",") +
      "}";
  stack.delete(value);
  return result;
}
export const clone = <T>(value: T): T => JSON.parse(canonical(value)) as T;
export const hash = (value: unknown): string => sha256(canonical(value));
export function transform(
  value: unknown,
  marker: string,
  replace: (value: string) => unknown,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => transform(item, marker, replace));
  if (!record(value)) return value;
  if (Object.hasOwn(value, marker)) {
    const name = value[marker];
    if (Object.keys(value).length !== 1 || typeof name !== "string" || !name)
      throw new Error(
        `${marker} must be the sole key with a nonempty string value`,
      );
    return replace(name);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      transform(item, marker, replace),
    ]),
  );
}
export function referenceParts(reference: string): string[] {
  const parts = reference.split(".");
  if (
    parts.length < 2 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_-]+$/.test(part) ||
        ["__proto__", "prototype", "constructor"].includes(part),
    )
  )
    throw new Error(`Invalid reference: ${reference}`);
  return parts;
}
export function resolveReferences(value: unknown, results: unknown): unknown {
  return transform(clone(value), "$ref", (reference) => {
    let current = results;
    for (const part of referenceParts(reference)) {
      if (Array.isArray(current)) {
        if (
          !/^(0|[1-9][0-9]*)$/.test(part) ||
          !Number.isSafeInteger(Number(part)) ||
          Number(part) >= current.length
        )
          throw new Error(
            `Invalid or out-of-range array index in reference: ${reference}`,
          );
        current = current[Number(part)];
      } else {
        if (!record(current) || !Object.hasOwn(current, part))
          throw new Error(`Unresolved reference: ${reference}`);
        current = current[part];
      }
    }
    return clone(current);
  });
}
/** UTF-8 byte count without a Node Buffer or host encoder. */
export function utf8Length(text: string): number {
  let length = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    length += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
  }
  return length;
}
