import fs from "node:fs";
import path from "node:path";

export interface ConsoleExportOptions {
  readonly format?: "jsonl" | "text";
  readonly overwrite?: boolean;
  readonly retention?: Readonly<Record<string, unknown>>;
}

/** Export a detached snapshot without overwriting an existing file implicitly. */
export function createConsoleExporter(sanitize: (value: string) => string) {
  return function exportRows(
    file: string,
    rows: readonly unknown[],
    {
      format = "jsonl",
      overwrite = false,
      retention = {},
    }: ConsoleExportOptions = {},
  ): number {
    const snapshot = structuredClone(rows);
    const data =
      format === "text"
        ? "# Retention: " +
          JSON.stringify(retention) +
          "\n" +
          snapshot.map((row) => sanitize(JSON.stringify(row))).join("\n") +
          "\n"
        : [
            JSON.stringify({ type: "retention", ...retention }),
            ...snapshot.map((row) => JSON.stringify(row)),
          ].join("\n") + "\n";
    const fd = fs.openSync(path.resolve(file), overwrite ? "w" : "wx", 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return snapshot.length;
  };
}
