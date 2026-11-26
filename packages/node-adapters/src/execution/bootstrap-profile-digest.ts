import { createHash } from "node:crypto";
import { decodeAdmissionJson } from "./admission-json";

function ascii(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function pythonOrder(a: string, b: string): number {
  const left = Array.from(a),
    right = Array.from(b);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference =
      left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
}

function pythonNumber(token: string): string {
  if (!/[.eE]/.test(token)) return BigInt(token).toString();
  const value = Number(token);
  if (Object.is(value, -0)) return "-0.0";
  if (value === 0) return "0.0";
  const [coefficient = "", power = "0"] = value.toExponential().split("e");
  const exponent = Number(power);
  if (exponent < -4 || exponent >= 16) {
    return (
      coefficient +
      "e" +
      (exponent < 0 ? "-" : "+") +
      Math.abs(exponent).toString().padStart(2, "0")
    );
  }
  const negative = coefficient.startsWith("-");
  const digits = coefficient.replace("-", "").replace(".", "");
  const point = exponent + 1;
  const decimal =
    point <= 0
      ? "0." + "0".repeat(-point) + digits
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length) + ".0"
        : digits.slice(0, point) + "." + digits.slice(point);
  return (negative ? "-" : "") + decimal;
}

/** Owned-v3 profile attestation: native json.dumps(sort_keys=True,
 * separators=(",", ":"), allow_nan=False), with default ensure_ascii=True.
 * Keep numeric token type: Python re-encodes JSON 3.0 differently from 3.
 * Admission decoding first retains the existing duplicate/nonfinite/loss guards.
 */
export function bootstrapProfileSemanticDigest(bytes: Uint8Array): string {
  // Preserve U+FEFF for strict JSON refusal, matching native bytes.decode("utf-8").
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  decodeAdmissionJson(text);
  let cursor = 0;
  const space = () => {
    while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    while (cursor < text.length) {
      const character = text[cursor++];
      if (character === "\\") cursor++;
      else if (character === '"')
        return JSON.parse(text.slice(start, cursor)) as string;
    }
    throw new Error("Incomplete profile string");
  };
  const value = (): string => {
    space();
    if (text[cursor] === '"') return ascii(string());
    if (text[cursor] === "{") {
      cursor++;
      space();
      const fields: [string, string][] = [];
      while (text[cursor] !== "}") {
        const key = string();
        space();
        cursor++;
        fields.push([key, value()]);
        space();
        if (text[cursor] !== ",") break;
        cursor++;
        space();
      }
      cursor++;
      return (
        "{" +
        fields
          .sort(([a], [b]) => pythonOrder(a, b))
          .map(([key, encoded]) => ascii(key) + ":" + encoded)
          .join(",") +
        "}"
      );
    }
    if (text[cursor] === "[") {
      cursor++;
      space();
      const items: string[] = [];
      while (text[cursor] !== "]") {
        items.push(value());
        space();
        if (text[cursor] !== ",") break;
        cursor++;
      }
      cursor++;
      return "[" + items.join(",") + "]";
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length;
        return literal;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(cursor),
    )?.[0];
    if (!number) throw new Error("Invalid profile value");
    cursor += number.length;
    return pythonNumber(number);
  };
  const encoded = value();
  space();
  if (cursor !== text.length) throw new Error("Trailing profile bytes");
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}
