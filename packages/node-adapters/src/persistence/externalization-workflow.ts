import type * as fs from "node:fs/promises";
import { hash } from "../../../core/src/application/documents/json";
import {
  validate,
  manifest,
} from "../../../core/src/application/documents/externalization-input";
import { executeExternalization } from "../../../core/src/application/documents/externalization";
import type {
  ExternalizationServices,
  ExternalizationRecord,
} from "../../../core/src/application/documents/externalization";
import {
  restoreKnownPendingEvidence,
  preserveKnownCursor,
  restoreBlockedCheckpoints,
  copyIntent,
} from "../../../core/src/application/documents/externalization-evidence";
import { openExternalizationJournal } from "./externalization";
import {
  readOperationJournal,
  writeOperationRecord,
} from "./operation-journal";
import { publishComplete } from "./publish";

interface Dependencies {
  fs?: typeof fs;
  step(
    action: "inspect",
    data: Record<string, unknown>,
    readOnly: true,
  ): ReturnType<ExternalizationServices["inspect"]>;
  step(
    action: "perform",
    data: Record<string, unknown>,
    readOnly: false,
  ): ReturnType<ExternalizationServices["perform"]>;
  refresh: ExternalizationServices["refresh"];
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}
/** Bind the existing journal and SDK ports without resubmitting uncertain effects. */
export async function execute(
  _client: unknown,
  input: unknown,
  context: { readOnly?: unknown } | null | undefined,
  deps: Dependencies,
) {
  return executeExternalization(input, context?.readOnly === true, {
    validate,
    requestHash: (data) => hash(manifest(data)),
    open: (data) =>
      openExternalizationJournal(
        data,
        {
          hash,
          manifest,
          publish: publishComplete,
          // The common journal authenticates the envelope; the family store below
          // validates each result's schema and exact operation owner before use.
          read: async (...args) =>
            (await readOperationJournal(...args)) as ExternalizationRecord[],
          write: writeOperationRecord,
        },
        deps.fs,
      ),
    restore(result, records) {
      restoreKnownPendingEvidence(result, records);
      restoreBlockedCheckpoints(result, records);
    },
    copyIntent,
    preserveCursor: preserveKnownCursor,
    inspect: (stored, result) =>
      deps.step("inspect", { ...stored, result }, true),
    perform: ({ stored, ...request }) =>
      deps.step("perform", { ...stored, ...request }, false),
    refresh: (request) => deps.refresh(request),
    now: deps.now ?? Date.now,
    sleep:
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  });
}
