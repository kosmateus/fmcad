import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(__filename),
  root = process.cwd();
const { commands, findCommand } = load(
  path.join(root, "src/commands"),
) as typeof import("../src/composition/library-commands");
const { catalog, validateCad } = load(
  path.join(root, "src/cad"),
) as typeof import("../src/composition/cad-execution");
const { manuals } = load(
  path.join(root, "src/help-manual"),
) as typeof import("../src/composition/library-help-manual");
const { detail } = load(
  path.join(root, "src/help"),
) as typeof import("../src/composition/library-help");
const { parseCadInput } = load(
  path.join(root, "src/cad-input"),
) as typeof import("../src/composition/library-cad-input");
function helpFor(key: string): string {
  const [first, ...rest] = key.split(" ");
  assert(first);
  return detail(first, ...rest);
}
test("every executable/help route has explicit source-audit metadata and published return contract", () => {
  for (const command of commands.filter((c) => c.kind !== "family")) {
    const key = command.kind === "cad" ? command.target : command.key;
    assert(key);
    const manual = manuals[key];
    assert.ok(manual, `Unfinished command: ${key}`);
    assert.ok(manual.audit.sources.length, key);
    assert.ok(manual.audit.verified.length, key);
    assert.ok(manual.audit.tests.length, key);
    assert.equal(
      "testRetirement" in manual.audit
        ? manual.audit.testRetirement
        : undefined,
      undefined,
      key,
    );
    assert.ok(Array.isArray(manual.audit.gaps), key);
    assert.ok(manual.examples?.length, key);
    if (key !== "help")
      assert.ok(
        manual.sections.some((s) => /Return Contract/i.test(s.title)),
        key,
      );
    for (const example of manual.examples) {
      assert.ok(example.label && example.requires && example.output, key);
      if (command.kind === "cad") {
        let data = example.data;
        if (data === undefined) {
          assert.ok(
            Array.isArray(example.argv),
            `${key}: missing data or argv`,
          );
          const route = findCommand(example.argv);
          assert(route);
          const declaration = catalog[key];
          assert(declaration);
          assert.equal(
            route,
            command,
            `${key}: example must resolve to its owner`,
          );
          data = parseCadInput(
            example.argv.slice(route.key.split(" ").length),
            declaration.inputs,
          ).data;
        }
        assert.doesNotThrow(
          () => validateCad(key, data),
          `${key}: ${example.label}`,
        );
      }
    }
    const firstSection = manual.sections[0];
    assert(firstSection);
    assert.ok(helpFor(command.key).includes(firstSection.text), key);
  }
  assert.deepEqual(
    commands
      .filter((c) => c.kind === "cad")
      .map((c) => c.target)
      .sort(),
    Object.keys(catalog)
      .filter((operation) => !catalog[operation]!.internalOnly)
      .sort(),
  );
});

test("groups list actual registry children and aliases share their owner", () => {
  for (const command of commands) {
    if (command.kind === "family") {
      const text = helpFor(command.key);
      const listed = [...text.matchAll(/^  fmcad help (.+?) - /gm)].map(
        (match) => match[1],
      );
      const expected = commands
        .filter(
          (c) =>
            c.kind !== "family" &&
            [
              c.key,
              ...(c.aliases || []),
              ...(c.kind === "cad" ? [c.target!.replaceAll(".", " ")] : []),
            ].some((route) => route.startsWith(command.key + " ")),
        )
        .map((c) => c.key);
      assert.deepEqual(listed.sort(), expected.sort(), command.key);
    }
    for (const alias of command.aliases || []) {
      assert.equal(findCommand(alias.split(" ")), command, alias);
      assert.equal(helpFor(alias), helpFor(command.key), alias);
    }
  }
});

test("all referenced test evidence files exist", () => {
  for (const [key, manual] of Object.entries(manuals)) {
    for (const evidence of manual.audit.tests) {
      const file = evidence.split(/[: ]/)[0];
      assert(file);
      assert.ok(fs.existsSync(file), `${key}: missing test evidence ${file}`);
    }
  }
});

test("durable command reference and coverage matrix match the actual rendered CLI manuals", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/generate-help-audit.js", "--check"],
    { encoding: "utf8" },
  );
  const unfinishedRoutes = commands
    .filter((command) => command.kind !== "family")
    .map((command) => (command.kind === "cad" ? command.target : command.key))
    .filter((key) => {
      assert(key);
      return manuals[key]?.audit?.gaps?.length;
    })
    .sort();
  assert.deepEqual(unfinishedRoutes, [
    "frame.context_audit",
    "snapshot.capture_v2",
    "snapshot.diff_v2",
  ]);
  const coverage = fs.readFileSync("docs/COMMAND_COVERAGE.md", "utf8");
  const match = coverage.match(/^Unfinished command audits: (\d+)\./m);
  assert.ok(match, "coverage matrix publishes the unfinished-audit count");
  const unfinished = Number(match[1]);
  assert.equal(unfinished, unfinishedRoutes.length);
  assert.equal(
    result.status,
    unfinished ? 1 : 0,
    result.stdout + result.stderr,
  );
  assert.match(
    result.stdout,
    new RegExp(
      `${unfinished} unfinished audits; generated documentation current\\.`,
    ),
  );
  assert.doesNotMatch(result.stderr, /Stale generated documentation/);
});
