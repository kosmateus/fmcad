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
      if (/^assert(?:\.|$)/u.test(name))
        add(node, "assertion", node.getText(file));
      else if (/^(?:assertion|near|assert[A-Z]\w*)$/u.test(name))
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

export function inventorySources(root: string) {
  return currentSources(root).map((source) => {
    const content = fs.readFileSync(path.join(root, source), "utf8");
    return {
      source,
      sha256: digest(content),
      assertions: assertionSites(source, content),
    };
  });
}
