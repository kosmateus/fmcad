/// <reference lib="dom" />
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import type { ProjectActionResponse } from "../packages/control-center/dist/web/agents-projects.js";

const load = createRequire(import.meta.url);
const repository = process.cwd();
const { LOCALE_CODES } = load(
  path.join(repository, "packages/control-center/dist/web/locale-catalogs.js"),
) as typeof import("../packages/control-center/dist/web/locale-catalogs.js");
const { setupProjects, openHistory, registeredProject, FIXTURE_NOW } = load(
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
  { timeout: undefined },
  async (t) => {
    const artifacts = path.resolve(
      process.env["FMCAD_CONTROL_CENTER_E2E_ARTIFACTS"] ??
        path.join(os.tmpdir(), "opencode/fmcad-control-center-e2e"),
      `production-${Date.now()}-${process.pid}`,
    );
    fs.mkdirSync(artifacts, { recursive: true });
    const errors: string[] = [];
    const browserLaunchErrors: string[] = [];
    const failedRequests: { url: string; error: string }[] = [];
    const badResponses: { url: string; status: number }[] = [];
    const postRequests: string[] = [];
    const projectActionResults: ProjectActionResponse[] = [];
    const cleanup: {
      composition?: ReturnType<typeof createControlCenterComposition>;
      server?: ReturnType<typeof createControlCenterHttpServer>;
      browser?: Awaited<ReturnType<typeof chromium.launch>>;
    } = {};
    t.after(async () => {
      try {
        try {
          if (cleanup.browser) {
            const context = cleanup.browser.contexts()[0];
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
          await cleanup.browser?.close();
        }
      } finally {
        try {
          await cleanup.server?.close();
        } finally {
          try {
            await cleanup.composition?.close?.();
          } finally {
            fs.writeFileSync(
              path.join(artifacts, "report.json"),
              JSON.stringify(
                {
                  browserLaunchErrors,
                  errors,
                  failedRequests,
                  badResponses,
                  postRequests,
                  projectActionResults,
                },
                null,
                2,
              ),
            );
          }
        }
      }
    });
    const fixture = setupProjects(t, [
      "browser-project-a",
      "browser-project-b",
      "browser-project-archived",
    ]);
    const archivedProject = registeredProject(
      fixture.registry,
      "browser-project-archived",
    );
    const archivedHistory = openHistory(fixture.registry, archivedProject);
    archivedHistory.setLifecycle({
      monitoring: false,
      archivedAtMs: FIXTURE_NOW,
      updatedAtMs: FIXTURE_NOW,
    });
    archivedHistory.close();
    fixture.registry.setLifecycle(archivedProject.projectId, {
      monitoring: false,
      archivedAtMs: FIXTURE_NOW,
      nowMs: FIXTURE_NOW,
    });
    const retainedFiles = [...fixture.projects.values()].flatMap((project) =>
      [project.queueStatePath, project.outputPath].map((file) => ({
        file,
        bytes: fs.readFileSync(file),
      })),
    );
    const port = await availablePort();
    const composition = createControlCenterComposition(
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
    cleanup.composition = composition;
    const server = createControlCenterHttpServer({
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
      ...(composition.projectActions
        ? { projectActions: composition.projectActions }
        : {}),
      resolvePrincipal: composition.resolvePrincipal,
    });
    cleanup.server = server;
    await server.start();
    const browser = await chromium
      .launch({ headless: true })
      .catch((error: unknown) => {
        browserLaunchErrors.push(
          error instanceof Error
            ? (error.stack ?? `${error.name}: ${error.message}`)
            : String(error),
        );
        throw error;
      });
    cleanup.browser = browser;
    const page = await browser.newPage({
      locale: "pl-PL",
      viewport: { width: 1440, height: 960 },
    });
    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(0);
    await page
      .context()
      .tracing.start({ screenshots: true, snapshots: true, sources: true });
    page.on("requestfailed", (request) =>
      failedRequests.push({
        url: request.url(),
        error: request.failure()?.errorText ?? "unknown",
      }),
    );
    page.on("request", (request) => {
      if (request.method() === "POST") postRequests.push(request.url());
    });
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
    await page.locator('[data-action="view"][data-view="projects"]').click();
    const form = page.locator(
      'form[data-action="project-alias-form"][data-project="browser-project-a"]',
    );
    await form.locator('input[name="alias"]').fill("Production browser alias");
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/console/project-actions") &&
        response.request().method() === "POST",
    );
    await form.locator('[type="submit"]').click();
    assert.equal((await (await saved).json()).state, "ok");
    await page
      .locator(
        'aside [data-action="scope"][data-id="browser-project-a"] .project-name',
      )
      .filter({ hasText: "Production browser alias" })
      .waitFor();
    await page.goto(`http://localhost:${port}/?project=browser-project-a`);
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-action="task"]')];
      return (
        rows.length === 1 &&
        rows[0]?.getAttribute("data-project") === "browser-project-a"
      );
    });
    assert.equal(
      await page
        .locator(
          'aside [data-action="scope"][data-id="browser-project-a"] .project-name',
        )
        .textContent(),
      "Production browser alias",
    );
    await page.locator('[data-action="view"][data-view="projects"]').click();
    const reset = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/console/project-actions") &&
        response.request().method() === "POST",
    );
    await form.locator('[data-action="project-alias-reset"]').click();
    const resetResult: ProjectActionResponse = await (await reset).json();
    projectActionResults.push(resetResult);
    assert.equal(resetResult.state, "ok");
    assert.equal(resetResult.code, "PROJECT_ALIAS_UPDATED");
    assert.equal(resetResult.alias, null);
    await page.waitForFunction(
      () =>
        document
          .querySelector(
            'aside [data-action="scope"][data-id="browser-project-a"] .project-name',
          )
          ?.textContent?.trim() === "browser-project-a",
    );
    await page.reload();
    await page.locator('[data-action="view"][data-view="projects"]').click();
    await form.waitFor();
    assert.equal(
      await form.locator('input[name="alias"]').inputValue(),
      "browser-project-a",
    );
    const beforeArchive = registeredProject(
      fixture.registry,
      "browser-project-a",
    );
    await page
      .locator(
        '[data-action="project-archive-open"][data-project="browser-project-a"]',
      )
      .click();
    const archive = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/console/project-actions") &&
        response.request().method() === "POST",
    );
    await page.locator('[data-action="project-action-confirm"]').click();
    const archiveResult: ProjectActionResponse = await (await archive).json();
    projectActionResults.push(archiveResult);
    assert.equal(archiveResult.state, "unavailable");
    assert.equal(archiveResult.code, "FRESH_STATE_UNAVAILABLE");
    await page
      .locator('[data-project-action-dialog="archive"] [role="status"]')
      .waitFor();
    assert.deepEqual(
      registeredProject(fixture.registry, "browser-project-a"),
      beforeArchive,
    );
    await page.screenshot({
      path: path.join(artifacts, "production-archive-guard.png"),
      fullPage: true,
    });
    await page.locator('[data-action="project-action-cancel"]').first().click();
    await page
      .locator('[data-action="project-filter"][data-filter="archived"]')
      .click();
    await page
      .locator(
        '[data-action="project-restore-open"][data-project="browser-project-archived"]',
      )
      .click();
    const restore = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/console/project-actions") &&
        response.request().method() === "POST",
    );
    const postsBeforeRestore = postRequests.length;
    await page.locator('[data-action="project-action-confirm"]').click();
    const restoreResult: ProjectActionResponse = await (await restore).json();
    projectActionResults.push(restoreResult);
    assert.equal(restoreResult.state, "ok");
    assert.equal(restoreResult.code, "PROJECT_RESTORED");
    assert.equal(restoreResult.monitoring, true);
    assert.equal(restoreResult.archivedAtMs, null);
    await page
      .locator('[data-project-action-dialog="restore"] [role="status"]')
      .waitFor();
    assert.equal(
      registeredProject(fixture.registry, archivedProject.projectId).monitoring,
      true,
    );
    assert.equal(
      registeredProject(fixture.registry, archivedProject.projectId)
        .archivedAtMs,
      null,
    );
    assert.deepEqual(
      postRequests
        .slice(postsBeforeRestore)
        .map((url) => new URL(url).pathname)
        .filter((pathname) => pathname !== "/api/v1/console/query"),
      ["/api/v1/console/project-actions"],
      "restoring monitoring must not submit or replay a job",
    );
    await page.screenshot({
      path: path.join(artifacts, "production-project-restored.png"),
      fullPage: true,
    });
    await page.locator('[data-action="project-action-cancel"]').first().click();
    await page.goto(`http://localhost:${port}/?project=browser-project-a`);
    for (const locale of LOCALE_CODES) {
      await page.locator("#locale-selector-trigger").click();
      await page
        .locator(`[role="menuitemradio"][data-locale="${locale}"]`)
        .click();
      await page.waitForFunction(
        (expected) => document.documentElement.lang === expected,
        locale,
      );
      for (const view of ["tasks", "overview"]) {
        await page
          .locator(`.tabs [data-action="view"][data-view="${view}"]`)
          .click();
        await page
          .locator('[data-action="task"][data-id="task-browser-project-a"]')
          .first()
          .waitFor();
      }
      if (["de", "fi", "el", "uk"].includes(locale)) {
        await page.setViewportSize({ width: 390, height: 844 });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        );
        assert.equal(overflow, false, `${locale} must fit the mobile viewport`);
        await page.screenshot({
          path: path.join(artifacts, `locale-${locale}.png`),
          fullPage: true,
        });
        await page.setViewportSize({ width: 1440, height: 960 });
      }
    }
    const fonts = await page.evaluate(async () => {
      const regular = await document.fonts.load(
        '14px "Fmcad Unicode"',
        "Ελληνικά Українська Български",
      );
      const bold = await document.fonts.load(
        '700 14px "Fmcad Unicode"',
        "Ελληνικά Українська Български",
      );
      return {
        regular: regular.map((font) => font.status),
        bold: bold.map((font) => font.status),
      };
    });
    assert.deepEqual(fonts, { regular: ["loaded"], bold: ["loaded"] });
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
    assert.deepEqual(
      postRequests
        .map((url) => new URL(url).pathname)
        .filter((pathname) => pathname !== "/api/v1/console/query"),
      Array(4).fill("/api/v1/console/project-actions"),
      "project display and lifecycle actions must never POST jobs",
    );
    for (const { file, bytes } of retainedFiles)
      assert.deepEqual(fs.readFileSync(file), bytes);
  },
);

