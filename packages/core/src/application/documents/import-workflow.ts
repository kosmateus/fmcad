import type { DataImportFiles } from "../../ports/data-import-files";
import { sha256 } from "../../domain/engineering/sha256";
import { prepareDataImport, offlineImportResult } from "./data-import";
import type { ImportPlan } from "./data-import";
import { prepareRecords } from "./import-records";
import {
  fields,
  text,
  integer,
  stable,
  transform,
  multiply,
  inverse,
} from "./import-values";

/** Bind public input metadata and host file reads once; preparation remains synchronous. */
export function createImportWorkflow(
  inputs: (operation: string) => readonly string[] | null,
  localFiles: DataImportFiles,
) {
  return {
    prepare(
      operation: string,
      data: Record<string, unknown>,
      files = localFiles,
    ) {
      return prepareDataImport(operation, data, files, {
        inputs,
        fields,
        text,
        integer,
        digest: (value) => sha256(stable(value)!),
        records: prepareRecords,
      });
    },
    offlineResult(plan: ImportPlan, preview = false) {
      return offlineImportResult(plan, preview, {
        transform,
        multiply,
        inverse,
        stable,
      });
    },
  };
}
