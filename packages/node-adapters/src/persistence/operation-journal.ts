import * as fs from "node:fs/promises";
import path from "node:path";
import { hashCadJson as hash } from "@fmcad/core";
import { publishComplete } from "./publish.js";

/** Read the shared envelope; each operation validates its own result schema. */
export async function readOperationJournal(
  directory: string,
  binding: unknown,
  io: typeof fs = fs,
): Promise<unknown[]> {
  let names: string[];
  try {
    names = (await io.readdir(directory))
      .filter((name) => /^\d{8}\.json$/.test(name))
      .sort();
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return [];
    throw error;
  }
  const records: unknown[] = [];
  for (const [index, name] of names.entries()) {
    if (name !== String(index).padStart(8, "0") + ".json")
      throw new Error("Operation journal sequence gap; outcome unknown");
    const record = JSON.parse(
      await io.readFile(path.join(directory, name), "utf8"),
    ) as {
      sequence?: unknown;
      binding?: unknown;
    };
    if (record.sequence !== index || hash(record.binding) !== hash(binding))
      throw new Error("Operation journal identity mismatch; no replay");
    records.push(record);
  }
  return records;
}

export async function writeOperationRecord<Binding, Value extends object>(
  directory: string,
  binding: Binding,
  sequence: number,
  value: Value,
  io: typeof fs = fs,
): Promise<Value & { sequence: number; binding: Binding; at: string }> {
  await io.mkdir(directory, { recursive: true, mode: 0o700 });
  const record = { ...value, sequence, binding, at: new Date().toISOString() };
  await publishComplete(
    path.join(directory, String(sequence).padStart(8, "0") + ".json"),
    JSON.stringify(record) + "\n",
    io,
  );
  return record;
}
