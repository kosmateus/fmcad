# Terminal retirement acceptance ledger

The browser replaces the terminal presentation, not its broker policy, evidence
readers or operational assertions. This inventory is a deletion gate, not a claim
that retirement is complete. Keychain is excluded. Modeling delivery does not
wait for this ledger.

## Behavior and ownership

| Existing surface | Replacement or retained owner | Acceptance before deletion |
| --- | --- | --- |
| `console` / `diagnostic`, config and project selection | E public launcher calling F `openControlCenter` | Installed CLI: both aliases, explicit config/project, non-TTY URL, safe browser argv, shared authenticated service, no broker auto-start |
| Overview, tasks, logs, agents, System tabs | Typed Control Center app and query contracts | Production SQLite Chromium run; empty/missing/partial states; identity-preserving navigation; console/network evidence |
| Search, filters, sorting, reset, frozen views and refresh | Query snapshot tokens plus browser controller | Filter reset preserves other view state; stale responses cannot replace a newer scope/filter; freeze is presentation-only |
| Correlated task/agent/log navigation | Typed read model and browser detail queries | Preserve document, request, job, session and agent identity; historical agents remain after live presence disappears |
| Bounded JSONL/text export with explicit overwrite | Browser snapshot CSV/JSON download | Consistent selected snapshot and filters; browser owns destination/overwrite; document deliberate format change, no source writes |
| Source and response previews | Owned bounded artifact reader and browser modal | Exact retained bytes/hash/provenance, project ownership, invalid UTF-8, missing/oversize/non-regular inputs, malformed JSON text, no source execution |
| Python in-memory formatter and terminal syntax coloring | Original-byte browser preview | Deliberate presentation retirement; no formatting subprocess required to inspect an artifact; retain reader/security assertions |
| Pause/drain/resume and guarded stopped start | F System adapter consuming A contracts | Real broker fixture, receipts, fresh generation fences, uncertain outcome observed without replay, no automatic physical probe |
| Inspect/stop/restart/reload terminal administration | A/E retained administrative interfaces | Explicit supported-command mapping or retirement decision required; do not invent a second HTTP restart implementation |
| Console mouse/cell painting, terminal layout and scrolling | Browser responsive/accessibility controls | Chromium desktop/mobile, keyboard/modal navigation and 25 locales; terminal cell-size assertions retire only after replacement acceptance |
| Demo data and static presentation | Isolated browser test fixture | No fixture injected into production composition; production tests use registered SQLite histories |
| Project monitoring/archive and alias | Registry/SQLite actions | Alias/restore verified; archive now uses the shared SQLite admission/presence fence with live owner and full-state proofs; legacy/unqualified sources remain unavailable |

## Test disposition

| Existing tests | Preserve or migrate | Presentation-only assertions |
| --- | --- | --- |
| `console-bounded-read`, `console-read-model`, `console-read-port`, `console-telemetry`, `console-metrics`, `console-snapshot-readers`, `console-data`, `console-offline`, `console-pause`, `console-services` | Keep domain, reader, control and lifecycle assertions | None removed wholesale |
| `console-interface` | Locale/config precedence, purpose parsing/persistence, bounded sanitized export, fresh broker fences and no replay | Terminal render sizes and terminal navigation move to Chromium |
| `console-filters`, `console-visual-models` | Reset/search/sort/freeze isolation, missing outcomes and navigation identities | Terminal dimensions/paint move to Chromium |
| `console-components`, `console-document`, `console-details` | Correlation, absent-vs-zero, document identity/fallback, refresh pinning | Mouse/cell rendering and scrolling retire with their UI |
| `console-source`, `console-response` | Read-only bytes, hashes, ownership, bounds, malformed data, no execution | Optional Python formatting, terminal colors, terminal modal scrolling retire explicitly |
| `console-task-events`, `client-presence` | Historical events, correlation and measured-presence semantics | Remove terminal-kit imports only after expressing the same domain expectations directly |
| `console-bootstrap`, `mcp-installed-package` | Replace bootstrap contract with installed browser launcher behavior | Non-TTY rejection and terminal-kit installation assertion become obsolete only after E/G integration |
| `verify-console`, `console-visual-evidence` scripts | Replace evidence entry point with production Chromium artifacts | Terminal screenshots and dimensions retired after browser evidence |

## Source dependency boundary

Pure terminal presentation candidates are `console-app`, `console-chrome`,
`console-renderer`, `console-view`, `console-ui`, `console-pointer`, `console-theme`,
`console-detail-view`, `console-source-view`, `console-response-view`, and
`console-tabs/*`. Keep `console-services`, lock observations, typed log/task-event/
system readers, artifact readers and their guards until their shared callers are
migrated. Do not remove dependencies merely because their filenames say console.

