import { createRequire } from "node:module";
import {
  indexCommandRoutes,
  type OperationContract,
  type OperationDeclaration,
} from "@fmcad/core";
import type { CommandEntry } from "../entrypoints/cli/parser";
export interface CommandDescriptor {
  key?: string;
  usage: string;
  desc: string;
  example: string;
  extra?: string | undefined;
}
export interface RegisteredCommand extends CommandEntry {
  description: string;
  example: string;
  extra?: string | undefined;
  readOnly?: boolean;
  pathMapper?: boolean;
  targetArg?: string;
  contract?: OperationContract;
}
type RegistrationOptions = Partial<Omit<RegisteredCommand, "key">> & {
  kind: string;
};
const load = createRequire(__filename);
function provider(name: string): {
  descriptor: CommandDescriptor;
  descriptors: Record<string, CommandDescriptor>;
  flags: Record<string, "value" | "boolean">;
} {
  return load("../../" + name);
}

function fmt(
  name: string,
  usage: string,
  desc: string,
  example: string,
  extra?: string,
): CommandDescriptor {
  return { key: name, usage, desc, example, extra };
}

const DOC_REQUIRED =
  "--doc <name> is REQUIRED: document lookup requires one case-insensitive open-name match; duplicate names are rejected before activation. Check the printed DOC name=... line. ERROR ... lines produce non-zero exit status, but not every underlying API failure is detected. No automatic save or rollback.";

