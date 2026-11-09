/// <reference lib="dom" />

"use strict";

import type {
  Browser,
  BrowserContext,
  Locator,
  Page,
  Request,
} from "playwright";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
  createBrowserFixture,
  projectId,
} from "./control-center-browser-fixture.mts";

import {
  classifyNetworkConsoleErrors,
  type BrowserConsoleError,
  type ExpectedNetworkFailure,
} from "./browser-network-evidence.ts";

interface CapturedQuery {
  readonly collection?: string;
  readonly scope?: { readonly kind?: string; readonly projectId?: string };
  readonly search?: string;
  readonly offset?: number;
  readonly sort?: readonly { readonly field?: string }[];
  readonly filters?: {
    readonly id?: string;
    readonly taskId?: string;
    readonly source?: string;
    readonly level?: string;
    readonly clientId?: { readonly any?: readonly string[] };
    readonly presence?: { readonly any?: readonly string[] };
    readonly state?: { readonly any?: readonly string[] };
    readonly label?: { readonly contains?: string };
    readonly executionMs?: {
      readonly min?: number;
      readonly max?: number;
      readonly includeMissing?: boolean;
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestBody(request: Request): Record<string, unknown> | null {
  try {
    const body: unknown = request.postDataJSON();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function requestHasLabelSort(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value["sort"])) return false;
  return value["sort"].some(
    (item: unknown) => isRecord(item) && item["field"] === "label",
  );
}

interface ObservedControl {
  readonly action: string | null;
  readonly id: string | null;
  readonly view: string | null;
  readonly range: string | null;
  readonly column: string | null;
  readonly kind: string | null;
  readonly table: string | null;
  readonly page: string | null;
  readonly collection: string | null;
  readonly format: string | null;
  readonly value: string | null;
  readonly label: string;
}

declare global {
  interface Window {
    __recordConsoleControlInventory?: (
      controls: readonly ObservedControl[],
    ) => void;
    __recordConsoleControlClick?: (control: ObservedControl) => void;
  }
}

interface MobileLayout {
  readonly viewport: number;
  readonly content: number;
  readonly overflowers: readonly {
    readonly element: string;
    readonly id: string | null;
    readonly className: string | null;
    readonly left: number;
    readonly right: number;
    readonly width: number;
    readonly scrollWidth: number;
    readonly clientWidth: number;
  }[];
}

const artifactsRoot = path.resolve(
  process.env["FMCAD_CONTROL_CENTER_E2E_ARTIFACTS"] ??
    path.join(os.tmpdir(), "opencode", "fmcad-control-center-e2e"),
);

function waitForQuery(
  page: Page,
  predicate: (query: CapturedQuery) => boolean,
): Promise<import("playwright").Request> {
  return page.waitForRequest(
    (request) => {
      if (!request.url().includes("/api/v1/console/query")) return false;
      const payload = requestBody(request);
      return payload ? predicate(payload as CapturedQuery) : false;
    },
    { timeout: 10_000 },
  );
}

async function waitForCount(locator: Locator, count: number): Promise<void> {
  if (count > 0) await locator.nth(count - 1).waitFor();
  await locator.nth(count).waitFor({ state: "detached" });
}

test(
  "Control Center interactions work in headless Chromium against an isolated query fixture",
  { timeout: 120_000 },
  async (t) => {
    fs.mkdirSync(artifactsRoot, { recursive: true });
    const runId = `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
    const runDirectory = path.join(artifactsRoot, runId);
    fs.mkdirSync(runDirectory, { recursive: false });
    const fixture = createBrowserFixture();
    const http = await fixture.start();
    const consoleErrors: string[] = [];
    const consoleMessages: BrowserConsoleError[] = [];
    const outageFailures: ExpectedNetworkFailure[] = [];
    const classifyConsoleErrors = (): void => {
      const classified = classifyNetworkConsoleErrors(
        consoleMessages,
        outageFailures,
        http.origin,
      );
      consoleErrors.splice(0, consoleErrors.length, ...classified.unexpected);
      expectedNetworkConsoleErrors.splice(
        0,
        expectedNetworkConsoleErrors.length,
        ...classified.expected,
      );
    };
    const expectedNetworkConsoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    const intentionalRequestAborts: string[] = [];
    const expectedNetworkFailures: string[] = [];
    const badResponses: string[] = [];
    const assertions: string[] = [];
    // Real registry/SQLite composition is covered by the companion production browser test.
    const unmetRequirements: string[] = [];
    const observedControls = new Map<string, ObservedControl>();
    const clickedControls: ObservedControl[] = [];
    let mobileLayout: MobileLayout | null = null;
    const cleanup: {
      browser?: Browser;
      context?: BrowserContext;
      page?: Page;
    } = {};
    let traceStarted = false;
    let browserVersion = "not-started";
    const unsupported: string[] = [
      "Project alias/archive/restore and mutating system controls are not exercised: this read-only fixture has no safe mutation instance or control endpoint.",
    ];

    const record = (name: string): void => {
      assertions.push(name);
    };
    const unexercisedActions = (): string[] => {
      const observed = new Set(
        [...observedControls.values()]
          .map((control) => control.action)
          .filter((action): action is string => action !== null),
      );
      const clicked = new Set(
        clickedControls
          .map((control) => control.action)
          .filter((action): action is string => action !== null),
      );
      return [...observed].filter((action) => !clicked.has(action)).sort();
    };
    const writeReport = () => {
      classifyConsoleErrors();
      fs.writeFileSync(
        path.join(runDirectory, "report.json"),
        `${JSON.stringify(
          {
            runId,
            browser: browserVersion,
            origin: http.origin,
            viewport: { desktop: [1440, 960], mobile: [390, 844] },
            mobileLayout,
            assertions,
            unmetRequirements,
            unsupported,
            controls: {
              observed: [...observedControls.values()].sort((left, right) =>
                JSON.stringify(left).localeCompare(JSON.stringify(right)),
              ),
              clicked: clickedControls,
              unexercisedActions: unexercisedActions(),
            },
            backendCalls: fixture.calls,
            consoleErrors,
            consoleMessages,
            outageFailures,
            expectedNetworkConsoleErrors,
            pageErrors,
            failedRequests,
            intentionalRequestAborts,
            expectedNetworkFailures,
            badResponses,
          },
          null,
          2,
        )}\n`,
      );
    };

    t.after(async () => {
      if (traceStarted && cleanup.context) {
        try {
          await cleanup.context.tracing.stop({
            path: path.join(runDirectory, "trace.zip"),
          });
        } catch (error) {
          pageErrors.push(
            `trace-save: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (cleanup.page && !cleanup.page.isClosed())
        await cleanup.page.close().catch(() => {});
      if (cleanup.context) await cleanup.context.close().catch(() => {});
      if (cleanup.browser) await cleanup.browser.close().catch(() => {});
      await http.close();
      writeReport();
    });

    const browser = await chromium.launch({ headless: true });
    cleanup.browser = browser;
    browserVersion = browser.version();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      locale: "pl-PL",
      acceptDownloads: true,
    });
    cleanup.context = context;
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: http.origin,
    });
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    traceStarted = true;
    const page = await context.newPage();
    cleanup.page = page;
    await page.exposeFunction(
      "__recordConsoleControlInventory",
      (controls: readonly ObservedControl[]) => {
        for (const control of controls)
          observedControls.set(JSON.stringify(control), control);
      },
    );
    await page.exposeFunction(
      "__recordConsoleControlClick",
      (control: ObservedControl) => {
        clickedControls.push(control);
      },
    );
    await context.addInitScript(() => {
      const describe = (element: HTMLElement): ObservedControl => {
        const data = element.dataset;
        return {
          action: data["action"] ?? null,
          id: data["id"] ?? null,
          view: data["view"] ?? null,
          range: data["range"] ?? null,
          column: data["column"] ?? null,
          kind: data["kind"] ?? null,
          table: data["table"] ?? null,
          page: data["page"] ?? null,
          collection: data["collection"] ?? null,
          format: data["format"] ?? null,
          value: data["value"] ?? null,
          label: (
            element.getAttribute("aria-label") ||
            element.innerText ||
            element.textContent ||
            ""
          )
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 120),
        };
      };
      const scan = () => {
        const controls = [
          ...document.querySelectorAll<HTMLElement>(
            "#app [data-action], #overlay-root [data-action]",
          ),
        ]
          .filter(
            (element) =>
              // Submission is verified through the form's submit button; disabled
              // pagination controls are unavailable, not missed interactions.
              !(element instanceof HTMLFormElement) &&
              !(element instanceof HTMLButtonElement && element.disabled),
          )
          .map(describe);
        void window.__recordConsoleControlInventory?.(controls);
      };
      const reportClick = (event: Event): void => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const control = target.closest<HTMLElement>(
          "#app [data-action], #overlay-root [data-action]",
        );
        if (control)
          void window.__recordConsoleControlClick?.(describe(control));
      };
      new MutationObserver(scan).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-action"],
      });
      document.addEventListener("click", reportClick, true);
      document.addEventListener("change", reportClick, true);
      queueMicrotask(scan);
    });
    let expectingNetworkOutage = false;
    const pendingRequests = new Set<Request>();
    const outageRequests = new WeakSet<Request>();
    page.on("request", (request) => {
      pendingRequests.add(request);
      if (expectingNetworkOutage) outageRequests.add(request);
    });
    page.on("requestfinished", (request) => pendingRequests.delete(request));
    page.on("console", (message) => {
      if (message.type() === "error")
        consoleMessages.push({
          text: message.text(),
          url: message.location().url,
        });
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      pendingRequests.delete(request);
      const failure = request.failure()?.errorText ?? "unknown failure";
      const description = `${request.method()} ${request.url()}: ${failure}`;
      const pathname = new URL(request.url()).pathname;
      if (
        outageRequests.has(request) &&
        new URL(request.url()).origin === http.origin &&
        pathname.startsWith("/api/v1/console/")
      ) {
        expectedNetworkFailures.push(description);
        outageFailures.push({ url: request.url(), error: failure });
      } else if (
        pathname === "/api/v1/console/events" &&
        failure === "net::ERR_ABORTED"
      )
        intentionalRequestAborts.push(description);
      else failedRequests.push(description);
    });
    page.on("response", (response) => {
      if (response.status() >= 400)
        badResponses.push(`${response.status()} ${response.url()}`);
    });

    const response = await page.goto(http.origin, {
      waitUntil: "domcontentloaded",
    });
    assert.equal(
      response?.status(),
      200,
      "real HTTP server returns the production page",
    );
    await page.getByRole("heading", { name: "Przegląd globalny" }).waitFor();
    // The shell renders before API data. Wait for the data and freshness state
    // that the assertions below actually verify.
    await page
      .getByRole("button", { name: /E2E Synthetic Project/ })
      .first()
      .waitFor();
    await page.getByText("E2E queued task", { exact: true }).first().waitFor();
    await page.getByText("POŁĄCZONO", { exact: true }).waitFor();
    assert.equal(await page.locator("#app .app-shell").count(), 1);
    assert.match(
      await page.locator("#app").innerText(),
      /E2E Synthetic Project/,
    );
    assert.match(await page.locator("#app").innerText(), /E2E queued task/);
    assert.match(await page.locator("#app").innerText(), /POŁĄCZONO/);
    record(
      "desktop overview rendered real project/task rows and fresh-source status",
    );
    await page.screenshot({
      path: path.join(runDirectory, "desktop-overview.png"),
      fullPage: true,
    });

    const localeTrigger = page.locator("#locale-selector-trigger");
    if ((await localeTrigger.count()) === 0) {
      unmetRequirements.push(
        "Language selector is not rendered; locale selection, catalog change, and persistence were not exercised.",
      );
    } else {
      await localeTrigger.click();
      const germanOption = page.locator(
        '[role="menuitemradio"][data-locale="de"]',
      );
      await germanOption.waitFor();
      assert.equal(await germanOption.innerText(), "Deutsch");
      await germanOption.click();
      await page.waitForFunction(() => document.documentElement.lang === "de");
      await page.getByRole("heading", { name: "Globale Übersicht" }).waitFor();
      assert.equal(
        await page.evaluate(() =>
          localStorage.getItem("fmcad.control-center.locale.v1"),
        ),
        "de",
      );
      await page.screenshot({
        path: path.join(runDirectory, "desktop-locale-de.png"),
        fullPage: true,
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Globale Übersicht" }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.lang),
        "de",
      );
      assert.equal(
        await page.evaluate(() =>
          localStorage.getItem("fmcad.control-center.locale.v1"),
        ),
        "de",
      );
      await page.locator("#locale-selector-trigger").click();
      await page
        .locator('[role="menuitemradio"][data-locale="system"]')
        .click();
      await page.waitForFunction(() => document.documentElement.lang === "pl");
      assert.equal(
        await page.evaluate(() =>
          localStorage.getItem("fmcad.control-center.locale.v1"),
        ),
        null,
      );
      await page.getByRole("heading", { name: "Przegląd globalny" }).waitFor();
      record(
        "language menu changes the catalog, persists after reload, and returns to browser language",
      );
    }

    const scopeRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" && query.scope?.projectId === projectId,
    );
    await page
      .getByRole("button", { name: /E2E Synthetic Project/ })
      .first()
      .click();
    await scopeRequest;
    await page
      .getByRole("heading", { name: "E2E Synthetic Project" })
      .waitFor();
    await page
      .getByText("OSTATNI ODCZYT NIEAKTUALNY", { exact: true })
      .waitFor();
    await page
      .getByText("E2E stale-data scenario", { exact: false })
      .first()
      .waitFor();
    assert.match(
      await page.locator("#app").innerText(),
      /OSTATNI ODCZYT NIEAKTUALNY/,
    );
    assert.match(
      await page.locator("#app").innerText(),
      /E2E stale-data scenario/,
    );
    record(
      "project navigation requests project-scoped data and exposes stale freshness",
    );

    await page.getByRole("combobox", { name: /Zakres projektu:/ }).click();
    await page
      .getByRole("option", { name: "Wszystkie projekty", exact: true })
      .click();
    await page.getByRole("heading", { name: "Przegląd globalny" }).waitFor();
    await page.getByText("POŁĄCZONO", { exact: true }).waitFor();
    assert.match(await page.locator("#app").innerText(), /POŁĄCZONO/);
    record("project scope selector returns to fresh global snapshot");

    const queueOpenRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" &&
        query.scope?.kind === "global" &&
        query.filters?.state?.any?.includes("queued") === true,
    );
    await page.getByRole("button", { name: /Przejdź do kolejki/ }).click();
    await queueOpenRequest;
    await page.getByRole("heading", { name: "Kolejki i zadania" }).waitFor();
    const taskRows = page.locator("tbody tr.click-row");
    const allTasksRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" && query.filters?.state === undefined,
    );
    await page
      .locator(".queue-list-header .segmented")
      .getByRole("button", { name: /^Wszystkie/ })
      .click();
    await allTasksRequest;
    await page.getByRole("row", { name: /E2E queued task/ }).waitFor();
    await waitForCount(taskRows, 12);
    assert.equal(
      await taskRows.count(),
      12,
      "task table shows the production page size",
    );
    record("tasks view renders paged backend query results and statuses");

    const openRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" &&
        query.filters?.state?.any?.includes("queued") === true &&
        !query.filters?.state?.any?.includes("completed"),
    );
    await page.getByRole("button", { name: /Otwarte/ }).click();
    await openRequest;
    await page.getByRole("row", { name: /E2E queued task/ }).waitFor();
    await waitForCount(
      page.getByRole("row", { name: /E2E completed task/ }),
      0,
    );
    assert.equal(
      await page.getByRole("row", { name: /E2E completed task/ }).count(),
      0,
    );
    record("open-task segment changes server filters and visible task rows");
    const historyRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" &&
        query.filters?.state?.any?.includes("completed") === true &&
        !query.filters?.state?.any?.includes("queued"),
    );
    await page.getByRole("button", { name: /Historia/ }).click();
    await historyRequest;
    await page.getByRole("row", { name: /E2E completed task/ }).waitFor();
    await waitForCount(page.getByRole("row", { name: /E2E queued task/ }), 0);
    assert.equal(
      await page.getByRole("row", { name: /E2E queued task/ }).count(),
      0,
    );
    record("task history segment queries terminal records from the backend");

    const restoreAllTasksRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" && query.filters?.state === undefined,
    );
    await page
      .locator(".queue-list-header .segmented")
      .getByRole("button", { name: /^Wszystkie/ })
      .click();
    await restoreAllTasksRequest;
    const taskSearchRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" && query.search === "E2E queued task",
    );
    await page.getByLabel("Szukaj zadań").fill("E2E queued task");
    await taskSearchRequest;
    await page.getByRole("row", { name: /E2E queued task/ }).waitFor();
    await waitForCount(taskRows, 1);
    assert.equal(await taskRows.count(), 1);
    record(
      "task search is sent to the backend and narrows the rendered result",
    );
    await page.getByLabel("Szukaj zadań").fill("");
    await page.getByRole("row", { name: /E2E completed task/ }).waitFor();

    const filterRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" &&
        query.filters?.state?.any?.length === 1 &&
        query.filters.state.any[0] === "queued",
    );
    await page.getByRole("button", { name: /Filtruj Stan/ }).click();
    await page.getByRole("dialog", { name: "state" }).waitFor();
    await page.locator('[data-action="filter-select-visible"]').click();
    await page.locator('[data-action="filter-select-all"]').click();
    await page.locator('[data-action="filter-select-none"]').click();
    await page
      .locator('[data-action="filter-toggle"][data-value="queued"]')
      .click();
    await page.getByRole("button", { name: "Zastosuj" }).click();
    await filterRequest;
    await page.getByRole("row", { name: /E2E queued task/ }).waitFor();
    await waitForCount(
      page.getByRole("row", { name: /E2E completed task/ }),
      0,
    );
    assert.equal(
      await page.getByRole("row", { name: /E2E completed task/ }).count(),
      0,
    );
    record(
      "categorical task filter dialog applies a backend filter and updates the table",
    );
    const clearFilterRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" && query.filters?.state === undefined,
    );
    await page.getByRole("button", { name: "Filtruj Stan" }).click();
    await page.getByRole("dialog", { name: "state" }).waitFor();
    await page
      .getByRole("dialog", { name: "state" })
      .getByRole("button", { name: "Resetuj", exact: true })
      .click();
    await clearFilterRequest;

    const textFilterRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" &&
        query.filters?.label?.contains === "E2E failed",
    );
    await page
      .getByRole("button", { name: "Filtruj Zadanie / dokument" })
      .click();
    await page.getByRole("dialog").waitFor();
    await page.locator("#filter-text").fill("E2E failed");
    await page.getByRole("button", { name: "Zastosuj" }).click();
    await textFilterRequest;
    await page.getByRole("row", { name: /E2E failed task/ }).waitFor();
    await waitForCount(taskRows, 1);
    assert.equal(await taskRows.count(), 1);
    record("text column filter sends contains to the backend and narrows rows");
    const resetTextFilterRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" && query.filters?.label === undefined,
    );
    await page.getByRole("button", { name: /Resetuj/ }).click();
    await resetTextFilterRequest;

    const numericFilterRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" &&
        query.filters?.executionMs?.min === 500 &&
        query.filters.executionMs.max === 700 &&
        query.filters.executionMs.includeMissing === true,
    );
    await page.getByRole("button", { name: "Filtruj Wykonanie" }).click();
    await page.getByRole("dialog").waitFor();
    await page.locator("#filter-min").fill("0.8");
    await page.locator("#filter-max").fill("0.2");
    await page.getByRole("button", { name: "Zastosuj" }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(
      fixture.calls.some(
        (call) =>
          call.method === "query" &&
          isRecord(call.request) &&
          isRecord(call.request["filters"]) &&
          call.request["filters"]["executionMs"] !== undefined,
      ),
      false,
      "invalid numeric range must not reach the backend",
    );
    await page.locator("#filter-min").fill("0.5");
    await page.locator("#filter-max").fill("0.7");
    assert.equal(await page.locator("#filter-missing").isChecked(), true);
    await page.getByRole("button", { name: "Zastosuj" }).click();
    await numericFilterRequest;
    await page.getByRole("row", { name: /E2E queued task/ }).waitFor();
    record(
      "numeric filter validates reversed bounds and applies millisecond range with missing values",
    );
    const resetNumericFilterRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" &&
        query.filters?.executionMs === undefined,
    );
    await page.getByRole("button", { name: /Resetuj/ }).click();
    await resetNumericFilterRequest;

    const pageTwoRequest = waitForQuery(
      page,
      (query) => query.collection === "tasks" && query.offset === 12,
    );
    await page.getByRole("button", { name: "Następna" }).click();
    await pageTwoRequest;
    await page.getByRole("row", { name: /E2E pagination task 14/ }).waitFor();
    record(
      "pagination sends the next offset to the backend and displays its row",
    );
    await page.getByRole("button", { name: "Poprzednia" }).click();

    const sortRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" &&
        query.sort?.some((sort) => sort.field === "label") === true,
    );
    await page
      .getByRole("button", {
        name: "Sortuj według Zadanie / dokument; Ctrl lub Command dodaje kolumnę",
      })
      .click();
    await sortRequest;
    assert.ok(
      fixture.calls.some(
        (call) =>
          call.method === "query" &&
          isRecord(call.request) &&
          call.request["collection"] === "tasks" &&
          requestHasLabelSort(call.request),
      ),
      "sorting is sent through the production query API",
    );
    record("task column sorting reaches the backend query handler");
    const multiSortRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" &&
        query.sort !== undefined &&
        query.sort.length === 2,
    );
    await page
      .getByRole("button", {
        name: "Sortuj według Stan; Ctrl lub Command dodaje kolumnę",
      })
      .click({ modifiers: ["Control"] });
    await multiSortRequest;
    record("control-click adds a second server-side sort column");
    const resetSortRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" &&
        query.sort?.length === 1 &&
        query.sort[0]?.field === "submittedAt",
    );
    await page.getByRole("button", { name: /Resetuj/ }).click();
    await resetSortRequest;

    const taskDetailsRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" && query.filters?.id === "task-e2e-queued",
    );
    await page.getByRole("row", { name: /E2E queued task/ }).click();
    await taskDetailsRequest;
    await page.getByRole("dialog", { name: "Szczegóły zadania" }).waitFor();
    assert.match(
      await page.getByRole("dialog").innerText(),
      /queued-model\.f3d/,
    );
    await page.screenshot({
      path: path.join(runDirectory, "desktop-task-details.png"),
      fullPage: true,
    });
    const taskRefreshRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" && query.filters?.id === "task-e2e-queued",
    );
    await page.getByRole("button", { name: /Odśwież szczegóły/ }).click();
    await taskRefreshRequest;
    const sourceDetailRequest = page.waitForRequest(
      (request) => {
        if (
          !request.url().includes("/api/v1/console/detail") ||
          request.method() !== "POST"
        )
          return false;
        return requestBody(request)?.["kind"] === "original-source";
      },
      { timeout: 10_000 },
    );
    await page.getByRole("tab", { name: "Kod" }).click();
    await page
      .locator('[data-action="artifact"][data-kind="original-source"]')
      .click();
    await sourceDetailRequest;
    await page.getByText("synthetic retained source").waitFor();
    await page.locator('[data-action="copy-artifact"]').click();
    await page.getByText("Skopiowano do schowka.").waitFor();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      "def e2e_fixture():\n    return 'synthetic retained source'\n",
    );
    await page.locator('[data-action="copy-hash"]').click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      fixture.artifactHashes.originalSource,
    );
    record(
      "task code tab reads and copies a hash-bound retained file through the detail API",
    );

    const responseDetailRequest = page.waitForRequest(
      (request) => {
        if (
          !request.url().includes("/api/v1/console/detail") ||
          request.method() !== "POST"
        )
          return false;
        return requestBody(request)?.["kind"] === "response";
      },
      { timeout: 10_000 },
    );
    await page.getByRole("tab", { name: "Odpowiedź" }).click();
    await page
      .getByRole("button", { name: "Wczytaj zgodną odpowiedź" })
      .click();
    await responseDetailRequest;
    await page.getByText("Synthetic E2E retained response.").waitFor();
    await page.locator('[data-action="copy-artifact"]').click();
    await page.getByText("Skopiowano do schowka.").waitFor();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      "Synthetic E2E retained response.\n",
    );
    const detailCountBeforeMissingOutput = fixture.calls.filter(
      (call) => call.method === "detail",
    ).length;
    await page.locator('[data-action="artifact"][data-kind="stdout"]').click();
    await page
      .getByText("No retained stdout in the synthetic browser record.")
      .waitFor();
    assert.equal(
      fixture.calls.filter((call) => call.method === "detail").length,
      detailCountBeforeMissingOutput,
      "the explicit missing stdout channel must not send an artifact request",
    );
    record(
      "missing retained output is explained by the UI without a detail request",
    );
    await page.getByRole("tab", { name: "Szczegóły" }).click();
    const linkedAgentRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "agents" &&
        query.scope?.projectId === projectId &&
        query.filters?.id === "agent-e2e-active",
    );
    await page.getByRole("button", { name: /Otwórz agenta \/ sesję/ }).click();
    await linkedAgentRequest;
    await page.getByRole("dialog", { name: "Agent / sesja" }).waitFor();
    await page.locator('[data-action="back-task"]').click();
    await page.getByRole("dialog", { name: "Szczegóły zadania" }).waitFor();
    record(
      "task detail opens its linked agent and returns to the same task snapshot",
    );
    const eventsRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "logs" &&
        query.filters?.taskId === "task-e2e-queued",
    );
    await page.getByRole("tab", { name: "Zdarzenia" }).click();
    await eventsRequest;
    await page.getByText("E2E queued task was accepted").waitFor();
    record("task detail and its event tab query scoped backend records");
    await page.getByRole("button", { name: "Zamknij", exact: true }).click();

    await page.getByRole("tab", { name: "Agenci" }).click();
    await page.getByRole("heading", { name: "Agenci i ich praca" }).waitFor();
    await page.locator('[data-action="agent-search"]').click();
    await page.getByText("E2E Active Agent").waitFor();
    assert.match(await page.locator("#app").innerText(), /Potwierdzone/);
    // Both agents are already visible in the unfiltered table. The historical
    // row alone cannot prove that the asynchronous filter response rendered.
    await page.getByText("E2E Historical Agent").waitFor();
    const historicalAgentsRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "agents" &&
        query.scope?.kind === "global" &&
        query.filters?.presence?.any?.includes("unknown") === true &&
        query.filters.presence.any.includes("active") === false,
    );
    await page
      .locator('[data-action="agent-filter"][data-filter="history"]')
      .click();
    await historicalAgentsRequest;
    await page.getByText("E2E Active Agent").waitFor({ state: "detached" });
    await page.getByText("E2E Historical Agent").waitFor();
    assert.equal(await page.getByText("E2E Active Agent").count(), 0);
    const technicalSessionsRequest = waitForQuery(
      page,
      (query) => query.collection === "sessions",
    );
    await page
      .locator('[data-action="session-filter"][data-filter="all"]')
      .click();
    await technicalSessionsRequest;
    record(
      "agents view and confirmed/history filter display source-backed presence states",
    );
    await page.getByText("E2E Historical Agent").click();
    await page.getByRole("dialog", { name: "Agent / sesja" }).waitFor();
    const agentAlias = page.locator("#agent-alias-input");
    await agentAlias.fill("");
    await page.locator('[data-action="agent-alias-save"]').click();
    assert.equal(
      await agentAlias.evaluate(
        (input: HTMLInputElement) => input.validity.valueMissing,
      ),
      true,
    );
    const agentLogsRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "logs" &&
        query.scope?.projectId === projectId &&
        query.filters?.clientId?.any?.includes("agent-e2e-history") === true,
    );
    await page.locator('[data-action="agent-logs"]').click();
    await agentLogsRequest;
    await page.locator('[data-action="back-agent"]').click();
    await page.getByRole("dialog", { name: "Agent / sesja" }).waitFor();
    record(
      "agent detail opens project-scoped logs and returns to the same agent",
    );
    await page.getByRole("button", { name: "Zamknij", exact: true }).click();
    const globalLogsRequest = waitForQuery(
      page,
      (query) => query.collection === "logs" && query.scope?.kind === "global",
    );
    await page.getByRole("combobox", { name: /Zakres projektu:/ }).click();
    await page
      .getByRole("option", { name: "Wszystkie projekty", exact: true })
      .click();
    await globalLogsRequest;

    await page.getByRole("tab", { name: "Logi" }).click();
    await page.getByRole("heading", { name: "Strumień zdarzeń" }).waitFor();
    await page.getByText("E2E queued task was accepted").waitFor();
    assert.equal(await page.getByText("E2E synthetic heartbeat").count(), 0);
    await page.getByLabel("Pokaż heartbeat").check();
    await page.getByText("E2E synthetic heartbeat").waitFor();
    const errorLevelRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "logs" && query.filters?.level === "ERROR",
    );
    await page
      .getByRole("combobox", { name: "Poziom logów: Wszystkie poziomy" })
      .click();
    await page.getByRole("option", { name: "ERROR", exact: true }).click();
    await errorLevelRequest;
    // The ERROR row already existed before filtering. Wait for the INFO row
    // to leave the rendered result, not merely for the request to be sent.
    await page
      .getByText("E2E queued task was accepted")
      .waitFor({ state: "detached" });
    await page.getByText("E2E synthetic failure detail").waitFor();
    assert.equal(
      await page.getByText("E2E queued task was accepted").count(),
      0,
    );
    const allLevelsRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "logs" && query.filters?.level === undefined,
    );
    await page.getByRole("combobox", { name: "Poziom logów: ERROR" }).click();
    await page
      .getByRole("option", { name: "Wszystkie poziomy", exact: true })
      .click();
    await allLevelsRequest;
    const workerSourceRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "logs" && query.filters?.source === "e2e-worker",
    );
    await page
      .getByRole("combobox", { name: "Źródło logów: Wszystkie źródła" })
      .click();
    await page.getByRole("option", { name: "e2e-worker", exact: true }).click();
    await workerSourceRequest;
    await page
      .getByText("E2E synthetic failure detail")
      .waitFor({ state: "detached" });
    assert.equal(
      await page.getByText("E2E synthetic failure detail").count(),
      0,
    );
    const allSourcesRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "logs" && query.filters?.source === undefined,
    );
    await page
      .getByRole("combobox", { name: "Źródło logów: e2e-worker" })
      .click();
    await page
      .getByRole("option", { name: "Wszystkie źródła", exact: true })
      .click();
    await allSourcesRequest;
    const infoLevelStatRequest = waitForQuery(
      page,
      (query) => query.collection === "logs" && query.filters?.level === "INFO",
    );
    await page
      .locator('[data-action="log-level-select"][data-level="INFO"]')
      .click();
    await infoLevelStatRequest;
    await page.getByText("E2E queued task was accepted").waitFor();
    await page
      .getByText("E2E synthetic failure detail")
      .waitFor({ state: "detached" });
    const resetLevelStatRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "logs" && query.filters?.level === undefined,
    );
    await page.getByRole("combobox", { name: "Poziom logów: INFO" }).click();
    await page
      .getByRole("option", { name: "Wszystkie poziomy", exact: true })
      .click();
    await resetLevelStatRequest;
    await page.getByRole("button", { name: "Śledzenie włączone" }).click();
    await page.getByRole("button", { name: "Śledzenie zatrzymane" }).waitFor();
    const logsSearchRequest = waitForQuery(
      page,
      (query) => query.collection === "logs" && query.search === "accepted",
    );
    await page.getByLabel("Szukaj w logach").fill("accepted");
    await logsSearchRequest;
    await page.getByText("E2E queued task was accepted").waitFor();
    await page
      .getByText("E2E synthetic failure detail")
      .waitFor({ state: "detached" });
    assert.equal(
      await page.getByText("E2E synthetic failure detail").count(),
      0,
    );
    record(
      "logs search, level/source filters, heartbeat and follow controls change the view",
    );

    await page.locator('[data-action="log"][data-id="log-e2e-queued"]').click();
    await page.getByRole("dialog", { name: "Szczegóły zdarzenia" }).waitFor();
    assert.match(
      await page.getByRole("dialog").innerText(),
      /E2E queued task was accepted/,
    );
    await page.getByRole("button", { name: "Kopiuj wpis" }).click();
    await page.getByText("Skopiowano do schowka.").waitFor();
    const copiedLog: unknown = JSON.parse(
      await page.evaluate(() => navigator.clipboard.readText()),
    );
    assert.ok(isRecord(copiedLog));
    assert.equal(copiedLog["id"], "log-e2e-queued");
    assert.equal(copiedLog["message"], "E2E queued task was accepted");
    const linkedTaskRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" &&
        query.scope?.projectId === projectId &&
        query.filters?.id === "task-e2e-queued",
    );
    await page.getByRole("button", { name: "Powiązane zadanie" }).click();
    await linkedTaskRequest;
    await page.getByRole("dialog", { name: "Szczegóły zadania" }).waitFor();
    await page.getByRole("button", { name: /Zdarzenie/ }).click();
    await page.getByRole("dialog", { name: "Szczegóły zdarzenia" }).waitFor();
    record(
      "log detail copies its actual record and opens/returns to its linked task",
    );
    await page.getByRole("dialog", { name: "Szczegóły zdarzenia" }).waitFor();
    await page.getByRole("button", { name: "Zamknij okno" }).click();

    await page.getByRole("button", { name: "Szukaj globalnie" }).click();
    await page
      .getByRole("dialog", { name: "Szukaj w przestrzeni roboczej" })
      .waitFor();
    const globalSearchRequest = page.waitForRequest(
      (request) => {
        if (!request.url().includes("/api/v1/console/query")) return false;
        const query = requestBody(request);
        return (
          query?.["collection"] === "search" &&
          query["search"] === "E2E Active Agent"
        );
      },
      { timeout: 10_000 },
    );
    await page
      .getByRole("searchbox", { name: "Szukaj globalnie" })
      .fill("E2E Active Agent");
    await globalSearchRequest;
    await page.getByText("E2E Active Agent").waitFor();
    record("global search dialog queries and renders real search results");
    const searchAgentRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "agents" &&
        query.scope?.projectId === projectId &&
        query.filters?.id === "agent-e2e-active",
    );
    await page
      .locator('[data-action="search-result"][data-kind="agent"]')
      .click();
    await searchAgentRequest;
    await page.getByRole("dialog", { name: "Agent / sesja" }).waitFor();
    record("global search result navigates to the matching agent details");
    await page
      .locator('[data-action="task-open"][data-id="task-e2e-queued"]')
      .click();
    await page.locator('[data-action="task-refresh"]').waitFor();
    assert.match(
      await page.locator('[role="dialog"]').innerText(),
      /E2E queued task/,
    );
    record("agent activity opens the retained owning task");
    await page.getByRole("button", { name: "Zamknij okno" }).click();

    await page.getByRole("button", { name: "Pomoc", exact: true }).click();
    await page.getByRole("dialog", { name: "Pomoc", exact: true }).waitFor();
    await page.locator("#overlay-root .overlay").click({
      position: { x: 2, y: 2 },
    });
    await page.getByRole("dialog", { name: "Pomoc", exact: true }).waitFor({
      state: "detached",
    });
    await page
      .locator(".topbar")
      .getByRole("button", { name: "Ustawienia", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: /Odstęp między aktualizacjami widoku:/ })
      .click();
    await page.getByRole("option", { name: /Co 8 sekund/ }).click();
    const preferences: unknown = await page.evaluate(() => {
      const saved = localStorage.getItem("fmcad-prefs");
      return saved === null ? null : JSON.parse(saved);
    });
    assert.ok(isRecord(preferences));
    assert.equal(preferences["refreshIntervalMs"], 8000);
    await page
      .getByRole("dialog", { name: "Ustawienia", exact: true })
      .waitFor({ state: "detached" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Przegląd globalny" }).waitFor();
    await page
      .locator(".topbar")
      .getByRole("button", { name: "Ustawienia", exact: true })
      .click();
    assert.match(
      (await page
        .getByRole("combobox", { name: /Odstęp między aktualizacjami widoku:/ })
        .getAttribute("aria-label")) ?? "",
      /Co 8 sekund/,
    );
    record(
      "settings dialog persists the selected refresh interval across reload",
    );
    await page.getByRole("button", { name: "Zamknij", exact: true }).click();

    await page.getByRole("button", { name: "Eksportuj dane" }).click();
    await page
      .getByRole("dialog", { name: "Eksportuj", exact: true })
      .waitFor();
    const exportRequest = page.waitForRequest(
      (request) =>
        request.url().includes("/api/v1/console/export") &&
        request.method() === "POST",
      { timeout: 10_000 },
    );
    const downloadEvent = page.waitForEvent("download", { timeout: 10_000 });
    await page.getByRole("button", { name: /CSV · pełny wynik/ }).click();
    const [download] = await Promise.all([downloadEvent, exportRequest]);
    const downloadPath = await download.path();
    assert.ok(downloadPath, "CSV export is downloaded from the browser");
    const exported = fs.readFileSync(downloadPath, "utf8");
    assert.match(exported, /E2E queued task/);
    assert.match(download.suggestedFilename(), /^fmcad-tasks-.*\.csv$/);
    record("CSV export downloads backend-generated retained query data");
    await page.getByRole("button", { name: "Eksportuj dane" }).click();
    await page
      .getByRole("dialog", { name: "Eksportuj", exact: true })
      .waitFor();
    const jsonExportRequest = page.waitForRequest(
      (request) => {
        if (
          !request.url().includes("/api/v1/console/export") ||
          request.method() !== "POST"
        )
          return false;
        return requestBody(request)?.["format"] === "json";
      },
      { timeout: 10_000 },
    );
    const jsonDownloadEvent = page.waitForEvent("download", {
      timeout: 10_000,
    });
    await page.getByRole("button", { name: /JSON · pełny wynik/ }).click();
    const [jsonDownload] = await Promise.all([
      jsonDownloadEvent,
      jsonExportRequest,
    ]);
    const jsonDownloadPath = await jsonDownload.path();
    assert.ok(jsonDownloadPath, "JSON export is downloaded from the browser");
    const exportedJson: unknown = JSON.parse(
      fs.readFileSync(jsonDownloadPath, "utf8"),
    );
    assert.ok(isRecord(exportedJson));
    assert.equal(exportedJson["collection"], "tasks");
    const exportedRows = exportedJson["rows"];
    assert.ok(Array.isArray(exportedRows));
    assert.ok(
      exportedRows.some(
        (row: unknown) => isRecord(row) && row["label"] === "E2E queued task",
      ),
    );
    assert.match(jsonDownload.suggestedFilename(), /^fmcad-tasks-.*\.json$/);
    record("JSON export downloads backend-generated retained query data");

    const refreshBefore = fixture.calls.filter(
      (call) => call.method === "snapshot",
    ).length;
    await page.getByRole("button", { name: "Zamroź podgląd" }).click();
    await page.getByText("Podgląd zamrożony.").waitFor();
    await page
      .locator(".heading-actions")
      .getByRole("button", { name: "Wznów podgląd" })
      .click();
    const refreshRequest = page.waitForRequest(
      (request) => request.url().includes("/api/v1/console/snapshot"),
      { timeout: 10_000 },
    );
    await page.getByRole("button", { name: "Odśwież widok" }).click();
    await refreshRequest;
    assert.ok(
      fixture.calls.filter((call) => call.method === "snapshot").length >
        refreshBefore,
    );
    record(
      "freeze/resume are safe local preview controls and refresh requests a new snapshot",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Otwórz menu" }).click();
    assert.equal(
      (await page.locator("aside.sidebar").getAttribute("class"))?.includes(
        "open",
      ),
      true,
    );
    await page.screenshot({
      path: path.join(runDirectory, "mobile-menu.png"),
      fullPage: true,
    });
    await page.locator(".mobile-scrim").click({
      position: { x: 300, y: 100 },
    });
    assert.equal(
      (await page.locator("aside.sidebar").getAttribute("class"))?.includes(
        "open",
      ),
      false,
    );
    await page.getByRole("button", { name: "Otwórz menu" }).click();
    const mobileScopeRequest = waitForQuery(
      page,
      (query) =>
        query.collection === "tasks" && query.scope?.projectId === projectId,
    );
    await page
      .getByRole("button", { name: /E2E Synthetic Project/ })
      .first()
      .click();
    await mobileScopeRequest;
    await page
      .getByRole("heading", { name: "E2E Synthetic Project" })
      .waitFor();
    assert.doesNotMatch(
      (await page.locator("aside.sidebar").getAttribute("class")) ?? "",
      /open/,
    );
    // Visually hidden absolute labels must stay inside the table's scroll container.
    // The document remains narrow while every table column remains reachable.
    const tableScroll = await page
      .locator(".table-wrap")
      .first()
      .evaluate((element) => {
        const original = element.scrollLeft;
        element.scrollLeft = element.scrollWidth;
        const reached = element.scrollLeft;
        element.scrollLeft = original;
        return {
          reached,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });
    assert.ok(tableScroll.scrollWidth > tableScroll.clientWidth);
    assert.ok(
      tableScroll.reached > 0,
      "Mobile table columns must remain scrollable",
    );
    mobileLayout = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      const overflowers = [...document.querySelectorAll("body *")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            element: element.tagName.toLowerCase(),
            id: element.id || null,
            className:
              typeof element.className === "string"
                ? element.className.slice(0, 100)
                : null,
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
          };
        })
        .filter(
          (item) =>
            item.width > 0 &&
            (item.right > viewport + 1 ||
              item.left < -1 ||
              item.scrollWidth > item.clientWidth + 1),
        )
        .sort((left, right) => right.right - left.right)
        .slice(0, 12);
      return {
        viewport,
        content: document.documentElement.scrollWidth,
        overflowers,
      };
    });
    await page.screenshot({
      path: path.join(runDirectory, "mobile-project.png"),
      fullPage: true,
    });
    record(
      "mobile navigation opens/closes and loads the selected project; layout dimensions are checked below",
    );

    const networkTestGlobalRequest = waitForQuery(
      page,
      (query) => query.collection === "tasks" && query.scope?.kind === "global",
    );
    await page.getByRole("combobox", { name: /Zakres projektu:/ }).click();
    await page
      .getByRole("option", { name: "Wszystkie projekty", exact: true })
      .click();
    await networkTestGlobalRequest;
    expectingNetworkOutage = true;
    for (const request of pendingRequests) outageRequests.add(request);
    const failedSnapshot = new Promise<Request>((resolve) => {
      const onRequestFailed = (request: Request): void => {
        if (new URL(request.url()).pathname !== "/api/v1/console/snapshot")
          return;
        page.off("requestfailed", onRequestFailed);
        resolve(request);
      };
      page.on("requestfailed", onRequestFailed);
    });
    await http.stop();
    await page.getByRole("button", { name: "Odśwież widok" }).click();
    const failedSnapshotRequest = await failedSnapshot;
    assert.equal(
      new URL(failedSnapshotRequest.url()).pathname,
      "/api/v1/console/snapshot",
    );
    // The error can also appear in an empty table, but retained rows hide that
    // duplicate. Assert the persistent status notice for either table state.
    await page
      .locator('.notice[role="status"]')
      .filter({ hasText: "Nie można połączyć się z lokalnym panelem." })
      .waitFor();
    assert.ok(
      expectedNetworkFailures.some((request) =>
        request.includes("/api/v1/console/snapshot"),
      ),
    );
    record("backend network loss is reported in the UI without a JS crash");
    await http.start();
    expectingNetworkOutage = false;
    const recoveredSnapshot = page.waitForRequest(
      (request) => request.url().includes("/api/v1/console/snapshot"),
      { timeout: 10_000 },
    );
    await page.getByRole("button", { name: "Odśwież widok" }).click();
    await recoveredSnapshot;
    await page.getByText("POŁĄCZONO").waitFor();
    record("restarting only the owned loopback fixture restores browser reads");

    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    classifyConsoleErrors();
    assert.deepEqual(consoleErrors, [], "browser console has no errors");
    assert.deepEqual(
      pageErrors,
      [],
      "browser has no uncaught JavaScript errors",
    );
    assert.deepEqual(
      failedRequests,
      [],
      "browser has no failed network requests",
    );
    assert.deepEqual(
      badResponses,
      [],
      "browser has no HTTP responses with status >= 400",
    );
    assert.deepEqual(
      unexercisedActions(),
      [],
      "all observed data-action controls must be clicked by this browser run",
    );
    const acceptanceFailures = [...unmetRequirements];
    if (mobileLayout.content > mobileLayout.viewport + 1)
      acceptanceFailures.push(
        `mobile document overflows (${mobileLayout.content}px > ${mobileLayout.viewport}px): ${JSON.stringify(mobileLayout.overflowers)}`,
      );
    assert.deepEqual(
      acceptanceFailures,
      [],
      "required browser interactions must be exercised and mobile layout must fit its viewport",
    );
    assert.ok(
      fixture.calls.some((call) => call.method === "subscribe"),
      "real HTTP SSE subscription is exercised",
    );
    assert.ok(
      fixture.calls.some((call) => call.method === "export"),
      "real backend export handler is exercised",
    );
    record("console, page, network and HTTP status guards are clean");
    t.diagnostic(`Browser E2E artifacts: ${runDirectory}`);
  },
);

