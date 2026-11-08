/// <reference lib="dom" />
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

const load = createRequire(import.meta.url);
const repository = process.cwd();
const { setupProjects } = load(
  path.join(repository, "dist/tests/control-center-test-support.js"),
) as typeof import("./control-center-test-support.js");
const { createControlCenterComposition } = load(
  path.join(repository, "dist/src/dist/composition/control-center.js"),
) as typeof import("../dist/library-build/src/composition/control-center.js");
const { createControlCenterHttpServer } = load(
  path.join(repository, "dist/src/dist/control-center/server/index.js"),
) as typeof import("../packages/control-center/dist/server/index.js");

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

test(
  "browser reads real registered SQLite histories through the installed production composition",
  { timeout: 45000 },
  async (t) => {
    const artifacts = path.resolve(
      process.env["FMCAD_CONTROL_CENTER_E2E_ARTIFACTS"] ??
        path.join(os.tmpdir(), "opencode/fmcad-control-center-e2e"),
      `production-${Date.now()}-${process.pid}`,
    );
    fs.mkdirSync(artifacts, { recursive: true });
    const errors: string[] = [];
    const failedRequests: { url: string; error: string }[] = [];
    const badResponses: { url: string; status: number }[] = [];
    let composition:
      ReturnType<typeof createControlCenterComposition> | undefined;
    let server: ReturnType<typeof createControlCenterHttpServer> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    t.after(async () => {
      try {
        try {
          if (browser) {
            const context = browser.contexts()[0];
            const page = context?.pages()[0];
            if (page && !page.isClosed())
              await page
                .screenshot({
                  path: path.join(artifacts, "final.png"),
                  fullPage: true,
                })
                .catch(() => {});
            await context?.tracing.stop({
              path: path.join(artifacts, "trace.zip"),
            });
          }
        } finally {
          await browser?.close();
        }
      } finally {
        try {
          await server?.close();
        } finally {
          try {
            await composition?.close?.();
          } finally {
            fs.writeFileSync(
              path.join(artifacts, "report.json"),
              JSON.stringify({ errors, failedRequests, badResponses }, null, 2),
            );
          }
        }
      }
    });
    const fixture = setupProjects(t, [
      "browser-project-a",
      "browser-project-b",
    ]);
    const port = await availablePort();
    composition = createControlCenterComposition(
      {
        port,
        installationRoot: path.join(repository, "dist"),
        stateDirectory: path.join(fixture.root, "service"),
        buildIdentity: "a".repeat(64),
        protocolVersion: 1,
        instanceNonce: randomBytes(32).toString("hex"),
      },
      {
        registry: { filePath: fixture.registry.readonlyPath },
        queueDirectory: path.join(fixture.root, "absent-queue"),
        openCodePresenceDirectory: path.join(fixture.root, "absent-presence"),
      },
    );
    server = createControlCenterHttpServer({
      identity: {
        port,
        protocolVersion: 1,
        buildIdentity: "a".repeat(64),
        pid: process.pid,
        processBirth: `sqlite-browser:${process.pid}`,
        instanceNonce: randomBytes(32).toString("hex"),
        probeSecret: randomBytes(32).toString("hex"),
      },
      ...(composition.assets ? { assets: composition.assets } : {}),
      query: composition.query,
      resolvePrincipal: composition.resolvePrincipal,
    });
    await server.start();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      locale: "pl-PL",
      viewport: { width: 1440, height: 960 },
    });
    await page
      .context()
      .tracing.start({ screenshots: true, snapshots: true, sources: true });
    page.on("requestfailed", (request) =>
      failedRequests.push({
        url: request.url(),
        error: request.failure()?.errorText ?? "unknown",
      }),
    );
    page.on("response", (response) => {
      if (response.status() >= 400)
        badResponses.push({ url: response.url(), status: response.status() });
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error")
        errors.push(`${message.text()} ${message.location().url}`);
    });
    await page.goto(`http://localhost:${port}/`);
    await page
      .locator('[data-action="task"][data-id="task-browser-project-a"]')
      .waitFor();
    await page
      .locator('[data-action="task"][data-id="task-browser-project-b"]')
      .waitFor();
    for (const projectId of ["browser-project-a", "browser-project-b"]) {
      await page
        .locator(`aside [data-action="scope"][data-id="${projectId}"]`)
        .click();
      // A matching row already exists in the global view. Wait for the
      // complete scoped result, including removal of the other project's row.
      await page.waitForFunction((expected) => {
        const rows = [...document.querySelectorAll('[data-action="task"]')];
        return (
          rows.length === 1 &&
          rows[0]?.getAttribute("data-id") === `task-${expected}` &&
          rows[0]?.getAttribute("data-project") === expected
        );
      }, projectId);
      const rows = await page
        .locator('[data-action="task"]')
        .evaluateAll((elements) =>
          elements.map((element) => ({
            id: element.getAttribute("data-id"),
            projectId: element.getAttribute("data-project"),
          })),
        );
      assert.deepEqual(rows, [{ id: `task-${projectId}`, projectId }]);
      await page.reload();
      await page
        .locator(`[data-action="task"][data-id="task-${projectId}"]`)
        .waitFor();
    }
    await page.screenshot({
      path: path.join(artifacts, "production-sqlite-project.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(badResponses, []);
    assert.deepEqual(
      failedRequests.filter(
        (request) =>
          !(
            request.url.includes("/api/v1/console/events") &&
            request.error === "net::ERR_ABORTED"
          ),
      ),
      [],
    );
    assert.equal(fs.existsSync(path.join(fixture.root, "absent-queue")), false);
  },
);
