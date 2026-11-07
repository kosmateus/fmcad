const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  refresh,
  verifyCache,
  modules,
  prefix,
  sha256,
  network,
} = require("../dist/scripts/adsk-refresh/refresh.js");

const policy = {
  licenseHash: sha256("fixture-license"),
  licenseSection: "fixture license terms",
};
const core =
  'class Point3D(Base):\n    @staticmethod\n    def create(x: float = 0.0, y: float = 0.0, z: float = 0.0) -> Point3D:\n        """Returns the new Point3D object or null if the creation failed."""\n        return Point3D()\n';
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const blobHash = (b) =>
  createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
function fixture(options = {}) {
  const commit = options.commit || commitA;
  let head = commit;
  const files = {
    LICENSE: "fixture-license",
    "README.md": `**Updated as of Fusion ${options.release || "May 2026 Major"} Release**\n\nLicense\n-------\n\nfixture license terms\n\nAcknowledgements\n---\n`,
    ...Object.fromEntries(
      modules.map((n) => [
        prefix + n,
        n === "core.py" ? core : "# annotated fixture\n",
      ]),
    ),
    ...options.files,
  };
  const entries = Object.entries(files).map(([name, s]) => {
    const b = Buffer.from(s);
    return {
      path: name,
      type: "blob",
      mode: "100644",
      sha: blobHash(b),
      size: b.length,
    };
  });
  options.tree?.(entries);
  const urls = [];
  return {
    urls,
    get head() {
      return head;
    },
    async get(url, limit) {
      urls.push(url);
      if (options.fail?.(url)) throw new Error(options.error || "offline");
      let b;
      if (url.endsWith("/FusionAPIReference"))
        b = Buffer.from(JSON.stringify({ default_branch: "main" }));
      else if (url.endsWith("/commits/main"))
        b = Buffer.from(JSON.stringify({ sha: head }));
      else if (url.includes("/git/trees/"))
        b = Buffer.from(
          JSON.stringify({
            truncated: options.truncated || false,
            tree: entries,
          }),
        );
      else {
        head = options.movingHead || head;
        assert.ok(
          url.includes(`/${commit}/`),
          "all blobs pinned even if HEAD advances",
        );
        const name = url.split(`/${commit}/`)[1];
        assert.ok(Object.hasOwn(files, name));
        b = Buffer.from(files[name]);
        if (options.corrupt === name) b = b.subarray(1);
      }
      assert.ok(b.length <= limit);
      return b;
    },
  };
}
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "adsk-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test("pinned refresh never resolves a moving branch and rejects mismatches before replacing the cache", async (t) => {
  const root = await temporary(t);
  await refresh(root, fixture(), policy);
  const before = await fs.readFile(path.join(root, "current.json"), "utf8");
  const lock = { commit: commitA, snapshot: JSON.parse(before).snapshot };
  const pinned = fixture({ movingHead: commitB });
  await refresh(root, pinned, policy, lock);
  assert.equal(
    pinned.urls.some(
      (url) => url.includes("/commits/") || url.endsWith("/FusionAPIReference"),
    ),
    false,
  );
  assert.equal(
    await fs.readFile(path.join(root, "current.json"), "utf8"),
    before,
  );
  await assert.rejects(
    refresh(root, fixture(), policy, { ...lock, snapshot: "0".repeat(64) }),
    /Pinned API snapshot differs/,
  );
  assert.equal(
    await fs.readFile(path.join(root, "current.json"), "utf8"),
    before,
  );
  const invalid = fixture();
  await assert.rejects(
    refresh(root, invalid, policy, { ...lock, commit: "main" }),
    /Invalid pinned API lock/,
  );
  assert.equal(invalid.urls.length, 0);
});
test("A→B snapshots, immutable reads, deterministic generation and retained notices", async (t) => {
  const root = await temporary(t);
  const source = fixture({ movingHead: commitB });
  const a = await refresh(root, source, policy);
  const first = await verifyCache(root, policy);
  assert.equal(a.commit, commitA);
  assert.equal(source.head, commitB, "HEAD advanced during blob downloads");
  assert.equal(source.urls.filter((u) => u.includes("/commits/")).length, 1);
  assert.match(
    await fs.readFile(path.join(first.directory, "adsk/core.py"), "utf8"),
    /-> Point3D \| None:/,
  );
  assert.match(
    await fs.readFile(path.join(first.directory, "NOTICES.md"), "utf8"),
    /Autodesk rights unverified; not legal clearance/,
  );
  assert.equal(
    await fs.readFile(path.join(first.directory, "LICENSE.upstream"), "utf8"),
    "fixture-license",
  );
  await refresh(root, fixture(), policy);
  assert.equal((await verifyCache(root, policy)).directory, first.directory);
  const other = await temporary(t);
  await refresh(other, fixture(), policy);
  assert.deepEqual(
    await fs.readFile(
      path.join((await verifyCache(other, policy)).directory, "manifest.json"),
    ),
    await fs.readFile(path.join(first.directory, "manifest.json")),
  );
  const b = await refresh(
    root,
    fixture({
      commit: commitB,
      release: "June 2026 Major",
      files: { [prefix + "fusion.py"]: "# B\n" },
    }),
    policy,
  );
  assert.equal(b.commit, commitB);
  assert.notEqual((await verifyCache(root, policy)).directory, first.directory);
  assert.equal(
    await fs.readFile(path.join(first.directory, "adsk/fusion.py"), "utf8"),
    "# annotated fixture\n",
  );
  assert.equal(
    await fs.readFile(
      path.join((await verifyCache(root, policy)).directory, "adsk/fusion.py"),
      "utf8",
    ),
    "# B\n",
  );
});

