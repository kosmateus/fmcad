# fmcad configuration

fmcad reads its own configuration and works without OpenCode. Ordinary startup
does not search for or read `opencode.json`/`opencode.jsonc`. The only OpenCode
read is the explicit, one-way `fmcad init --from-opencode` migration.

## Sources and precedence

Configuration values resolve in this order:

1. Explicit adapter settings (CLI settings or options passed by a plugin).
2. `FMCAD_*` environment settings.
3. The selected fmcad JSON/JSONC file: `--config`, then `FMCAD_CONFIG`, then
   `$XDG_CONFIG_HOME/fmcad/config.json` or `~/.config/fmcad/config.json`.
4. Safe product defaults.

An explicit `--config` path selects a file; it does not merge the default user
file. Relative `--config` paths are relative to the command's working directory.
`FMCAD_CONFIG` likewise selects the file to read, but a relative value is
resolved against `$XDG_CONFIG_HOME` or `~/.config`, so MCP and CLI clients use
the same file regardless of working directory. Environment values override
values in the selected file.

## JSONC shape

```jsonc
{
  "backend": "addin",
  "routing": "queue",
  "backends": {
    "addin": {
      "url": "http://127.0.0.1:8765/mcp",
      "timeoutMs": 180000,
      "tool": "execute_python",
      "transport": "node",
      "headers": {},
    },
    "mcp": {
      "url": "https://mcp.example.invalid/mcp",
      "headers": { "Authorization": "Bearer replace-me" },
    },
  },
  "controlCenter": { "port": 4748 },
  "queue": { "autoStart": true, "autoRecover": true },
}
```

Comments and trailing commas are supported. Unknown file keys, malformed values,
conflicting field aliases, and invalid ports fail before transport or SDK
admission. `routing` is fixed to `queue`; `direct` is not a configuration choice.
The `mcp` backend has no built-in URL and must be configured explicitly. Its
legacy top-level `url`, `headers`, `timeoutMs`, `tool`, `transport`,
`curlPath`, and `protocolVersion` values are accepted only when `backend` is
`mcp`. They are never inherited by `addin`.

`backend` is `addin` or `mcp`. Each `backends.<backend>` block accepts `url`
(`endpoint` alias), `headers`, `timeoutMs` (`timeout` alias), `tool`,
`transport`, `curlPath` (`curl-path` alias), and `protocolVersion`
(`protocol_version` alias). Headers are case-insensitively merged from the
legacy MCP block, selected backend block, environment, and explicit adapter
settings. A header value may contain credentials; keep the file private and do
not copy runtime config objects into public DTOs, logs, history, or URLs.

URLs must be absolute HTTP(S) URLs without embedded credentials or secret query
parameters. Use authentication headers instead. The `addin` endpoint must use a
loopback host. A loopback URL on the Control Center port is rejected so fmcad
cannot mistake its own panel for the Fusion add-in. `windows-curl` also requires
a loopback endpoint.

## Defaults and shared service port

With no config file or override, fmcad selects `backend: "addin"`,
`http://127.0.0.1:8765/mcp`, no inherited headers, `execute_python`, and
`routing: "queue"`. On WSL, the Node adapter selects the existing Windows
loopback curl transport and its standard executable path. The default does not
contact a private or repository-author server. If the add-in is unavailable,
enable/configure the Autodesk Fusion MCP add-in at the configured local URL; to
use another MCP server, select `backend: "mcp"` and configure its URL.

`controlCenter.port` is an integer from `1` through `65535`, default `4748`.
CLI, MCP, and plugin options use the same field. Environment override:
`FMCAD_CONTROL_CENTER_PORT`. Different explicit port settings across adapter,
environment, and config sources are a conflict; a new client does not select an
alternate port or switch an existing service.

After a lifecycle has positively verified the identity/protocol/build of its
own Control Center service, it may persist the accepted port through
`writeAcceptedServiceConfiguration({ version: 1, controlCenter: { port } })`.
The private record lives at
`$XDG_STATE_HOME/fmcad/control-center/accepted-service.json` (or
`~/.local/state/fmcad/control-center/accepted-service.json`). When a client has
no explicit port, this last verified value is used before `4748`. It is not a
port scan or discovery of arbitrary listeners. A conflicting explicit port
fails; a corrupt record is not silently ignored.

The broker also rejects a queued request whose selected physical backend differs
from its configured backend (`BACKEND_MISMATCH`). All MCP/add-in work remains
behind the broker; this configuration has no direct transport mode. An existing
`routing: "direct"` value is rejected with an explicit migration error; change
it deliberately to `routing: "queue"` or remove the redundant setting. No
automatic rewrite or direct fallback occurs.

## Environment variables

| Variable                             | Setting                                                  |
| ------------------------------------ | -------------------------------------------------------- |
| `FMCAD_CONFIG`                       | Select a fmcad config file; `--config` takes precedence. |
| `FMCAD_BACKEND`                      | `mcp` or `addin`.                                        |
| `FMCAD_URL` / `FMCAD_ENDPOINT`       | Selected backend endpoint.                               |
| `FMCAD_HEADERS`                      | JSON object of header names and string values.           |
| `FMCAD_TIMEOUT_MS` / `FMCAD_TIMEOUT` | Positive request timeout in milliseconds.                |
| `FMCAD_TOOL`                         | MCP tool name.                                           |
| `FMCAD_TRANSPORT`                    | `node` or `windows-curl`.                                |
| `FMCAD_CURL_PATH`                    | Executable path for `windows-curl`.                      |
| `FMCAD_PROTOCOL_VERSION`             | MCP protocol version.                                    |
| `FMCAD_ROUTING`                      | Only `queue` is accepted.                                |
| `FMCAD_CONTROL_CENTER_PORT`          | Shared Control Center port.                              |
| `FMCAD_QUEUE_AUTO_START`             | `true` or `false`.                                       |
| `FMCAD_QUEUE_AUTO_RECOVER`           | `true` or `false`.                                       |
| `FMCAD_QUEUE_STARTUP_TIMEOUT_MS`     | Positive startup timeout, at most `600000`.              |
| `FMCAD_QUEUE_WAIT_TIMEOUT_MS`        | Positive safe-integer queue wait timeout.                |
| `FMCAD_QUEUE_CLIENT`                 | Queue client label.                                      |

Invalid values are rejected locally, without probing Fusion or invoking an SDK.
Diagnostics report parse locations rather than snippets and redact configured
headers and URL credentials.

## Explicit migration from OpenCode

`fmcad init --from-opencode` reads the first matching user file in this order:
`~/.opencode/opencode.jsonc`, `~/.opencode/opencode.json`,
`~/.config/opencode/opencode.jsonc`, `~/.config/opencode/opencode.json`. It
recognizes the legacy `mcp.fusion` block and `mcp.servers.fusion`, `url` and
`endpoint`, `timeout` and `timeoutMs`, and explicit HTTP transport aliases.
Remote `remote`/`http`/`https`/`sse`/`node` entries map to Node HTTP;
`curl` maps to `windows-curl`. Local command/stdio MCP entries are rejected;
they are not treated as remote Fusion endpoints. The importer validates and
writes only fmcad config, never modifies the OpenCode file, and requires
`--force` to replace an existing fmcad config. Without this explicit command,
OpenCode configuration is not read.