export const OPS_DETAIL: Record<string, CommandDescriptor> = {
  projects: {
    usage: "projects",
    desc: "List all projects in the active hub.",
    example: "fmcad projects",
  },
  project_create: {
    usage: "project_create <project> [purpose]",
    desc: "Create a new project in the active hub. Idempotent: reports EXISTS if the name is taken.",
    example: 'fmcad project_create "Dust Collector"',
  },
  project_rename: {
    usage: "project_rename <project> <new_name>",
    desc: "Rename an existing project.",
    example: 'fmcad project_rename "Dust Collector" "Dust Collector 2"',
  },
  folder_list: {
    usage: "folder_list <project> [folder_path]",
    desc: 'List immediate folders and files. folder_path is relative to the project root; "" (default) is the root. Nested paths use "/".',
    example: 'fmcad folder_list "Dust Collector" "Engine"',
  },
  folder_create: {
    usage: "folder_create <project> <folder_path>",
    desc: 'Create folders (recursive: "A/B" creates A then B inside it). Idempotent (EXISTS_*).',
    example: 'fmcad folder_create "Dust Collector" "Engine/Motor"',
  },
  folder_rename: {
    usage: "folder_rename <project> <folder_path> <new_name>",
    desc: "Rename a folder inside a project.",
    example: 'fmcad folder_rename "Dust Collector" "Engine" "Motor"',
  },
  folder_delete: {
    usage: "folder_delete <project> <folder_path>",
    desc: "Delete a folder. The project root cannot be deleted.",
    example: 'fmcad folder_delete "Dust Collector" "Engine"',
  },
  file_rename: {
    usage: "file_rename <project> <folder_path> <file_name> <new_name>",
    desc: 'Rename a file. folder_path "" means the project root. file_name matches the Fusion display name, optionally with extension.',
    example: 'fmcad file_rename "Dust Collector" "" "Part v1" "Part v2"',
  },
  file_move: {
    usage: "file_move <project> <folder_path> <file_name> <dest_folder_path>",
    desc: "Move a file to another folder of the same project.",
    example: 'fmcad file_move "Dust Collector" "" "Part v1" "Engine"',
  },
  file_delete: {
    usage: "file_delete <project> <folder_path> <file_name>",
    desc: "Request SDK file deletion. Acceptance does not verify permanent deletion or editable-slot release. Open/edit locks may reject deletion.",
    example: 'fmcad file_delete "Dust Collector" "Engine" "Part v1"',
  },
  file_editability: {
    usage: "file_editability",
    desc: "Read-only diagnostic of the personal-use editable-file quota and editable file IDs, names and isReadOnly values. Reports mutationSupported: false and diagnosticsComplete. File getter failures preserve observed counts with editableFiles: null and getter-specific errors, then fail with nonzero status. DataFile.isReadOnly is read-only in the public API; switching editable/read-only status requires the Fusion GUI.",
    example: "fmcad file_editability",
  },
  file_editability_list: {
    usage: "file_editability_list [project]",
    desc: "Recursively inventory active-hub files using DataFile.isReadOnly. Optional project is an exact name or ID; ambiguous matches fail. Unknown status is null. Partial rows and counts are preserved with errors and nonzero exit status. Not-read-only counts do not establish personal-use editable-slot membership.",
    example: 'fmcad file_editability_list "Dust Collector"',
  },
  tree: {
    usage: "tree <project> [folder_path]",
    desc: "Recursive listing of folders and files.",
    example: 'fmcad tree "Dust Collector"',
  },
  param_list: {
    usage: "param_list --doc <name>",
    desc: `List user parameters of the design. ${DOC_REQUIRED}`,
    example: 'fmcad param_list --doc "Bez nazwy"',
  },
  param_add: {
    usage: "param_add <name> <expression> [unit] [comment] --doc <name>",
    desc: `Create a user parameter (dimension parameterization). The expression may contain units ("25 mm") or reference other parameters ("width * 2"). When unit is omitted it is resolved from the expression (referenced parameter unit, else a known unit token like mm/cm/in/deg/rad). Idempotent (EXISTS). ${DOC_REQUIRED}`,
    example: 'fmcad param_add width "25 mm" "" "outer width" --doc "Bez nazwy"',
  },
  param_set: {
    usage: "param_set <name> <expression> --doc <name>",
    desc: `Change the expression of an existing user parameter. ${DOC_REQUIRED}`,
    example: 'fmcad param_set width "30 mm" --doc "Bez nazwy"',
  },
  param_rename: {
    usage: "param_rename <name> <new_name> --doc <name>",
    desc: `Rename a user parameter (references update automatically). ${DOC_REQUIRED}`,
    example: 'fmcad param_rename width width_outer --doc "Bez nazwy"',
  },
  param_delete: {
    usage: "param_delete <name> --doc <name>",
    desc: `Delete a user parameter. Fails if other parameters reference it. ${DOC_REQUIRED}`,
    example: 'fmcad param_delete width_outer --doc "Bez nazwy"',
  },
  plane_list: {
    usage: "plane_list --doc <name>",
    desc: `List construction planes of the root component. ${DOC_REQUIRED}`,
    example: 'fmcad plane_list --doc "Bez nazwy"',
  },
  plane_add: {
    usage:
      "plane_add <name> offset <ref> <distance> --doc <name>\n  plane_add <name> mid <ref1> <ref2> --doc <name>\n  plane_add <name> angle <ref> <axis> <angle> --doc <name>",
    desc: `Create a construction plane on the root component. ref is XY/XZ/YZ or the name of an existing construction plane; axis is X/Y/Z (origin axes). offset: plane parallel to ref at distance ("10 mm"); mid: bisector of two planes (fails if co-planar); angle: plane rotated around axis. Idempotent (EXISTS). ${DOC_REQUIRED}`,
    example: 'fmcad plane_add P1 offset XY "10 mm" --doc "Bez nazwy"',
  },
  plane_rename: {
    usage: "plane_rename <name> <new_name> --doc <name>",
    desc: `Rename a construction plane. ${DOC_REQUIRED}`,
    example: 'fmcad plane_rename P1 PlaneOffset --doc "Bez nazwy"',
  },
  plane_delete: {
    usage: "plane_delete <name> --doc <name>",
    desc: `Delete a construction plane. ${DOC_REQUIRED}`,
    example: 'fmcad plane_delete PlaneOffset --doc "Bez nazwy"',
  },
  stats: {
    usage: "stats --doc <name>",
    desc: `Counts of bodies, features, sketches, user parameters and construction planes, plus every timeline item whose health is not healthy (name, state, message). ${DOC_REQUIRED}`,
    example: 'fmcad stats --doc "Bez nazwy"',
  },
  bbox: {
    usage: "bbox --doc <name>",
    desc: `Per-body bounding box: min/max corner and size in mm. ${DOC_REQUIRED}`,
    example: 'fmcad bbox --doc "Bez nazwy"',
  },
  bodies: {
    usage: "bodies --doc <name>",
    desc: `Per-body volume (mm3) and visibility. ${DOC_REQUIRED}`,
    example: 'fmcad bodies --doc "Bez nazwy"',
  },
  comp_list: {
    usage: "comp_list --doc <name>",
    desc: `Component tree (occurrence hierarchy): each component with its parent. ${DOC_REQUIRED}`,
    example: 'fmcad comp_list --doc "Bez nazwy"',
  },
  comp_add: {
    usage: "comp_add <name> [<parent>] --doc <name>",
    desc: `Create a new component (and an occurrence referencing it) under the root or under an existing component given as <parent>. Idempotent (EXISTS). ${DOC_REQUIRED}`,
    example: 'fmcad comp_add Motor Housing --doc "Bez nazwy"',
  },
  rollback: {
    usage: "rollback <pos> --doc <name>",
    desc: `Move the timeline marker to position <pos> (0 = start, count = end). Useful for repairing parametric history. Out-of-range positions produce a clear error. ${DOC_REQUIRED}`,
    example: 'fmcad rollback 2 --doc "Bez nazwy"',
  },
  units: {
    usage: "units <mm|cm|in> --doc <name>",
    desc: `Set the design length display units (mm, cm or in). ${DOC_REQUIRED}`,
    example: 'fmcad units mm --doc "Bez nazwy"',
  },
  upload: {
    usage: "upload <local_wsl_path> [--project <name>] [--folder <path>]",
    desc: "Upload a local file (WSL path; converted to a Windows path for the machine running Fusion) into a hub project folder (default: active project, root folder). Polls the async upload state (UploadProcessing/Finished/Failed) with adsk.doEvents() for up to 30 s: prints UPLOAD_FINISHED name=<name> id=<id>, or UPLOAD_PENDING - the file appears in fmcad folder_list / fmcad doc search only once the upload finishes (that is the cross-call status check).",
    example:
      'fmcad upload ./notes.txt --project "Dust Collector" --folder "Engine"',
  },
};

