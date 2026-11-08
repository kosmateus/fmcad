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
| Project monitoring/archive and alias | Registry/SQLite actions | Alias/restore verified; archive remains unavailable until A provides shared activity fencing, never inferred from idle telemetry |

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
