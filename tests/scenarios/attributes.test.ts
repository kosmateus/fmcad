import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { runScenarios } from "./runner";
import {
  attributeScenarios,
  attributeBody,
  attribute,
} from "./attribute-cases";
import { cadCommand } from "./cad-programs";
import { record, text } from "./contracts";
import { program, guard, emit } from "./programs";

for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`body attributes via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { directory, model, backend } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        attributeScenarios(simulatorFolder),
        directory,
        concurrency,
      );
      for (const report of reports) {
        assert.equal(report.status, "passed", JSON.stringify(report));
        assert.equal(report.cleanup, "complete");
      }
      assert.deepEqual(await remaining(model), { active: null, documents: [] });
    });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("attribute fixtures are removed after a failed assertion", async (t) => {
  const { directory, model, backend } = await fixture(t);
  const reports = await runScenarios(
    backend,
    [
      {
        ...attributeScenarios(simulatorFolder, 1)[0]!,
        async run(session) {
          const ref = await attributeBody(session);
          await attribute(session, "set", {
            ref,
            group: "failure",
            name: "key",
            value: "written",
          });
          assert.fail("Injected assertion after a successful write");
        },
      },
    ],
    directory,
    1,
  );
  assert.equal(reports[0]?.status, "failed");
  assert.match(reports[0]?.error ?? "", /Injected assertion/);
  assert.equal(reports[0]?.cleanup, "complete");
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("foreign body tokens cannot mutate another live scenario's document", async (t) => {
  const { directory, model, backend } = await fixture(t);
  const references = [
    deferred<Record<string, unknown> | null>(),
    deferred<Record<string, unknown> | null>(),
  ];
  const attempted = [deferred<void>(), deferred<void>()];
  const scenarios = attributeScenarios(simulatorFolder).map(
    (scenario, index) => ({
      ...scenario,
      async run(session: Parameters<typeof scenario.run>[0]) {
        try {
          const ref = await attributeBody(session);
          await attribute(session, "set", {
            ref,
            group: "shared",
            name: "key",
            value: "owner-" + index,
          });
          references[index]!.resolve(ref);
          const foreign = await references[1 - index]!.promise;
          assert.ok(foreign, "Other fixture failed setup");
          const result = await session.execute(
            "foreign-token",
            cadCommand(session.document, "entity.attribute.set", {
              ref: foreign,
              group: "shared",
              name: "key",
              value: "misrouted",
            }),
            session.document,
            "cad-v1",
          );
          assert.match(
            text(result["error"]),
            /Entity token: expected one match, found 0/,
          );
          assert.equal(result["result"], null);
          attempted[index]!.resolve();
          await attempted[1 - index]!.promise;
          const own = await attribute(session, "get", {
            ref,
            group: "shared",
            name: "key",
          });
          assert.deepEqual(own["attributes"], [
            { name: "key", value: "owner-" + index },
          ]);
        } finally {
          references[index]!.resolve(null);
          attempted[index]!.resolve();
        }
      },
    }),
  );
  const reports = await runScenarios(backend, scenarios, directory, 2);
  for (const report of reports) {
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.cleanup, "complete");
  }
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("attribute handlers preserve pre-refactor values, errors and namespace isolation", async (t) => {
  const root = path.resolve(__dirname, "../../..");
  const source = readFileSync(
    path.join(root, "tests/fixtures/history/attributes-a262.py.txt"),
    "utf8",
  );
  const metadata = record(
    JSON.parse(
      readFileSync(
        path.join(root, "tests/fixtures/history/attributes-a262.py.json"),
        "utf8",
      ),
    ),
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    metadata["sha256"],
  );
  const { prepareCadBundle } = createRequire(path.join(root, "package.json"))(
    "./src/python",
  ) as typeof import("../../packages/node-adapters/src/python/bundle");
  const observations: unknown[] = [];
  for (const historical of [true, false]) {
    const { directory, backend } = await fixture(t);
    const reports = await runScenarios(
      backend,
      [
        {
          ...attributeScenarios(simulatorFolder, 1)[0]!,
          async run(session) {
            await attributeBody(session);
            const state = await session.execute(
              "compare-handler",
              prepareCadBundle(
                root,
                (historical
                  ? source.replace(/^CAD_HANDLERS\.update.*$/m, "") + "\n"
                  : "") +
                  program(`${guard(session.document)}
ctx = CadContext(doc.name, 'root', doc_id=doc.creationId)
body = design.rootComponent.bRepBodies.item(0)
ref = ctx.ref(body)
rows: list[object] = []
for value in ['first', 'second', 'second']:
    out = entity_attribute_set(ctx, dict(ref=ref, group='shared', name='key', value=value))
    rows.append(dict(changed=out['changed'], previous=out['previousValue'], value=out['value']))
_ = entity_attribute_set(ctx, dict(ref=ref, group='other', name='key', value='independent'))
for name in ['key', 'missing']:
    out = entity_attribute_get(ctx, dict(ref=ref, group='shared', name=name))
    rows.append(dict(count=out['count'], attributes=out['attributes']))
for value in [None, 4]:
    try:
        entity_attribute_set(ctx, dict(ref=ref, group='shared', name='key', value=value))
    except ValueError as error:
        rows.append(str(error))
    else:
        raise AssertionError('Non-string attribute accepted')
${emit("dict(creationId=doc.creationId, rows=rows, attributes=[dict(group=a.groupName, name=a.name, value=a.value) for a in body.attributes])")}`),
              ).script,
            );
            observations.push({
              rows: state["rows"],
              attributes: state["attributes"],
            });
          },
        },
      ],
      directory,
      1,
    );
    assert.equal(reports[0]?.status, "passed", JSON.stringify(reports));
    assert.equal(reports[0]?.cleanup, "complete");
  }
  assert.deepEqual(observations[1], observations[0]);
});
