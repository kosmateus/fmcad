"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");

const repository = path.resolve(__dirname, "..");
const installation = path.join(repository, "dist");
const assetRoot = path.join(installation, "assets/control-center");
const stagedResolver = path.join(
  repository,
  "src/dist/control-center/resources/static-assets.js",
);
const buildScript = path.join(
  repository,
  "packages/control-center/scripts/build-browser.cjs",
);
const resolver = require("../packages/control-center/dist/resources");
const serverFactory = require("../packages/control-center/dist/server/http");
const digest = (value) => createHash("sha256").update(value).digest("hex");

function copyBundle(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-web-assets-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "dist");
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.cpSync(assetRoot, path.join(root, "assets/control-center"), {
    recursive: true,
  });
  return { temp, root, assets: path.join(root, "assets/control-center") };
}

async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function httpGet(url, cookie) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      url,
      {
        headers: {
          Host: new URL(url).host,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once("error", reject);
  });
}

function checkBrowserEsmGraph(assetRoot) {
  const source = String.raw`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const root = process.argv[1];
    const context = vm.createContext({ console, URL, URLSearchParams, AbortController, DOMException, Response, setTimeout, clearTimeout, queueMicrotask });
    const cache = new Map();
    function moduleFor(file) {
      const absolute = path.resolve(file);
      if (!absolute.startsWith(root + path.sep)) throw new Error('browser import escaped emitted root');
      let result = cache.get(absolute);
      if (!result) {
        result = new vm.SourceTextModule(fs.readFileSync(absolute, 'utf8'), { context, identifier: absolute });
        cache.set(absolute, result);
      }
      return result;
    }
    const linker = (specifier, referencing) => {
      if (!/^\.{1,2}\//.test(specifier) || !specifier.endsWith('.js')) throw new Error('unexpected browser import: ' + specifier);
      return moduleFor(path.resolve(path.dirname(referencing.identifier), specifier));
    };
    (async () => {
      const entry = moduleFor(path.join(root, 'web/index.js'));
      await entry.link(linker);
      await entry.evaluate();
      assert.equal(typeof entry.namespace.ControlCenterApp, 'function');
      const app = cache.get(path.join(root, 'web/app.js'));
      assert.ok(app, 'the operational application must be emitted and linked');
      assert.equal(typeof app.namespace.ControlCenterApp, 'function');
      const api = cache.get(path.join(root, 'web/api.js'));
      const projectActions = cache.get(path.join(root, 'contracts/project-actions.js'));
      assert.equal(projectActions?.namespace.PROJECT_ACTIONS_ROUTE, '/api/v1/console/project-actions');
      const calls = [];
      const client = new api.namespace.ConsoleQueryClient('http://localhost:4748', async (input, init) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        assert.equal(init.credentials, 'same-origin');
        if (url.pathname === '/api/v1/console/session')
          return new Response(JSON.stringify({ version: 1, csrfToken: 'c'.repeat(64) }),
            { headers: { 'Content-Type': 'application/json' } });
        assert.equal(url.pathname, '/api/v1/console/snapshot');
        return new Response(JSON.stringify({ version: 1, revision: { epoch: 'e', revision: 1 }, capturedAt: 10,
          scope: { kind: 'global' }, snapshotToken: 'fixture-token', sources: {} }),
          { headers: { 'Content-Type': 'application/json' } });
      });
      const snapshot = await client.snapshot({ kind: 'global' });
      assert.equal(snapshot.snapshotToken, 'fixture-token');
      assert.deepEqual(calls, ['/api/v1/console/session', '/api/v1/console/snapshot']);
      const contract = moduleFor(path.join(root, 'contracts/query.js'));
      await contract.link(linker);
      await contract.evaluate();
      assert.equal(contract.namespace.CONSOLE_QUERY_CONTRACT_VERSION, 1);
      console.log(JSON.stringify({ modules: cache.size, entrypoint: 'index.js', queryApi: 'ok' }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", "--no-warnings", "-e", source, assetRoot],
    { cwd: repository, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /"modules":20/);
}

test("browser build emits standalone ESM and a hash-bound static allowlist", async (t) => {
  execFileSync(process.execPath, [buildScript], {
    cwd: repository,
    encoding: "utf8",
    timeout: 120000,
  });
  execFileSync(
    process.execPath,
    [
      path.join(repository, "dist/scripts/devtools/stage-core.js"),
      "--identity-only",
    ],
    { cwd: repository, encoding: "utf8" },
  );
  const manifest = resolver.readControlCenterAssetManifest(installation);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.entrypoint, "/assets/control-center/web/index.js");
  // The agents/projects feature added a browser module and a runtime route contract.
  // Both are emitted by the browser build and must be in the exact server allowlist.
  assert.equal(manifest.assets.length, 33);
  for (const file of [
    "web/agents-projects.js",
    "contracts/project-actions.js",
    "web/locale-runtime.js",
    "web/locale-selector.js",
    "assets/locale-selector.css",
  ]) {
    assert.ok(
      manifest.assets.some((asset) => asset.file === file),
      file,
    );
  }
  assert.equal(manifest.notices.length, 5);
  assert.deepEqual(
    manifest.assets.map((asset) => asset.path),
    [...manifest.assets.map((asset) => asset.path)].sort(),
  );
  assert.ok(manifest.assets.some((asset) => asset.path.endsWith("/index.js")));
  assert.ok(
    manifest.assets.some((asset) => asset.path.endsWith("/styles.css")),
  );
  assert.equal(
    manifest.assets.filter((asset) => asset.contentType === "font/woff2")
      .length,
    8,
  );
  const serialized = fs.readFileSync(
    path.join(assetRoot, "asset-manifest.json"),
    "utf8",
  );
  assert.doesNotMatch(
    serialized,
    /(?:\/home\/|\.development|\/tmp\/opencode)/i,
  );

  const sourceFiles = fs.readdirSync(path.join(assetRoot, "web"));
  assert.deepEqual(sourceFiles.sort(), [
    "agents-projects.js",
    "api.js",
    "app.js",
    "index.js",
    "locale-agents-projects.js",
    "locale-app-extra.js",
    "locale-catalogs.js",
    "locale-runtime.js",
    "locale-selector.js",
    "locale-system-controls.js",
    "locale-system-view.js",
    "locale-types.js",
    "locale-web-ui.js",
    "read-model.js",
    "select-controls.js",
    "system-controls.js",
    "table-model.js",
  ]);
  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(assetRoot, "web", file), "utf8");
    // Catalog keys such as "system.process.panel" are data, not Node APIs.
    // Inspect executable syntax so those keys do not mask real API access.
    const ts = require("typescript");
    const syntax = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const inspect = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
        assert.notEqual(node.expression.text, "require", file);
      if (
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
        ts.isIdentifier(node.expression)
      )
        assert.notEqual(node.expression.text, "process", file);
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        assert.ok(!node.moduleSpecifier.text.startsWith("node:"), file);
      ts.forEachChild(node, inspect);
    };
    inspect(syntax);
    assert.doesNotMatch(
      source,
      /FmcadDemo|completed-project-demo|snapshotMode|Math\.random/,
      file,
    );
    // SVG namespace identifies a local DOM element; it is not a network resource.
    assert.doesNotMatch(
      source.replaceAll("http://www.w3.org/2000/svg", ""),
      /https?:\/\//,
      file,
    );
  }
  const html = fs.readFileSync(path.join(assetRoot, "index.html"), "utf8");
  assert.match(html, /src="\/assets\/control-center\/web\/index\.js"/);
  assert.match(html, /href="\/assets\/control-center\/assets\/styles\.css"/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.ok(
    fs.existsSync(path.join(assetRoot, "assets/fonts/DM-Sans-OFL.txt")),
  );
  assert.ok(
    fs.existsSync(path.join(assetRoot, "assets/fonts/IBM-Plex-Mono-OFL.txt")),
  );
  assert.ok(
    fs.existsSync(path.join(assetRoot, "assets/vendor/highlight-LICENSE.txt")),
  );

  checkBrowserEsmGraph(assetRoot);
});

test("installed static resolver rejects changed bytes, symlinks and manifest traversal", (t) => {
  const original = resolver.readControlCenterAssetManifest(installation);
  const changed = copyBundle(t);
  const first = original.assets[0];
  fs.appendFileSync(path.join(changed.assets, first.file), "changed");
  assert.throws(
    () => resolver.loadConsoleHttpAssets(changed.root),
    /asset bytes do not match/i,
  );

  const escaped = copyBundle(t);
  const manifestPath = path.join(escaped.assets, "asset-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.assets[0].file = "../outside.js";
  const payload = {
    version: manifest.version,
    entrypoint: manifest.entrypoint,
    assets: manifest.assets,
    notices: manifest.notices,
  };
  manifest.fingerprint = digest(JSON.stringify(payload));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(
    () => resolver.loadConsoleHttpAssets(escaped.root),
    /invalid route or resource/i,
  );

  const unlisted = copyBundle(t);
  const unlistedManifestPath = path.join(
    unlisted.assets,
    "asset-manifest.json",
  );
  const unlistedManifest = JSON.parse(
    fs.readFileSync(unlistedManifestPath, "utf8"),
  );
  unlistedManifest.assets[0].path = "/assets/control-center/assets/extra.js";
  unlistedManifest.assets[0].file = "assets/extra.js";
  const unlistedPayload = {
    version: unlistedManifest.version,
    entrypoint: unlistedManifest.entrypoint,
    assets: unlistedManifest.assets,
    notices: unlistedManifest.notices,
  };
  unlistedManifest.fingerprint = digest(JSON.stringify(unlistedPayload));
  fs.writeFileSync(unlistedManifestPath, JSON.stringify(unlistedManifest));
  assert.throws(
    () => resolver.loadConsoleHttpAssets(unlisted.root),
    /invalid route or resource/i,
  );

  const linked = copyBundle(t);
  const entry = original.assets.find(
    (asset) => asset.path === original.entrypoint,
  );
  const destination = path.join(linked.assets, entry.file);
  const outside = path.join(linked.temp, "outside.js");
  fs.renameSync(destination, outside);
  fs.symlinkSync(outside, destination);
  assert.throws(
    () => resolver.loadConsoleHttpAssets(linked.root),
    /cannot be symlinks/i,
  );
});

test("loopback HTTP serves only manifest-backed local browser resources", async (t) => {
  const assets = resolver.loadConsoleHttpAssets(installation);
  const port = await availablePort();
  const server = serverFactory.createControlCenterHttpServer({
    identity: {
      port,
      protocolVersion: 1,
      buildIdentity: "a".repeat(64),
      pid: 101,
      processBirth: "synthetic:101",
      instanceNonce: "b".repeat(64),
      probeSecret: "c".repeat(64),
    },
    assets,
    query: {
      snapshot: async () => {
        throw new Error("query route is not used by static fixture");
      },
      query: async () => {
        throw new Error("query route is not used by static fixture");
      },
      detail: async () => {
        throw new Error("query route is not used by static fixture");
      },
      export: async () => {
        throw new Error("query route is not used by static fixture");
      },
      subscribe: () => null,
    },
    resolvePrincipal: () => ({
      subject: "fixture",
      projectIds: [],
      globalRead: true,
    }),
  });
  await server.start();
  t.after(() => server.close());

  const origin = `http://localhost:${port}`;
  const page = await httpGet(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers["content-security-policy"], /default-src 'self'/);
  assert.match(
    page.body.toString("utf8"),
    /\/assets\/control-center\/web\/index\.js/,
  );
  const cookie = page.headers["set-cookie"][0].split(";", 1)[0];

  const manifest = resolver.readControlCenterAssetManifest(installation);
  for (const asset of manifest.assets) {
    const response = await httpGet(`${origin}${asset.path}`, cookie);
    assert.equal(response.status, 200, asset.path);
    assert.equal(
      response.headers["content-type"],
      asset.contentType,
      asset.path,
    );
    assert.equal(response.body.length, asset.bytes, asset.path);
    assert.equal(digest(response.body), asset.sha256, asset.path);
  }
  const missing = await httpGet(
    `${origin}/assets/control-center/not-in-manifest.js`,
    cookie,
  );
  assert.equal(missing.status, 503);
  assert.equal(
    JSON.parse(missing.body.toString("utf8")).code,
    "UI_UNAVAILABLE",
  );
  assert.ok(
    !assets.some((asset) => asset.path.endsWith(".txt")),
    "notices stay packaged but are not web routes",
  );
});

