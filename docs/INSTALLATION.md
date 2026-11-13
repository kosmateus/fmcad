# Install and migrate fmcad

This guide installs a release package artifact into a consumer project. It
does not publish a package, install Fusion, edit a host configuration, or start
the shared broker. For an artifact release, use the exact `.tgz` supplied by
the release owner; this repository's version is not a promise that a package
has been published to npm.

## Requirements and what is installed

- Node.js **22.13 or later within 22.x**, or **24.x**, and npm. Other Node
  majors are outside the package engine range.
- Local CLI/MCP and offline operations run on Ubuntu 22.04/24.04 x64. Full CAD
  support is for **WSL2 on Windows 11**, with Fusion installed independently on
  Windows. Plain Linux, native Windows/macOS, other distributions and other
  architectures are not supported CAD hosts. WSL must provide
  `WSL_DISTRO_NAME`; WSL path mapping uses `/mnt/<drive>` and `\\wsl$`.
- Python helpers require CPython **3.10–3.12**. Python is selected by an
  explicit setting, `FMCAD_PYTHON`, then `python3`. Fusion's embedded Python is
  separate. Dependencies are a user-managed, optional step: inspect the
  matching requirements file shipped with the package and install it into the
  Python environment selected for that helper. For example, create/activate a
  dedicated venv, then run `python -m pip install -r <installed-requirements-file>`
  for only the helper being enabled. Do not install every optional dependency
  by default. CairoSVG also needs system Cairo. fmcad does not install Python
  packages at runtime. See [runtime paths and requirements](RUNTIME_PATHS.md#python).

The npm artifact contains the CLI, `fmcad-mcp`, JavaScript API, optional
OpenCode plugin, Python workers/resources, Fusion helper scripts and their
requirements, PowerShell UI helper, formatter, and Autodesk editor-definition
snapshot with provenance/notices. It does **not** contain or install Autodesk
Fusion, the Autodesk Fusion MCP add-in, an Autodesk login, or a running broker.
The Autodesk add-in is a separately installed/managed Fusion extension; enable
it in Fusion and configure its local endpoint when ready. Package installation
alone does not start Fusion, the add-in, or any CAD operation.

## Install from npm or a release tarball

From the project that will use fmcad, install the chosen artifact. A release
tarball can be copied into any location; paths below are examples, not required
locations:

```sh
# For a version available in the configured npm registry:
FMCAD_VERSION=0.1.0
npm install "fmcad@$FMCAD_VERSION"
# Or install a supplied artifact directly:
npm install ./vendor/fmcad-release.tgz
npx --no-install fmcad --help
npx --no-install fmcad-mcp --help
```

For a tarball installation, keep the artifact and its release checksum/proof
available so the installed version can be audited. Do not run `npm publish` as
an installation step. Verify the CLI and MCP help first: these commands only
display local metadata and do not need Fusion, a broker, or OpenCode.

The package installs `fmcad` and `fmcad-mcp` executable bins. It uses the
package's installed resources, not the current directory or a source checkout.
No plugin is required for either executable or for `fmcad/api`.

## Changing the physical Fusion backend

Ordinary `queue serve --backend ...` is not reconfiguration. It rejects a
configuration different from the durable identity before reserving Fusion.
For a released `normal-multidocument` epoch, the existing epoch owner can
explicitly switch the physical add-in/MCP endpoint on **the same live Fusion**:

1. Verify no current active, queued, preparing, leased, blocked or unknown work
   remains. Coordinate with other clients, then use the existing authenticated
   idle `queue stop`; do not delete locks or edit `instance.json`.
2. Create a private JSON approval (mode `0600`) with a fresh alphanumeric,
   underscore or hyphen `requestId`, the epoch owner's existing `clientId` and
   `clientToken`, the completed `queue stop` request's `stopRequestId`, and exact
   `previousConfig` and `nextConfig` objects. These are
   the fully loaded broker configurations (`routing: "queue"`, `queue: {}`),
   not partial CLI overrides. Only physical endpoint fields `backend` (`addin`
   ↔ `mcp`), `url`, `headers`, `tool` and `protocolVersion` may differ; connection
   timeouts, transport and local queue/settings must remain exact. Keep
   credentials out of shell arguments and logs.
3. Run `fmcad queue transition-backend --backend mcp --backend-approval
/absolute/private-approval.json --confirm-ownership true` using the matching
   runtime/config. This starts the **same user-global broker/SDK queue**. The
   target endpoint must itself be the physical MCP listener, not an add-in
   proxy. A read-only probe must prove the exact original PID, birth and Fusion
   version, an idle UI and unmodified current documents.
4. The supported stop's durable pause is **preserved**, not silently cleared.
   After checking the listening receipt, the same owner explicitly runs
   `queue resume --request-id NEW_RESUME_ID` before submitting new work.

A paused transition requires the exact accepted owner stop, its terminal
`released` receipt, unchanged control generation and the matching predecessor
runtime. That stop proof is single-use for backend transition. A generic pause,
foreign receipt or unresolved release does not authorize it.

Foreign credentials, changed evidence/configuration and unfinished current
work fail before any physical client or SDK request. Quarantined historical
unknown work remains unknown and is never replayed or accepted by a transition.
Transport uncertainty retains broker ownership and original startup receipts;
inspect those receipts before recovery, never blindly repeat a transition.

The transition writes a separate immutable identity and predecessor evidence
under `physical-backend-transitions/REQUEST_ID`, with an explicit
`physical-backend-head.json`. It does not rewrite root/epoch identities,
receipts or the historical configuration hash. A normal reopen uses that exact
head/runtime; damaged evidence fails closed. To restore the add-in, idle-stop
and repeat the explicit lifecycle with a **new** request ID and reversed exact
configurations. Do not restart Fusion, create a second queue directory, remove
locks, or manually rewrite the head to change backends.

## One standalone MCP server

Add one stdio MCP server named **`fmcad`** to the MCP client you use. This is
the OpenCode-style local MCP config shape; other clients may use a different
envelope, but should launch the same executable once:

```json
{
  "mcp": {
    "fmcad": {
      "type": "local",
      "command": ["npx", "--no-install", "fmcad-mcp"],
      "enabled": true
    }
  }
}
```

Use your host's documented stdio-server syntax if it does not use this shape.
If the host cannot resolve the local npm bin, point `command` at the installed
`fmcad-mcp` executable, using a path appropriate to that machine. MCP stdout is
reserved for protocol messages. OpenCode integration is optional and separate;
see [OpenCode plugin](OPENCODE_PLUGIN.md).

The process can start and list its local tool catalog without Fusion or a
broker. An SDK operation needs a project directory and a pinned target document
(document name plus available creation/file identity) in its invocation. For
example, an MCP call supplies `context.projectDirectory`, `context.doc`,
`context.docId` and/or `context.docFileId` as appropriate, and a meaningful
`purpose`; see [MCP application examples](MCP_APPLICATION.md#structured-execution-and-help).
Alternatively set `FMCAD_PROJECT_DIRECTORY` or pass
`--project-directory PATH`. MCP roots are hints, not an implicit project
selection; multiple roots require an explicit project. Never use the package
directory as the project.

`--client OWNER-ID` or `FMCAD_CLIENT` selects a stable owner identity across
restarts; `clientInfo` is display metadata, not identity. Keep the client owner
stable to look up its requests. A request is admitted to the shared broker
queue only after validation and returns a receipt/job ID. Poll the owned result
with `fmcad_queue_result` / `fmcad_queue_request`, or reconcile an uncertain
job with `fmcad_queue_reconcile`. `accepted`, `running`, and `unknown` are not
proof of completed CAD work. After a timeout, lost reply, or disconnect, look
up the same request/job and reconcile its state; do **not** replay the
operation. Disconnecting an MCP client stops its local wait, not the broker,
Fusion, or already accepted CAD work. See the [MCP lifecycle contract](MCP_APPLICATION.md#broker-receipts-and-compatibility).

Queue pause blocks or controls admission according to broker state; it is not a
remote stop button and cannot freeze an SDK call already executing in Fusion.
An uncertain operation remains `unknown` until its owned result is observed or
reconciled; pause, timeout, and disconnect do not turn it into failure or
authorize a retry.

The public `direct` route has been removed. `routing: "direct"` and
`FMCAD_ROUTING=direct` are rejected; there is no direct fallback. `queue` is
the only routing mode; an old `routing: "queue"` setting remains accepted but
is redundant and may be removed by the user. Some hosts may still display old
`fusion` and `fusion_addin` aliases. They were aliases for one application and
physical backend, not separate servers. Remove duplicate entries yourself
after checking their settings and permissions; fmcad does not edit host config
or silently migrate it. Changing an entry's display name does not create a new
backend.

## Configuration, storage, and migration

Fmcad's config is separate from the MCP host config. By default it reads
`$XDG_CONFIG_HOME/fmcad/config.json` or `~/.config/fmcad/config.json`; `FMCAD_CONFIG`
or an explicit CLI `--config` can select another file. It does not read
OpenCode config during ordinary startup. `fmcad init --from-opencode` is an
explicit migration command: it validates and writes fmcad's own config, never
rewrites the source host file, and requires `--force` before replacing an
existing fmcad config. Review the result before using it. See
[configuration precedence and schema](CONFIGURATION.md).

The standard XDG locations are used for user config, state, cache, and data;
project-owned results live under the explicitly selected project's `.cad/results`.
Temporary diagnostics use a private, permission-restricted OS temp directory.
Treat config and credentials as private. Do not put tokens in examples, URLs,
project files, or shared logs. Installed package resources are inputs and are
not writable state.

Autodesk cloud features still require the relevant Autodesk account,
authorization, product entitlement, network access, and Fusion behavior. A
locally running MCP or add-in does not grant cloud authorization, and no
offline-cloud capability is promised.

## Safe updates and support boundary

Choose and review an exact release before updating. Back up fmcad config and
important project results; install the selected npm package/tarball using your
normal package-manager workflow, then verify both `--help` commands and the
installed MCP tool catalog. Do not replace files under an active broker or
restart a shared service as an update shortcut: executable identity fencing
can report `BUILD_CHANGED`. Coordinate broker lifecycle with its owner and
reconcile outstanding requests before any authorized restart. Updating does
not authorize a CAD operation.

Offline installed-artifact tests validate packaging, local CLI/MCP startup,
catalog schemas, and bounded local workers; they do not validate a physical
Fusion model. A CAD smoke test is separate and should be performed only after
explicit authorization, with the add-in and compatible broker available and a
noncritical, explicitly pinned test document.

### Console entrypoints

`fmcad console [--config PATH] [--project PATH]` prints the Control Center URL
once the configured service is ready. `diagnostic` and `--web` remain compatibility
aliases. No interactive terminal is required and no browser opens automatically.
Without `--project`, the URL selects the global view. An explicit path must resolve
to exactly one registered Control Center project; an arbitrary artifact directory
is not a substitute.

Closing this command releases only caller resources. The shared service continues
running and broker state is unchanged. Broker inspection, stop, restart and reload
remain explicit administrative CLI commands with their existing ownership checks.

Useful references: [package README](../README.md), [runtime/platform support](RUNTIME_PATHS.md),
[CLI command reference](COMMAND_REFERENCE.md), [MCP application](MCP_APPLICATION.md),
[OpenCode plugin](OPENCODE_PLUGIN.md), and [notices](../NOTICE.md).