const failures = {
  offline: { fail: (u) => u.includes("/commits/"), error: "offline" },
  forbidden: { fail: (u) => u.includes("/git/trees/"), error: "403" },
  timeout: {
    fail: (u) => u.includes("raw.githubusercontent"),
    error: "timeout",
  },
  truncatedTree: { truncated: true },
  truncatedBlob: { corrupt: prefix + "fusion.py" },
  traversal: { tree: (e) => e.push({ path: "../escape", type: "blob" }) },
  absolute: { tree: (e) => e.push({ path: "/escape", type: "blob" }) },
  backslash: { tree: (e) => e.push({ path: "foo\\escape", type: "blob" }) },
  symlink: {
    tree: (e) => {
      e.find((x) => x.path === prefix + "core.py").mode = "120000";
    },
  },
  oversized: {
    tree: (e) => {
      e.find((x) => x.path === prefix + "core.py").size = 9 * 1024 * 1024;
    },
  },
  totalLimit: {
    tree: (e) => {
      for (const x of e) x.size = 8 * 1024 * 1024;
    },
  },
  missing: {
    tree: (e) =>
      e.splice(
        e.findIndex((x) => x.path === prefix + "cam.py"),
        1,
      ),
  },
  duplicate: { tree: (e) => e.push(e[0]) },
  extraDefinition: { files: { [prefix + "new.py"]: "# unreviewed" } },
  nestedNotice: {
    files: { "Fusion_API_Python_Reference/LICENSE": "new license" },
  },
  licenseChange: { files: { LICENSE: "changed terms" } },
  readmeLicenseChange: {
    files: {
      "README.md":
        "**Updated as of Fusion May 2026 Major Release**\nLicense\n-------\nnew terms\nAcknowledgements\n---",
    },
  },
  overlayConflict: {
    files: { [prefix + "core.py"]: core.replace("-> Point3D:", "-> Other:") },
  },
  overlayDocConflict: {
    files: { [prefix + "core.py"]: core.replace("or null", "never null") },
  },
  invalidUtf8: { files: { [prefix + "cam.py"]: Buffer.from([0xff]) } },
  rootNotice: { files: { NOTICE: "new license scope" } },
};
for (const [name, options] of Object.entries(failures))
  test(`failure ${name} preserves prior snapshot and fails full refresh`, async (t) => {
    const root = await temporary(t);
    await refresh(root, fixture(), policy);
    const before = await fs.readFile(path.join(root, "current.json"));
    await assert.rejects(refresh(root, fixture(options), policy));
    assert.deepEqual(
      await fs.readFile(path.join(root, "current.json")),
      before,
    );
    await verifyCache(root, policy);
    assert.deepEqual((await fs.readdir(root)).sort(), [
      "current.json",
      "snapshots",
    ]);
  });
