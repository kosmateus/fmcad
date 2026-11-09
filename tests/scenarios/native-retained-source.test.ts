import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import ts from "typescript";
import { runScenarios } from "./runner";
import type { ScenarioBackend } from "./contracts";
import { nativeEngineeringScenarios } from "./native-engineering-cases";
import { nativeThreadScenarios } from "./native-thread-cases";
import { nativeBatchReferenceScenarios } from "./native-batch-reference-cases";
import { nativeJointLimitsScenarios } from "./native-joint-limits-cases";
const root = path.resolve(__dirname, "../../..");
function readbacks(file: string) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(path.join(root, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const rows: unknown[] = [];
  const literal = (node: ts.Node | undefined): unknown => {
    if (!node) return null;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(node.operand)
    )
      return -Number(node.operand.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    return "dynamic-expression";
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "check"
    )
      rows.push([
        literal(node.arguments[0]),
        literal(node.arguments[1]),
        literal(node.arguments[3]),
        literal(node.arguments[4]),
      ]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return rows;
}
for (const family of ["engineering", "thread"] as const)
  test(`retained ${family} port preserves every readback label, literal expected value and tolerance`, () => {
    const old =
      family === "engineering"
        ? "tests/live-engineering-analytics.js"
        : "tests/live-thread-method.js";
    const previous = readbacks(old);
    assert.ok(previous.length > 20);
    assert.deepEqual(
      readbacks(`tests/scenarios/native-${family}-cases.ts`),
      previous,
    );
  });

for (const protocol of ["mcp", "addin"] as const)
  test(`native batch, joint, engineering and thread require real capabilities before any dispatch via ${protocol}`, async (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "fmcad-native-capability-"),
    );
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let sends = 0;
    const backend: ScenarioBackend = {
      identity: "unsupported-native-proof",
      mode: "simulator",
      qualification: "component",
      protocol,
      capabilities: new Set(["documents"]),
      fusionPath: (value) => value,
      async execute() {
        sends++;
        throw new Error("Native capability must prevent SDK dispatch");
      },
    };
    const scenarios = [
      ...nativeEngineeringScenarios(10),
      ...nativeThreadScenarios(10),
      ...nativeBatchReferenceScenarios(10),
      ...nativeJointLimitsScenarios(10),
    ];
    const reports = [];
    // Each independent owner must actually reach the capability gate; an earlier
    // exclusive failure otherwise correctly marks later work as not-run.
    for (const scenario of scenarios)
      reports.push(...(await runScenarios(backend, [scenario], directory, 10)));
    assert.equal(reports.length, 50);
    assert.ok(
      reports.every(
        (report) =>
          report.status === "unsupported" &&
          report.cleanup === "not-created" &&
          report.requests.length === 0,
      ),
    );
    assert.equal(sends, 0);
  });
