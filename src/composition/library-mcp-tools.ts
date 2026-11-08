export interface QueueToolProperty {
  type: "string";
  minLength?: number;
  maxLength?: number;
  enum?: readonly string[];
}
export interface QueueTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Readonly<Record<string, QueueToolProperty>>;
    required: readonly string[];
    additionalProperties: false;
  };
}
const definitions: readonly [
  string,
  string,
  Record<string, QueueToolProperty>,
  (readonly string[])?,
][] = [
  [
    "begin",
    "Begin an explicit queue sequence lease; returns sequenceId and revision.",
    {},
  ],
  [
    "end",
    "Release an idle queue sequence lease.",
    { sequenceId: { type: "string", minLength: 1, maxLength: 256 } },
  ],
  ["status", "Read broker queue status and revision.", {}],
  [
    "result",
    "Read an owned queue job and its available result.",
    { jobId: { type: "string", minLength: 1, maxLength: 256 } },
  ],
  [
    "request",
    "Recover this client’s existing job by stable requestId; never resubmit it.",
    { requestId: { type: "string", minLength: 1, maxLength: 256 } },
  ],
  [
    "reconcile",
    "Reconcile an owned uncertain job without replay. Optional acceptedOutcome explicitly acknowledges the exact scoped atomic proof; it never verifies rollback or model state.",
    {
      jobId: { type: "string", minLength: 1, maxLength: 256 },
      acceptedOutcome: { type: "string", enum: ["committed", "aborted"] },
    },
    ["jobId"],
  ],
];
export const queueTools: readonly QueueTool[] = definitions.map(
  ([name, description, properties, required]) => ({
    name: "fmcad_queue_" + name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required: required || Object.keys(properties),
      additionalProperties: false,
    },
  }),
);

/** The advertised properties include optional fields; required is not an allowlist. */
export function validateQueueHelperArguments(
  tool: QueueTool,
  input: unknown,
): Record<string, string> {
  const fail = (): never => {
    throw Object.assign(
      new Error(
        tool.name +
          " requires exactly: " +
          (tool.inputSchema.required.join(", ") || "empty arguments"),
      ),
      { code: "INVALID_QUEUE_PARAMS" },
    );
  };
  const value = input === undefined ? {} : input;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail();
  const args = value as Record<string, unknown>;
  for (const key of tool.inputSchema.required)
    if (!Object.hasOwn(args, key)) return fail();
  const validated: Record<string, string> = {};
  for (const [key, entry] of Object.entries(args)) {
    if (!Object.hasOwn(tool.inputSchema.properties, key)) return fail();
    const property = tool.inputSchema.properties[key]!;
    if (
      typeof entry !== "string" ||
      !entry.trim() ||
      entry.length > (property.maxLength ?? 256) ||
      entry.length < (property.minLength ?? 1) ||
      (property.enum && !property.enum.includes(entry))
    )
      return fail();
    validated[key] = entry;
  }
  return validated;
}
