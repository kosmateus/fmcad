import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { at, record, list, text } from "./integration/offline-cli";
const testRoot = process.cwd();
const runtimeRequire = createRequire(testRoot + "/tests/manual-legacy.test.js");
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const { commands, legacyCommands, globalFlags, findCommand } = runtimeRequire(
  "../src/commands",
) as typeof import("../src/composition/library-commands");
const { manuals } = runtimeRequire(
  "../src/help-manual",
) as typeof import("../src/composition/library-help-manual");
const { detail } = runtimeRequire(
  "../src/help",
) as typeof import("../src/composition/library-help");
const { fixture, ok } = runtimeRequire("./helpers/legacy") as {
  fixture(
    t: TestContext,
    respond?: (message: {
      method: string;
      params: Record<string, unknown>;
    }) => unknown,
  ): Promise<{
    run(
      argv: string[],
    ): Promise<{ code: number; stdout: string; stderr: string }>;
    requests: unknown[];
    calls(): unknown[];
  }>;
  ok(
    value: { code: number; stdout: string; stderr: string },
    message?: string,
  ): void;
};
// These examples execute against a fake backend and explicitly assert WSL path spelling.
const restoreWsl = (
  runtimeRequire("./fixtures/fake-wsl-platform.cjs") as () => () => void
)();
test.after(restoreWsl);

test("non-family legacy/help routes have handler-audited self-contained manuals", () => {
  for (const command of legacyCommands.filter(
    (entry) => entry.kind !== "family",
  )) {
    const manual = manuals[command.key];
    assert.ok(manual, command.key);
    assert.ok(
      manual.audit.sources.length &&
        manual.audit.verified.length &&
        manual.audit.tests.length,
      command.key,
    );
    assert.deepEqual(manual.audit.gaps, [], command.key);
    assert.ok(present(manual.examples).length, command.key);
    assert.match(
      detail(...(command.key.split(" ") as [string, ...string[]])),
      command.key === "help"
        ? /Configuration Schema And Precedence/
        : /Return Contract/,
    );
  }
});

test("legacy manual examples pass argv through the broker boundary and never select a direct client", async (t) => {
  for (const owner of legacyCommands.filter(
    (entry) => entry.kind !== "family",
  )) {
    for (const example of present(present(manuals[owner.key]).examples)) {
      const f = await fixture(t);
      ok(await f.run(present(example.argv)), owner.key);
      const routedArgv = present(example.argv).filter(
        (arg, index) =>
          !globalFlags[arg] &&
          !globalFlags[present(example.argv)[index - 1] ?? ""],
      );
      const entry = findCommand(routedArgv);
      assert.ok(entry, `${owner.key}: example resolves to an actual command`);
      if (
        entry.kind === "help" ||
        entry.kind === "init" ||
        (entry.kind === "run" && routedArgv.includes("--list"))
      ) {
        assert.equal(f.requests.length, 0, `${owner.key}: ${entry.key}`);
      } else if (entry.kind === "run") {
        assert.equal(f.requests.length, 0, "run uses the typed public service");
        assert.ok(f.calls().length, `${owner.key}: ${entry.key}`);
      } else {
        assert.equal(f.requests.length, 1, `${owner.key}: ${entry.key}`);
        assert.equal(at(f.requests[0], "action"), "submit");
        assert.ok(
          ["mcp", "addin"].includes(
            text(at(f.requests[0], "request", "backend")),
          ),
        );
        assert.ok(
          list(at(f.requests[0], "request", "argv")).includes(
            entry.key.split(" ")[0],
          ),
        );
      }
    }
  }
});

test("file_delete CLI retains accepted/rejected/exception results through one broker worker call", async (t) => {
  const cases = [
    {
      reply: {
        body: {
          result: {
            content: [
              {
                type: "text",
                text: 'DELETED_FILE name=Part\nFILE_DELETE {"accepted":true,"permanentDeletionVerified":false,"editableSlotReleased":"notVerified"}\nDONE',
              },
            ],
          },
        },
      },
      code: 0,
    },
    {
      reply: {
        body: {
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: "ERROR file_delete deleteMe returned false: Part",
              },
            ],
          },
        },
      },
      code: 1,
    },
    { reply: new Error("SDK deletion failed"), code: 1 },
  ];
  for (const item of cases) {
    const f = await fixture(t, () =>
      item.reply instanceof Error
        ? (() => {
            throw item.reply;
          })()
        : item.reply,
    );
    const result = await f.run(["file_delete", "Project", "", "Part"]);
    assert.equal(result.code, item.code);
    assert.equal(f.requests.length, 1);
    assert.equal(f.calls().length, 1);
    if (item.code === 0)
      assert.match(result.stdout, /DELETED_FILE.*FILE_DELETE.*DONE/s);
    else assert.doesNotMatch(result.stdout, /DELETED_FILE|FILE_DELETE|DONE/);
    if (item.reply instanceof Error)
      assert.match(result.stderr, /SDK deletion failed/);
  }
});

