import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { createOperationCatalog, type OperationDeclaration } from "@fmcad/core";
import type { JsonValue } from "@fmcad/core";

const operations = [
  "sketch.dimension-plan",
  "sketch.dimension-apply",
  "sketch.mirror",
  "sketch.offset",
  "sketch.pattern",
  "sketch.project",
  "sketch.transform",
  "sketch.coordinate-check",
  "sketch.check",
] as const;
const expectedReadOnly = new Set<string>([
  "sketch.dimension-plan",
  "sketch.coordinate-check",
  "sketch.check",
]);
type JsonRecord = Record<string, JsonValue>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRecord(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(isRecord(value), `${file} must contain a JSON object`);
  return value;
}

function stringMap(value: unknown, label: string): Record<string, string> {
  assert.ok(isRecord(value), `${label} must be a string map`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string")
      throw new TypeError(`${label}.${key} must be text`);
    result[key] = item;
  }
  return result;
}

function stringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value.map((item) => {
    if (typeof item !== "string")
      throw new TypeError(`${label} must contain strings`);
    return item;
  });
}

function jsonRecord(value: unknown, label: string): JsonRecord {
  assert.ok(isRecord(value), `${label} must be an object`);
  const result: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      result[key] = item;
    } else if (Array.isArray(item)) {
      result[key] = item.map((nested) => jsonValue(nested, `${label}.${key}`));
    } else if (isRecord(item)) {
      result[key] = jsonRecord(item, `${label}.${key}`);
    } else {
      throw new TypeError(`${label}.${key} must be JSON-compatible`);
    }
  }
  return result;
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, label));
  if (isRecord(value)) return jsonRecord(value, label);
  throw new TypeError(`${label} must be JSON-compatible`);
}

function declaration(value: unknown, operation: string): OperationDeclaration {
  assert.ok(isRecord(value), `${operation} declaration must be an object`);
  if (typeof value["summary"] !== "string")
    throw new TypeError(`${operation} summary must be text`);
  if (typeof value["readOnly"] !== "boolean")
    throw new TypeError(`${operation} readOnly must be boolean`);
  const result: OperationDeclaration = {
    summary: value["summary"],
    inputs: stringMap(value["inputs"], `${operation} inputs`),
    required: stringArray(value["required"], `${operation} required fields`),
    example: jsonRecord(value["example"], `${operation} example`),
    limitations: stringArray(value["limitations"], `${operation} limitations`),
    readOnly: value["readOnly"],
  };
  if (typeof value["requiresDoc"] === "boolean")
    result.requiresDoc = value["requiresDoc"];
  if (typeof value["offline"] === "boolean") result.offline = value["offline"];
  if (typeof value["nodeOnly"] === "boolean")
    result.nodeOnly = value["nodeOnly"];
  return result;
}

test("the nine requested sketch methods remain document-scoped Python SDK operations", () => {
  const root = process.cwd();
  const sources = [
    readRecord(path.join(root, "src/catalog/sketch.json")),
    readRecord(path.join(root, "src/catalog/model.json")),
    readRecord(path.join(root, "src/catalog/sketch-geometry-proof.json")),
  ];
  const declarations: Record<string, OperationDeclaration> = {};
  for (const operation of operations) {
    const source = sources.find((candidate) =>
      Object.hasOwn(candidate, operation),
    );
    assert.ok(source, `No catalog source declares ${operation}.`);
    declarations[operation] = declaration(source[operation], operation);
  }
  const catalog = createOperationCatalog(declarations, { services: {} });
  for (const operation of operations) {
    const contract = catalog.contracts[operation];
    assert.ok(contract, operation);
    assert.equal(contract.service.kind, "python", operation);
    assert.equal(contract.requirements.sdk, "required", operation);
    assert.equal(contract.requirements.document, true, operation);
    assert.equal(
      contract.readOnlyRequested,
      expectedReadOnly.has(operation),
      operation,
    );
    assert.equal(
      catalog.validate(operation, contract.declaration.example),
      contract.declaration,
      operation,
    );
  }
});

test("the live source is strict TypeScript and invokes only the generated installed CLI through queue", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "tests/live-sketch-operations.ts"),
    "utf8",
  );
  for (const operation of operations)
    assert.ok(source.includes(`"${operation}"`), operation);
  assert.match(source, /dist\/bin\/fmcad\.js/u);
  assert.match(source, /src\/commands\.js/u);
  assert.match(source, /commandRoute/u);
  assert.match(source, /--routing/u);
  assert.match(source, /--client/u);
  assert.match(source, /--doc-id/u);
  assert.match(source, /command\(\s*"doc close"/u);
  assert.match(source, /"--discard"/u);
  assert.match(source, /assertOtherDocumentsPreserved/u);
  assert.doesNotMatch(
    source,
    /helpers\/live-broker\.js|execute_python|@ts-nocheck|@ts-ignore/u,
  );
  assert.doesNotMatch(source, /\bany\b/u);
});
