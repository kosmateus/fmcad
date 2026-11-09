import type { CommandManual } from "./library-help-manual";
const guide: CommandManual = {
  sections: [
    {
      title: "Help And Discovery",
      text: `fmcad help, no arguments, --help and -h print only the command listing. fmcad help <command> [subcommand...] and <command> --help/-h print detailed input/output contracts, examples and limits offline. fmcad help help is this shared guide. Group help lists exact child commands; aliases use their canonical command's help. Help lookup uses the longest registered prefix, so misspelled trailing words can fall back to group/parent help; check the Help: heading.
For installed raw tool schemas use fmcad tools --json (real metadata call). For offline operation/helper search and the catalog-backed cookbook use fmcad capabilities inspect --data '{"query":"interference"}'; this does not load config or probe Fusion. A native capability probe is a separate explicit fmcad capabilities probe call with --doc plus --doc-id or --doc-file-id; it requires the broker probe port and is never triggered by help, inspect or tool listing. For model IDs/refs use entity list/find/inspect, sketch inspect, doc list/search and material/appearance list as described by each command. Opaque example tokens are not real IDs. Group help and all supplemental manuals are bundled into the CLI; no source-code access is required. docs/COMMAND_REFERENCE.md is the generated offline reference; docs/COMMAND_COVERAGE.md records audit evidence and known implementation defects.`,
    },
    {
      title: "CLI Grammar And JSON",
      text: `Use space-separated flags, never --key=value. There is no end-of-options -- sentinel. Only -h and run -l are short aliases; short-flag bundling is unsupported. Global flags are removed wherever they occur in argv, before command parsing; avoid using standalone global-flag strings as positional values. Repeated scalar/global flags take the last value. Repeated --header keys overwrite that exact key.
Legacy commands use positional strings and listed flags; switches such as --save, --discard, --readonly, --force take NO value. Do not append true/false to these. Many legacy op parsers permit excess positional arguments but handlers ignore them or misinterpret a document slot: supply only the documented exact positions. Empty positional strings are accepted, while legacy value flags reject empty values and values beginning -- or -<letter>. Signed numeric expressions such as '-10 mm' remain valid positional values.
CAD commands take --data '<JSON object>' OR --file <CLI-local JSON path>, not both or repeated payloads. Optional direct --kebab-case value flags merge into payload; duplicates against payload keys fail, repeated direct flags currently take the last value. Direct values try JSON.parse first: true/false/null, numbers, arrays and objects become their actual JSON types; unparseable text stays a string. To force a numeric-looking string, supply a JSON string value (for example --name '\"123\"') or --data. --component/--doc/--project-id are unparsed context strings; --input-component is the supported payload component field. CAD direct flags can accept actual empty strings, e.g. --folder ''. Boolean inputs still require explicit true/false, even --confirm true. --json and --preview alone are switches.
Shell examples use POSIX quoting. Windows PowerShell/cmd have different quoting rules; use --file for complex CAD JSON. JSON files must contain a JSON object, not comments/JSONC or a list. --file is a local read, not a Fusion upload and not stdin ('-' is treated as a filename). No automatic tilde/environment expansion occurs inside JSON strings; the shell may expand unquoted command paths.`,
    },
    {
      title: "Global Flags",
      text: `--config <path>: explicit local fmcad JSON/JSONC configuration file. --url <HTTP(S) endpoint>: connection override for the selected backend. --header 'Name:Value': repeatable header, split at first colon (empty value allowed; nonempty name required). Do not expose credentials in examples or shell history. --timeout <milliseconds>: finite positive number when connecting, default 180000; represents a timeout, not a mutation cancellation guarantee.
--backend <mcp|addin>: exact lower-case selector, default addin. --transport <node|windows-curl>: exact selector. --curl-path <executable>: path used only by windows-curl. --routing accepts only queue; direct transport is not a client option. There is no --tool or --protocol-version CLI flag; those are config-only fields. Timeout applies to each HTTP request, not the whole batch; a timeout does not cancel work already started in Fusion.
Unknown global options are not silently supported. Config/backend validity is checked when loaded; help, run --list, and CAD offline previews do not load connection config. A syntactically invalid known global flag (e.g. missing --url value) still fails before help. No automatic retry, backend fallback, saved session reuse between CLI processes or model rollback.`,
    },
    {
      title: "Configuration Schema And Precedence",
      text: `Configuration is a strict JSON/JSONC object with backend, routing, controlCenter:{port}, queue, and backends:{mcp:{...connection fields...},addin:{...connection fields...}}. Comments and trailing commas are supported; unknown keys and invalid values fail locally. Precedence is explicit adapter settings > FMCAD_* environment > selected config file > safe defaults. File priority is --config, FMCAD_CONFIG, then $XDG_CONFIG_HOME/fmcad/config.json or ~/.config/fmcad/config.json; these paths are alternatives, not merged files. FMCAD_BACKEND selects a backend and other FMCAD_* values override selected-file values. Environment values override the selected file. Backend default is addin; mcp has no built-in endpoint and requires explicit url/endpoint configuration. Legacy top-level connection fields apply to mcp only. Headers merge case-insensitively; secrets belong in headers, never URLs or public DTO/history.
Safe addin default: http://127.0.0.1:8765/mcp, empty headers, timeoutMs 180000, tool execute_python, protocolVersion 2025-06-18. On Linux with WSL_DISTRO_NAME set, transport windows-curl and curlPath /mnt/c/Windows/System32/curl.exe; otherwise node. Addin URLs are loopback-only. URL credentials, secret query parameters, and the fmcad Control Center endpoint are rejected. All MCP/addin transports use queue routing; direct is not configurable.
controlCenter.port defaults to integer 4748 and is shared by CLI, MCP, and plugin options. FMCAD_CONTROL_CENTER_PORT is its environment override. Divergent explicit settings fail; when no port is explicit, the last verified fmcad service port is used before 4748. There is no free-port scan or alternate server fallback.
Ordinary loading reads only fmcad configuration and never reads OpenCode. Explicit init --from-opencode reads, never edits, the first supported file in ~/.opencode/opencode.jsonc, ~/.opencode/opencode.json, ~/.config/opencode/opencode.jsonc, ~/.config/opencode/opencode.json. It imports only remote HTTP(S) Fusion MCP configuration, recognizes url/endpoint and timeout/timeoutMs aliases, and rejects local command/stdio MCP. --force overwrites fmcad config only. See docs/CONFIGURATION.md for exact schema, environment variables, port discovery, and migration contract.`,
    },
    {
      title: "Backend And Transport Boundaries",
      text: `mcp sends tool requests to the configured service. It is not proof that the endpoint is the official Autodesk service or that every raw tool enforces a sandbox. CAD readOnly flags and run --readonly are declarations sent to that server; actual enforcement belongs to the installed server. Legacy script operations generally omit readOnly, even for inspection. Arbitrary raw calls do not gain document scoping or confirmation automatically.
addin targets the independent Frank Hommers AutodeskFusionMCP, not Autodesk's official service. It executes adapted scripts via execute_python with persistent:false and invokes run(\"\"). For mutating adapted scripts it rejects active commands other than empty/SelectCommand before the script starts. This is an idle-command guard, not a sandbox, lock or rollback. readOnly scripts bypass that guard and are not write-protected. No automatic mutation retry or fallback.
addin bridges projects, document open/search/list/save/close and partial active-command inspection; screenshot and API documentation map to native add-in tools. API documentation filter is unsupported there; categories class/member/description/all map to its metadata search. Active-command output has ID only, not the official full input schema. licensing, recent documents, undo/redo and electronics are unsupported: select mcp explicitly. Addin save requires an existing save target; close --save explicitly saves/checks modified state before closing. Extra raw non-bridge tool names go straight to the selected add-in.
node uses Node HTTP(S) from the CLI host; the existing timeout is a total per-request deadline, including a continuously streaming response. It cancels the local request, not Fusion execution: outcome is unknown and inspection is required before retry. windows-curl is an explicit Windows-loopback bridge, limited to HTTP(S) localhost/127.0.0.1/[::1], not LAN URLs. It bypasses proxy and ambient curl startup config, does not follow redirects or retry, and uses only generated stdin config for URL/headers and literal JSON data-binary, keeping request secrets out of argv. Curl transmits the original UTF-8 JSON bytes. It enforces total process/curl time plus a combined stdout/stderr cap of 32 MiB. Timeout must be <=2147483647 ms for this transport. Failures may occur after execution; inspect before retry. TLS trust follows the selected HTTP/curl environment, not a --insecure option.`,
    },
    {
      title: "Documents, Units And Failure",
      text: `CAD --doc means EXACT case-sensitive unique OPEN document name, never a file ID or fuzzy cloud search. --project-id optionally filters saved documents by exact project ID. Default component is root; --component chooses a name or occurrence full path, not JSON. References in payload may carry token/kind/component/occurrence as documented by entity inspect. CAD wrappers generally activate the target for mutations, except commands that explicitly require it already active; reads do not activate. Every command's own scope/prerequisites still apply.
Legacy --doc operations require one case-insensitive open-document name match; ambiguous names fail before activation. doc save/close/undo/redo/shot and arbitrary scripts/raw calls have their separately documented active-document behavior. No command silently saves the model as a side effect of ordinary CAD modeling.
Dimensioned CAD inputs normally require strings with explicit units or dimensional parameter references; counts/vectors and restore-state internal units are exceptions documented per command. Coordinates evaluated to doubles are NOT necessarily driving expressions. Raw core geometry uses cm/rad; measurements expose explicit chosen units. Do not infer units from the UI.
CAD output is pretty JSON by default, compact with --json. Executed non-Node operations return {success,operation,document,result,created}; result is the handler contract, created contains available created refs. --preview returns an offline input-validated-only record, not geometry. Generic operations check only outer keys and unconditional required-key presence; designated specialist previews also validate their documented nested input constraints but still do not resolve native refs or run the kernel. Batch validate/preview adds step/ref/parameter structure checks but does not prove native geometry. An offline success never establishes solver, geometry or physical validity. Batches have report/validation schemas, not the normal execution envelope. Legacy output is unescaped text and native tool formatting, not universally machine-safe JSON. Success/ERROR detection is conservative but not complete: inspect native health, passed/restored/status fields and per-command caveats. Errors/timeouts can leave partial geometry, files, assignments or accepted saves; no general rollback/retry/cancellation guarantee exists. The executable exits 0 on a broken stdout pipe (EPIPE); an early-closing output consumer is not proof of operation success. Retain full mutation output/reports rather than truncating a running command's output.`,
    },
    {
      title: "Paths And Saves",
      text: `CAD --file and batch reportPath are on the CLI host; reportPath is a directory. CAD export/import/checkpoint/shot pack/motion frame path fields are mapped to the Fusion host: relative paths resolve from CLI cwd, /mnt/c/... -> C:\\..., Windows drive/UNC paths pass through; other Linux paths -> \\\\wsl$\\<WSL_DISTRO_NAME or Ubuntu>\\...; macOS/Windows retain native absolute paths. Ensure that Fusion actually sees these locations. Parents usually must exist; command-specific overwrite rules apply.
Legacy export/file_download resolves relative output against invocation cwd and preserves Windows-native/UNC strings. WSL mapping uses the actual detected distribution; ordinary Linux has no Windows path mapping. Legacy shot writes decoded bytes locally and overwrites without confirmation. Legacy upload resolves its WSL input path then asks Fusion to upload from the mapped path. Cloud project/folder paths are logical names, never filesystem paths.
Cloud save-as requires an explicit existing project/folder and confirm:true, forbids overwrites, and can change open-document identity for a copy. accepted/pending is not durable completion; use doc status and compare actual file identity/target fields. Export/checkpoint does not save the cloud document. No save_as inside a modeling batch/command-event transaction.`,
    },
    {
      title: "Secondary Entry Point: fmcad-mcp.js",
      text: `node <installed-package>/bin/fmcad-mcp.js (also installed as fmcad-mcp) is the local application-catalog MCP entry point, not a registered fmcad subcommand. It accepts --backend mcp|addin and offline --help; backend uses the shared config default and is checked against the broker. FMCAD_CONFIG/XDG config paths and the selected backend's connection/transport settings still apply; routing is always queue. Send one JSON-RPC 2.0 object per stdin line; method string required, id optional for notifications. Initialize explicitly through the client. tools/list publishes the bundled fmcad_cad_* catalog locally, without an SDK probe; queue helpers remain available in queue mode. Catalog tools take data, doc/document pins, component, projectId, purpose and preview; they use shared CAD validation and typed application execution. SDK execution uses the existing phased broker worker, not CLI parsing or raw tool forwarding. Read-only hints are requested, never an enforced sandbox. Capability availability does not prove geometry correctness or cloud access. For installed raw backend schemas use fmcad tools --json; explicitly named raw tools/resources still retain transport/session forwarding without fallback, retries or a second initialization.
Output is newline-delimited JSON-RPC. Invalid JSON -> -32700, invalid request -> -32600, connection/missing matching response -> -32000 with uncertain-execution warning. Notifications log failures to stderr. Session and negotiated protocol header are retained within the process; concurrent input requests are not serialized into modeling transactions. EOF waits for pending requests. Do not manually stream mutations concurrently. This interface is tested offline in tests/mcp-stdio.test.js, not a guarantee of every upstream tool's behavior.`,
    },
  ],
  examples: [
    {
      label: "Offline detailed help",
      argv: ["help", "batch", "run"],
      requires: "No config or Fusion connection.",
      output: "Detailed step schema, reference wiring and report/replay help.",
    },
    {
      label: "Discover installed raw schemas",
      argv: ["tools", "--json", "--backend", "addin"],
      requires:
        "Trusted running add-in endpoint configured; this performs a metadata request only.",
      output: "JSON array of installed tool descriptors including inputSchema.",
    },
  ],
  audit: {
    sources: [
      "bin/fmcad.js:stdout error handling",
      "src/cli.js:parseFlags,parseCommand,main,toWindowsPath",
      "src/config.js:loadConfig,initConfig",
      "src/client.js:McpClient",
      "src/addin-client.js:AddinClient",
      "assets/addin-bridge.py:run",
      "src/curl-transport.js:postWithCurl",
      "src/entrypoints/mcp-stdio.ts:startStdio",
      "src/mcp-stdio-compat.js:createForwarder",
    ],
    verified: [
      "all global flags, config keys, defaults and precedence",
      "backend adaptations and enforcement limits",
      "legacy/CAD parsing and result formats",
      "path mapping and secondary stdio entry point",
    ],
    tests: [
      "tests/backend-config.test.js",
      "tests/backend-cli.test.js",
      "tests/curl-transport.test.js",
      "tests/mcp-stdio.test.js",
      "tests/manual-legacy.test.js",
    ],
    gaps: [],
    bugs: [
      "Regex JSONC stripping is not string-aware for all comment-like content; use plain unambiguous JSON.",
      "Help resolves the longest known prefix and can silently ignore unknown trailing words.",
      "Executable stdout EPIPE exits 0 even though a complete mutation result may not have been observed.",
    ],
  },
};

export = guide;
