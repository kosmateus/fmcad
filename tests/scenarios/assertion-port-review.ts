import * as ts from "typescript";
import * as fs from "node:fs";
import path from "node:path";
import { record, text } from "./contracts";

/** Only expression syntax: never evidence of helper behavior or execution order. */
export function normalizedAssertion(expression: string): string | null {
  const source = ts.createSourceFile(
    "site.ts",
    expression,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = (
    source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  const statement = source.statements[0];
  if (
    diagnostics.length ||
    source.statements.length !== 1 ||
    !statement ||
    !ts.isExpressionStatement(statement)
  )
    return null;
  function canonical(node: ts.Node): unknown {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return canonical(node.expression);
    if (ts.isPropertyAccessExpression(node))
      return [
        "property",
        !!node.questionDotToken,
        canonical(node.expression),
        [
          ts.isPrivateIdentifier(node.name) ? "private" : "public",
          node.name.text,
        ],
      ];
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression)
    )
      return [
        "property",
        !!node.questionDotToken,
        canonical(node.expression),
        ["public", node.argumentExpression.text],
      ];
    if (ts.isStringLiteral(node)) return ["string", node.text];
    if (ts.isIdentifier(node)) return ["identifier", node.text];
    if (ts.isNumericLiteral(node)) return ["number", node.text];
    // Raw template and regex bytes are significant (including tagged templates).
    if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      return [node.kind, node.getText(source)];
    const raw = node.getChildren(source);
    const children =
      node.kind === ts.SyntaxKind.SyntaxList
        ? raw.filter((child) => child.kind !== ts.SyntaxKind.CommaToken)
        : raw;
    return children.length
      ? [node.kind, ...children.map(canonical)]
      : [node.kind, node.getText(source)];
  }
  return JSON.stringify(canonical(statement.expression));
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected ledger rows");
  return value.map(record);
}
const ports = new Set([
  "tests/live-data-import-fixed.ts",
  "tests/live-data-import.ts",
  "tests/live-sketch-operations.ts",
]);
export function reviewAssertionPorts(root: string) {
  const history = record(
    JSON.parse(
      fs.readFileSync(
        path.join(root, "tests/live-assertion-predecessors.json"),
        "utf8",
      ),
    ),
  );
  const inventory = record(
    JSON.parse(
      fs.readFileSync(
        path.join(root, "tests/live-assertion-inventory.json"),
        "utf8",
      ),
    ),
  );
  const sources = rows(inventory["sources"]);
  return {
    schemaVersion: 1,
    scope:
      "One-to-one syntax-only pairs in the three JS-to-TS ports. Formatting, quote spelling, literal property access and erased assertions only; not helper behavior, execution order, fixture safety or migration coverage.",
    sources: rows(history["sources"])
      .filter((source) => ports.has(text(source["source"])))
      .map((source) => {
        const comparison = record(source["comparison"]);
        const removed = rows(comparison["removed"]);
        const current = sources.find(
          (row) => row["source"] === source["source"],
        );
        if (!current) throw new Error("Missing current source");
        if (!Array.isArray(comparison["addedIds"]))
          throw new Error("Missing added IDs");
        const added = new Set(comparison["addedIds"]);
        const candidates = rows(current["assertions"]).filter((row) =>
          added.has(row["id"]),
        );
        const before = removed.map((row) => ({
          row,
          key: normalizedAssertion(text(row["expression"])),
        }));
        const after = candidates.map((row) => ({
          row,
          key: normalizedAssertion(text(row["expression"])),
        }));
        const syntaxPairs: { before: string; after: string }[] = [];
        const openRemovedIds: string[] = [];
        for (const { row, key } of before) {
          const matches =
            key === null
              ? []
              : after.filter((candidate) => candidate.key === key);
          if (
            matches.length === 1 &&
            before.filter((candidate) => candidate.key === key).length === 1
          ) {
            syntaxPairs.push({
              before: text(row["id"]),
              after: text(matches[0]!.row["id"]),
            });
          } else openRemovedIds.push(text(row["id"]));
        }
        return {
          source: source["source"],
          commit: source["commit"],
          predecessor: source["predecessor"],
          beforeSha256: record(comparison["before"])["sha256"],
          afterSha256: record(comparison["after"])["sha256"],
          syntaxPairs,
          openRemovedIds,
        };
      }),
  };
}
if (require.main === module) {
  const root = path.resolve(__dirname, "../../..");
  const output = process.argv[2];
  if (!output)
    throw new Error(
      "Provide a review output path; never overwrite the frozen source inventory",
    );
  fs.writeFileSync(
    output,
    JSON.stringify(reviewAssertionPorts(root), null, 2) + "\n",
  );
}
