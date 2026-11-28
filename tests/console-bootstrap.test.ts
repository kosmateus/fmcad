import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliDependencies } from "../src/entrypoints/cli";
const { resolveProject } = createRequire(__filename)(
  path.join(process.cwd(), "src/console-project"),
) as typeof import("../src/composition/library-console-project");
const { main } = createRequire(__filename)(
  path.join(process.cwd(), "src/cli"),
) as typeof import("../src/entrypoints/cli");
const { consoleCommand } = createRequire(__filename)(
  path.join(process.cwd(), "src/console"),
) as typeof import("../src/composition/library-console");
function configuration(
  port: number,
): ReturnType<NonNullable<CliDependencies["loadConfig"]>> {
  return {
    cfg: {
      backend: "addin",
      url: "http://127.0.0.1:8765",
      headers: {},
      timeoutMs: 180000,
      tool: "execute_python",
      transport: "node",
      protocolVersion: "2025-11-25",
      routing: "queue",
      queue: { autoStart: false },
      controlCenter: { port },
    },
  };
}

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "CAD project");
  const child = path.join(project, "drawings", "nested");
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.join(project, ".fmcad-batch"));
  return { root, project, child };
}

test("nearest artifact project, explicit relative path and symlink resolve canonically", (t) => {
  const { root, project, child } = fixture(t);
  assert.equal(resolveProject({ cwd: project }), project);
  assert.equal(resolveProject({ cwd: child }), project);
  assert.equal(resolveProject({ cwd: root, project: "CAD project" }), project);
  fs.symlinkSync(project, path.join(root, "link"), "dir");
  assert.equal(resolveProject({ cwd: root, project: "link" }), project);
  fs.mkdirSync(path.join(child, ".cad", "telemetry", "direct"), {
    recursive: true,
  });
  assert.equal(resolveProject({ cwd: child }), child);
});

test("generic repository markers do not select projects; explicit errors never fall back", (t) => {
  const { root, project } = fixture(t);
  fs.mkdirSync(path.join(root, ".beads"));
  fs.mkdirSync(path.join(root, ".cad"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  assert.equal(resolveProject({ cwd: root }), null);
  assert.throws(
    () => resolveProject({ cwd: project, project: "missing" }),
    /ENOENT/,
  );
  assert.throws(
    () => resolveProject({ cwd: project, project: ".." }),
    /No fmcad project artifacts/,
  );
});

function dependencies(extra: Partial<CliDependencies> = {}) {
  let output = "",
    error = "",
    code = 0;
  const deps: CliDependencies = {
    stdin: { isTTY: false },
    stdout: {
      write: (s: string) => {
        output += s;
      },
      isTTY: false,
    },
    stderr: {
      write: (s: string) => {
        error += s;
      },
    },
    setExitCode: (n: number) => {
      code = n;
    },
    loadConfig: () => {
      throw new Error("unexpected config access");
    },
    createFmcad: () => {
      throw new Error("unexpected Fusion access");
    },
    ...extra,
  };
  return { deps, result: () => ({ output, error, code }) };
}

test("console and diagnostic help work offline without config or terminal", async () => {
  for (const argv of [
    ["console", "--help"],
    ["diagnostic", "-h"],
    ["help", "console"],
    ["help", "diagnostic"],
  ]) {
    const io = dependencies();
    assert.equal(await main(argv, io.deps), 0);
    assert.match(io.result().output, /fmcad console/);
    assert.equal(io.result().error, "");
  }
});

test("default and explicit web console uses configured readiness without TTY and releases caller resources", async (t) => {
  const { root } = fixture(t);
  for (const alias of ["console", "diagnostic"])
    for (const mode of [[], ["--web"]]) {
      const calls: unknown[] = [];
      const io = dependencies({
        cwd: root,
        loadConfig: (options) => {
          calls.push(["config", options]);
          return configuration(4951);
        },
        openControlCenter: async (options) => {
          calls.push(["open", options]);
          return {
            url: "http://localhost:4951/?project=registered",
            projectId: "registered",
            dispose: () => {
              calls.push(["dispose"]);
            },
          };
        },
      });
      assert.equal(
        await main(
          [
            alias,
            ...mode,
            "--config",
            "selected.json",
            "--project",
            "registered-project",
          ],
          io.deps,
        ),
        0,
      );
      assert.equal(
        io.result().output,
        "http://localhost:4951/?project=registered\n",
      );
      assert.deepEqual(calls, [
        ["config", { config: "selected.json" }],
        [
          "open",
          { port: 4951, projectPath: path.join(root, "registered-project") },
        ],
        ["dispose"],
      ]);
    }
});

test("web global view has no implicit artifact project and readiness errors retain failure", async (t) => {
  const { project } = fixture(t);
  const io = dependencies({
    cwd: project,
    loadConfig: () => configuration(4952),
    openControlCenter: async (options) => {
      assert.deepEqual(options, { port: 4952 });
      throw Object.assign(new Error("registered project is unavailable"), {
        code: "CONTROL_CENTER_PROJECT_UNREGISTERED",
      });
    },
  });
  assert.equal(await main(["console"], io.deps), 1);
  assert.equal(io.result().output, "");
  assert.match(io.result().error, /registered project is unavailable/);
});

test("console web option rejects duplicates before configuration and disposes after output failure", async () => {
  for (const args of [
    ["--web", "--web"],
    ["--web", "--project"],
    ["--web", "--unknown"],
  ]) {
    const io = dependencies();
    assert.equal(await main(["console", ...args], io.deps), 1);
    assert.equal(io.result().output, "");
  }
  let disposed = 0;
  await assert.rejects(
    consoleCommand(["--web"], {
      stdout: {
        write() {
          throw Error("closed output");
        },
      },
      loadConfig: () => ({ cfg: { controlCenter: { port: 4953 } } }),
      openControlCenter: async () => ({
        url: "http://localhost:4953/",
        projectId: null,
        dispose() {
          disposed++;
        },
      }),
    }),
    /closed output/,
  );
  assert.equal(disposed, 1);
});
