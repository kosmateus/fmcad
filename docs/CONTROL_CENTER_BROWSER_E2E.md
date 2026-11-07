# Control Center browser E2E

The TypeScript (`.mts`) browser E2E starts the production Control Center bundle
on an
isolated loopback HTTP server and drives it in headless Chromium. Its synthetic
records are currently supplied through the public Console Query read port;
HTTP session/CSRF, query, filter, detail, export and SSE handling use the
production server and query implementation. The injected read port is a test
adapter, not proof of the production SQLite/registry/runtime composition. The
fixture does not connect to Fusion or use user data.

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