export const DOC_SUB: Record<string, CommandDescriptor> = {
  search: {
    usage: "doc search <name> [--project <name>]",
    desc: "Search hub documents by name (fuzzy, case-insensitive); optionally scoped to one project. Prints FILE name=<name> id=<id> lines.",
    example: 'fmcad doc search "Dust"',
  },
  open: {
    usage: "doc open <name>",
    desc: "Search the hub by name and open the FIRST match in Fusion (fileId from the search result). Prints OPENED name=... id=...",
    example: 'fmcad doc open "SKF_30205"',
  },
  new: {
    usage: "doc new [--name <name>]",
    desc: "Create a new Fusion design document; optionally set its pre-save name. It becomes the active document.",
    example: 'fmcad doc new --name "New Design"',
  },
  list: {
    usage: "doc list",
    desc: "List currently open documents with isActive/isModified/isSaved.",
    example: "fmcad doc list",
  },
  recent: {
    usage: "doc recent",
    desc: "List recently used hub documents.",
    example: "fmcad doc recent",
  },
  save: {
    usage: "doc save",
    desc: "Save the active document through the selected backend. First-save, unchanged-document and asynchronous completion behavior depends on that backend; see the detailed save contract.",
    example: "fmcad doc save",
  },
  close: {
    usage: "doc close --save | --discard",
    desc: "Close the active document. Exactly one of --save (save first) or --discard (drop changes) is REQUIRED; missing flag is an error.",
    example: "fmcad doc close --discard",
  },
};

function exportHelp(sub: string): CommandDescriptor | undefined {
  if (sub === "stl") {
    return fmt(
      "export stl",
      "export stl [--body <name>] [--out <wsl_path>] --doc <name>",
      `Export the design (or a single root-level body with --body) as STL. Default output: <doc_name>.stl in the current directory. --doc is REQUIRED. The file is written by the machine running Fusion; the WSL path is mapped automatically (/mnt/c/... becomes C:\\..., anything else becomes \\\\wsl$\\<distro>\\...).`,
      'fmcad export stl --doc "Bez nazwy"',
    );
  }
  if (sub === "step") {
    return fmt(
      "export step",
      "export step [--out <wsl_path>] --doc <name>",
      `Export the whole design as STEP. Default output: <doc_name>.step in the current directory. --doc is REQUIRED. Path mapping as for STL.`,
      'fmcad export step --out /mnt/c/cad-output/model.step --doc "Bez nazwy"',
    );
  }
  return undefined;
}