test("tools schema discovery and subsequent raw call stay inside the broker worker", async (t) => {
  const schema = [
    {
      name: "example_read",
      description: "Read a named entity",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
    },
  ];
  const f = await fixture(t, (message) =>
    message.method === "tools/list"
      ? { body: { result: { tools: schema } } }
      : undefined,
  );
  assert.equal((await f.run(["tools", "--json"])).code, 0);
  assert.deepEqual(
    JSON.parse((await f.run(["tools", "--json"])).stdout),
    schema,
  );
  assert.equal((await f.run(["tools"])).stdout, "example_read\n");
  const descriptor = present(schema[0]);
  const request = { name: "DiscoveredName" };
  assert.equal(
    (await f.run(["call", descriptor.name, JSON.stringify(request)])).code,
    0,
  );
  assert.deepEqual(f.calls().at(-1), {
    name: "example_read",
    arguments: request,
  });
  assert.equal(f.requests.length, 4);
});

test("documented param_add and export examples preserve generated script positions and path mapping", async (t) => {
  const param = await fixture(t);
  await param.run(
    present(present(present(manuals["param_add"]).examples)[0]!.argv),
  );
  assert.deepEqual(
    scriptConfig(text(at(param.calls()[0], "arguments", "object", "script")), [
      "OP",
      "ARGS",
    ]),
    {
      OP: "param_add",
      ARGS: ["wall", "3 mm", "", "", "Model"],
    },
  );
  assert.deepEqual(
    present(present(present(manuals["param_add"]).examples)[0]!.argv),
    ["param_add", "wall", "3 mm", "--doc", "Model"],
  );
  assert.match(detail("param_add"), /CLI fills omitted slots/);

  const exported = await fixture(t);
  await exported.run(
    present(present(present(manuals["export step"]).examples)[0]!.argv),
  );
  assert.equal(
    at(
      scriptConfig(
        text(at(exported.calls()[0], "arguments", "object", "script")),
        ["ARGS"],
      ),
      "ARGS",
      0,
    ),
    "step",
  );
  const relative = await fixture(t);
  await relative.run([
    "export",
    "step",
    "--doc",
    "Model",
    "--out",
    "model.step",
  ]);
  assert.match(
    text(
      at(
        scriptConfig(
          text(at(relative.calls()[0], "arguments", "object", "script")),
          ["ARGS"],
        ),
        "ARGS",
        2,
      ),
    ),
    /^\\\\wsl\$\\LegacyTest\\/,
  );
});

test("shared guide exposes global keys and stays offline", async () => {
  let output = "";
  const { main } = runtimeRequire(
    "../src/cli",
  ) as typeof import("../src/entrypoints/cli");
  assert.equal(
    await main(["help", "help"], {
      stdout: {
        write(value) {
          output += value;
        },
      },
      loadConfig: () => assert.fail("Help must not load config"),
    }),
    0,
  );
  for (const token of [
    "FMCAD_CONFIG",
    "FMCAD_BACKEND",
    "XDG_CONFIG_HOME",
    "WSL_DISTRO_NAME",
    "protocolVersion",
    "--curl-path",
    "32 MiB",
    "not a sandbox",
    "no end-of-options",
    "bin/fmcad-mcp.js",
  ])
    assert.ok(output.includes(token), token);
  assert.ok(Object.keys(globalFlags).includes("--timeout"));
  assert.ok(
    commands.some((command) => findCommand(command.key.split(" ")) === command),
  );
  assert.ok(
    fs
      .readFileSync(
        path.join(testRoot + "/tests", "../docs/COMMAND_REFERENCE.md"),
        "utf8",
      )
      .includes("fmcad help help"),
  );
});

function scriptConfig(
  script: string,
  names: string[],
): Record<string, unknown> {
  const result = (
    runtimeRequire("node:child_process") as typeof import("node:child_process")
  ).spawnSync(
    "python3",
    [path.join(testRoot + "/tests", "helpers/python_config.py")],
    {
      input: JSON.stringify({ script, names }),
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return record(JSON.parse(result.stdout));
}
