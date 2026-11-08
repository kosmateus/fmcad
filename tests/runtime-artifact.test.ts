"use strict";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

type NpmPackedPackage = { filename: string; files: Array<{ path: string }> };
type PackageManifest = {
  name: string;
  engines: { node: string };
  exports: {
    ".": { default: string; types: string };
    "./server": { default: string; types: string };
    "./api": { default: string; types: string };
  };
};
type RuntimeManifest = {
  fingerprint: string;
  entrypoints: Record<string, string>;
};
type SdkManifest = {
  commit: string;
  authorization: string;
  files: Record<string, string>;
};
type McpMessage = { id?: number; result?: { tools: Array<{ name: string }> } };
function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

const projectRoot = path.resolve(__dirname, "..", "..");
const runtimeRequire = createRequire(__filename);

function assertNoEvidenceFiles(paths: string[]): void {
  const unexpected = paths.filter((file) =>
    /(^|\/)(\.cad|\.beads|\.development|\.cache|fixtures|reports?)(\/|$)|(^|\/)[^/]*(?:^|[-_.])report[^/]*\.[^/]+$|(^|\/)[^/]*(?:benchmark|diagnosis)[^/]*\.[^/]+$|\.py[co]$|Zone\.Identifier|(^|\/)\.env(?:\.|$)|\.pem$|\.key$|\.log$/i.test(
      file,
    ),
  );
  assert.deepEqual(
    unexpected,
    [],
    "Package contains local evidence or diagnostic files",
  );
}

test("npm package excludes local evidence without installing dependencies", () => {
  const packages = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  ) as NpmPackedPackage[];
  assert.equal(packages.length, 1);
  assertNoEvidenceFiles(packages[0]!.files.map((file) => file.path));
});