export const SPECIAL: Record<string, () => CommandDescriptor> = {
  file_download: () =>
    fmt(
      "file_download",
      "file_download <name> [--out <wsl_path|dir>]",
      "Download a hub file by name (first match) to a local path. Only NON-Fusion files can be downloaded (txt, images, ...); F3D produces a clear error. If --out has no file extension it is treated as a directory and the hub name is appended; the path is mapped like export.",
      'fmcad file_download "notes.txt" --out ~/downloads',
    ),
  shot: () =>
    fmt(
      "shot",
      "shot [--out file.png] [--dir iso-top-right] [--width N] [--height N] [--no-aa] [--transparent]",
      "Take a screenshot of the Fusion graphics view and save it as a PNG (base64 decoded locally). Directions: current, front, back, bottom, top, left, right, iso-*. Default output: shot-<timestamp>.png in the current directory.",
      "fmcad shot --out check.png --dir iso-top-right",
    ),
  undo: () =>
    fmt(
      "undo",
      "undo",
      "Undo the last committed operation in the active document (fusion_mcp_update).",
      "fmcad undo",
    ),
  redo: () =>
    fmt(
      "redo",
      "redo",
      "Redo the last undone operation in the active document (fusion_mcp_update).",
      "fmcad redo",
    ),
  active: () =>
    fmt(
      "active",
      "active",
      "Show the currently open Fusion command dialog (id, name, tooltip) or NONE.",
      "fmcad active",
    ),
  licensing: () =>
    fmt(
      "licensing",
      "licensing",
      "Show the signed-in Fusion license/entitlement summary.",
      "fmcad licensing",
    ),
  doctor: () =>
    fmt(
      "doctor",
      "doctor",
      "Self-check: resolved config (url/tool/timeout) plus server connectivity and tool list.",
      "fmcad doctor",
    ),
  init: () =>
    fmt(
      "init",
      "init [--from-opencode] [--force]",
      "Write the config file (~/.config/fmcad/config.json by default, or --config <path>). Defaults are used unless --from-opencode imports the mcp.fusion block (url + headers) from ~/.opencode/opencode.jsonc. Refuses to overwrite without --force. Also creates the user scripts dir ~/.config/fmcad/scripts/.",
      "fmcad init --from-opencode",
    ),
  tools: () =>
    fmt(
      "tools",
      "tools",
      "List the tool names exposed by the MCP server.",
      "fmcad tools",
    ),
  call: () =>
    fmt(
      "call",
      "call <tool> '<json-args>'",
      "Call any MCP tool directly with a JSON argument object. Useful for tools without a dedicated command (e.g. read queries, electronics).",
      'fmcad call fusion_mcp_read \'{"queryType":"projects"}\'',
    ),
  run: () =>
    fmt(
      "run",
      "run <script|name> [--args '<json>' | --args-file <path>] [--doc <name> [--doc-id <creationId>] [--doc-file-id <cloudId>]] [--helpers <version>] [--readonly] [--out <path> [--out-format text|json] [--pretty true|false]] [--list]",
      "Run a trusted Python script inside Fusion. Bare names resolve user scripts then built-ins; explicit paths resolve locally. --args or --args-file replaces a matching ARGS line with any JSON value. --args-file reads a local UTF-8 file relative to cwd, avoiding OS argument limits; it is mutually exclusive with --args and parsed before backend setup. --doc replaces DOC_NAME; optional --doc-id / --doc-file-id require --doc and check the unique named target before user code. Guarded mutation activates/checks the target; guarded --readonly does not activate. --helpers cad-v1 exposes the FMCAD facade (call/resolve/units/require_pass/require_history_end/emit), requires --doc plus --doc-id or --doc-file-id, and prints exactly one terminal FMCAD_RESULT with a helperCallsOnly journal; unknown helper versions are rejected before any RPC. This is a trusted-code precondition, NOT a sandbox; arbitrary readonly is not enforced. See the detailed script contract and helper facade below.",
      "fmcad run --list",
    ),
};

const { OPS, DOCUMENT_OPS } = load("../../ops") as {
  OPS: Record<string, number>;
  DOCUMENT_OPS: string[];
};

