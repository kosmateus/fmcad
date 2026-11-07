import { record, type CadContext, type CadData } from "./contracts";

export interface CadInputFormatting {
  summaryFlag?: boolean;
  observeShortcut?: boolean;
}
export interface CadInputPlan {
  context: CadContext;
  payload: { kind: "inline" | "file"; value: string } | null;
  direct: CadData;
  observeShortcut: boolean;
}
export function planCadInput(
  args: readonly string[],
  inputs: Readonly<Record<string, unknown>> = {},
  formatting: CadInputFormatting = {},
): CadInputPlan {
  const options: CadContext = {
    doc: null,
    component: null,
    projectId: null,
    json: false,
    preview: false,
  };
  let payload: CadInputPlan["payload"] = null;
  const direct: CadData = {};
  const values: Readonly<
    Record<string, "doc" | "component" | "projectId" | "docId" | "docFileId">
  > = {
    "--doc": "doc",
    "--component": "component",
    "--project-id": "projectId",
    "--doc-id": "docId",
    "--doc-file-id": "docFileId",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!,
      next = args[i + 1];
    const field = values[arg];
    if (Object.hasOwn(values, arg) && field) {
      if (["--doc-id", "--doc-file-id"].includes(arg)) {
        if (Object.hasOwn(options, field))
          throw new Error(`Duplicate CAD option: ${arg}`);
        if (
          typeof next !== "string" ||
          !next ||
          /\s/.test(next) ||
          next.startsWith("-")
        )
          throw new Error(
            `${arg} requires a nonempty identity without whitespace`,
          );
      }
      if (!next || next.startsWith("--"))
        throw new Error(`${arg} requires a value`);
      options[field] = next;
      i++;
    } else if (arg === "--json") options.json = true;
    else if (arg === "--summary" && formatting.summaryFlag)
      options.summary = true;
    else if (arg === "--preview") options.preview = true;
    else if (arg === "--data" || arg === "--file") {
      if (payload !== null)
        throw new Error("Provide only one of --data or --file");
      if (!next || next.startsWith("--"))
        throw new Error(`${arg} requires a value`);
      payload = { kind: arg === "--file" ? "file" : "inline", value: next };
      i++;
    } else if (arg.startsWith("--")) {
      const key = (
        arg === "--input-component" ? "component" : arg.slice(2)
      ).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      if (!Object.hasOwn(inputs, key))
        throw new Error(`Unknown CAD option: ${arg}`);
      if (next === undefined || next.startsWith("--"))
        throw new Error(`${arg} requires a value`);
      i++;
      try {
        direct[key] = JSON.parse(next) as unknown;
      } catch {
        direct[key] = next;
      }
    } else throw new Error(`Unknown CAD option: ${arg}`);
  }
  return {
    context: options,
    payload,
    direct,
    observeShortcut: formatting.observeShortcut === true,
  };
}
/** Receives decoded bytes from the file adapter; never opens a file itself. */
export function decodeCadInput(
  plan: CadInputPlan,
  fileText?: string,
): CadContext & { data: CadData } {
  const payload =
    plan.payload === null
      ? null
      : plan.payload.kind === "inline"
        ? plan.payload.value
        : fileText;
  if (payload === undefined)
    throw new Error("CAD input file snapshot required");
  const data: unknown =
    payload === null
      ? {}
      : plan.observeShortcut && payload.trim() === "observe"
        ? { operations: [] }
        : (JSON.parse(payload) as unknown);
  if (!record(data)) throw new Error("CAD command data must be a JSON object");
  for (const [key, value] of Object.entries(plan.direct)) {
    if (Object.hasOwn(data, key))
      throw new Error(`Duplicate CAD input: ${key}`);
    data[key] = value;
  }
  return { ...plan.context, data };
}