test("cache is explicit, verified and policy-bound, without fallback", async (t) => {
  const root = await temporary(t);
  await assert.rejects(verifyCache(root, policy));
  await refresh(root, fixture(), policy);
  await assert.rejects(verifyCache(root), /policy/);
  const cache = await verifyCache(root, policy);
  await fs.writeFile(
    path.join(cache.directory, "adsk/fusion.py"),
    "# tampered",
  );
  await assert.rejects(verifyCache(root, policy), /hash mismatch/);
});
test("cache rejects symlink files and snapshot directories", async (t) => {
  const root = await temporary(t);
  await refresh(root, fixture(), policy);
  const cache = await verifyCache(root, policy);
  const file = path.join(cache.directory, "adsk/cam.py");
  await fs.rename(file, file + ".moved");
  await fs.symlink(file + ".moved", file);
  await assert.rejects(verifyCache(root, policy));
  await fs.unlink(file);
  await fs.rename(file + ".moved", file);
  await fs.rename(cache.directory, cache.directory + "-moved");
  await fs.symlink(cache.directory + "-moved", cache.directory);
  await assert.rejects(verifyCache(root, policy), /directory/);
});
test("network adapter rejects HTTP, deadline, size, redirect and truncation errors", async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });
  global.fetch = async (url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response("forbidden", { status: 403 });
  };
  await assert.rejects(network.get("https://example.invalid", 1024), /403/);
  global.fetch = async () => new Response("12345");
  await assert.rejects(network.get("https://example.invalid", 2), /size limit/);
  global.fetch = async () =>
    new Response("abc", { headers: { "content-length": "9" } });
  await assert.rejects(
    network.get("https://example.invalid", 1024),
    /Truncated/,
  );
  global.fetch = async () => {
    throw new DOMException("timeout", "TimeoutError");
  };
  await assert.rejects(network.get("https://example.invalid", 1024), /timeout/);
});

test("failed staging, failed pointer swap and corrupt same-id snapshots never publish success", async (t) => {
  const root = await temporary(t);
  await refresh(root, fixture(), policy);
  const before = await fs.readFile(path.join(root, "current.json"));
  const originalWrite = fs.writeFile;
  fs.writeFile = async (name, ...args) => {
    if (String(name).includes(".stage-") && String(name).endsWith("cam.py"))
      throw new Error("injected disk full");
    return originalWrite(name, ...args);
  };
  try {
    await assert.rejects(
      refresh(root, fixture({ commit: commitB }), policy),
      /disk full/,
    );
  } finally {
    fs.writeFile = originalWrite;
  }
  assert.deepEqual(await fs.readFile(path.join(root, "current.json")), before);
  assert.deepEqual((await fs.readdir(root)).sort(), [
    "current.json",
    "snapshots",
  ]);
  const originalRename = fs.rename;
  fs.rename = async (from, to) => {
    if (String(from).includes(".current-"))
      throw new Error("injected swap failure");
    return originalRename(from, to);
  };
  try {
    await assert.rejects(
      refresh(root, fixture({ commit: commitB }), policy),
      /swap failure/,
    );
  } finally {
    fs.rename = originalRename;
  }
  assert.deepEqual(await fs.readFile(path.join(root, "current.json")), before);
  const old = await verifyCache(root, policy);
  await fs.writeFile(path.join(old.directory, "adsk/cam.py"), "# corrupt");
  await assert.rejects(refresh(root, fixture(), policy), /snapshot corrupt/);
  assert.deepEqual(await fs.readFile(path.join(root, "current.json")), before);
});

test("concurrent refreshes and readers only observe complete snapshots", async (t) => {
  const root = await temporary(t);
  await refresh(root, fixture(), policy);
  const writer = Promise.all([
    refresh(root, fixture({ commit: commitA }), policy),
    refresh(root, fixture({ commit: commitB }), policy),
  ]);
  const readers = Promise.all(
    Array.from({ length: 12 }, async () => {
      const value = await verifyCache(root, policy);
      assert.ok([commitA, commitB].includes(value.manifest.commit));
    }),
  );
  await Promise.all([writer, readers]);
  await verifyCache(root, policy);
});
test("code-only package wiring includes generated manifests and notices", async (t) => {
  const root = await temporary(t);
  const packageJson = JSON.parse(
    await fs.readFile(path.join(__dirname, "../package.json"), "utf8"),
  );
  assert.ok(
    packageJson.scripts.build.includes(
      "--pinned scripts/adsk-refresh/api-lock.json",
    ),
  );
  assert.ok(packageJson.scripts["build:dev"].includes("--dev"));
  const typingDirectory = "dist/runtime/python/typing";
  assert.ok(
    packageJson.files.some(
      (entry) =>
        entry === typingDirectory || typingDirectory.startsWith(entry + "/"),
    ),
    "npm files must include the typing directory or an ancestor directory",
  );
  // Isolated npm packaging fixture: no network, no mutation of the working cache.
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "adsk-package-fixture",
      version: "1.0.0",
      files: packageJson.files,
    }),
  );
  await refresh(
    path.join(root, "dist/runtime/python/typing"),
    fixture(),
    policy,
  );
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  const paths = packed[0].files.map((f) => f.path);
  for (const name of [
    "manifest.json",
    "NOTICES.md",
    "LICENSE.upstream",
    "README.upstream.md",
    "adsk/core.py",
  ])
    assert.ok(
      paths.some(
        (p) => p.startsWith(typingDirectory + "/") && p.endsWith("/" + name),
      ),
      name,
    );
});