test(
  "browser System controls reach authenticated lifecycle IPC and retain original receipts",
  { timeout: undefined },
  async (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "fmcad-system-browser-"),
    );
    const children: ChildProcess[] = [];
    const cleanup: {
      browser?: Awaited<ReturnType<typeof chromium.launch>>;
    } = {};
    t.after(async () => {
      try {
        await cleanup.browser?.close();
      } finally {
        for (const child of children.reverse()) {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGTERM");
            await exited;
          }
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const environment = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
    };
    async function startFixture(
      name: string,
      args: string[],
      extra: NodeJS.ProcessEnv = {},
    ) {
      const child = fork(path.join(repository, "tests/fixtures", name), args, {
        env: { ...environment, ...extra },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      children.push(child);
      let errors = "";
      child.stderr!.on("data", (bytes) => {
        errors += String(bytes);
      });
      const ready = await Promise.race([
        once(child, "message"),
        once(child, "exit").then(() => {
          throw new Error(errors || `${name} exited before readiness`);
        }),
      ]);
      assert.equal(ready[0].ready, true);
      return { child, message: ready[0] };
    }
    const control = await startFixture("system-controls-production-http.cjs", [
      "browser-system-owner",
    ]);
    const queue: string = control.message.queueDirectory;
    assert.ok(queue.startsWith(root + path.sep));
    await startFixture(
      "system-controls-lifecycle.cjs",
      [queue, `--build-hash=${"a".repeat(64)}`],
      {
        FMCAD_FIXTURE_CLIENT_TOKEN: control.message.auth.clientToken,
      },
    );
    const port = await availablePort();
    const ready = once(control.child, "message");
    control.child.send({ action: "run", port, browser: true });
    assert.equal((await ready)[0].browserReady, true);
    const browser = await chromium.launch({ headless: true });
    cleanup.browser = browser;
    const page = await browser.newPage({ locale: "en-US" });
    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(0);
    const errors: string[] = [];
    const posts: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400)
        errors.push(`${response.status()} ${response.url()}`);
    });
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/system-controls")
      )
        posts.push(request.postData() ?? "");
    });
    await page.goto(`http://localhost:${port}/`);
    await page.locator('.tabs [data-view="system"]').click();
    await page
      .locator('[data-system-control-action="pause"]:enabled')
      .waitFor();
    assert.deepEqual(
      posts,
      [],
      "opening System must not dispatch a lifecycle mutation",
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(queue, "counts.json"), "utf8")),
      { probes: 0, closes: 0 },
    );
    assert.equal(
      await page.locator('[data-system-control-action="start"]').isDisabled(),
      true,
    );
    for (const [action, phase] of [
      ["pause", "PAUSED"],
      ["resume", "RUNNING"],
      ["drain", "PAUSED"],
    ]) {
      const button = page.locator(
        `[data-system-control-action="${action}"]:enabled`,
      );
      await button.waitFor();
      await button.click();
      await page
        .locator(`[data-system-control-confirm-action="${action}"]`)
        .waitFor();
      const response = page.waitForResponse(
        (value) =>
          value.request().method() === "POST" &&
          value.url().endsWith("/system-controls"),
      );
      await page
        .locator(`[data-system-control-confirm-action="${action}"]`)
        .click();
      const receipt = await (await response).json();
      assert.equal(receipt.state, "confirmed");
      assert.equal(receipt.snapshot.phase, phase);
      const digest = createHash("sha256")
        .update(receipt.requestId)
        .digest("hex");
      const saved = JSON.parse(
        fs.readFileSync(
          path.join(queue, `lifecycle-control-${digest}.json`),
          "utf8",
        ),
      );
      assert.equal(saved.status, "completed");
      assert.equal(saved.binding.action, action);
      assert.equal(saved.binding.instanceId, receipt.instanceId);
      assert.equal(saved.binding.clientId, control.message.auth.clientId);
    }
    assert.equal(
      posts.length,
      3,
      "one confirmed intent produces exactly one mutation POST",
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(queue, "counts.json"), "utf8")),
      { probes: 1, closes: 0 },
    );
    assert.deepEqual(errors, []);
  },
);