test(
  "actual npm tarball runs CLI MCP and worker readonly outside checkout with clean Unicode HOME",
  { timeout: 120000 },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad artifact żółć "));
    const home = path.join(root, "clean home");
    const cwd = path.join(root, "foreign cwd");
    fs.mkdirSync(home);
    fs.mkdirSync(cwd);
    for (const directory of [
      path.join(root, "xdg", "config"),
      path.join(root, "xdg", "state"),
      path.join(root, "xdg", "cache"),
      path.join(root, "xdg", "data"),
    ])
      fs.mkdirSync(directory, { recursive: true });
    const installation: { path?: string } = {};
    t.after(() => {
      if (installation.path) {
        for (const entry of fs.readdirSync(installation.path, {
          recursive: true,
          withFileTypes: true,
        })) {
          if (entry.isDirectory())
            fs.chmodSync(path.join(entry.parentPath, entry.name), 0o755);
        }
        fs.chmodSync(installation.path, 0o755);
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const packedPackages = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", root],
        {
          cwd: projectRoot,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        },
      ).toString(),
    ) as NpmPackedPackage[];
    const packed = packedPackages[0];
    assert.ok(packed);
    const packedPaths = packed.files.map((file) => file.path);
    assert.ok(
      ["README.md", "LICENSE", "NOTICE.md"].every((file) =>
        packedPaths.includes(file),
      ),
    );
    assert.ok(
      packedPaths.every(
        (file) => !/(?:^|\/)[^/]+(?<!\.d)\.(?:ts|tsx|mts|cts)$/.test(file),
      ),
    );
    assert.ok(
      packedPaths.every(
        (file) => !/(?:^|\/)(?:tsx|ts-node|bun)(?:\/|$)/i.test(file),
      ),
    );
    assert.ok(
      packed.files.some((file) => file.path === "dist/runtime-build.json"),
    );
    assert.ok(packedPaths.includes("dist/runtime/python/typing/current.json"));
    assert.ok(
      packedPaths.some((file) =>
        /^dist\/runtime\/python\/typing\/snapshots\/[a-f0-9]{64}\/manifest\.json$/.test(
          file,
        ),
      ),
    );
    assert.ok(
      packedPaths.some((file) =>
        /^dist\/runtime\/python\/typing\/snapshots\/[a-f0-9]{64}\/NOTICES\.md$/.test(
          file,
        ),
      ),
    );
    assert.ok(packedPaths.includes("dist/assets/ui_dialog.ps1"));
    assert.ok(packedPaths.includes("dist/assets/image_trace_requirements.txt"));
    assert.ok(
      packedPaths.includes("dist/scripts/console-source-requirements.txt"),
    );
    for (const resource of [
      "dist/runtime/python/entrypoints/source_units.py",
      "dist/runtime/python/typing/checker-project.py",
      "dist/runtime/python/fmcad/adapters/fusion/identity.py",
      "dist/assets/cad/identity.py",
      "dist/src/dist/python/checker.js",
      "dist/src/dist/python/run-script.js",
      "dist/src/dist/composition/run.js",
      "dist/src/dist/python/cad-script.js",
      "dist/src/dist/composition/cad.js",
      "dist/src/dist/composition/cad-service.js",
      "dist/src/dist/composition/catalog-execution.js",
      "dist/src/dist/node-adapters/execution/invocation.js",
      "dist/src/dist/composition/cad-execution.js",
      "dist/src/dist/composition/document-publication.js",
      "dist/src/dist/composition/document-stages.js",
      "dist/src/dist/composition/batch-atomic.js",
      "dist/src/dist/composition/batch.js",
      "dist/src/dist/core/application/cad/atomic-receipt.js",
      "dist/src/dist/core/application/cad/atomic-receipt.d.ts",
      "dist/src/dist/node-adapters/execution/pause-budget.js",
      "dist/src/dist/node-adapters/execution/pause-budget.d.ts",
      "dist/src/dist/node-adapters/execution/request-timeout.js",
      "dist/src/dist/node-adapters/execution/request-timeout.d.ts",
      "dist/src/dist/node-adapters/persistence/batch-journal.js",
      "dist/src/dist/node-adapters/persistence/operation-journal.js",
      "dist/src/dist/python/document-probe.js",
      "dist/src/dist/fusion-transport/addin-capabilities.js",
      "dist/src/queue-autostart.js",
      "dist/src/dist/entrypoints/queue-autostart.js",
    ])
      assert.ok(
        packedPaths.includes(resource),
        `${resource} is missing from the npm tarball`,
      );
    assert.ok(
      packed.files.every(
        (file) =>
          !/^(src|assets|packages|\.development|\.beads)\//.test(file.path),
      ),
    );
    assertNoEvidenceFiles(packedPaths);
    assert.ok(!packedPaths.includes("docs/inspection-benchmark.json"));
    assert.ok(!packedPaths.includes("docs/inspection-strict-report.json"));
    // Install actual production dependencies, not symlinks back into this checkout.
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--prefix",
        root,
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        path.join(root, packed.filename),
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 60000,
      },
    );
    const installationRoot = path.join(root, "node_modules/fmcad");
    installation.path = installationRoot;
    const runtime = path.join(installationRoot, "dist");
    const queueAutostart = runtimeRequire(
      path.join(runtime, "src/queue-autostart.js"),
    );
    assert.equal(typeof queueAutostart.ensureBroker, "function");
    assert.equal(typeof queueAutostart.reclaimStart, "function");
    const scripts = runtimeRequire(
      path.join(runtime, "src/run.js"),
    ) as typeof import("../src/composition/run.js");
    const box = scripts.prepareRunScript(
      "box",
      [25],
      true,
      "Installed fixture",
      { docId: "installed-creation" },
    );
    assert.ok(box.script.includes("installed-creation"));
    assert.ok(box.units.some((unit) => unit.id === "identity"));
    assert.equal(
      box.units.find((unit) => unit.id === "user-script")?.filename,
      path.join(runtime, "assets/scripts/box.py"),
    );
    const cad = runtimeRequire(
      path.join(runtime, "src/cad.js"),
    ) as typeof import("../src/composition/cad.js");
    const status = cad.prepareCadScript(
      "document.status",
      {},
      { doc: "Installed fixture", docId: "installed-creation" },
    );
    assert.ok(status.script.includes("installed-creation"));
    assert.ok(status.units.some((unit) => unit.id === "document_snapshot"));
    for (const declaration of [
      "python/run-script.d.ts",
      "composition/run.d.ts",
      "python/cad-script.d.ts",
      "composition/cad.d.ts",
      "composition/cad-service.d.ts",
      "composition/catalog-execution.d.ts",
      "node-adapters/execution/invocation.d.ts",
      "composition/cad-execution.d.ts",
      "composition/document-publication.d.ts",
      "composition/document-stages.d.ts",
      "composition/batch-atomic.d.ts",
      "composition/batch.d.ts",
      "node-adapters/persistence/batch-journal.d.ts",
      "node-adapters/persistence/operation-journal.d.ts",
    ]) {
      assert.doesNotMatch(
        fs.readFileSync(path.join(runtime, "src/dist", declaration), "utf8"),
        /@fmcad\/core|packages\/node-adapters/,
      );
    }
    const packageJson = readJson<PackageManifest>(
      path.join(installationRoot, "package.json"),
    );
    assert.equal(packageJson.name, "fmcad");
    assert.equal(packageJson.engines.node, ">=22.13.0 <23 || >=24.0.0 <25");
    assert.equal(
      packageJson.exports["./api"].default,
      "./dist/src/dist/api/index.js",
    );
    assert.equal(
      packageJson.exports["./api"].types,
      "./dist/src/dist/api/index.d.ts",
    );
    const pathsAdapter = runtimeRequire(
      path.join(runtime, "src/dist/config-platform"),
    );
    const paths = pathsAdapter.resolveRuntimePaths({
      anchor: path.join(runtime, "src/cli.js"),
      home,
      env: {},
    });
    assert.equal(paths.installation, runtime);
    const manifest = readJson<RuntimeManifest>(
      path.join(runtime, "runtime-build.json"),
    );
    assert.equal(
      pathsAdapter.runtimeBuildIdentity(paths),
      manifest.fingerprint,
    );
    const snapshotPointer = readJson<{ snapshot: string }>(
      path.join(runtime, "runtime/python/typing/current.json"),
    );
    assert.match(snapshotPointer.snapshot, /^[a-f0-9]{64}$/);
    const snapshotRoot = path.join(
      runtime,
      "runtime/python/typing/snapshots",
      snapshotPointer.snapshot,
    );
    const sdkManifestBytes = fs.readFileSync(
      path.join(snapshotRoot, "manifest.json"),
    );
    assert.equal(
      runtimeRequire("node:crypto")
        .createHash("sha256")
        .update(sdkManifestBytes)
        .digest("hex"),
      snapshotPointer.snapshot,
    );
    const sdkManifest = JSON.parse(
      sdkManifestBytes.toString("utf8"),
    ) as SdkManifest;
    assert.match(sdkManifest.commit, /^[a-f0-9]{40}$/);
    assert.equal(
      sdkManifest.authorization,
      "user-authorized-2026-10-24; Autodesk rights unverified; not legal clearance",
    );
    for (const [relative, digest] of Object.entries(sdkManifest.files)) {
      const bytes = fs.readFileSync(path.join(snapshotRoot, relative));
      assert.equal(
        runtimeRequire("node:crypto")
          .createHash("sha256")
          .update(bytes)
          .digest("hex"),
        digest,
        relative,
      );
    }
    for (const [name, relative] of Object.entries(manifest.entrypoints)) {
      assert.ok(
        ["queue-worker", "queue-autostart-worker", "queue-broker"].includes(
          name,
        ),
      );
      assert.ok(
        fs.statSync(path.join(runtime, relative)).isFile(),
        `${name} entrypoint is missing`,
      );
    }
    assert.deepEqual(Object.keys(manifest.entrypoints).sort(), [
      "queue-autostart-worker",
      "queue-broker",
      "queue-worker",
    ]);
    for (const exported of [
      packageJson.exports["."].types,
      packageJson.exports["./server"].types,
      packageJson.exports["./api"].types,
    ]) {
      const relative = exported.replace(/^\.\//, "");
      assert.ok(
        packedPaths.includes(relative),
        `${relative} is not in the tarball`,
      );
      const declaration = fs.readFileSync(
        path.join(installationRoot, relative),
        "utf8",
      );
      assert.doesNotMatch(
        declaration,
        /@opencode(?:-ai)?\/plugin|(?:^|["'])\.\.\/.*packages\//m,
        relative,
      );
    }
    const before = fs.readdirSync(installationRoot, { recursive: true }).sort();
    for (const entry of fs.readdirSync(installationRoot, {
      recursive: true,
      withFileTypes: true,
    })) {
      fs.chmodSync(
        path.join(entry.parentPath, entry.name),
        entry.isDirectory() ? 0o555 : 0o444,
      );
    }
    fs.chmodSync(installationRoot, 0o555);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"],
      HOME: home,
      XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
      XDG_STATE_HOME: path.join(root, "xdg", "state"),
      XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
      XDG_DATA_HOME: path.join(root, "xdg", "data"),
    };
    const run = (
      file: string,
      args: string[] = [],
      extra: NodeJS.ProcessEnv = {},
    ) =>
      spawnSync(process.execPath, [file, ...args], {
        cwd,
        env: { ...env, ...extra },
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 16 * 1024 * 1024,
      });
    const cli = path.join(runtime, "bin/fmcad.js");
    const help = run(cli, ["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /fmcad/i);
    const listing = run(cli, ["run", "--list"]);
    assert.equal(listing.status, 0, listing.stderr);
    assert.ok(listing.stdout.includes(path.join(runtime, "assets/scripts")));
    assert.deepEqual(fs.readdirSync(home), []);
    const prepared = run("-e", [
      `
    const assert = require('node:assert/strict');
    const root = ${JSON.stringify(runtime)};
    const cad = require(root + '/src/cad');
    const artifact = cad.prepareCadScript('document.status', {}, {doc:'readonly fixture'});
    assert.ok(artifact.units.some(unit => unit.id === 'values'));
    assert.ok(!artifact.units.some(unit => unit.id === 'model'));
    const source = 'exec(compile(' + JSON.stringify(artifact.script) + ', "<readonly-fixture>", "exec"))';
    const wire = require(root + '/src/python').prepareWireArtifact(root + '/runtime/python', source);
    require(root + '/src/python').verifyPythonArtifact(wire);
    assert.ok(wire.units.some(unit => unit.filename === '<readonly-fixture>'));
    process.stdout.write(wire.sha256);
  `,
    ]);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(prepared.stdout, /^[a-f0-9]{64}$/);
    const mcp = spawnSync(
      process.execPath,
      [path.join(runtime, "bin/fmcad-mcp.js")],
      {
        cwd,
        env,
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 16 * 1024 * 1024,
        input: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n',
      },
    );
    assert.equal(mcp.status, 0, mcp.stderr);
    const messages = mcp.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as McpMessage);
    assert.ok(
      messages.some((message) => {
        assert.ok(message.result);
        return (
          message.id === 1 &&
          message.result.tools.some((tool) =>
            tool.name.startsWith("fmcad_cad_"),
          )
        );
      }),
    );
    // Reuse the production broker fake-endpoint suite, but bind it to the actual
    // installed package rather than this checkout's src/. Every queue/temp root
    // is created by that fixture beneath its own /tmp directory.
    const installedBrokerTest = path.join(
      projectRoot,
      "dist/tests/fusion-transport-broker.test.js",
    );
    const broker = spawnSync(
      process.execPath,
      ["--test", installedBrokerTest],
      {
        cwd,
        env: {
          ...env,
          XDG_STATE_HOME: path.join(cwd, "isolated broker state"),
          FMCAD_TEST_RUNTIME_ROOT: installationRoot,
        },
        encoding: "utf8",
        timeout: 90000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    assert.equal(broker.status, 0, broker.stderr + broker.stdout);
    assert.match(broker.stdout, /tests 4\b/);
    assert.match(broker.stdout, /pass 4\b/);
    const project = path.join(cwd, "fake CAD project");
    const queue = path.join(project, "isolated queue");
    const jobs = path.join(queue, "jobs");
    fs.mkdirSync(jobs, { recursive: true });
    const config = path.join(project, "fmcad.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        backend: "addin",
        routing: "queue",
        url: "http://127.0.0.1:1/mcp",
      }),
    );
    const jobFile = path.join(jobs, "request.json");
    // The broker compatibility edge parses before spawn; the installed worker
    // receives a typed service request, not executable raw CLI arguments.
    const workerRequest = runtimeRequire(
      path.join(runtime, "src/composition/execution-request"),
    ).prepareRequest({
      request: { argv: ["run", "--list"], cwd: project, inputFiles: [] },
    });
    assert.equal(workerRequest.payload.kind, "legacy-command");
    assert.equal(workerRequest.payload.listing, true);
    fs.writeFileSync(
      jobFile,
      JSON.stringify({
        id: "artifact-worker",
        deadline: Date.now() + 15000,
        buildHash: manifest.fingerprint,
        request: workerRequest,
      }),
    );
    const fakeTransport = path.join(cwd, "fake-transport.cjs");
    fs.writeFileSync(
      fakeTransport,
      `
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const load = Module._load;
    const workerRoot = ${JSON.stringify(path.join(runtime, "src/dist/entrypoints/worker.js"))};
    Module._load = function (name, parent, ...args) {
      if (parent?.filename === workerRoot && name === '../../queue-connection.js') {
        return { acceptedWorkerRequest: async (directory, message) => {
          if (directory !== process.env.FMCAD_QUEUE_DIR || message.action !== 'backend' || message.method !== 'callTool') {
            throw new Error('unexpected worker transport request');
          }
          fs.appendFileSync(path.join(directory, 'fake-transport.jsonl'), JSON.stringify(message) + '\\n');
          return { value: { content: [{ type: 'text', text: 'fake transport accepted' }] } };
        } };
      }
      if (parent?.filename === workerRoot && name === '../composition/execution-worker.js') {
        return { execute: async (_request, backend, outcome) => {
          const response = await backend.callTool({ featureType: 'script', object: { script: '# fake transport only' } }, 'fusion_mcp_execute');
          outcome({ status: 'succeeded', transport: 'fake', response });
          return 0;
        } };
      }
      return load.call(this, name, parent, ...args);
    };
  `,
    );
    const workerEnv: NodeJS.ProcessEnv = {
      FMCAD_CONFIG: config,
      FMCAD_QUEUE_DIR: queue,
      FMCAD_QUEUE_WORKER_JOB: "artifact-worker",
      FMCAD_QUEUE_WORKER_TOKEN: "local-test-only",
      FMCAD_QUEUE_WORKER_CONFIG: JSON.stringify({
        routing: "queue",
        backend: "addin",
        timeoutMs: 1000,
      }),
    };
    const worker = pathsAdapter.resolveChildEntrypoint(paths, "queue-worker");
    assert.equal(worker, path.join(runtime, "src/queue-worker.js"));
    const completed = run("-r", [fakeTransport, worker, jobFile], workerEnv);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(jobs, "worker-result.json"), "utf8"))
        .terminal,
      true,
    );
    const transportRequests = fs
      .readFileSync(path.join(queue, "fake-transport.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { workerToken: string; args: string[] },
      );
    assert.equal(transportRequests.length, 1);
    const transportRequest = transportRequests[0];
    assert.ok(transportRequest);
    assert.equal(transportRequest.workerToken, "local-test-only");
    assert.equal(transportRequest.args[1], "fusion_mcp_execute");
    assert.deepEqual(fs.readdirSync(home), []);
    const custom = path.join(home, "custom config/config.json");
    const initialized = run(cli, ["init"], { FMCAD_CONFIG: custom });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.ok(
      fs.statSync(path.join(path.dirname(custom), "scripts")).isDirectory(),
    );
    const missing = run(
      cli,
      ["image", "trace", "--input", "source.png", "--out", "new"],
      { FMCAD_PYTHON: path.join(home, "missing python") },
    );
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Python unavailable/);
    assert.equal(fs.existsSync(path.join(cwd, "new")), false);
    const noWsl = run(cli, ["upload", "source.step"]);
    assert.equal(noWsl.status, 1);
    assert.match(noWsl.stderr, /Unsupported fmcad platform/);
    assert.deepEqual(
      fs.readdirSync(installationRoot, { recursive: true }).sort(),
      before,
    );
    assert.equal(
      pathsAdapter.runtimeBuildIdentity(paths),
      manifest.fingerprint,
    );
    // A changed executable resource must invalidate the old worker capability.
    const resource = path.join(runtime, "assets/cad/identity.py");
    fs.chmodSync(resource, 0o644);
    fs.appendFileSync(resource, "\n# changed executable resource\n");
    assert.notEqual(
      pathsAdapter.runtimeBuildIdentity(paths),
      manifest.fingerprint,
    );
    const fenced = run(worker, [jobFile], workerEnv);
    assert.equal(fenced.status, 1);
    assert.match(fenced.stderr, /BUILD_CHANGED/);
  },
);
