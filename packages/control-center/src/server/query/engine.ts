import {
  CONSOLE_QUERY_CONTRACT_VERSION,
  CONSOLE_QUERY_MISSING_FACET,
  type ConsoleNumericAggregate,
  type ConsoleQueryCollection,
  type ConsoleQueryRecord,
  type ConsoleQueryRangeFilter,
  type ConsoleQueryScope,
  type ConsoleQuerySort,
  type ConsoleQueryTextFilter,
} from "../../contracts/index.js";
type QueryRecord = ConsoleQueryRecord;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function boundedId(value: unknown, maxLength = 256): value is string {
  return nonempty(value) && value.length <= maxLength;
}

export function validScope(scope: unknown): scope is ConsoleQueryScope {
  return (
    isRecord(scope) &&
    (scope["kind"] === "global" ||
      (scope["kind"] === "project" && boundedId(scope["projectId"])))
  );
}

export function sameScope(
  left: ConsoleQueryScope,
  right: ConsoleQueryScope,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "global" ||
      (right.kind === "project" && left.projectId === right.projectId))
  );
}

function field(record: QueryRecord, path: string): unknown {
  if (!path || path.length > 200) return undefined;
  let value: unknown = record;
  for (const part of path.split(".")) {
    if (
      !part ||
      part === "__proto__" ||
      part === "prototype" ||
      part === "constructor"
    )
      return undefined;
    if (!isRecord(value)) return undefined;
    value = value[part];
  }
  return value;
}

function missing(value: unknown): boolean {
  return value === undefined || value === null;
}

function isRange(value: unknown): value is ConsoleQueryRangeFilter {
  return (
    isRecord(value) &&
    ("eq" in value ||
      "any" in value ||
      "min" in value ||
      "max" in value ||
      "includeMissing" in value)
  );
}

function isTextFilter(value: unknown): value is ConsoleQueryTextFilter {
  return isRecord(value) && typeof value["contains"] === "string";
}

function matchesFilter(value: unknown, filter: unknown): boolean {
  if (isTextFilter(filter))
    return (
      typeof value === "string" &&
      value
        .normalize("NFC")
        .toLowerCase()
        .includes(filter.contains.normalize("NFC").toLowerCase())
    );
  if (isRange(filter)) {
    if (missing(value)) return filter.includeMissing === true;
    if ("eq" in filter && value !== filter.eq) return false;
    if (filter.any && !filter.any.includes(String(value))) return false;
    if (filter.min !== undefined || filter.max !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (filter.min !== undefined && value < filter.min) return false;
      if (filter.max !== undefined && value > filter.max) return false;
    }
    return true;
  }
  if (Array.isArray(filter))
    return filter.some((item) => String(item) === String(value));
  return value === filter;
}

export function filterRows(
  rows: readonly QueryRecord[],
  search: string,
  filters: Record<string, unknown>,
  omitFilter?: string,
): QueryRecord[] {
  const needle = search.trim().normalize("NFC").toLowerCase();
  return rows.filter((row) => {
    if (
      needle &&
      !JSON.stringify(row).normalize("NFC").toLowerCase().includes(needle)
    )
      return false;
    for (const [key, value] of Object.entries(filters)) {
      if (key !== omitFilter && !matchesFilter(field(row, key), value))
        return false;
    }
    return true;
  });
}

function compareValue(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number")
    return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === "boolean" && typeof right === "boolean")
    return Number(left) - Number(right);
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function sortRows(
  rows: readonly QueryRecord[],
  sorts: readonly ConsoleQuerySort[],
): QueryRecord[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      for (const sort of sorts) {
        const left = field(a.row, sort.field);
        const right = field(b.row, sort.field);
        const leftMissing = missing(left);
        const rightMissing = missing(right);
        if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
        if (!leftMissing) {
          const compared = compareValue(left, right);
          if (compared) return sort.direction === "desc" ? -compared : compared;
        }
      }
      const leftId = nonempty(a.row.id) ? a.row.id : "";
      const rightId = nonempty(b.row.id) ? b.row.id : "";
      return leftId.localeCompare(rightId) || a.index - b.index;
    })
    .map(({ row }) => row);
}