The shared observation/fencing class has been extracted into typed
`node-adapters/control-center/broker-observation.ts`. The System composition now
imports it directly, without importing the legacy ConsoleModel, export helper or
terminal presentation. The terminal controller temporarily re-exports the same
behavior for existing callers. This preserves registration with `autoStart:false`,
fresh reads and exactly one mutation attempt; it adds no broker policy.

## Outstanding evidence

PR #41 has passed full CI and Chromium and is merged. Richer operational views,
Unicode fonts and retention are in #60/#69/#74, with their own CI still pending.
Producer runtime integration is #77; default MCP hookup remains with E. No native
Fusion UI, macOS/Windows opener or WSL desktop qualification has been performed
in this host. Those results must be recorded separately rather than inferred
from simulator or Linux Chromium success.


## Continuation decisions (9 November 2026)

E and F agreed to make the web launcher the default while retaining `--web` as a
compatibility alias. Browser System remains limited to pause/drain/resume and
fenced stopped start. CLI inspect/stop/restart/reload retain their administrative
owner and are not duplicated in HTTP. The Python formatter, terminal semantic
coloring, cell/mouse hit regions and PTY rendering are deliberately retired
presentation behavior once the browser gate passes; artifact bytes, ownership,
hashes and non-execution guarantees remain mandatory.

`console-task-events` and `client-presence` no longer need ScreenBuffer or
terminal-kit for their historical/measured-presence assertions. `identityCounts`
is outside the terminal agents renderer and shared by the existing renderer
until deletion. No assertion about stale, missing or unconfirmed processes has
been relaxed.

The production browser suite now contains a dedicated authenticated lifecycle
case, using installed assets and the same QueueClient/IPC/receipt adapter as the
HTTP regression. It verifies no mutation or physical probe on opening System,
a disabled start while the broker is running, and one mutation POST plus the
original durable receipt for each of pause, resume and drain. The supervisor's
single resume probe is explicitly simulated: native Fusion qualification is a
separate final acceptance gate.

The historical public-help oracle still imports terminal-kit. After runtime
imports are removed, G should retain that package as a development-only
dependency while the frozen baseline comparison needs it. Removing a runtime
dependency does not justify deleting a useful baseline oracle.


## Prepared retirement candidate

The isolated retirement candidate removes all terminal paint modules listed in
this ledger, the five terminal tabs, the PTY smoke and the ScreenBuffer evidence
script. `scripts/verify-console.js` now runs the production Chromium evidence
suite; `npm run test:control-center:e2e` is the full build/typecheck invocation.
E's default web launcher and standalone help formatter are prerequisites. The
frozen historical help oracle now has attributed source fixtures independent of
the npm package, so terminal-kit can be removed entirely by G after integration.

Eleven presentation-only test cases retire with their implementation: two
ScreenBuffer/table/mouse cases in `console-components`, one terminal render-size
case each in `console-interface`, `console-filters`, `console-visual-models` and
`console-document`, two wrapping/modal-paint cases in `console-details`, two
cell-width/source-line scrolling cases in `console-source`, and one response
modal/mouse case. Their replacements are the browser suite's desktop/mobile
layout, filters/reset, frozen refresh, keyboard/dialog, artifact text and response
selection cases. PTY alternate-screen/signal restoration no longer describes a
browser launcher; E's non-TTY launcher lifecycle tests replace that boundary.

All remaining cases in those suites retain their domain assertions. Details use
a text-only label/format context rather than a terminal screen. Unknown outcome
groups, recorded intervals and confirmed timestamp statistics now execute typed
core summaries. Source/response read-only bytes, hashes, malformed data, ownership,
bounds and no-execution checks remain. Locale precedence, purpose retention,
sanitation/export overwrite and broker freshness/no-replay tests are retained.

Focused local result after candidate preparation: 28 tests, 26 pass, two existing
optional formatter-library skips, no failures. CI browser acceptance, complete
package build and dependency removal remain final integration gates; this local
result does not qualify native Fusion or claim a successful Chromium run.


The 2026-11-09 continuation moves the retained domain suites to strict TypeScript
and completes production archive fencing. See F_UI_LEDGER.md for the current
reader, real broker IPC and competing-process evidence. Browser snapshot expiry
now refreshes the selected table filter once; translated copy/navigation actions
retain independent semantic assertions. Terminal paint assertions remain retired
according to the mapping above; no artifact ownership, response identity, read
bound, false/zero, unknown outcome or no-replay assertion was removed.
