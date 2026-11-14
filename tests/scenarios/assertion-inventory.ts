import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";

export interface AssertionSite {
  id: string;
  line: number;
  kind: "assertion" | "helper" | "embedded-python";
  expression: string;
}
export const digest = (source: string): string =>
  createHash("sha256").update(source).digest("hex");

/** Static assertion sites, not runtime invocation counts or proof of coverage.
 * Loop-generated assertions remain one site with their full expression retained.
 * Python in strings is retained separately instead of pretending it is JS AST.
 */
export function assertionSites(
  filename: string,
  source: string,
): AssertionSite[] {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  // Discover local assertion wrappers rather than relying on their spelling.
  // Calls retain their argument expressions, including expected values/tolerances.
  const functions = new Map<string, Set<string>>();
  function collect(node: ts.Node): void {
    let name: string | undefined;
    let body: ts.Node | undefined;
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      name = node.name.text;
      body = node.body;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      name = node.name.text;
      body = node.initializer.body;
    }
    if (name && body) {
      const calls = functions.get(name) ?? new Set<string>();
      function scan(value: ts.Node): void {
        if (ts.isCallExpression(value))
          calls.add(value.expression.getText(file));
        ts.forEachChild(value, scan);
      }
      scan(body);
      functions.set(name, calls);
    }
    ts.forEachChild(node, collect);
  }
  collect(file);
  const helpers = new Set<string>();
  const assertionName = (name: string) => /^assert(?:\.|$)/u.test(name);
  const namedHelper = (name: string) =>
    /^(?:assertion|near|assert[A-Z]\w*)$/u.test(name);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const [name, calls] of functions) {
      if (
        !helpers.has(name) &&
        [...calls].some(
          (call) =>
            assertionName(call) || namedHelper(call) || helpers.has(call),
        )
      ) {
        helpers.add(name);
        expanded = true;
      }
    }
  }
  const sites: AssertionSite[] = [];
  const occurrences = new Map<string, number>();
  function add(node: ts.Node, kind: AssertionSite["kind"], expression: string) {
    const hash = digest(kind + "\n" + expression);
    const occurrence = (occurrences.get(hash) ?? 0) + 1;
    occurrences.set(hash, occurrence);
    sites.push({
      id: hash.slice(0, 20) + "-" + occurrence,
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      kind,
      expression,
    });
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(file);
      if (assertionName(name)) add(node, "assertion", node.getText(file));
      else if (namedHelper(name) || helpers.has(name))
        add(node, "helper", node.getText(file));
    }
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      // Preserve the entire string fragment: multiline Python asserts and template
      // substitutions cannot safely be reconstructed by splitting at newlines.
      if (/(?:^|\n)\s*assert\s|raise AssertionError/u.test(node.text))
        add(node, "embedded-python", node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return sites;
}

export function currentSources(root: string): string[] {
  const inventory = JSON.parse(
    fs.readFileSync(path.join(root, "tests/live-suite-inventory.json"), "utf8"),
  ) as { entries: { source: string }[] };
  return [
    ...new Set([
      ...inventory.entries.map((entry) => entry.source),
      ...fs
        .readdirSync(path.join(root, "tests/helpers"))
        .filter((name) => /^live-.*\.(?:js|ts)$/u.test(name))
        .map((name) => "tests/helpers/" + name),
    ]),
  ].sort();
}

/** Explicit review boundary for the three import sources whose assertions moved.
 * The old sites remain obligations. Every current source byte and assertion site
 * is checked separately before any frozen source may be used by the inventory.
 */
export const reviewedImportSources = [
  "tests/live-data-import-fixed.ts",
  "tests/live-data-import.ts",
  "tests/live-import-receipts.ts",
] as const;
interface ReviewedSource {
  source: string;
  sha256: string;
  assertions: AssertionSite[];
}
interface ExtractionReview {
  schemaVersion: number;
  retained: { source: string; snapshot: string; sha256: string }[];
  current: ReviewedSource[];
}
export function reviewedImportSnapshots(
  root: string,
): ReadonlyMap<string, string> {
  const review = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/live-import-extraction-review.json"),
      "utf8",
    ),
  ) as ExtractionReview;
  assert.equal(review.schemaVersion, 1);
  assert.deepEqual(
    review.retained.map((row) => row.source),
    [...reviewedImportSources],
  );
  const snapshots = new Map<string, string>();
  const originalSites = new Map<string, AssertionSite>();
  for (const row of review.retained) {
    const expected =
      "tests/fixtures/history/" +
      path.basename(row.source, ".ts") +
      "-dce47c5.ts.txt";
    assert.equal(
      row.snapshot,
      expected,
      "Only the named public pre-extraction source snapshots are permitted",
    );
    const content = fs.readFileSync(path.join(root, expected), "utf8");
    assert.equal(
      digest(content),
      row.sha256,
      "Retained import snapshot changed: " + row.source,
    );
    snapshots.set(row.source, content);
    for (const site of assertionSites(row.source, content))
      originalSites.set(row.source + ":" + site.id, site);
  }
  const ledger = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/scenarios/assertion-dispositions-import.json"),
      "utf8",
    ),
  ) as {
    mappings: {
      source: string;
      assertionId: string;
      evidence: string;
      evidenceAssertion: string;
      requiredObservation?: string;
    }[];
  };
  assert.equal(
    originalSites.size,
    482,
    "Review must preserve all original import assertions",
  );
  assert.deepEqual(
    ledger.mappings.map((row) => row.source + ":" + row.assertionId).sort(),
    [...originalSites.keys()].sort(),
    "Every retained import assertion needs exactly one semantic disposition",
  );
  const expectedCurrent = [
    ...new Set([
      ...reviewedImportSources,
      ...ledger.mappings.map((row) => row.evidence),
    ]),
  ].sort();
  assert.deepEqual(
    review.current.map((row) => row.source),
    expectedCurrent,
    "Current review must cover original callers and every extracted evidence source",
  );
  const current = new Map<string, string>();
  for (const row of review.current) {
    assert.ok(
      row.source.startsWith("tests/") && !row.source.split("/").includes(".."),
    );
    const content = fs.readFileSync(path.join(root, row.source), "utf8");
    assert.equal(
      digest(content),
      row.sha256,
      "Review changed current import source: " + row.source,
    );
    assert.deepEqual(
      assertionSites(row.source, content),
      row.assertions,
      "Review changed current import assertions: " + row.source,
    );
    current.set(row.source, content);
  }
  for (const row of ledger.mappings) {
    const original = originalSites.get(row.source + ":" + row.assertionId);
    assert.ok(original);
    if (row.requiredObservation !== undefined)
      assert.equal(row.requiredObservation, original.expression);
    assert.ok(
      row.evidenceAssertion.length > 0 &&
        current.get(row.evidence)?.includes(row.evidenceAssertion),
      "Retained import evidence disappeared: " +
        row.source +
        ":" +
        row.assertionId,
    );
  }
  return snapshots;
}

export function inventorySources(root: string) {
  const reviewed = reviewedImportSnapshots(root);
  return currentSources(root).map((source) => {
    const content =
      reviewed.get(source) ?? fs.readFileSync(path.join(root, source), "utf8");
    return {
      source,
      sha256: digest(content),
      assertions: assertionSites(source, content),
    };
  });
}