// Flag values are 'value' or 'boolean'. Globals are removed before command parsing.
export const globalFlags: Record<string, "value" | "boolean"> = {
  "--purpose": "value",
  "--config": "value",
  "--url": "value",
  "--header": "value",
  "--timeout": "value",
  "--backend": "value",
  "--transport": "value",
  "--curl-path": "value",
  "--routing": "value",
  "--client": "value",
  "--request-id": "value",
  "--queue-timeout": "value",
  "--sequence-action": "value",
  "--sequence-id": "value",
  "--sequence-mode": "value",
  "--expected-revision": "value",
};
export const commands: RegisteredCommand[] = [];
function register(
  key: string,
  descriptor: CommandDescriptor,
  options: RegistrationOptions,
) {
  commands.push({
    key,
    usage: descriptor.usage,
    description: descriptor.desc,
    example: descriptor.example,
    extra: descriptor.extra,
    flags: {},
    minArgs: 0,
    maxArgs: 0,
    requiresDoc: false,
    ...options,
  });
}

for (const [key, minArgs] of Object.entries(OPS)) {
  const requiresDoc = DOCUMENT_OPS.some(
    (p) => key === p || key.startsWith(p + "_"),
  );
  const editability =
    key === "file_editability" || key === "file_editability_list";
  register(
    key,
    OPS_DETAIL[key]!,
    key === "upload"
      ? {
          kind: "upload",
          target: key,
          minArgs: 1,
          maxArgs: 1,
          flags: { "--project": "value", "--folder": "value" },
        }
      : {
          kind: "op",
          target: key,
          minArgs,
          maxArgs: editability
            ? key === "file_editability_list"
              ? 1
              : 0
            : Infinity,
          requiresDoc,
          flags: editability ? {} : { "--doc": "value" },
          ...(editability ? { readOnly: true } : {}),
        },
  );
}

for (const [sub, descriptor] of Object.entries(DOC_SUB)) {
  const options = (
    {
      search: { minArgs: 1, maxArgs: 1, flags: { "--project": "value" } },
      open: { minArgs: 1, maxArgs: 1 },
      new: { flags: { "--name": "value" } },
      close: {
        flags: { "--save": "boolean", "--discard": "boolean" },
        exactlyOne: ["--save", "--discard"],
      },
    } as Record<string, Partial<RegisteredCommand>>
  )[sub];
  register(`doc ${sub}`, descriptor, {
    kind: "docops",
    target: `doc${sub[0]!.toUpperCase()}${sub.slice(1)}Cmd`,
    ...options,
  });
}

const specialOptions: Record<string, RegistrationOptions> = {
  file_download: {
    kind: "docops",
    target: "fileDownloadCmd",
    minArgs: 1,
    maxArgs: 1,
    flags: { "--out": "value" },
    pathMapper: true,
  },
  shot: {
    kind: "docops",
    target: "shotCmd",
    flags: {
      "--out": "value",
      "--dir": "value",
      "--width": "value",
      "--height": "value",
      "--no-aa": "boolean",
      "--transparent": "boolean",
    },
  },
  undo: { kind: "docops", target: "undoRedoCmd", targetArg: "undo" },
  redo: { kind: "docops", target: "undoRedoCmd", targetArg: "redo" },
  active: { kind: "docops", target: "activeCmd" },
  licensing: { kind: "docops", target: "licensingCmd" },
  doctor: { kind: "doctor" },
  init: {
    kind: "init",
    flags: { "--from-opencode": "boolean", "--force": "boolean" },
  },
  tools: { kind: "tools", flags: { "--json": "boolean" } },
  call: { kind: "call", minArgs: 2, maxArgs: 2 },
  run: {
    kind: "run",
    minArgs: 1,
    maxArgs: 1,
    listFlags: ["--list", "-l"],
    flags: {
      "--args": "value",
      "--args-file": "value",
      "--doc": "value",
      "--readonly": "boolean",
      "--doc-id": "value",
      "--doc-file-id": "value",
      "--helpers": "value",
      "--out": "value",
      "--out-format": "value",
      "--pretty": "value",
      "--list": "boolean",
      "-l": "boolean",
    },
  },
};
for (const [key, options] of Object.entries(specialOptions)) {
  register(key, SPECIAL[key]!(), options);
}
for (const format of ["stl", "step"]) {
  register(`export ${format}`, exportHelp(format)!, {
    kind: "export",
    target: format,
    requiresDoc: true,
    flags: { "--doc": "value", "--body": "value", "--out": "value" },
  });
}
register(
  "help",
  {
    usage: "help [command] [subcommand]",
    desc: "Show global or per-command help.",
    example: "fmcad help doc close",
  },
  { kind: "help", maxArgs: 2, aliases: ["--help", "-h"] },
);
for (const [key, description] of [
  ["doc", "Document lifecycle commands."],
  ["export", "Export the design to STL or STEP."],
] as const) {
  register(
    key,
    {
      usage: commands
        .filter((c) => c.key.startsWith(key + " "))
        .map((c) => c.usage)
        .join("\n  fmcad "),
      desc: description,
      example: `fmcad ${key} ${key === "doc" ? "list" : 'stl --doc "Bez nazwy"'}`,
    },
    { kind: "family" },
  );
}

