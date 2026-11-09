# Shared operation catalog

`packages/core/src/catalog` is the strict, host-independent implementation of
operation contracts. `src/catalog/index.js` composes the retained JSON and family
declarations and their existing specialist validators. It does not import CAD
execution, load configuration, connect to a backend, or probe Fusion.

The catalog owns the runtime outer-object schema, required/unknown input checks,
CLI canonical names and aliases, service mapping, requirements, and the MCP
projection. `src/cad.js` uses its **same** `validateCad` function and service
mapping; CLI/help/reference use the projected command contracts. There is no
parallel host-specific CAD validator. Family validators remain in their existing
modules and run as the common specialist chain after the outer schema. Declaration
prose is not parsed into a new schema language. Nested fields that were previously
validated only inside Python remain SDK-side validation, not fictional JSON Schema
guarantees. Preview still does not prove entity resolution or geometry feasibility.

`src/catalog` exports `catalog`, `contracts`, `validateCad`, `cliContracts`,
`mcpTools`, `byMcpName` and `mcpInvocation`. Internal primitives (currently
`document.save_native`) are excluded from CLI and MCP discovery. Existing legacy
routes remain registered by `src/commands.js`; they reserve spellings before CAD
projection, so collisions retain the existing `cad ...` prefix. No keychain
workflow is restored.

All 463 retained CLI routes (including legacy, local and family routes) use core's
`indexCommandRoutes` for longest-route lookup and duplicate-alias detection. CAD
schema validation is separately shared across the 306 CAD declarations, with
305 public operations and one internal primitive at this migration boundary.
`geometry.delta` and `geometry.compare-region` are public Python CAD commands;
their finite-solid inputs receive specialist validation in
`src/catalog/regional-geometry.js` and their canonical runtime registration is
manifest-owned. The public `FmcadServices.execute` overload exposes typed
regional inputs while preserving the ordinary queued CAD execution path.

## MCP integration boundary

The pure `projectMcpTools` projection exports one `fmcad_cad_*` tool per public CAD
operation, with `data`, document pins, component, purpose and preview in its input
envelope. `data` uses the exact catalog schema, not a physical backend's raw tool
schema. Backend raw tools and queue helper tools are separate namespaces, not
alternative implementations of CAD validation.

The strict local MCP adapter serves initialize, ping, help and `tools/list` from
this local catalog (plus queue helpers and explicit deprecated compatibility
adapters), without configuration or a backend metadata/SDK call. Native
`fmcad_execute` accepts operation/data/context objects and uses the same public
typed API as other clients. Explicit supported raw tool requests use the broker;
optional resource catalogs retain the physical discovery control plane. There is
no mutual server proxy or direct SDK route. See [MCP_APPLICATION.md](MCP_APPLICATION.md).

`mcpInvocation(name, arguments)` performs envelope checks and shared CAD validation,
returning a versioned `CatalogInvocation`. Shared `executeInvocation` invokes
`executeCad` without CLI parsing. Local/preview operations run without constructing
a backend or registering with the broker. SDK operations use existing command jobs,
carrying the typed invocation as retained admission payload. The existing phased
worker executes that DTO through its broker-capability backend; it never invokes
`cli.main` for catalog jobs. Existing broker admission, pin checks, sequence leases,
purpose, timeout/uncertain-result behavior and receipt ownership remain in force.
Compatibility argv contains **only guard metadata** for the existing broker's
route/document selectors. The worker checks exact equality with the projection
of the DTO before any SDK request, preventing a different document/operation from
being executed under those guards. It does not parse those words for execution.

Large catalog results use the same `readOwnedResult` adapter as raw RPC results:
the job, project scope, artifact name, size and hash must match; caller-advertised
paths never authorize reads. An accepted or unknown job is not resubmitted. Neither
discovery nor these offline transport tests establish live execution or geometry.

## Requirements and evidence

Contracts distinguish local services, host coordinators and Python handlers.
SDK requirements are none, required or conditional (for data-import preflight).
`document` preserves existing invocation requirements; purpose is optional.
Cloud requirements are none for known local execution, required for cloud-save
publication, conditional for externalization/reference refresh, and otherwise
explicitly unknown. `cloudAccess: not-implied` never asserts an authenticated
session, network reachability or Autodesk permission from catalog discovery.
Backend restrictions include addin-only UI and atomic reconciliation/finalization.
Atomic batch execution additionally requires addin when `atomic` is omitted/true;
explicit `atomic:false` retains the existing non-atomic route. Conditional workflow
requirements and cloud permission checks remain enforced by their coordinators.

`readOnlyRequested` is a declaration, **not** enforcement. `readOnlyEnforced` is
false: no host sandbox is promised. A read-only hint, available capability,
successful receipt or passing offline contract test is not evidence of geometric
correctness, physical safety, Autodesk authorization or cloud durability.

## Verification

- `npm run build:code`, `npm run typecheck:tests`, `npm run lint`.
- `node --test dist/tests/command-catalog.test.js tests/cad.test.js tests/registry.test.js`:
  projection parity, aliases, negative schema/specialist cases, local execution,
  missing services, malformed declarations, and executable Python registry parity
  (including duplicate-handler detection with mocked `adsk`).
- `node scripts/generate-help-audit.js [--check]`: retained reference and coverage
  come from the same commands and detailed help. No SDK access is needed.
- `node --test tests/mcp-catalog.test.js tests/catalog-worker.test.js tests/mcp-stdio.test.js
  tests/mcp-stdio-queue-lifecycle.test.js`: actual local discovery, typed input,
  negative envelopes, purpose/pins, owned artifacts and real phased-worker dispatch
  against an offline backend fixture; the worker test rejects CLI-parser imports.

These are offline checks. They do not exercise live Fusion or certify a CAD model.
