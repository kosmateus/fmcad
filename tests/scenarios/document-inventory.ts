import { record, text } from "./contracts";

/** Normalize only the public document-list JSON needed by scenario assertions. */
export function parseDocumentInventory(
  stdout: string,
): Record<string, unknown> {
  const response = record(JSON.parse(stdout) as unknown);
  if (response["success"] !== true)
    throw new Error("Public document inventory did not succeed");
  if (!Array.isArray(response["results"]))
    throw new Error("Public document inventory has no results array");

  const active: string[] = [],
    documents = response["results"].map((value) => {
      const row = record(value),
        creationId = text(row["creationId"]),
        name = text(row["name"]);
      for (const key of ["isActive", "isSaved", "isModified"])
        if (typeof row[key] !== "boolean")
          throw new Error("Invalid document inventory field: " + key);
      if (
        row["dataFileError"] !== undefined &&
        row["dataFileError"] !== null &&
        row["dataFileError"] !== ""
      )
        throw new Error(
          `Document ${JSON.stringify(name)} has a data-file error: ${JSON.stringify(row["dataFileError"])}`,
        );
      if (row["isActive"] === true) active.push(creationId);
      const fileId =
        row["id"] === undefined || row["id"] === null ? null : text(row["id"]);
      return {
        creationId,
        name,
        saved: row["isSaved"],
        modified: row["isModified"],
        fileId,
      };
    });
  if (
    new Set(documents.map((document) => document["creationId"])).size !==
    documents.length
  )
    throw new Error("Duplicate document identity in public inventory");
  if (active.length > 1)
    throw new Error("Public document inventory has multiple active documents");
  return { active: active[0] ?? null, documents };
}