export const legacyCommands = commands.slice();
register("console", provider("console").descriptor, {
  kind: "local",
  aliases: ["diagnostic"],
});
for (const [key, descriptor] of Object.entries(
  provider("queue-cli").descriptors,
)) {
  register(`queue ${key}`, descriptor, { kind: "queue" });
}
register(
  "queue",
  {
    usage:
      "queue <serve|exec|submit|status|result|cancel|release|pause|resume|stop|reclaim|reconcile> --help",
    desc: "Optional durable multi-agent Fusion broker.",
    example: "fmcad help queue serve",
  },
  { kind: "family" },
);
register("fusion reset", provider("fusion-reset").descriptor, {
  kind: "local",
  flags: { "--force": "boolean" },
});
register(
  "fusion",
  {
    usage: "fusion <reset> --help",
    desc: "Local Fusion application lifecycle operations.",
    example: "fmcad help fusion reset",
  },
  { kind: "family" },
);
register("review", provider("review").descriptor, {
  kind: "review",
  requiresDoc: true,
  flags: provider("review").flags,
});
for (const [key, descriptor] of Object.entries(
  provider("engineering-local").descriptors,
)) {
  register(key, descriptor, { kind: "local" });
}
register("image trace", provider("image-trace").descriptor, { kind: "local" });
register("image optimize", provider("image-optimize").descriptor, {
  kind: "local",
});
register("image boundaries", provider("image-boundaries").descriptor, {
  kind: "local",
});
const { catalog, cliContracts } = load("../../catalog") as {
  catalog: Record<string, OperationDeclaration>;
  cliContracts(reserved: string[]): Record<string, OperationContract>;
};
const cadContracts = cliContracts(
  commands.flatMap((c) => [c.key, ...(c.aliases || [])]),
);
for (const [operation, item] of Object.entries(catalog)) {
  if (item.internalOnly) continue;
  const contract = cadContracts[operation]!;
  const key = contract.cli.key;
  register(
    key,
    {
      usage:
        (item["usage"] as string | undefined) ||
        `${key} --doc <name> --data '<object>' [--component <ref>] [--json] [--preview]${item["summaryFlag"] ? " [--summary]" : ""}`,
      desc: item.summary,
      example: `fmcad ${key}${item.requiresDoc === false ? "" : " --doc Model"}${operation === "document.clear" ? " --doc-file-id DISCOVER_EXACT_DATAFILE_ID" : ""} --data '${JSON.stringify(item.example)}' --json`,
      extra:
        "Inputs (also accepted as --kebab-case value flags; payload component uses --input-component):\n" +
        Object.entries(item.inputs)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n") +
        "\nRequired: " +
        (item.required.join(", ") || "none") +
        "\nRead-only: " +
        item.readOnly +
        "\nUse --file <JSON file> instead of --data for complex inputs. All input flags require values, including booleans.\n" +
        "Limits:\n" +
        item.limitations.map((l) => "  - " + l).join("\n"),
    },
    {
      kind: "cad",
      target: operation,
      requiresDoc: item.requiresDoc !== false,
      aliases: contract.cli.aliases,
      contract,
    },
  );
}
const docFamily = commands.find((command) => command.key === "doc")!;
docFamily.extra =
  "Additional scoped commands: doc save-as --doc <name> --data <object>; doc status --doc <name>.\n" +
  "Use fmcad help doc save-as or fmcad help doc status for inputs, cloud destination and confirmation requirements.";
for (const prefix of [
  ...new Set(
    commands.filter((c) => c.kind === "cad").map((c) => c.key.split(" ")[0]!),
  ),
]) {
  if (!commands.some((c) => c.key === prefix)) {
    register(
      prefix,
      {
        usage: `${prefix} <operation> --help`,
        desc: "CAD operation group.",
        example: `fmcad help ${commands.find((c) => c.kind === "cad" && c.key.startsWith(prefix + " "))!.key}`,
      },
      { kind: "family" },
    );
  }
}
export const findCommand = indexCommandRoutes(commands);
