import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, remaining } from "./test-support";
import { record } from "./contracts";
import { marker } from "./programs";
import { runScenarios, resumeCleanup } from "./runner";
import {
  nativeFileExportScenarios,
  nativeFileExportsCapability,
  nativeFileExportBinaryReadbackProgram,
  ownedExportPaths,
} from "./native-file-export-cases";

test("generated native export binary readback passes the pinned Python checker", () => {
  const root = path.resolve(__dirname, "../../.."),
    checkerRequire = createRequire(path.join(root, "package.json")),
    checkerPath = checkerRequire.resolve("basedpyright/index.js"),
    packagePath = checkerRequire.resolve("basedpyright/package.json"),
    checkerPackage = record(
      JSON.parse(fs.readFileSync(packagePath, "utf8")) as unknown,
    );
  assert.equal(checkerPackage["version"], "1.40.2");
  const document = {
      name: "FMCAD_SCENARIO_binary_readback_owner",
      creationId: "owned-creation-id",
    },
    files = [
      { native: "C:\\owned\\fixture.step" },
      { native: "C:\\owned\\fixture.stl" },
      { native: "C:\\owned\\fixture_parts.step" },
      { native: "C:\\owned\\fixture_parts.stl" },
    ],
    source = nativeFileExportBinaryReadbackProgram(
      document,
      files,
      files[0]!.native,
    );
  assert.ok(source.includes("content[:16].hex()"));
  assert.ok(source.includes("hashlib.sha256(content).hexdigest()"));
  assert.ok(
    source.includes(
      "bytes.fromhex(step['prefix']).startswith(b'ISO-10303-21;')",
    ),
  );

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-export-readback-check-"),
  );
  try {
    fs.writeFileSync(path.join(directory, "request.py"), source);
    const adsk = path.join(directory, "stubs", "adsk");
    fs.mkdirSync(adsk, { recursive: true });
    fs.writeFileSync(path.join(adsk, "__init__.py"), "");
    fs.writeFileSync(
      path.join(adsk, "core.py"),
      `from __future__ import annotations

class Document:
    creationId: str
    name: str
    isSaved: bool
    dataFile: None

class Application:
    documents: list[Document]
    activeDocument: Document

    @staticmethod
    def get() -> Application: ...
`,
    );
    fs.writeFileSync(
      path.join(directory, "pyrightconfig.json"),
      JSON.stringify({
        include: ["request.py"],
        exclude: ["stubs"],
        stubPath: "stubs",
        extraPaths: [],
        pythonVersion: "3.11",
        pythonPlatform: "Linux",
        typeCheckingMode: "strict",
        useLibraryCodeForTypes: false,
        reportMissingImports: "error",
        reportMissingModuleSource: "error",
        reportMissingTypeStubs: "error",
        reportAny: "error",
        reportExplicitAny: "error",
        enableTypeIgnoreComments: false,
        reportUnusedImport: "none",
        reportUnusedVariable: "none",
        reportUnusedFunction: "none",
      }),
    );
    const checked = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=512",
        checkerPath,
        "--outputjson",
        "--pythonpath",
        path.join(directory, "no-host-python"),
        "--project",
        path.join(directory, "pyrightconfig.json"),
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1_048_576,
        env: { PATH: process.env["PATH"] ?? "", HOME: directory },
      },
    );
    assert.ifError(checked.error);
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.equal(checked.stderr, "");
    const report = record(JSON.parse(checked.stdout) as unknown);
    assert.equal(report["version"], "1.40.2");
    assert.deepEqual(report["generalDiagnostics"], []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const protocol of ["mcp", "addin"] as const) {
  test(`native exports reject all ten unsupported owners before SDK dispatch via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    const before = model.executions;
    const reports = [];
    for (const scenario of nativeFileExportScenarios())
      reports.push(...(await runScenarios(backend, [scenario], directory, 10)));
    assert.equal(reports.length, 10);
    assert.equal(model.executions, before);
    for (const report of reports) {
      assert.equal(report.status, "unsupported");
      assert.equal(report.cleanup, "not-created");
      assert.equal(report.fixture, undefined);
      assert.deepEqual(report.requests, []);
    }
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });

  test(`native export uncertain metadata retains the exact owner and forbids file work or replay via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    let injected = false;
    let cadCommands = 0;
    let fileRequests = 0;
    const faulted = {
      ...backend,
      // Inject only into a real metadata reply, before any unsupported geometry.
      capabilities: new Set([
        ...backend.capabilities,
        nativeFileExportsCapability,
      ]),
      async execute(request: Parameters<typeof backend.execute>[0]) {
        if (request.command) cadCommands++;
        if (
          request.source.includes("existing = [filename") ||
          request.source.includes("os.remove(filename)")
        )
          fileRequests++;
        const result = await backend.execute(request);
        if (
          !injected &&
          request.source.includes("version=app.version, documents=docs")
        ) {
          assert.equal(request.target, undefined);
          assert.equal(result.state, "succeeded");
          assert.equal(result.sdkSettled, true);
          const lines = result.stdout
            .trim()
            .split(/\r?\n/u)
            .filter((line) => line.startsWith(marker));
          assert.equal(lines.length, 1);
          const value = record(
            JSON.parse(lines[0]!.slice(marker.length)) as unknown,
          );
          value["nativeFiles"] = { completed: false };
          injected = true;
          return { ...result, stdout: marker + JSON.stringify(value) + "\n" };
        }
        return result;
      },
    };
    const reports = await runScenarios(
      faulted,
      nativeFileExportScenarios(2),
      directory,
      10,
    );
    assert.equal(injected, true);
    assert.equal(cadCommands, 0);
    assert.equal(fileRequests, 0);
    const first = reports[0]!;
    assert.equal(first.status, "failed");
    assert.equal(first.cleanup, "deferred");
    assert.match(first.cleanupHold?.reason ?? "", /unknown\/pending/u);
    assert.equal(reports[1]?.status, "not-run");
    assert.deepEqual(reports[1]?.requests, []);
    const state = record(await remaining(model));
    assert.ok(Array.isArray(state["documents"]));
    assert.equal(state["documents"].length, 1);
    assert.equal(
      record(state["documents"][0])["creationId"],
      first.document?.creationId,
    );
    assert.ok(!first.requests.some((request) => request.phase === "cleanup"));
    const persisted = record(
      JSON.parse(
        fs.readFileSync(path.join(first.directory, "report.json"), "utf8"),
      ) as unknown,
    );
    assert.deepEqual(persisted["cleanupHold"], first.cleanupHold);
    const count = model.executions;
    await assert.rejects(
      resumeCleanup(backend, path.join(first.directory, "report.json")),
      /case-specific|cleanup hold|uncertainty/iu,
    );
    assert.equal(model.executions, count);
  });
}