test(
  "offline installed npm tarball serves hash-verified browser ESM without host SDK",
  {
    skip: fs.existsSync(stagedResolver)
      ? false
      : "root-owned stage-core hook has not staged the console resource resolver",
  },
  async (t) => {
    assert.ok(
      fs.existsSync(path.join(assetRoot, "asset-manifest.json")),
      "run build:code before packaging browser resources",
    );
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "fmcad-installed-web-assets-"),
    );
    const installed = path.join(directory, "node_modules/fmcad");
    t.after(() => {
      if (fs.existsSync(installed)) {
        for (const entry of fs.readdirSync(installed, {
          recursive: true,
          withFileTypes: true,
        })) {
          if (entry.isDirectory())
            fs.chmodSync(path.join(entry.parentPath, entry.name), 0o755);
        }
        fs.chmodSync(installed, 0o755);
      }
      fs.rmSync(directory, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(directory, "package.json"), '{"private":true}');
    const cleanHome = path.join(directory, "clean-home");
    fs.mkdirSync(cleanHome, { recursive: true });
    const cleanEnvironment = {
      PATH: process.env.PATH,
      HOME: cleanHome,
      XDG_CONFIG_HOME: path.join(cleanHome, "config"),
      XDG_STATE_HOME: path.join(cleanHome, "state"),
      npm_config_userconfig: "/dev/null",
      npm_config_cache:
        process.env.npm_config_cache ?? path.join(os.homedir(), ".npm"),
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
    };
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
        {
          cwd: repository,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        },
      ),
    )[0];
    const packedPaths = packed.files.map((file) => file.path);
    for (const required of [
      "dist/assets/control-center/asset-manifest.json",
      "dist/assets/control-center/index.html",
      "dist/assets/control-center/web/index.js",
      "dist/assets/control-center/contracts/query.js",
      "dist/src/dist/control-center/resources/static-assets.js",
      "dist/src/dist/control-center/server/http.js",
    ])
      assert.ok(
        packedPaths.includes(required),
        `${required} missing from installed tarball`,
      );
    assert.ok(
      packedPaths.every(
        (file) =>
          !/^dist\/assets\/control-center\/.*\.(?:ts|tsx|mts|cts)$/.test(file),
      ),
    );
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--prefix",
        directory,
        path.join(directory, packed.filename),
      ],
      {
        cwd: directory,
        env: cleanEnvironment,
        encoding: "utf8",
        timeout: 90000,
      },
    );
    for (const entry of fs.readdirSync(installed, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.isDirectory())
        fs.chmodSync(path.join(entry.parentPath, entry.name), 0o555);
      else if (entry.isFile())
        fs.chmodSync(path.join(entry.parentPath, entry.name), 0o444);
    }
    fs.chmodSync(installed, 0o555);
    assert.equal(
      fs.existsSync(path.join(directory, "node_modules/@opencode-ai/plugin")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(directory, "node_modules/@opencode/plugin")),
      false,
    );
    const installedDist = path.join(installed, "dist");
    const installedResolver = require(
      path.join(
        installedDist,
        "src/dist/control-center/resources/static-assets.js",
      ),
    );
    const installedServerFactory = require(
      path.join(installedDist, "src/dist/control-center/server/http.js"),
    );
    const runtimePaths = require(
      path.join(installedDist, "src/dist/config-platform"),
    );
    const runtimeBuild = JSON.parse(
      fs.readFileSync(path.join(installedDist, "runtime-build.json"), "utf8"),
    );
    const runtime = runtimePaths.resolveRuntimePaths({
      anchor: path.join(installedDist, "src/queue-worker.js"),
      home: path.join(directory, "clean-home"),
      env: {
        HOME: path.join(directory, "clean-home"),
        XDG_CONFIG_HOME: path.join(directory, "clean-home/config"),
        XDG_STATE_HOME: path.join(directory, "clean-home/state"),
      },
    });
    assert.equal(
      runtimePaths.runtimeBuildIdentity(runtime),
      runtimeBuild.fingerprint,
    );
    const assets = installedResolver.loadConsoleHttpAssets(installedDist);
    assert.equal(assets.length, 33);
    for (const module of [
      "web/agents-projects.js",
      "contracts/project-actions.js",
      "web/locale-runtime.js",
      "web/locale-selector.js",
      "assets/locale-selector.css",
    ])
      assert.ok(
        assets.some(
          (asset) => asset.path === `/assets/control-center/${module}`,
        ),
      );
    checkBrowserEsmGraph(path.join(installedDist, "assets/control-center"));

    const port = await availablePort();
    const { createControlCenterComposition } = require(
      path.join(installedDist, "src/dist/composition/control-center.js"),
    );
    const composition = createControlCenterComposition(
      {
        port,
        installationRoot: installedDist,
        stateDirectory: path.join(directory, "console-state"),
        buildIdentity: runtimeBuild.fingerprint,
        protocolVersion: 1,
        instanceNonce: "d".repeat(64),
      },
      {
        registry: {
          filePath: path.join(directory, "console-data/projects.json"),
        },
        queueDirectory: path.join(directory, "absent-queue"),
        openCodePresenceDirectory: path.join(directory, "absent-presence"),
      },
    );
    t.after(() => composition.close());
    const principal = await composition.resolvePrincipal({
      subject: "installed-fixture",
      createdAt: Date.now(),
    });
    const snapshot = await composition.query.snapshot(
      { kind: "global" },
      principal,
    );
    assert.ok(snapshot.snapshotToken, JSON.stringify(snapshot));
    assert.equal(snapshot.scope.kind, "global");
    const server = installedServerFactory.createControlCenterHttpServer({
      identity: {
        port,
        protocolVersion: 1,
        buildIdentity: runtimeBuild.fingerprint,
        pid: 101,
        processBirth: "installed-synthetic:101",
        instanceNonce: "d".repeat(64),
        probeSecret: "e".repeat(64),
      },
      assets: composition.assets,
      query: composition.query,
      resolvePrincipal: composition.resolvePrincipal,
    });
    await server.start();
    t.after(() => server.close());
    const origin = `http://localhost:${port}`;
    const page = await httpGet(`${origin}/`);
    assert.equal(page.status, 200);
    const cookie = page.headers["set-cookie"][0].split(";", 1)[0];
    for (const asset of assets) {
      const response = await httpGet(`${origin}${asset.path}`, cookie);
      assert.equal(response.status, 200, asset.path);
      assert.equal(
        response.headers["content-type"],
        asset.contentType,
        asset.path,
      );
      assert.equal(digest(response.body), digest(asset.body), asset.path);
    }
    assert.match(
      page.body.toString("utf8"),
      /\/assets\/control-center\/web\/index\.js/,
    );
    console.log(
      JSON.stringify({
        tarball: packed.filename,
        browserAssets: assets.length,
        runtimeFingerprint: runtimeBuild.fingerprint,
        openCodeSdkInstalled: false,
        server: "isolated-loopback",
      }),
    );
  },
);
