import type { OperationContract } from "../catalog";

interface Data extends Record<string, unknown> {
  reads?: unknown;
  id?: unknown;
  operation?: unknown;
  data?: unknown;
  fields?: unknown;
}
export interface InspectionRead {
  id: string;
  operation: string;
  data: Data;
  fields?: string[];
}
export interface InspectionPlan {
  reads: InspectionRead[];
  maxItems: number;
  maxDepth: number;
  maxStringBytes: number;
  maxBytes: number;
  inventory: string[];
}

function object(value: unknown): value is Data {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A projection of the existing catalog, never a second dispatch registry. */
export function planInspection(
  data: Data,
  contracts: Readonly<Record<string, OperationContract>>,
  validate: (operation: string, data: Data) => unknown,
): InspectionPlan {
  if (
    Object.keys(data).some(
      (key) =>
        ![
          "reads",
          "maxItems",
          "maxDepth",
          "maxStringBytes",
          "maxBytes",
        ].includes(key),
    )
  )
    throw new Error("Unsupported inspect.pack inputs");
  if (
    !Array.isArray(data.reads) ||
    data.reads.length < 1 ||
    data.reads.length > 100
  )
    throw new Error("inspect.pack requires 1..100 reads");
  // readOnlyRequested alone is not a purity guarantee (e.g. viewport/file I/O).
  const inventory = Object.values(contracts)
    .filter(
      (contract) =>
        contract.service.kind === "python" &&
        contract.readOnlyRequested &&
        !contract.declaration.internalOnly &&
        contract.declaration["inspectionSafe"] === true,
    )
    .map((contract) => contract.operation)
    .sort();
  const supported = new Set(inventory);
  const ids = new Set<string>();
  const reads = data.reads.map((read): InspectionRead => {
    if (
      !object(read) ||
      Object.keys(read).some(
        (key) => !["id", "operation", "data", "fields"].includes(key),
      ) ||
      typeof read.id !== "string" ||
      !/^[\w-]{1,64}$/.test(read.id) ||
      ids.has(read.id) ||
      typeof read.operation !== "string" ||
      !/^[a-z][a-z0-9_.-]{0,127}$/.test(read.operation) ||
      !object(read.data)
    )
      throw new Error("Invalid inspect.pack read or duplicate id");
    ids.add(read.id);
    if (
      read.fields !== undefined &&
      (!Array.isArray(read.fields) ||
        read.fields.length < 1 ||
        read.fields.length > 32 ||
        read.fields.some(
          (field) => typeof field !== "string" || !/^[\w-]{1,64}$/.test(field),
        ) ||
        new Set(read.fields).size !== read.fields.length)
    )
      throw new Error(
        "inspect.pack fields must contain 1..32 distinct top-level names",
      );
    if (supported.has(read.operation)) validate(read.operation, read.data);
    return {
      id: read.id,
      operation: read.operation,
      data: read.data,
      ...(read.fields === undefined ? {} : { fields: read.fields as string[] }),
    };
  });
  const limit = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const value = data[name] === undefined ? fallback : data[name];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    )
      throw new Error(`inspect.pack ${name} must be an integer ${min}..${max}`);
    return value;
  };
  const plan = {
    reads,
    inventory,
    maxItems: limit("maxItems", 100, 1, 1000),
    maxDepth: limit("maxDepth", 8, 1, 16),
    maxStringBytes: limit("maxStringBytes", 2048, 16, 8192),
    maxBytes: limit("maxBytes", 65536, 1024, 1048576),
  };
  // Host-independent UTF-8 length; reject before source loading or SDK admission.
  const encoded = JSON.stringify(plan);
  let bytes = 0;
  for (const char of encoded) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  if (bytes > 262144)
    throw new Error("inspect.pack request exceeds 262144 bytes");
  return plan;
}