test("export files are exact owner-private session children and reject escaping native mappings", () => {
  const directory = path.resolve(".test-artifacts/export-path-proof/run/owner");
  const document = { name: "FMCAD_SCENARIO_run_owner", creationId: "owned-id" };
  const fusionPath = (local: string) =>
    path.win32.join(
      "C:\\owned-scenarios",
      path.relative(path.dirname(directory), local),
    );
  const backend = { fusionPath };
  const paths = ownedExportPaths({ directory, document, backend });
  assert.equal(paths.files.length, 4);
  assert.deepEqual(
    paths.files.map((file) => file.key),
    ["step", "stl", "partsStep", "partsStl"],
  );
  assert.ok(
    paths.files.every((file) => path.dirname(file.local) === directory),
  );
  assert.ok(
    paths.files.every(
      (file) => path.win32.dirname(file.native) === paths.nativeParent,
    ),
  );
  assert.throws(() =>
    ownedExportPaths({
      directory,
      document: { ...document, name: "../foreign" },
      backend,
    }),
  );
  assert.throws(() =>
    ownedExportPaths({
      directory,
      document,
      backend: { ...backend, fusionPath: () => "relative.step" },
    }),
  );
  assert.throws(() =>
    ownedExportPaths({
      directory,
      document,
      backend: {
        ...backend,
        fusionPath: (local) =>
          local === directory ? fusionPath(local) : "C:\\foreign\\file.step",
      },
    }),
  );
});