export function buildFacets(
  rows: readonly QueryRecord[],
  filters: Record<string, unknown>,
  requested: readonly string[] = [],
  search = "",
  maxValues = 500,
): Record<string, Record<string, number>> | null {
  const fields = [...new Set([...Object.keys(filters), ...requested])];
  const facets: Record<string, Record<string, number>> = Object.create(
    null,
  ) as Record<string, Record<string, number>>;
  for (const name of fields) {
    const counts: Record<string, number> = Object.create(null) as Record<
      string,
      number
    >;
    for (const row of filterRows(rows, search, filters, name)) {
      const value = field(row, name);
      if (missing(value)) {
        counts[CONSOLE_QUERY_MISSING_FACET] =
          (counts[CONSOLE_QUERY_MISSING_FACET] ?? 0) + 1;
        continue;
      }
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        const key = typeof item === "string" ? item : JSON.stringify(item);
        if (key !== undefined) counts[key] = (counts[key] ?? 0) + 1;
        if (Object.keys(counts).length > maxValues) return null;
      }
    }
    facets[name] = Object.fromEntries(
      Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return facets;
}

export function buildAggregates(
  rows: readonly QueryRecord[],
  requested: readonly string[],
): Record<string, ConsoleNumericAggregate | null> {
  const fields = [...new Set(requested)];
  return Object.fromEntries(
    fields
      .sort((a, b) => a.localeCompare(b))
      .map((key) => {
        const items = rows
          .map((row) => field(row, key))
          .filter(
            (value): value is number =>
              typeof value === "number" && Number.isFinite(value),
          )
          .sort((a, b) => a - b);
        if (!items.length) return [key, null];
        const sum = items.reduce((total, item) => total + item, 0);
        if (!Number.isFinite(sum)) return [key, null];
        const middle = Math.floor(items.length / 2);
        return [
          key,
          {
            count: items.length,
            sum,
            min: items[0]!,
            max: items[items.length - 1]!,
            average: sum / items.length,
            median:
              items.length % 2
                ? items[middle]!
                : (items[middle - 1]! + items[middle]!) / 2,
            p95: items[Math.max(0, Math.ceil(items.length * 0.95) - 1)]!,
          },
        ];
      }),
  );
}

export function stablePage<T>(
  rows: readonly T[],
  offset: number,
  limit: number,
): T[] {
  return rows.slice(offset, offset + limit);
}

export function normalizeSource(
  source: import("../../contracts/index.js").ConsoleSourceStatus | undefined,
  rowCount: number,
): import("../../contracts/index.js").ConsoleSourceStatus {
  if (!source)
    return {
      state: "unavailable",
      source: "unspecified",
      observedAt: null,
      reason: "Read model did not report source availability",
    };
  if (source.state === "no-data" && rowCount > 0)
    return {
      ...source,
      state: "partial",
      reason: source.reason || "Read model reported data with a no-data status",
    };
  return source;
}

export function supportedCollection(
  value: unknown,
): value is ConsoleQueryCollection {
  return (
    typeof value === "string" &&
    [
      "projects",
      "overview",
      "tasks",
      "agents",
      "sessions",
      "files",
      "logs",
      "system",
      "search",
    ].includes(value)
  );
}

export function validRevision(
  value: unknown,
): value is { epoch: string; revision: number } {
  return (
    isRecord(value) &&
    typeof value["epoch"] === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(value["epoch"]) &&
    Number.isSafeInteger(value["revision"]) &&
    (value["revision"] as number) >= 0
  );
}

export function validSorts(
  value: unknown,
): value is readonly ConsoleQuerySort[] {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 8 &&
      value.every(
        (item) =>
          isRecord(item) &&
          nonempty(item["field"]) &&
          (item["field"] as string).length <= 200 &&
          (item["direction"] === "asc" || item["direction"] === "desc"),
      ))
  );
}

export function validFilters(value: unknown): value is Record<string, unknown> {
  if (value === undefined) return true;
  if (!isRecord(value) || Object.keys(value).length > 32) return false;
  return Object.entries(value).every(([key, item]) => {
    if (!key || key.length > 200) return false;
    if (typeof item === "string") return item.length <= 2048;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "boolean") return true;
    if (Array.isArray(item))
      return (
        item.length <= 200 &&
        item.every((part) => typeof part === "string" && part.length <= 2048)
      );
    if (!isRecord(item)) return false;
    if ("contains" in item)
      return (
        Object.keys(item).length === 1 &&
        typeof item["contains"] === "string" &&
        item["contains"].length <= 512
      );
    const filter = item as ConsoleQueryRangeFilter;
    return (
      (!("eq" in filter) ||
        ["string", "number", "boolean"].includes(typeof filter.eq)) &&
      (typeof filter.eq !== "string" || filter.eq.length <= 2048) &&
      (!filter.any ||
        (Array.isArray(filter.any) &&
          filter.any.length <= 200 &&
          filter.any.every(
            (part) => typeof part === "string" && part.length <= 2048,
          ))) &&
      (filter.min === undefined || Number.isFinite(filter.min)) &&
      (filter.max === undefined || Number.isFinite(filter.max)) &&
      (filter.min === undefined ||
        filter.max === undefined ||
        filter.min <= filter.max) &&
      (filter.includeMissing === undefined ||
        typeof filter.includeMissing === "boolean")
    );
  });
}

export function validPrincipal(value: unknown): value is {
  subject: string;
  projectIds: readonly string[];
  globalRead: boolean;
} {
  return (
    isRecord(value) &&
    nonempty(value["subject"]) &&
    (value["subject"] as string).length <= 256 &&
    Array.isArray(value["projectIds"]) &&
    value["projectIds"].length <= 4096 &&
    value["projectIds"].every((id) => nonempty(id) && id.length <= 256) &&
    typeof value["globalRead"] === "boolean"
  );
}

export function errorResult(
  state: "unavailable" | "error" | "expired" | "forbidden",
  code: string,
  message: string,
) {
  return {
    version: CONSOLE_QUERY_CONTRACT_VERSION,
    state,
    code,
    message,
  } as const;
}