test(
  "disposed browser mounts cannot restart reads or subscriptions",
  { timeout: 30000 },
  async (t) => {
    const fixture = createBrowserFixture();
    const http = await fixture.start();
    t.after(() => http.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route("**/web/index.js", (route) =>
      route.fulfill({ contentType: "text/javascript", body: "" }),
    );
    await page.goto(http.origin);
    const result = await page.evaluate(async () => {
      const modulePath = "/assets/control-center/web/app.js";
      const apiPath = "/assets/control-center/web/api.js";
      const { ControlCenterApp } = await import(modulePath);
      const { ConsoleQueryClient } = await import(apiPath);
      const root = document.getElementById("app")!;
      const client = new ConsoleQueryClient(location.origin);
      const snapshot = await client.snapshot({ kind: "global" });
      let release!: (value: unknown) => void;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      let snapshots = 0,
        queries = 0,
        watches = 0;
      client.snapshot = () => {
        snapshots++;
        return pending;
      };
      client.query = () => {
        queries++;
        throw new Error("Read after disposal");
      };
      client.watch = () => {
        watches++;
        return { close() {} };
      };
      const app = new ControlCenterApp(root, { client });
      void app.start();
      app.dispose();
      app.dispose();
      release(snapshot);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await app.start();
      return {
        snapshots,
        queries,
        watches,
        content: root.innerHTML,
        overlay: document.getElementById("overlay-root")?.innerHTML,
      };
    });
    assert.deepEqual(result, {
      snapshots: 1,
      queries: 0,
      watches: 0,
      content: "",
      overlay: "",
    });
  },
);

test(
  "closing task details rejects their delayed refresh",
  { timeout: 30000 },
  async (t) => {
    const fixture = createBrowserFixture();
    const http = await fixture.start();
    t.after(() => http.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(http.origin);
    await page.locator('[data-action="task"]').first().click();
    await page.locator('[data-action="task-refresh"]').waitFor();
    let release!: () => void;
    let requested!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await page.route("**/api/v1/console/query", async (route) => {
      const body = route.request().postDataJSON() as CapturedQuery;
      if (body.collection === "tasks" && body.filters?.id) {
        const response = await route.fetch();
        requested();
        await pending;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await page.locator('[data-action="task-refresh"]').click();
    await seen;
    await page.keyboard.press("Escape");
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
    const completed = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/console/query") &&
        !!(response.request().postDataJSON() as CapturedQuery).filters?.id,
    );
    release();
    await completed;
    // Flush the response handler and its render, not an already visible row.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
  },
);

test(
  "a delayed global session response cannot replace the selected project's sessions",
  { timeout: 30000 },
  async (t) => {
    const fixture = createBrowserFixture();
    const http = await fixture.start();
    t.after(() => http.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: "pl-PL" });
    let release!: () => void;
    let requested!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await page.route("**/api/v1/console/query", async (route) => {
      const request = route.request().postDataJSON() as CapturedQuery;
      if (request.collection !== "sessions") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.json();
      const global = request.scope?.kind === "global";
      body.rows = [
        {
          id: global ? "stale-global-session" : "selected-project-session",
          projectId: "project-e2e-alpha",
          presence: "active",
        },
      ];
      body.total = 1;
      if (global) {
        requested();
        await pending;
      }
      await route.fulfill({ response, json: body });
    });
    await page.goto(http.origin);
    await page.getByRole("tab", { name: "Agenci" }).click();
    await seen;
    await page
      .locator('aside [data-action="scope"][data-id="project-e2e-alpha"]')
      .click();
    await page
      .locator(
        '[data-action="session-open"][data-id="selected-project-session"]',
      )
      .waitFor();
    const completed = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/console/query") &&
        (response.request().postDataJSON() as CapturedQuery).collection ===
          "sessions" &&
        (response.request().postDataJSON() as CapturedQuery).scope?.kind ===
          "global",
    );
    release();
    await completed;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(
      await page
        .locator('[data-action="session-open"][data-id="stale-global-session"]')
        .count(),
      0,
    );
    assert.equal(
      await page
        .locator(
          '[data-action="session-open"][data-id="selected-project-session"]',
        )
        .count(),
      1,
    );
  },
);
