import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const root = process.cwd();
const load = createRequire(path.join(root, "tests/modeling-installed.test.ts"));
const inventory = load("./fixtures/modeling-operation-contracts.json") as {
  operations: { owner: string }[];
};

test(
  "installed modeling contracts validate every assigned public example outside the checkout",
  { timeout: 180000 },
  (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "fmcad-modeling-consumer-"),
    );
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, "package.json"), '{"private":true}');
    const packed: { filename: string }[] = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
        { cwd: root, encoding: "utf8" },
      ),
    );
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--prefix",
        directory,
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        path.join(directory, packed[0]!.filename),
      ],
      { cwd: directory, encoding: "utf8", timeout: 120000 },
    );
    const installed = path.join(directory, "node_modules/fmcad");
    assert.equal(fs.existsSync(path.join(installed, "src")), false);
    assert.equal(fs.existsSync(path.join(installed, "tests")), false);
    const loaders = load(
      "./fixtures/modeling-python-history/manifest.json",
    ) as Record<string, { source: string; units: string[] }>;
    for (const entry of Object.values(loaders)) {
      assert.equal(
        fs.readFileSync(path.join(installed, "dist", entry.source), "utf8"),
        fs.readFileSync(path.join(root, entry.source), "utf8"),
        entry.source,
      );
      for (const unit of entry.units)
        assert.ok(fs.existsSync(path.join(installed, "dist", unit)), unit);
    }

    fs.writeFileSync(
      path.join(directory, "inventory.json"),
      JSON.stringify(inventory),
    );
    const declarations = [
      ...[
        "sketch",
        "curve",
        "surface",
        "datum",
        "entity-query",
        "spring",
        "thread",
        "seal",
        "cam",
        "fastener",
        "feature-rework",
        "selection-service",
      ].map((name) => "core/application/modeling/" + name),
      "node-adapters/persistence/selection-service",
      "node-adapters/persistence/brep-baseline-service",
      "python/curve-source",
      "composition/library-curve",
      "composition/library-selection-rules",
      "composition/library-brep-baseline",
      ...[
        "native-drive",
        "regional-geometry",
        "section-witness",
        "semantic-model-state",
        "selection-rules",
        "brep-baseline",
      ].map((name) => "core/application/modeling/" + name + "-policy"),
      "core/application/modeling/selection-rules-internal",
      "core/application/modeling/brep-baseline-internal",
    ];
    fs.writeFileSync(
      path.join(directory, "consumer.ts"),
      declarations
        .map(
          (name, index) =>
            `import * as module${index} from './node_modules/fmcad/dist/src/dist/${name}.js'; void module${index};`,
        )
        .join("\n"),
    );
    execFileSync(
      process.execPath,
      [
        path.join(root, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "false",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2023",
        "consumer.ts",
      ],
      { cwd: directory, encoding: "utf8", timeout: 60000 },
    );

    fs.writeFileSync(
      path.join(directory, "consumer.cjs"),
      `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const inventory = require('./inventory.json');
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (String(file).startsWith(${JSON.stringify(root + path.sep)})) throw Error('Unexpected checkout access: ' + file);
      return read.call(this, file, ...args);
    };
    const fail = () => { throw Error('Validation must not launch a host or native process'); };
    for (const key of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) require('node:child_process')[key] = fail;
    require('node:net').createConnection = fail;
    const { createCatalogServices } = require('fmcad/api');
    const services = createCatalogServices();
    const entries = new Map(services.list().map(entry => [entry.operation, entry]));
    let count = 0;
    for (const row of inventory.operations) {
      const entry = entries.get(row.operation);
      assert.ok(entry, row.operation);
      const input = structuredClone(entry.declaration.example);
      const before = JSON.stringify(input);
      services.validateData(row.operation, input);
      assert.equal(JSON.stringify(input), before, row.operation + ' mutated input');
      assert.equal(entry.declaration.readOnly === true, row.declaredReadOnly, row.operation);
      count++;
    }
    for (const family of ['sketch', 'curve', 'surface', 'datum', 'entity-query', 'spring', 'thread', 'seal', 'cam', 'fastener', 'feature-rework']) {
      const source = read(require('node:path').join(${JSON.stringify(installed)}, 'dist/src/dist/core/application/modeling', family + '.d.ts'), 'utf8');
      assert.ok(source.includes('export'), family);
    }
    (async () => {
      const { main } = require(require('node:path').join(${JSON.stringify(installed)}, 'dist/src/cli.js'));
      const { createCatalogPost } = require(require('node:path').join(${JSON.stringify(installed)}, 'dist/src/mcp-stdio.js'));
      const post = createCatalogPost(fail, { queued: true });
      let cliPreviews = 0, mcpPreviews = 0;
      for (const row of inventory.operations.filter(item => item.owner === 'C')) {
        const entry = entries.get(row.operation);
        const data = structuredClone(entry.declaration.example);
        const scoped = row.operation === 'snapshot.capture_v2' ? data.scope.document : null;
        const pins = { doc: 'Owned model', docId: scoped?.creationId || 'modeling-A', docFileId: scoped?.fileId || 'file-A' };
        let stdout = '', stderr = '';
        const code = await main([...entry.cli.key.split(' '), '--doc', pins.doc, '--doc-id', pins.docId, '--doc-file-id', pins.docFileId,
          '--data', JSON.stringify(data), '--preview', '--json'], {
          loadConfig: fail, createBackend: fail, McpClient: class { constructor() { fail(); } },
          stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } }, setExitCode() {},
        });
        assert.equal(code, 0, row.operation + ': ' + stderr + stdout);
        assert.equal(JSON.parse(stdout).success, true, row.operation);
        cliPreviews++;
        const response = await post({ jsonrpc: '2.0', id: mcpPreviews + 1, method: 'tools/call', params: {
          name: 'fmcad_cad_' + row.operation.replaceAll('.', '_').replaceAll('-', '_'), arguments: { ...pins, data, preview: true },
        } });
        assert.equal(response.status, 200, row.operation);
        const message = JSON.parse(response.raw);
        assert.equal(message.error, undefined, row.operation + ': ' + response.raw);
        assert.equal(message.result.isError, false, row.operation + ': ' + response.raw);
        assert.equal(message.result.structuredContent.success, true, row.operation);
        mcpPreviews++;
      }
      // A mismatched immutable owner must fail before any process/backend is available.
      const snapshot = entries.get('snapshot.capture_v2').declaration.example;
      let rejected = '';
      const code = await main([...entries.get('snapshot.capture_v2').cli.key.split(' '), '--doc', 'Owned model', '--doc-id', 'foreign', '--doc-file-id', 'foreign', '--data', JSON.stringify(snapshot), '--preview', '--json'], {
        loadConfig: fail, createBackend: fail, stdout: { write() {} }, stderr: { write: text => { rejected += text; } }, setExitCode() {},
      });
      assert.equal(code, 1);
      assert.match(rejected, /scope.document must match the pinned document identity/);
      process.stdout.write(JSON.stringify({ count, cliPreviews, mcpPreviews }));
      process.exit(0);
    })().catch(error => { console.error(error); process.exit(1); });
  `,
    );
    const result: { count: number; cliPreviews: number; mcpPreviews: number } =
      JSON.parse(
        execFileSync(process.execPath, ["consumer.cjs"], {
          cwd: directory,
          env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory },
          encoding: "utf8",
          timeout: 60000,
        }),
      );
    assert.equal(result.count, inventory.operations.length);
    const owned = inventory.operations.filter(
      (row) => row.owner === "C",
    ).length;
    assert.equal(result.cliPreviews, owned);
    assert.equal(result.mcpPreviews, owned);
  },
);
