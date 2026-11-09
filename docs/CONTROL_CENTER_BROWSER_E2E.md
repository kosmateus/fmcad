# Control Center browser E2E

The TypeScript (`.mts`) browser E2E starts the production Control Center bundle
on an
isolated loopback HTTP server and drives it in headless Chromium. Its synthetic
records are currently supplied through the public Console Query read port;
HTTP session/CSRF, query, filter, detail, export and SSE handling use the
production server and query implementation. The injected read port is a test
adapter, not proof of the production SQLite/registry/runtime composition. The
fixture does not connect to Fusion or use user data.

The companion `control-center-production-browser.test.mts` uses the installed
root composition and real temporary registry/SQLite histories. It verifies
project isolation, authenticated alias writes, reload and registered-ID URL
selection. It switches through all 25 locales on retained task/overview screens,
checks representative mobile layouts and loads both packaged Greek/Cyrillic
fallback font weights. Console errors, request failures, HTTP errors, screenshots
and a Playwright trace are retained even when an assertion fails.

Focused browser regressions cover repeated mount/dispose, delayed task refresh
after closing a dialog and delayed session results after selecting a project.
The fixture's control inventory includes enabled interactive controls; form
submission is counted through its submit button, while disabled pagination is
not claimed as an available operation. The original historical-agent filter
assertions still require the new response and removal of the active agent.

System controls additionally have real Node HTTP/QueueClient/lifecycle IPC
receipt tests in `system-controls.test.js`. Their isolated lifecycle process
does not connect to Fusion. They are not evidence of native Fusion qualification
or a Chromium run against a live native broker.

Run locally on Node 24 after installing the project dependencies:

```sh
npx playwright install --with-deps chromium
npm run test:control-center:e2e
```

The test fails if Chromium is not installed or cannot launch. It does not skip
browser checks. Screenshots, the Playwright trace and a JSON report are written
to `/tmp/opencode/fmcad-control-center-e2e/<run-id>` by default. Set
`FMCAD_CONTROL_CENTER_E2E_ARTIFACTS` to choose another output directory.

CI runs the same command after installing Chromium and its Linux dependencies.
