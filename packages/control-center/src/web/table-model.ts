/* Pure table transforms. Missing values stay last in both sort directions. */

export type SortDirection = "asc" | "desc";
export interface SortEntry {
  readonly key: string;
  readonly dir: SortDirection;
}
export type TableFilter =
  | {
      readonly type: "values";
      readonly values: readonly (string | number | null)[];
    }
  | { readonly type: "text"; readonly query: string }
  | {
      readonly type: "number";
      readonly min?: number | "" | null;
      readonly max?: number | "" | null;
      readonly includeUnknown?: boolean;
    };
export interface TableColumn<Row> {
  readonly type: "text" | "number";
  readonly value: (row: Row) => unknown;
  readonly sortValue?: (row: Row) => unknown;
}
export interface TableState {
  readonly sort?: readonly SortEntry[];
  readonly filters?: Readonly<Record<string, TableFilter>>;
}

const collator = new Intl.Collator("pl", {
  numeric: true,
  sensitivity: "base",
  usage: "sort",
});

function isMissing(value: unknown): boolean {
  return (
    value == null || (typeof value === "number" && !Number.isFinite(value))
  );
}

function normalizeSort(sort: readonly SortEntry[] | undefined): SortEntry[] {
  const seen = new Set<string>();
  const result: SortEntry[] = [];
  for (const entry of sort ?? []) {
    if (
      !entry ||
      typeof entry.key !== "string" ||
      seen.has(entry.key) ||
      (entry.dir !== "asc" && entry.dir !== "desc")
    )
      continue;
    seen.add(entry.key);
    result.push({ key: entry.key, dir: entry.dir });
  }
  return result;
}

/** Cycle absent → ascending → descending → absent; Ctrl/Command preserves other keys. */
export function toggleSort(
  sort: readonly SortEntry[] | undefined,
  key: string,
  multi = false,
): SortEntry[] {
  const current = normalizeSort(sort);
  const existing = current.find((entry) => entry.key === key);
  const direction = !existing ? "asc" : existing.dir === "asc" ? "desc" : null;
  if (!multi) return direction ? [{ key, dir: direction }] : [];
  if (!existing) return [...current, { key, dir: "asc" }];
  return current.flatMap((entry) =>
    entry.key !== key ? [entry] : direction ? [{ key, dir: direction }] : [],
  );
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function textParts(value: unknown): string[] | null {
  const values = Array.isArray(value) ? value : [value];
  const parts = values.filter((item) => !isMissing(item)).map(String);
  return parts.length ? parts : null;
}

function compareTextParts(
  left: readonly string[],
  right: readonly string[],
): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = collator.compare(left[index]!, right[index]!);
    if (difference) return difference;
  }
  return left.length - right.length;
}

export function compareText(left: unknown, right: unknown): number {
  const a = textParts(left);
  const b = textParts(right);
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return compareTextParts(a, b);
}

function passesFilter(value: unknown, filter: TableFilter): boolean {
  if (filter.type === "values") {
    const selected = new Set(
      filter.values.map((item) => (item == null ? null : String(item))),
    );
    return (Array.isArray(value) ? value : [value]).some((item) =>
      selected.has(isMissing(item) ? null : String(item)),
    );
  }
  if (filter.type === "text") {
    const query = filter.query.trim().normalize("NFC").toLocaleLowerCase("pl");
    if (!query) return true;
    return (Array.isArray(value) ? value : [value]).some(
      (item) =>
        !isMissing(item) &&
        String(item).normalize("NFC").toLocaleLowerCase("pl").includes(query),
    );
  }

  const hasMin = filter.min != null && filter.min !== "";
  const hasMax = filter.max != null && filter.max !== "";
  const min = hasMin ? numeric(filter.min) : null;
  const max = hasMax ? numeric(filter.max) : null;
  if (
    (hasMin && min === null) ||
    (hasMax && max === null) ||
    (hasMin && hasMax && min! > max!)
  )
    return false;
  const number = numeric(value);
  if (number === null) return filter.includeUnknown === true;
  return (!hasMin || number >= min!) && (!hasMax || number <= max!);
}

/** Filters and stable multi-column sorts rows without mutating source data. */
export function applyTable<Row>(
  rows: readonly Row[],
  state: TableState,
  columns: Readonly<Record<string, TableColumn<Row>>>,
): Row[] {
  const filters = Object.entries(state.filters ?? {}).flatMap(
    ([key, filter]) =>
      columns[key] ? [{ column: columns[key]!, filter }] : [],
  );
  const sorts = normalizeSort(state.sort).flatMap((entry) => {
    const column = columns[entry.key];
    return column
      ? [
          {
            direction: entry.dir === "desc" ? -1 : 1,
            type: column.type,
            read: column.sortValue ?? column.value,
          },
        ]
      : [];
  });

  const result = rows.flatMap((row, index) => {
    if (
      !filters.every(({ column, filter }) =>
        passesFilter(column.value(row), filter),
      )
    )
      return [];
    return [
      {
        row,
        index,
        values: sorts.map(({ read, type }) =>
          type === "number" ? numeric(read(row)) : textParts(read(row)),
        ),
      },
    ];
  });

  if (sorts.length)
    result.sort((left, right) => {
      for (let index = 0; index < sorts.length; index++) {
        const sort = sorts[index]!;
        const a = left.values[index];
        const b = right.values[index];
        if (a === null || b === null) {
          if (a !== b) return a === null ? 1 : -1;
          continue;
        }
        const difference =
          sort.type === "number"
            ? (a as number) - (b as number)
            : compareTextParts(a as string[], b as string[]);
        if (difference) return difference * sort.direction;
      }
      return left.index - right.index;
    });

  return result.map(({ row }) => row);
}
